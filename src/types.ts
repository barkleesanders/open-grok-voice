// Domain types + Zod schemas for the two trust boundaries.
//
// Both webhook bodies are attacker-reachable input. They are parsed with Zod
// (after signature verification) so that a malformed or hostile payload fails
// loudly at the edge instead of becoming `undefined` three layers down.

import { z } from 'zod';

import { isValidTimeZone } from './availability';

// --- Public API ------------------------------------------------------------

/**
 * The ONE E.164 shape this Worker accepts, as a reusable schema factory.
 *
 * Every route that takes a dialable number derives from this. A second regex
 * written next to the first is the failure this exists to prevent: the two
 * drift, and one surface starts accepting a number the dialer downstream
 * rejects -- or worse, accepts one the other would have refused.
 *
 * The pattern is exported as a STRING, not just baked into the schema, because
 * the browser console cannot import a zod schema. It is interpolated into the
 * console's `pattern=` attribute and its client-side check, so the field the
 * operator types into and the schema that rejects them are the same regex --
 * one literal, three consumers.
 */
export const E164_PATTERN = '^\\+[1-9]\\d{6,14}$';

/**
 * The ONE cal.com event-type-slug shape this Worker accepts.
 *
 * Exported as a STRING for the same reason E164_PATTERN is: it has two
 * consumers -- the Zod schema that admits the value, and `parseJob`, which
 * re-validates it on the way back out of R2. A second regex written next to
 * this one is how the two drift and the reader starts accepting a slug the
 * schema would have refused.
 */
export const CALCOM_SLUG_PATTERN = '^[a-z0-9][a-z0-9-]{0,63}$';

export function e164Schema(field: string): z.ZodString {
  return z
    .string()
    .trim()
    .regex(new RegExp(E164_PATTERN), `${field} must be E.164, e.g. +14155550123`);
}

/**
 * Escalation participants that may share ONE call.
 *
 * NOT a technical ceiling: Telnyx allows 2-800 per conference and defaults to
 * 250. Every participant is a real outbound PSTN call billed to this account
 * and placed by whoever holds the console session or the API key, so the cap is
 * the blast radius of a leaked credential, not a capacity target. Four covers
 * what this feature is actually for -- pulling a supervisor, a family member,
 * or an interpreter onto a live call -- and holds the worst case at four dials
 * per call instead of 250.
 *
 * Enforced in THREE places on purpose, because they fail differently: the zod
 * schema rejects an over-long list at the edge, the reducer refuses the (N+1)th
 * add whatever route asked for it, and `max_participants` on the conference
 * makes Telnyx itself the backstop if both are somehow bypassed.
 */
export const MAX_PARTICIPANTS = 4;

/**
 * Participants that may pass through ONE call over its whole lifetime.
 *
 * A LIFETIME budget, not a concurrent one, and it exists because the roster is
 * append-only: a departed row is what the cost model meters and what the
 * archive records, so nothing is ever removed. Without this, add-then-drop
 * repeated on one long call grows the persisted state without limit -- and past
 * a thousand rows the minted `p${n}` id stops matching PARTICIPANT_ID_RE, so
 * that participant's webhooks are rejected at the boundary and their answered,
 * billing leg is never tracked or torn down.
 *
 * 25 is the same number and the same reasoning as the per-call keypress budget
 * in src/call-session.ts: a loop must terminate even when every attempt fails.
 */
export const MAX_PARTICIPANT_ROWS = 25;

/**
 * How one participant is wired into the conference audio.
 *
 * These are Telnyx's own `supervisor_role` values on
 * `POST /conferences/{id}/actions/join`, minus one: the enum is
 * ['barge','monitor','none','whisper'] and the spec says of "barge" that it
 * "means the supervisor enters the conference as a normal participant. This is
 * the same as 'none'." Two wire values for one behaviour is two ways to write
 * the same call, so only 'barge' is accepted here and 'none' is never sent.
 * (tools/openapi/telnyx-conference.subset.json, retrieved 2026-08-30.)
 *
 * 'barge' stays the DEFAULT because that is what this feature was built for --
 * the operator pulls a supervisor, a family member, or an interpreter onto a
 * live call and they land speaking. A role that silently muted them would be a
 * different feature wearing this one's name.
 */
export const SUPERVISOR_ROLES = ['barge', 'monitor', 'whisper'] as const;
export type SupervisorRole = (typeof SUPERVISOR_ROLES)[number];
export const SupervisorRoleSchema = z.enum(SUPERVISOR_ROLES);

