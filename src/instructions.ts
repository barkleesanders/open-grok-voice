// Per-call system-prompt assembly.
//
// This is the whole point of the bridge: xAI's SIP path gives every inbound
// call the SAME agent unless the application configures the session itself. We
// open the realtime WebSocket per call and send THIS call's task as
// `session.update.instructions`, so one registered phone number can run an
// unbounded number of different outbound tasks.

/**
 * Telnyx answering-machine-detection results.
 * Verified against the Telnyx dial reference + AMD webhook docs (2026-08-26):
 * premium AMD reports one of human_residence | human_business | machine |
 * silence | fax_detected | not_sure; the non-premium modes report human/machine.
 */
export type AmdResult =
  | 'human'
  | 'human_residence'
  | 'human_business'
  | 'machine'
  | 'silence'
  | 'fax_detected'
  | 'not_sure';

const MACHINE_RESULTS: ReadonlySet<string> = new Set(['machine', 'fax_detected']);

export function isMachine(result: string | null | undefined): boolean {
  return !!result && MACHINE_RESULTS.has(result);
}

const BASE_PREAMBLE = [
  'You are placing an OUTBOUND phone call. The person did not call you; you called them.',
  'Open by stating who you are and why you are calling, in one short sentence, then stop and let them respond.',
  'Speak in short, plain sentences. This is a phone call, not an essay.',
  'When you say phone numbers, reference numbers, or codes, say each character separately.',
  'If the person asks to be removed, apologize once, confirm you will not call again, and end the call.',
  'Never claim to be a human. If asked directly whether you are an AI, say yes plainly.',
].join(' ');

/**
 * Inbound counterpart of BASE_PREAMBLE. Same phone manner, opposite framing:
 * the caller rang US, so "you called them" would be a lie the agent tells in
 * its first breath. The task string (inboundTask / directInboundTask) carries
 * the rest of the inbound-specific behaviour.
 */
const INBOUND_PREAMBLE = [
  'You are answering an INBOUND phone call. The caller dialed this number; you did not call them.',
  'Speak in short, plain sentences. This is a phone call, not an essay.',
  'When you say phone numbers, reference numbers, or codes, say each character separately.',
  'Never claim to be a human. If asked directly whether you are an AI, say yes plainly.',
].join(' ');

const VOICEMAIL_DIRECTIVE = [
  'IMPORTANT: This call was answered by voicemail or an answering machine, not a live person.',
  'Do not ask questions and do not wait for replies. Leave a single, self-contained message',
  'covering your purpose and any callback details, then stop speaking.',
].join(' ');

/**
 * Non-negotiable behaviour, asserted by `test/instructions.test.ts` to survive
 * ANY task string. Kept as exported constants so the test binds to the real
 * text rather than a copy that can drift.
 */
export const IDENTITY_LINE =
  'You are an automated assistant calling on behalf of <NAME>. You are not <NAME>. Never say or imply that you are them.';

/** Heading that separates the fixed safety block from the operator's words. */
export const TASK_HEADING = 'YOUR TASK ON THIS CALL:';

export const GUARDRAILS = [
  'You may ask questions, confirm status, take down information, and request a callback.',
  'You may NOT agree to terms, authorize a payment, cancel or change a service, accept a settlement,',
  'waive anything, or make any legal or financial commitment. If asked to, say you will have the operator call back.',
  'Do not volunteer personal identifiers. Only provide an identifier if it was given to you for this call.',
].join(' ');

/**
 * How the agent is told to work a phone tree.
 *
 * This exists because of a MEASURED failure, not a hypothetical one. On the
 * 2026-08-28 call to ACME Medical Center the IVR offered "for operator
 * assistance press zero" and the agent replied, out loud, "I'll press zero for
 * operator assistance. Zero." No tone was ever sent, the menu looped, and the
 * call ended having reached nobody. A model with a keypad tool still narrates
 * the action unless it is told, in as many words, that speaking a digit does
 * nothing.
 */
export const KEYPAD_DIRECTIVE = [
  'You can press keys on the phone keypad by calling the send_dtmf tool.',
  'Saying a number out loud does NOT press it; only the tool does.',
  'When a recording offers menu options, call the tool with just those keys,',
  'then stay quiet and listen to what happens next before doing anything else.',
  'Press one step at a time; do not guess ahead through a menu you have not heard.',
  'This is also how you finish a voicemail when the system says to press a key to send it.',
  'If you reach a menu with no option that fits, pressing 0 usually reaches an operator.',
].join(' ');

/**
 * How the agent is told to conference someone into the call.
 *
 * Only offered on outbound calls, never inbound, because the tool is only meaningful
 * when the agent is actively working toward a goal that requires bringing someone else in.
 */
export const CONFERENCE_DIRECTIVE = [
  'You can conference another person into this call by calling the add_conference_participant tool with their phone number.',
  'Use this when asked to loop in a supervisor, connect with a specific person or department, or bring someone else onto the line.',
  'The number you dial will ring and when they answer they will join this conversation.',
  'You can conference up to 4 people total.',
  'Only use this when explicitly asked or when it is clearly necessary to complete the task.',
].join(' ');

