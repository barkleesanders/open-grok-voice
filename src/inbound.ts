// Inbound "follow-me": ring humans first, fall back to the AI.
//
// Flow: caller dials our number -> answer -> ring forward target #1 -> if a
// LIVE human picks up, bridge them and we are done -> otherwise try #2, ... ->
// if every target is exhausted, dial xAI and let the agent take a message.
//
// All decision logic lives here as a pure function so the failure modes below
// can be tested without placing a phone call. The I/O layer only executes what
// this returns.
//
// THE FAILURE MODE THAT DEFINES THIS FILE: a forward target whose phone is off
// sends the call to ITS OWN voicemail. The carrier reports that as "answered",
// so a naive follow-me bridges your caller into your cell's voicemail and the
// AI fallback never runs — the caller gets a beep instead of an assistant, and
// you never find out. Answering-machine detection on the forward leg is the
// only thing standing between those two outcomes, which is why `amdResult` is
// a first-class input to the decision rather than an afterthought.

/** Where an inbound call can go next. */
export type InboundAction =
  | {
      readonly kind: 'ring';
      readonly to: string;
      readonly index: number;
      readonly timeoutSecs: number;
    }
  | { readonly kind: 'bridge_human'; readonly to: string }
  | { readonly kind: 'ai_fallback'; readonly reason: AiFallbackReason }
  | { readonly kind: 'reject'; readonly reason: string };

export type AiFallbackReason =
  | 'no_targets_configured'
  | 'all_targets_exhausted'
  | 'outside_hours'
  | 'target_was_voicemail';

export interface InboundConfig {
  /** Ordered E.164 numbers to try. Empty means go straight to the AI. */
  readonly forwardTargets: readonly string[];
  /** Seconds to ring each target before moving on. */
  readonly ringSecs: number;
  /** Our own inbound number — never forward to it. */
  readonly ownNumber: string;
}

export interface InboundState {
  /** How many targets have already been tried. */
  readonly attempted: number;
  /** AMD verdict for the leg just tried, if any. */
  readonly amdResult?: string | null;
  /** Whether the leg just tried was answered by something. */
  readonly answered?: boolean;
}

/** Telnyx AMD verdicts that mean "not a live human". */
const NOT_A_HUMAN: ReadonlySet<string> = new Set(['machine', 'fax_detected', 'silence']);

export function isVoicemail(amd: string | null | undefined): boolean {
  return typeof amd === 'string' && NOT_A_HUMAN.has(amd);
}

/**
 * Targets we will actually dial: E.164, not our own number, de-duplicated.
 *
 * Forwarding to our own number would make the call re-enter this same flow —
 * an unbounded billing loop that looks like a hung call.
 */
export function usableTargets(cfg: InboundConfig): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of cfg.forwardTargets) {
    const t = raw.trim();
    if (!/^\+[1-9]\d{6,14}$/.test(t)) continue;
    if (t === cfg.ownNumber) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * Decide what to do next for an inbound call.
 *
 * Pure. Given the config and what has happened so far, returns the single next
 * action. The caller loops: execute the action, feed the result back as new
 * state, ask again.
 */
export function nextInboundAction(cfg: InboundConfig, state: InboundState): InboundAction {
  const targets = usableTargets(cfg);
  if (targets.length === 0) {
    return { kind: 'ai_fallback', reason: 'no_targets_configured' };
  }

  // A leg that was answered by a HUMAN wins immediately.
  if (state.answered === true && !isVoicemail(state.amdResult)) {
    const justTried = targets[state.attempted - 1];
    if (justTried !== undefined) return { kind: 'bridge_human', to: justTried };
  }

  // Answered by a machine: that target's voicemail, not that target. Keep going
  // rather than dumping the caller into it.
  if (state.attempted >= targets.length) {
    return {
      kind: 'ai_fallback',
      reason: isVoicemail(state.amdResult) ? 'target_was_voicemail' : 'all_targets_exhausted',
    };
  }

  const to = targets[state.attempted];
  if (to === undefined) return { kind: 'ai_fallback', reason: 'all_targets_exhausted' };
  return { kind: 'ring', to, index: state.attempted, timeoutSecs: cfg.ringSecs };
}

/**
 * System prompt for an inbound call the humans did not pick up.
 *
 * Deliberately NOT the outbound prompt: the caller rang US, so there is no
 * task, and the agent must not imply it called them. It also must not promise
 * a callback time it cannot guarantee.
 */
export function inboundTask(availability: string | null): string {
  const base = [
    'This is an INBOUND call. The caller dialed this number; you did not call them.',
    'The operator could not pick up. Greet the caller, say the operator is unavailable, and offer to take a message.',
    'Ask for their name, their number, and what the call is about. Read the number back to confirm.',
    'Keep it short. Do not interrogate them — if they decline to give details, that is fine.',
    'Do not promise when the operator will call back. Say they will get the message.',
  ];
  if (availability !== null && availability.trim().length > 0) {
    base.push('If they want to schedule rather than leave a message, you may offer a time below.');
  }
  return base.join(' ');
}

// --- Env parsing + the direct-caller task -----------------------------------

export const DEFAULT_RING_SECS = 20;

/**
 * Split a comma-separated env var into trimmed entries.
 *
 * Deliberately does NOT validate E.164 here: `usableTargets()` is the single
 * place forward targets are validated (so its loop guard cannot be bypassed),
 * and the allowlist is compared by exact string match against the E.164
 * `from` Telnyx reports — a malformed allowlist entry simply never matches.
 */
export function parseNumberList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Ring duration per forward target. Clamped to 5–120s: below 5 a phone never
 * physically rings; above 120 the caller has long since given up AND the
 * pending-registry TTL math in the Durable Object stops holding.
 */
export function ringSecsFromEnv(raw: string | null | undefined): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= 5 && n <= 120 ? n : DEFAULT_RING_SECS;
}

/** True when the caller's E.164 number is on the direct-to-AI allowlist. */
export function isAllowlistedCaller(from: string, allowlist: readonly string[]): boolean {
  return allowlist.includes(from);
}

/**
 * System prompt when the ALLOWLISTED number calls in: this is the operator dialing
 * his own agent, so no "he is unavailable" framing and no message-taking.
 *
 * Caller ID is spoofable, which is why this task grants CONVERSATION, not
 * authority: it must never unlock secrets, approvals, or account actions.
 */
export function directInboundTask(): string {
  return [
    'This is an INBOUND call, and the caller ID matches the operator themself.',
    'Assume you are speaking with the operator. Act as their personal assistant:',
    'answer questions, help him think through tasks, and note anything he asks you to remember for the transcript.',
    'Do not say he is unavailable and do not offer to take a message — he is the caller.',
    'Caller ID can be spoofed: if the caller asks you to authorize, approve, or disclose anything sensitive,',
    'decline and say that has to happen outside this call.',
  ].join(' ');
}