/**
 * When a call records.
 *
 * `on_demand` is the DEFAULT and it is a deliberate behaviour change: calls
 * used to record unconditionally from the moment the media came up. Recording
 * a conversation is the kind of thing that should be a decision, and the
 * operator now makes it mid-call by pressing a key (see RECORDING_START_DTMF)
 * rather than at dial time, when they cannot yet know whether the call is
 * worth recording.
 *
 * `auto` reproduces the old behaviour verbatim for callers that want it.
 * `off` refuses to record at all -- the keypress is accepted, logged, and
 * declined, so an operator who set `off` cannot start one by muscle memory.
 */
export const RECORDING_MODES = ['auto', 'on_demand', 'off'] as const;
export type RecordingMode = (typeof RECORDING_MODES)[number];
export const RecordingModeSchema = z.enum(RECORDING_MODES);

/**
 * The key that starts recording from the handset.
 *
 * 9 rather than a more obvious 1 or *: single digits 0-9 are what every
 * handset sends without a modifier, and 9 sits far from the keys an IVR
 * commonly asks for, so a misdial while navigating a phone tree is unlikely
 * to trip it.
 */
export const RECORDING_START_DTMF = '9';

/** Body of POST /call. */
export const CallRequestSchema = z.object({
  /** E.164 destination, e.g. "+14155550123". */
  to: e164Schema('to'),
  /**
   * Numbers to conference in as soon as the call connects, in addition to the
   * subject and the AI. Dialed only AFTER the conference exists -- dialing them
   * up front would ring a third party into a call that may never answer.
   */
  participants: z.array(e164Schema('participant')).max(MAX_PARTICIPANTS).optional(),
  /** The per-call system prompt handed to Grok as `session.update.instructions`. */
  task: z.string().trim().min(1).max(16_000),
  /**
   * What this call is about, in the operator's own words ("ACME
   * Medical Center"). Optional, and NOT part of the prompt -- it never
   * reaches Grok, it only names the call in the console's log.
   *
   * It exists because nothing else can do this job. A campaign dials many
   * targets with ONE task file, so the task cannot say which target this is;
   * measured on the corpus behind the calls now archived, 41 calls shared 2
   * distinct task prefixes. Without this field two calls to different
   * facilities are distinguishable only by their number.
   *
   * Bounded at 120 to match MAX_SUBJECT_CHARS, which is what R2 custom
   * metadata will actually carry.
   */
  subject: z.string().trim().max(120).optional(),
  /**
   * When this call records. Defaults to `on_demand` -- nothing is recorded
   * until the operator presses RECORDING_START_DTMF on the leg we dialed.
   */
  recording: RecordingModeSchema.optional(),
  /**
   * Whether the spoken join notice plays. Defaults to TRUE.
   *
   * Setting this false suppresses the notice entirely and INDEPENDENTLY of
   * recording -- the two are separate switches because they answer separate
   * questions ("is anyone told?" vs "is audio kept?"). An operator who turns
   * this off is taking on whatever disclosure obligation applies to the
   * jurisdictions on the call; the Worker does not decide that for them.
   */
  notice: z.boolean().optional(),
  /**
   * When true, allow placing a new outbound call to the same E.164 even if a
   * live call to that number already exists. Default false: POST /call returns
   * 409 dial_locked with the existing callId so agents cannot double-dial.
   */
  force: z.boolean().optional(),
  /** Optional built-in voice id (see GET https://api.x.ai/v1/tts/voices). */
  voice: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9_-]{1,64}$/)
    .optional(),
  /**
   * Optional answering-machine detection mode passed through to Telnyx.
   * Values verified against the Telnyx dial reference (2026-08-26).
   */
  amd: z
    .enum(['disabled', 'detect', 'detect_beep', 'detect_words', 'greeting_end', 'premium'])
    .optional(),
  /**
   * Busy geometry for availability. Deliberately NUMBERS AND A BOOLEAN ONLY —
   * see `BusyInput` in src/availability.ts. `.strict()` rejects any extra key,
   * so a caller cannot smuggle a string field in alongside the numbers and
   * hope a future renderer picks it up.
   */
  busy: z
    .array(
      z
        .object({
          startMs: z.number().int().finite(),
          endMs: z.number().int().finite(),
          remote: z.boolean(),
        })
        .strict(),
    )
    .max(500)
    .optional(),
  /** How far ahead to offer slots. */
  windowDays: z.number().int().min(1).max(30).optional(),
  /**
   * Bookable start times from cal.com, epoch ms. Numbers only — the same
   * wire guarantee as `busy`: nothing a caller sends is a string, so nothing
   * a caller sends can be injected into the system prompt.
   */
  slots: z.array(z.number().int().finite()).max(400).optional(),
  /** Appointment length for those slots. */
  slotMinutes: z.number().int().min(5).max(480).optional(),
  /**
   * cal.com event-type slug for THIS call ("30mins", "50mins", "your-event-slug").
   *
   * The only availability input that is a caller-supplied STRING, and the
   * exception is bounded on purpose. It never reaches the system prompt: it is
   * written into ONE query parameter of a FIXED host (`CALCOM_API` in
   * src/calcom.ts, built with `new URL` + `searchParams.set`, so it cannot
   * escape into the path or the host). The charset below refuses everything
   * that is not a cal.com slug, and the length cap matches what cal.com will
   * actually route.
   *
   * It exists so a DEFERRED job can re-resolve its own slots at dial time
   * instead of replaying a frozen snapshot -- the slug is what selects the
   * appointment length, and the Worker cannot infer it from the numbers.
   */
  calcomEventTypeSlug: z.string().trim().regex(new RegExp(CALCOM_SLUG_PATTERN)).optional(),
  /**
   * IANA zone the operator scheduled in, e.g. "America/New_York".
   *
   * Epoch ms alone cannot answer "is this a civil hour to ring a stranger", so
   * a scheduled call needs the zone its runAt was chosen in. Validated as a
   * zone `Intl` can resolve rather than by regex, because an unresolvable zone
   * makes `Intl.DateTimeFormat` THROW, and the first thing that reads it is a
   * cron tick where one bad job would take every other due job down with it.
   */
  timeZone: z
    .string()
    .trim()
    .max(64)
    .refine(isValidTimeZone, { message: 'timeZone must be an IANA zone, e.g. America/Los_Angeles' })
    .optional(),
  /**
   * Absolute epoch ms. Numbers only — same injection rule as `slots`.
   * Absent: dial now. Present and in the future: persist, do not dial.
   */
  runAt: z.number().int().finite().optional(),
});
export type CallRequest = z.infer<typeof CallRequestSchema>;