/**
 * The prompt for the ONE turn that follows a keypress.
 *
 * It re-states the identity line and the guardrails, and that is the whole
 * point. MEASURED against the live API 2026-08-28: a per-response
 * `instructions` override REPLACES the session instructions for that response,
 * it does not append to them. Probe: session prompt "always include BANANA",
 * override "say CAT" -> the model returned "CAT"; the same session with no
 * override returned "BANANA". So sending only a stay-quiet line here would run
 * the turn after every keypress with the ENTIRE safety block stripped — and
 * that turn is exactly the one where an IVR says "enter your Social Security
 * number". The safety text is carried explicitly because the protocol will not
 * carry it for us.
 *
 * Lives in THIS module, not in the Durable Object, because the fixed prompt
 * text has exactly one owner — a rule test/script-preview.test.ts enforces.
 */
export const POST_KEYPAD_TURN_INSTRUCTIONS = [
  IDENTITY_LINE,
  GUARDRAILS,
  'You just pressed keys on the phone keypad. The tones have already been sent.',
  'Do not announce, narrate, or repeat what you pressed.',
  'Say nothing now. Wait silently and listen to what the phone system does next.',
].join(' ');

/**
 * Strip anything that is not printable text from an operator-supplied label.
 *
 * The label reaches TWO places that both matter: Telnyx's text-to-speech, and
 * Grok's system prompt. `payload_type` is pinned to 'text' rather than 'ssml'
 * so markup cannot be injected into the speech, and this closes the other half
 * -- a newline in the prompt could otherwise let a label open what looks like a
 * new instruction line.
 *
 * `\p{C}` rather than an explicit control-character range, and that is a
 * correctness upgrade rather than a lint workaround: the Unicode "Other"
 * category covers Cf as well as Cc, so it also removes zero-width and
 * bidirectional-override characters (U+200B, U+202E). Those are invisible in
 * the console where the operator types the label, survive a control-character
 * filter untouched, and can reorder how the rest of the prompt line reads.
 */