/** Browser console requests must explicitly acknowledge its recording notice. */
export const ConsoleCallRequestSchema = CallRequestSchema.extend({
  recordingNoticeAcknowledged: z.literal(true),
});
export type ConsoleCallRequest = z.infer<typeof ConsoleCallRequestSchema>;

/**
 * Body of the console's read-only script preview.
 *
 * `task` may be EMPTY here, unlike `CallRequestSchema.task`: the preview
 * updates as the operator types, and the first keystroke should not be
 * preceded by a validation error. The preview never starts a call, so an
 * empty task is a legitimate state to render rather than a rejected request.
 *
 * Calendar fields are optional so the preview can show what the prompt would
 * look like with or without availability data attached.
 */
export const ScriptPreviewRequestSchema = z.object({
  task: z.string().max(16_000),
  /**
   * Render the variant Telnyx AMD produces when the call lands on voicemail.
   * A boolean rather than an `amdResult` string so the browser cannot inject
   * an arbitrary AMD value into the composition.
   */
  voicemail: z.boolean().optional(),
  /** Busy geometry for preview. Same shape as CallRequestSchema.busy. */
  busy: z
    .array(
      z
        .object({
          startMs: z.number().int().finite(),
          endMs: z.number().int().finite(),
          remote: z.boolean(),
        })
        .strict(),
    )
    .max(500)
    .optional(),
  /** How far ahead to offer slots (preview). */
  windowDays: z.number().int().min(1).max(30).optional(),
  /** Bookable start times from cal.com (preview). */
  slots: z.array(z.number().int().finite()).max(400).optional(),
  /** Appointment length for those slots (preview). */
  slotMinutes: z.number().int().min(5).max(480).optional(),
  /** cal.com event-type slug (preview). */
  calcomEventTypeSlug: z.string().trim().regex(new RegExp(CALCOM_SLUG_PATTERN)).optional(),
  /** IANA zone (preview). */
  timeZone: z
    .string()
    .trim()
    .max(64)
    .refine(isValidTimeZone, { message: 'timeZone must be an IANA zone' })
    .optional(),
});
export type ScriptPreviewRequest = z.infer<typeof ScriptPreviewRequestSchema>;

/** Body of a preset save. The name travels in the path, not the body. */
export const PresetSaveRequestSchema = z.object({
  task: z.string().trim().min(1).max(16_000),
});
export type PresetSaveRequest = z.infer<typeof PresetSaveRequestSchema>;

/** Body of "conference this number into the live call". */
export const AddParticipantRequestSchema = z.object({
  to: e164Schema('to'),
  /**
   * Operator's name for this person ("Dr. Levine's office"). Display only --
   * it never reaches the spoken notice or Grok's prompt as raw bytes without
   * passing through the same sanitiser the subject does.
   */
  label: z.string().trim().max(60).optional(),
  /**
   * How they are wired into the audio. Absent means 'barge' -- a normal,
   * speaking participant, which is what every caller got before this field
   * existed and so is the only default that leaves them unchanged.
   */
  supervisorRole: SupervisorRoleSchema.optional(),
});
export type AddParticipantRequest = z.infer<typeof AddParticipantRequestSchema>;

// --- Telnyx webhooks -------------------------------------------------------

/**
 * Telnyx V2 event envelope. Verified against
 * developers.telnyx.com/docs/development/api-fundamentals/webhooks/receiving-webhooks.md
 * and the call-control callback samples (2026-08-26):
 *   { data: { record_type, event_type, id, occurred_at, payload }, meta: {...} }
 *
 * `.passthrough()` on payload: Telnyx adds payload fields over time and an
 * unknown field must never fail a live call. Unknown TOP-LEVEL shape, however,
 * is rejected.
 */
export const TelnyxWebhookSchema = z.object({
  data: z.object({
    record_type: z.string().optional(),
    event_type: z.string(),
    id: z.string().optional(),
    occurred_at: z.string().optional(),
    payload: z
      .object({
        call_control_id: z.string().optional(),
        call_leg_id: z.string().optional(),
        call_session_id: z.string().optional(),
        connection_id: z.string().optional(),
        client_state: z.string().nullish(),
        from: z.string().optional(),
        to: z.string().optional(),
        /** "incoming" on legs Telnyx originated toward US; "outgoing" on legs we dialed. */
        direction: z.string().optional(),
        state: z.string().optional(),
        hangup_cause: z.string().optional(),
        hangup_source: z.string().optional(),
        /** Present on call.machine.detection.ended / .premium.detection.ended. */
        result: z.string().optional(),
        sip_headers: z.array(z.object({ name: z.string(), value: z.string() }).loose()).optional(),
        /** Present on call.recording.saved. */
        recording_id: z.string().optional(),
        format: z.enum(['wav', 'mp3']).optional(),
        channels: z.enum(['single', 'dual']).optional(),
        recording_started_at: z.string().optional(),
        recording_ended_at: z.string().optional(),
        recording_urls: z
          .object({ mp3: z.string().optional(), wav: z.string().optional() })
          .loose()
          .optional(),
        public_recording_urls: z
          .object({ mp3: z.string().optional(), wav: z.string().optional() })
          .loose()
          .optional(),
      })
      .loose(),
  }),
});
export type TelnyxWebhook = z.infer<typeof TelnyxWebhookSchema>;

// --- xAI webhooks ----------------------------------------------------------

/**
 * xAI incoming-call webhook. Shape verified verbatim against
 * docs.x.ai/developers/model-capabilities/audio/speech-to-speech/sip (2026-08-26).
 */
export const XaiWebhookSchema = z.object({
  object: z.string().optional(),
  id: z.string().optional(),
  type: z.string(),
  created_at: z.number().optional(),
  data: z
    .object({
      call_id: z.string().optional(),
      sip_headers: z.array(z.object({ name: z.string(), value: z.string() }).loose()).optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    })
    .loose()
    .optional(),
});
export type XaiWebhook = z.infer<typeof XaiWebhookSchema>;

/** Read a SIP header by case-insensitive name. */
export function sipHeader(
  headers: ReadonlyArray<{ name: string; value: string }> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const want = name.toLowerCase();
  for (const h of headers) {
    if (h.name.toLowerCase() === want) return h.value;
  }
  return undefined;
}

// --- client_state ----------------------------------------------------------

/**
 * Telnyx echoes `client_state` (base64) back on every subsequent webhook for a
 * leg. We use it as the primary correlation channel: no lookup table, no
 * eventual-consistency window, no race. Verified: "Use this field to add state
 * to every subsequent webhook. It must be a valid Base-64 encoded string."
 */