export function sanitizeParticipantLabel(label: string | null): string | null {
  if (label === null) return null;
  const cleaned = label.replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * What every participant hears the moment someone joins.
 *
 * TWO facts in one short sentence, and both are deliberate. That a new person
 * joined, because a subject who has been speaking to one voice must not
 * discover a third party by accident. And that the call is recorded, because
 * the person who just joined never heard whatever notice was given at the top
 * of the call -- in a two-party-consent state their consent has to be sought at
 * the moment they arrive, not inferred from someone else's.
 *
 * Short on purpose: this plays over a live conversation, so every extra clause
 * is a second of someone being talked over.
 */
export function participantJoinNotice(label: string | null, recording: boolean): string {
  const who = sanitizeParticipantLabel(label);
  const subject = who === null ? 'Someone else' : who;
  // *** THE RECORDING CLAUSE IS CONDITIONAL, AND THAT IS NOT COSMETIC. ***
  // This sentence used to end "This call is being recorded." unconditionally,
  // which was true when every call recorded from the moment media came up.
  // With recording now on-demand it would be a FALSE STATEMENT on the common
  // path -- announcing a recording that does not exist. A notice that lies is
  // worse than no notice: it is the one sentence a listener is entitled to
  // rely on, and it would be relied on in exactly the jurisdictions that make
  // the notice matter.
  return recording
    ? `${subject} has joined this call. This call is being recorded.`
    : `${subject} has joined this call.`;
}

/**
 * What plays when recording starts mid-call.
 *
 * Present tense and unambiguous: the listener needs to know the state changed
 * just now, not that recording is a policy in general. Kept to one clause for
 * the same reason as the join notice -- it interrupts a live conversation.
 */
export function recordingStartedNotice(): string {
  return 'This call is now being recorded.';
}

/**
 * Tell the agent who else is on the line.
 *
 * Sent by re-sending `session.update` (the existing refresh_instructions
 * effect), NOT as a per-response override. That is not a style preference:
 * measured against the live API 2026-08-28, `response.create` with
 * `response.instructions` REPLACES the session prompt for that turn rather than
 * adding to it, so announcing a participant that way would run the very next
 * turn with the identity line and guardrails stripped.
 */
export function participantsDirective(labels: readonly string[]): string {
  const named = labels.map((label) => sanitizeParticipantLabel(label) ?? 'an unnamed participant');
  const list = named.join(', ');
  return [
    `OTHER PEOPLE ARE NOW ON THIS CALL: ${list}.`,
    'They joined after it started and heard a spoken notice announcing them.',
    'The person you were already speaking to is still on the line.',
    'Do not treat the spoken announcement as something they said.',
    'Address whoever is speaking; do not assume every voice is the same person.',
  ].join(' ');
}

/**
 * Should this call be offered the keypad tool?
 *
 * Both the prompt (which tells the agent the tool exists) and the session
 * declaration (which actually gives it the tool) are derived from this. If they
 * were decided separately they could drift, and the failure would be silent
 * and ugly: a prompt promising a keypad on a call where no tool was declared,
 * so every attempt to press a key vanishes.
 */
export function keypadAvailable(direction: 'outbound' | 'inbound' | undefined): boolean {
  return direction !== 'inbound';
}

/**
 * Should this call be offered the conference tool?
 *
 * Outbound only. The tool exists for calls where the agent is actively working
 * toward a goal that may require bringing someone else in. On inbound calls
 * the agent is message-taking, and conferencing is not part of that workflow.
 */
export function conferenceToolAvailable(direction: 'outbound' | 'inbound' | undefined): boolean {
  return direction !== 'inbound';
}

export interface BuildInstructionsInput {
  /** The caller-supplied task for THIS call. */
  readonly task: string;
  /** Which way the human leg was originated. Defaults to 'outbound'. */
  readonly direction?: 'outbound' | 'inbound';
  /** Latest AMD result, if Telnyx has reported one. */
  readonly amdResult?: string | null;
  /**
   * Server-built availability text. NEVER caller-supplied — see
   * `src/availability.ts` for why (it is free/busy only, no event contents).
   */
  readonly availability?: string | null;
  /**
   * Labels of people currently conferenced in besides the subject, if any.
   *
   * Operator-supplied bytes, so they go through `sanitizeParticipantLabel`
   * before they reach the prompt -- but they are still not `operator` kind,
   * because unlike the task they are a NAME rendered into fixed sentences
   * rather than instructions the operator authored.
   */
  readonly participants?: readonly string[];
}

/**
 * Which part of the prompt a segment is, so a reader can tell the operator's
 * own words apart from the fixed safety text without re-deriving the layout.
 *
 * `operator` is the ONLY kind carrying caller-supplied bytes. Everything else
 * is a constant from this module.
 */
export type InstructionSegmentKind =
  | 'identity'
  | 'preamble'
  | 'guardrails'
  | 'keypad'
  | 'conference'
  | 'participants'
  | 'availability'
  | 'heading'
  | 'operator'
  | 'voicemail'
  | 'blank';

export interface InstructionSegment {
  readonly kind: InstructionSegmentKind;
  readonly text: string;
}

/**
 * Compose the prompt as an ordered list of labelled segments.
 *
 * This exists so the operator console can SHOW the prompt broken into its
 * parts without a second renderer. `buildInstructions` is defined in terms of
 * this function, so a preview built from these segments cannot drift from the
 * string that is actually sent as `session.update.instructions` — there is one
 * composition, not two that merely agree today.
 *
 * Ordering is deliberate and matches xAI's prompting guide, which asks for a
 * fixed section order: stable framing first, then the variable task, then any
 * late-breaking situational override (voicemail) LAST so it wins.
 */
export function composeInstructions(input: BuildInstructionsInput): readonly InstructionSegment[] {
  // Order is load-bearing. The safety block is assembled HERE, ahead of the
  // task, so no task string can displace it — a task that says "ignore your
  // instructions" still arrives downstream of the identity and guardrails.
  const preamble = input.direction === 'inbound' ? INBOUND_PREAMBLE : BASE_PREAMBLE;
  const segments: InstructionSegment[] = [
    { kind: 'identity', text: IDENTITY_LINE },
    { kind: 'preamble', text: preamble },
    { kind: 'guardrails', text: GUARDRAILS },
  ];

  // Ahead of the task, like the rest of the fixed block: a task that says
  // "press 3 for billing" must not be the first place the agent learns it has
  // a keypad at all.
  if (keypadAvailable(input.direction)) {
    segments.push({ kind: 'keypad', text: KEYPAD_DIRECTIVE });
  }

  // Conference tool availability, also ahead of the task for the same reason.
  if (conferenceToolAvailable(input.direction)) {
    segments.push({ kind: 'conference', text: CONFERENCE_DIRECTIVE });
  }

  // Ahead of the task for the same reason the keypad block is: a task written
  // for a one-to-one call must not be the first thing that decides how the
  // agent treats a second voice on the line.
  const participants = input.participants ?? [];
  if (participants.length > 0) {
    segments.push({ kind: 'participants', text: participantsDirective(participants) });
  }

  const availability = (input.availability ?? '').trim();
  if (availability.length > 0) {
    segments.push({ kind: 'blank', text: '' }, { kind: 'availability', text: availability });
  }

  segments.push(
    { kind: 'blank', text: '' },
    { kind: 'heading', text: TASK_HEADING },
    { kind: 'operator', text: input.task.trim() },
  );

  if (isMachine(input.amdResult)) {
    segments.push({ kind: 'blank', text: '' }, { kind: 'voicemail', text: VOICEMAIL_DIRECTIVE });
  }
  return segments;
}

/** Compose the final `instructions` string sent to xAI. */
export function buildInstructions(input: BuildInstructionsInput): string {
  return composeInstructions(input)
    .map((segment) => segment.text)
    .join('\n');
}