/**
 * Stable per-call id of one conference participant, e.g. "p0".
 *
 * WHY A SEPARATE ID AT ALL, when the webhook already carries a
 * `call_control_id`: the client_state is encoded BEFORE the dial, so at that
 * moment the leg has no id yet. Leg 'F' gets away with correlating on
 * call_control_id because only ONE forward leg is ever live; several
 * participants can be dialing at once, so an answer webhook that raced our own
 * dial response would have no roster row to land on and the participant would
 * silently never be joined. Minting the id first makes the row exist before the
 * first webhook can arrive.
 *
 * The pattern is deliberately narrow. `client_state` is echoed back by Telnyx
 * from bytes we set, and every webhook carrying it is Ed25519-verified -- but
 * this value is used to look up state and is written to logs, so it is bounded
 * at the boundary rather than trusted because of where it came from.
 */
export const PARTICIPANT_ID_RE = /^p(?:0|[1-9][0-9]{0,2})$/;

/**
 * Telnyx echoes `client_state` (base64) back on every subsequent webhook for a
 * leg. We use it as the primary correlation channel: no lookup table, no
 * eventual-consistency window, no race. Verified: "Use this field to add state
 * to every subsequent webhook. It must be a valid Base-64 encoded string."
 *
 * A DISCRIMINATED UNION, not a leg letter plus optional fields: making 'P'
 * carry its `pid` in the type is what forces every consumer to decide what a
 * participant webhook means. The alternative -- a fourth letter on the existing
 * union -- compiles fine and routes a participant's `call.answered` into
 * `leg_b_answered`, because that branch is written as `leg === 'A' ? ... : ...`.
 */
export type ClientState =
  | {
      /** Our correlation id == the Durable Object name. */
      readonly callId: string;
      /**
       * Which leg this webhook is about. 'A' is the human leg (outbound: the
       * person we dialed; inbound: the caller), 'B' the SIP leg into xAI, and
       * 'F' a follow-me forward leg dialed toward a human target.
       */
      readonly leg: 'A' | 'B' | 'F';
    }
  | {
      readonly callId: string;
      /** An escalation participant conferenced into a live call. */
      readonly leg: 'P';
      readonly pid: string;
    };

export function encodeClientState(state: ClientState): string {
  return btoa(JSON.stringify(state));
}

export function decodeClientState(raw: string | null | undefined): ClientState | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(atob(raw));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    const callId = obj['callId'];
    const leg = obj['leg'];
    if (typeof callId !== 'string' || callId.length === 0) return null;
    if (leg === 'P') {
      // A participant state without a usable pid is not a weaker participant
      // state, it is an unroutable one -- so it is rejected outright rather
      // than degraded to a bare 'P' that the reducer could not attribute.
      const pid = obj['pid'];
      if (typeof pid !== 'string' || !PARTICIPANT_ID_RE.test(pid)) return null;
      return { callId, leg, pid };
    }
    if (leg !== 'A' && leg !== 'B' && leg !== 'F') return null;
    return { callId, leg };
  } catch {
    return null;
  }
}

// --- Inbound call.initiated -------------------------------------------------

export interface InboundCallInitiated {
  /** Telnyx call_control_id of the caller's leg. */
  readonly callControlId: string;
  /** Caller's number as Telnyx reports it (E.164 for PSTN callers). */
  readonly from: string;
  /** The number they dialed — ours. */
  readonly to: string;
}

/**
 * Recognize a NEW inbound call among Telnyx webhooks.
 *
 * Every leg — including the ones WE dial — emits `call.initiated`, so the
 * event type alone is not a discriminator. Two properties separate a caller
 * dialing our number from our own outbound legs:
 *   1. `payload.direction === "incoming"` (our dials are "outgoing"), and
 *   2. no `client_state` (we attach state to every leg we originate; a caller
 *      cannot). The caller enforces (2) by only consulting this function on
 *      webhooks whose client_state failed to decode.
 * Returns null for anything that is not a routable new inbound call.
 */
export function inboundInitiated(
  eventType: string,
  payload: {
    readonly direction?: string | undefined;
    readonly call_control_id?: string | undefined;
    readonly from?: string | undefined;
    readonly to?: string | undefined;
  },
): InboundCallInitiated | null {
  if (eventType !== 'call.initiated') return null;
  if (payload.direction !== 'incoming') return null;
  if (!payload.call_control_id || !payload.from || !payload.to) return null;
  return { callControlId: payload.call_control_id, from: payload.from, to: payload.to };
}
