// The call state machine: a PURE reducer, `(state, event) -> {state, effects}`.
//
// Everything that talks to a network lives outside this file. That makes the
// hard part -- the ordering between "Telnyx says leg B answered" and "xAI says
// the session is configured" -- testable with no mocks and no I/O.
//
// IDEMPOTENCY IS A HARD REQUIREMENT, not a nicety. Telnyx documents that
// webhooks "can be concurrent, duplicated, delayed, or delivered out of order"
// and that a delivery is repeated when an ack is lost. So every transition
// below is written so that replaying the same event produces the same state and
// emits NO second effect. A duplicate `leg_a_answered` must not dial leg B
// twice -- that would place a second real phone call.

import {
  DEFAULT_RING_SECS,
  type InboundAction,
  type InboundConfig,
  nextInboundAction,
} from './inbound';
import type { RecordingAsset } from './recordings';
import {
  MAX_PARTICIPANT_ROWS,
  MAX_PARTICIPANTS,
  RECORDING_START_DTMF,
  type RecordingMode,
  type SupervisorRole,
} from './types';

/** Maximum transcript entries retained per call (bounds DO storage growth). */
export const MAX_TRANSCRIPT_ENTRIES = 500;
/** Bound DO storage if Telnyx redelivers a recording callback repeatedly. */
export const MAX_RECORDING_ASSETS = 4;

export type CallPhase =
  | 'created'
  | 'dialing_a'
  | 'a_answered'
  /** Inbound follow-me: ringing human forward targets before any AI. */
  | 'forwarding'
  | 'dialing_b'
  | 'connecting'
  | 'bridged'
  | 'completed'
  | 'failed';

export interface TranscriptEntry {
  readonly role: 'user' | 'assistant' | 'system';
  readonly text: string;
  readonly at: number;
}

/**
 * Where one escalation participant is in their own little lifecycle.
 *
 * 'queued' is a real state, not padding: participants supplied on the call
 * request cannot be dialed until the conference exists, and rendering them as
 * 'dialing' before a single packet has left would be a lie the console draws.
 *
 * 'left' and 'failed' rows are NEVER removed from the roster. They are what the
 * cost model meters (answeredAt -> leftAt) and what the archive records about
 * who was actually on the call, so deleting them would delete the evidence.
 */
export type ParticipantStatus = 'queued' | 'dialing' | 'joined' | 'left' | 'failed';

/** One human conferenced into a live call alongside the subject and the AI. */
export interface Participant {
  /**
   * Stable per-call id ("p0", "p1"). Minted BEFORE the dial and carried in the
   * leg's client_state, which is what lets an answer webhook that races our own
   * dial response still find its row. See PARTICIPANT_ID_RE in src/types.ts.
   *
   * Derived from `participants.length` at append time, which is unique for the
   * life of a call precisely BECAUSE rows are never removed.
   */
  readonly pid: string;
  /** E.164 number dialed. */
  readonly to: string;
  /** Operator's name for this person, or null. Display only. */
  readonly label: string | null;
  /** Telnyx call_control_id, once the dial has returned one. */
  readonly legId: string | null;
  readonly status: ParticipantStatus;
  /**
   * When the LEG was answered -- the instant a carrier starts metering, and so
   * the one the cost model bills from. Deliberately not `joinedAt`: the
   * conference join lands a beat later, and billing from it would understate
   * every participant by that gap.
   */
  readonly answeredAt: number | null;
  /** When Telnyx confirmed the conference join. Display, not billing. */
  readonly joinedAt: number | null;
  /** When they left. Billable end; null means "still on, meter to call end". */
  readonly leftAt: number | null;
  readonly muted: boolean;
  /**
   * On hold: they hear the conference's hold audio and nobody hears them.
   *
   * Tracked SEPARATELY from `muted` because the two are independent commands
   * with different effects on what this person can hear -- a muted participant
   * still follows the conversation, a held one does not -- and Telnyx will
   * happily have both set at once. Collapsing them into one flag would make
   * "unmute" silently take somebody off hold.
   */
  readonly held: boolean;
  /**
   * How they are wired into the audio, as ACTUALLY JOINED rather than as
   * requested. 'whisper' is downgraded to 'monitor' at join time when there is
   * nobody to whisper to, and this field records the downgrade so the roster
   * and the archive report the role the call really had.
   */
  readonly supervisorRole: SupervisorRole;
}

export interface CallState {
  readonly callId: string;
  readonly phase: CallPhase;
  /** The HUMAN leg's remote number: outbound = who we dialed; inbound = the caller. */
  readonly to: string;
  readonly task: string;
  /**
   * Operator's name for this call, or null. Carried purely so the archive can
   * store it; it is never sent to Grok and never affects the prompt.
   */
  readonly subject: string | null;
  /** Which way the human leg was originated. Everything after leg A is shared. */
  readonly direction: 'outbound' | 'inbound';
  /** Inbound routing: allowlisted caller straight to the AI, or follow-me. */
  readonly inboundMode: 'direct' | 'follow_me' | null;
  /** OUR number (what the caller dialed). The follow-me loop guard. */
  readonly ownNumber: string | null;
  /** Follow-me targets in priority order, raw from env (usableTargets validates). */
  readonly forwardTargets: readonly string[];
  /** Seconds each forward target rings before the ladder advances. */
  readonly ringSecs: number;
  /** Forward attempts already resolved (answered-by-machine, rang out, failed). */
  readonly forwardAttempted: number;
  /** Whether the CURRENT forward leg was answered by something. */
  readonly forwardAnswered: boolean;
  /** AMD verdict for the CURRENT forward leg — what separates a live human from their voicemail. */
  readonly forwardAmd: string | null;
  /** Telnyx call_control_id of the CURRENT forward leg, if one is up. */
  readonly legF: string | null;
  /** Why the AI took over instead of a human (see AiFallbackReason). */
  readonly inboundFallbackReason: string | null;
  /** Busy geometry for availability. Numbers/booleans only — see BusyInput. */
  readonly busy: readonly { startMs: number; endMs: number; remote: boolean }[];
  /** How many days ahead to offer slots. */
  readonly windowDays: number;
  /** cal.com bookable start times, epoch ms. Preferred over `busy` windows. */
  readonly slots: readonly number[];
  /** Appointment length for `slots`. */
  readonly slotMinutes: number;
  /**
   * True when this call was set up WITH calendar data that was discarded as
   * too stale to trust, so `busy`/`slots` being empty means "unknown" rather
   * than "nothing booked". Only the deferred-call fire path sets it.
   */
  readonly availabilityUnknown: boolean;
  readonly voice: string;
  readonly amd: string | null;
  /** Telnyx call_control_id for the human leg. */
  readonly legA: string | null;
  /** Telnyx call_control_id for the SIP leg into xAI. */
  readonly legB: string | null;
  /** xAI's own call id, from the realtime.call.incoming webhook. */
  readonly xaiCallId: string | null;
  readonly legBAnswered: boolean;
  readonly xaiSessionReady: boolean;
  readonly bridgeRequested: boolean;
  readonly amdResult: string | null;
  readonly failureReason: string | null;
  readonly createdAt: number;
  /**
   * When the HUMAN leg was answered, epoch ms, or null if it never was.
   *
   * NOT the same as createdAt, and the difference is money: carriers bill from
   * ANSWER, while createdAt is when we started dialing. On a two-minute call a
   * twenty-second ring is a ~17% overstatement, and a call that rang out and was
   * never picked up would otherwise be costed as though it had connected.
   */
  readonly answeredAt: number | null;
  readonly updatedAt: number;
  readonly transcript: readonly TranscriptEntry[];
  /** Verified provider URLs retained for server-side, proxied playback. */
  readonly recordings: readonly RecordingAsset[];
  /** When this call records. `on_demand` waits for the operator's keypress. */
  readonly recordingMode: RecordingMode;
  /** Whether the spoken join notice plays. Independent of recordingMode. */
  readonly noticeEnabled: boolean;
  /**
   * Whether a record_start has already been ISSUED for this call.
   *
   * Not "is Telnyx recording" -- we never get told that directly. It exists to
   * make the keypress idempotent: a handset repeats a held digit, and each
   * repeat is its own webhook, so without this a leaning thumb issues N
   * record_start commands and bills for N recordings of one call.
   */
  readonly recordingStarted: boolean;
  /**
   * Telnyx conference id once one exists, else null.
   *
   * A conference REPLACES the two-leg bridge for the AI path. It is not an
   * upgrade for its own sake: `POST /calls/{id}/actions/bridge` joins exactly
   * two legs, so a third party could not be added at all. The follow-me path
   * (leg A to a human forward leg, no AI) still bridges, because two legs is
   * genuinely all it needs.
   */
  readonly conferenceId: string | null;
  /** Escalation participants, oldest first. Rows are appended, never removed. */
  readonly participants: readonly Participant[];
}

export type CallEvent =
  | { readonly type: 'leg_a_dialed'; readonly legA: string; readonly at: number }
  | { readonly type: 'leg_a_answered'; readonly at: number }
  | { readonly type: 'amd_result'; readonly result: string; readonly at: number }
  | { readonly type: 'leg_b_dialed'; readonly legB: string; readonly at: number }
  | { readonly type: 'leg_b_answered'; readonly at: number }
  | { readonly type: 'xai_incoming'; readonly xaiCallId: string; readonly at: number }
  | { readonly type: 'xai_session_ready'; readonly at: number }
  | { readonly type: 'bridge_confirmed'; readonly at: number }
  /**
   * The answered-to-bridged window ran out. Fired by a timer armed the moment
   * leg A answers -- see `arm_connect_deadline`. This is the ONLY thing that
   * bounds the interval in which a live human is on the line hearing nothing.
   */
  | { readonly type: 'connect_deadline'; readonly at: number }
  | {
      readonly type: 'hangup';
      readonly leg: 'A' | 'B';
      readonly cause: string | null;
      readonly at: number;
    }
  | { readonly type: 'forward_dialed'; readonly legF: string; readonly at: number }
  | { readonly type: 'forward_answered'; readonly legF: string; readonly at: number }
  | {
      readonly type: 'forward_amd';
      readonly legF: string;
      readonly result: string;
      readonly at: number;
    }
  | {
      readonly type: 'forward_hangup';
      readonly legF: string;
      readonly cause: string | null;
      readonly at: number;
    }
  /** The Telnyx dial API itself failed; the forward target never rang. */
  | { readonly type: 'forward_dial_failed'; readonly at: number }
  /** POST /conferences returned; the conference exists and legs can join it. */
  | { readonly type: 'conference_created'; readonly conferenceId: string; readonly at: number }
  /** An operator asked for this number to be conferenced in. */
  | {
      readonly type: 'participant_requested';
      readonly to: string;
      readonly label: string | null;
      /** How they should be wired in. 'barge' is a normal speaking participant. */
      readonly supervisorRole: SupervisorRole;
      readonly at: number;
    }
  | {
      readonly type: 'participant_dialed';
      readonly pid: string;
      readonly legId: string;
      readonly at: number;
    }
  /** The participant's LEG was answered. Billing starts here, not at join. */
  | { readonly type: 'participant_answered'; readonly pid: string; readonly at: number }
  /** Telnyx confirmed the conference join (conference.participant.joined). */
  | { readonly type: 'participant_joined'; readonly pid: string; readonly at: number }
  /** conference.participant.left -- they are out of the conference. */
  | { readonly type: 'participant_left'; readonly pid: string; readonly at: number }
  /**
   * The participant's LEG hung up. Deliberately its own event and NOT the
   * `hangup` event: `hangup` completes the whole call, and an escalation
   * participant putting the phone down must never end the subject's call.
   */
  | {
      readonly type: 'participant_hangup';
      readonly pid: string;
      readonly cause: string | null;
      readonly at: number;
    }
  /** The Telnyx dial API itself failed; this participant never rang. */
  | { readonly type: 'participant_dial_failed'; readonly pid: string; readonly at: number }
  | { readonly type: 'participant_drop_requested'; readonly pid: string; readonly at: number }
  | {
      readonly type: 'participant_mute_requested';
      readonly pid: string;
      readonly muted: boolean;
      readonly at: number;
    }
  | {
      readonly type: 'participant_hold_requested';
      readonly pid: string;
      readonly held: boolean;
      readonly at: number;
    }
  | { readonly type: 'failed'; readonly reason: string; readonly at: number }
  | { readonly type: 'recording_saved'; readonly asset: RecordingAsset; readonly at: number }
  /**
   * A key pressed on a handset, delivered by Telnyx's `call.dtmf.received`.
   *
   * `leg` is carried because WHO pressed it decides whether it counts: only
   * the leg we dialed controls recording. A participant conferenced in later
   * must not be able to start recording the person who invited them.
   */
  | {
      readonly type: 'dtmf_received';
      readonly digit: string;
      readonly leg: 'A' | 'B' | 'F' | 'P';
      readonly at: number;
    }
  | {
      readonly type: 'transcript';
      readonly role: TranscriptEntry['role'];
      readonly text: string;
      readonly at: number;
    };

export type CallEffect =
  | { readonly type: 'dial_leg_b' }
  /**
   * Start the clock on the answered-to-bridged window.
   *
   * MUST be emitted by every path that emits `dial_leg_b`. From the instant
   * leg A answers, a real person is holding a live phone, and until the
   * conference exists there is no media path for them to hear anything. That
   * window depends on FOUR external events we do not control -- xAI's
   * incoming-call webhook, xAI's `session.updated`, Telnyx's leg-B answer, and
   * Telnyx's conference create. Any one of them going missing used to leave
   * the human in silence for the rest of the call, archived as a clean
   * `completed` with no failureReason. Measured 2026-08-31 on call
   * 102dec69: `session.updated` never arrived, the reducer sat in `connecting`
   * for 11.6s, and the caller hung up on dead air.
   */
  | { readonly type: 'arm_connect_deadline' }
  | { readonly type: 'open_xai_ws'; readonly xaiCallId: string }
  /**
   * Something that feeds the system prompt changed AFTER the session was
   * already configured (in practice: answering-machine detection landed late).
   * The DO rebuilds `instructions` and re-sends session.update.
   */
  | { readonly type: 'refresh_instructions' }
  | { readonly type: 'teardown'; readonly reason: string }
  /** Ring the next follow-me target (AMD on, bounded ring). */
  | {
      readonly type: 'dial_forward';
      readonly to: string;
      readonly index: number;
      readonly timeoutSecs: number;
    }
  /** Hang up an abandoned forward leg (answered by voicemail) without ending the call. */
  | { readonly type: 'hangup_forward'; readonly legF: string }
  | { readonly type: 'start_monitor' }
  | { readonly type: 'start_recording' }
  /**
   * Copy a newly saved recording's bytes into durable storage. Telnyx hands us
   * a SIGNED, short-lived URL; once it expires the audio is unreachable, so
   * this is a data-loss fix rather than a convenience. Emitted only on the
   * first delivery of a given asset — the duplicate guard below returns before
   * reaching it — so a redelivered webhook never re-downloads the audio.
   */
  | { readonly type: 'archive_recording'; readonly asset: RecordingAsset }
  /**
   * Create the conference FROM THE OTHER LEG, then join leg A to it.
   *
   * *** THIS ORDER IS THE LOAD-BEARING DESIGN DECISION. DO NOT SWAP IT. ***
   *
   * `end_conference_on_exit` exists ONLY on the join command -- POST
   * /conferences has no such parameter (verified against Telnyx's own OpenAPI
   * spec, 2026-08-30; the create body is call_control_id, name, beep_enabled,
   * client_state, command_id, comfort_noise, duration_minutes, hold_audio_url,
   * hold_media_name, max_participants, start_conference_on_create, region).
   * The creator therefore CANNOT carry that flag.
   *
   * What the flag has to reproduce is the old bridge's behaviour: `bridge` was
   * issued without `park_after_unbridge`, so when the human on leg A hung up
   * Telnyx tore down the far side too. Creating from the OTHER leg and joining
   * leg A with `end_conference_on_exit: true` gets that back carrier-side --
   * leg A hanging up ends the conference and hangs up every remaining leg.
   *
   * Create from leg A instead and the flag is unreachable, so a leg-A hangup
   * would leave the far leg and every escalation participant PARKED AND STILL
   * BILLING, with nothing but our own teardown between that and an open-ended
   * charge. The DO teardown still runs as belt-and-braces; this is the primary.
   *
   * WHICH leg creates depends on the path, and BOTH obey the same rule -- the
   * creator is whichever leg is not the one whose hangup ends the call:
   *   'B' -- the xAI SIP leg, on every call that reaches the AI.
   *   'F' -- the answered follow-me forward leg, on an inbound call handed to a
   *          live human with no AI on it at all.
   * The leg letter travels with the effect because the executor has to encode
   * it into the creator's client_state, and deriving it by comparing the id
   * against state.legB / state.legF would silently pick the wrong letter the
   * first time a call has both.
   */
  | { readonly type: 'create_conference'; readonly legId: string; readonly leg: 'B' | 'F' }
  | {
      readonly type: 'join_conference';
      readonly conferenceId: string;
      readonly legId: string;
      /**
       * True ONLY for leg A -- the subject, whose hangup ends the call for
       * everyone. False for escalation participants: a supervisor putting the
       * phone down must leave the subject and the AI still talking.
       */
      readonly endConferenceOnExit: boolean;
      /** Roster id when this is a participant, null for leg A. */
      readonly pid: string | null;
      /**
       * Wire value for `supervisor_role`, or null to omit the field entirely.
       * Null for leg A: the subject is the call, not a supervisor of it.
       */
      readonly supervisorRole: SupervisorRole | null;
      /**
       * Legs a 'whisper' supervisor may be heard by. ALWAYS empty for every
       * other role, and never empty for 'whisper' -- the reducer resolves a
       * whisper with no target to 'monitor' before emitting this, because
       * Telnyx treats an absent list as a silent downgrade to monitor-only.
       */
      readonly whisperLegIds: readonly string[];
    }
  | { readonly type: 'dial_participant'; readonly pid: string; readonly to: string }
  /**
   * Remove a participant by HANGING UP their leg.
   *
   * Not `POST /conferences/{id}/actions/leave`: Telnyx documents leave as
   * "Removes a call leg from a conference and moves it back to PARKED state" --
   * the leg stays up and keeps billing, with nobody listening to it. Dropping
   * someone has to end their call, not silently orphan it.
   */
  | { readonly type: 'drop_participant'; readonly pid: string; readonly legId: string }
  | {
      readonly type: 'set_participant_mute';
      readonly conferenceId: string;
      readonly legId: string;
      readonly muted: boolean;
    }
  /**
   * Put ONE participant on hold, or take them off it.
   *
   * Carries the leg id for the same reason mute does, and it matters more here:
   * Telnyx reads an EMPTY `call_control_ids` on `hold` as "all participants",
   * so a hold that lost its leg id would freeze the subject and the AI too.
   * Making the id part of the effect means a hold with nobody to hold cannot
   * be represented at all.
   */
  | {
      readonly type: 'set_participant_hold';
      readonly conferenceId: string;
      readonly legId: string;
      readonly held: boolean;
    }
  | { readonly type: 'end_conference'; readonly conferenceId: string }
  /**
   * Speak the join notice to EVERY participant. The DO owns the wording; the
   * reducer only says who joined, because the spoken text is fixed policy and
   * fixed text has one owner (see src/instructions.ts).
   */
  | { readonly type: 'announce_participant'; readonly conferenceId: string; readonly pid: string }
  /**
   * Say that recording has begun.
   *
   * `toEveryone` is the consent/feedback split. With the notice ENABLED this
   * is a disclosure and everyone on the call hears it. With the notice
   * DISABLED the operator still asked for confirmation, so it is played back
   * to their leg alone -- they learn the keypress landed without it becoming
   * an announcement they explicitly turned off.
   */
  | {
      readonly type: 'announce_recording';
      readonly conferenceId: string;
      readonly toEveryone: boolean;
    };

export interface ReduceResult {
  readonly state: CallState;
  readonly effects: readonly CallEffect[];
}

const TERMINAL: ReadonlySet<CallPhase> = new Set<CallPhase>(['completed', 'failed']);

/**
 * The effects that fire when media comes up.
 *
 * A FUNCTION, not a constant, because recording is now conditional and there
 * are TWO call sites that start media (the bridged path and the leg-B dial
 * path). A constant would have to be gated at each of them, and the second
 * one is exactly the site a future reader forgets -- the bug would be a call
 * that records when the operator set `on_demand`, which nothing in the
 * response would reveal.
 */
function startMediaEffects(recordingMode: RecordingMode): readonly CallEffect[] {
  const effects: CallEffect[] = [{ type: 'start_monitor' }];
  if (recordingMode === 'auto') effects.push({ type: 'start_recording' });
  return effects;
}

export function isTerminal(phase: CallPhase): boolean {
  return TERMINAL.has(phase);
}

/**
 * Mint the roster row for one participant.
 *
 * `pid` comes from the CURRENT length, which is unique for the life of the call
 * because rows are only ever appended. Using a count of ACTIVE participants
 * would collide the moment someone leaves and someone else is added.
 */
function queuedParticipant(
  index: number,
  to: string,
  label: string | null,
  supervisorRole: SupervisorRole,
): Participant {
  return {
    pid: `p${index}`,
    to,
    label,
    legId: null,
    status: 'queued',
    answeredAt: null,
    joinedAt: null,
    leftAt: null,
    muted: false,
    held: false,
    supervisorRole,
  };
}

export function initialState(params: {
  callId: string;
  to: string;
  task: string;
  subject?: string | null | undefined;
  busy?: readonly { startMs: number; endMs: number; remote: boolean }[];
  windowDays?: number;
  slots?: readonly number[];
  slotMinutes?: number;
  availabilityUnknown?: boolean;
  voice: string;
  amd: string | null;
  recordingMode?: RecordingMode | undefined;
  noticeEnabled?: boolean | undefined;
  /** Numbers to conference in once the call connects. Queued, not yet dialed. */
  participants?: readonly string[];
  now: number;
}): CallState {
  return {
    callId: params.callId,
    phase: 'created',
    to: params.to,
    task: params.task,
    subject: params.subject ?? null,
    busy: params.busy ?? [],
    windowDays: params.windowDays ?? 7,
    slots: params.slots ?? [],
    slotMinutes: params.slotMinutes ?? 30,
    availabilityUnknown: params.availabilityUnknown ?? false,
    voice: params.voice,
    amd: params.amd,
    direction: 'outbound',
    inboundMode: null,
    ownNumber: null,
    forwardTargets: [],
    ringSecs: DEFAULT_RING_SECS,
    forwardAttempted: 0,
    forwardAnswered: false,
    forwardAmd: null,
    legF: null,
    inboundFallbackReason: null,
    legA: null,
    legB: null,
    xaiCallId: null,
    legBAnswered: false,
    xaiSessionReady: false,
    bridgeRequested: false,
    amdResult: null,
    failureReason: null,
    createdAt: params.now,
    answeredAt: null,
    updatedAt: params.now,
    transcript: [],
    recordings: [],
    // on_demand by default: see RECORDING_MODES. A caller that wants the old
    // always-record behaviour asks for it explicitly.
    recordingMode: params.recordingMode ?? 'on_demand',
    noticeEnabled: params.noticeEnabled ?? true,
    recordingStarted: false,
    conferenceId: null,
    // Start-of-call participants are always 'barge'. The call request carries
    // bare numbers, so there is no role to carry -- and a number the operator
    // typed into "conference these people in" means a person who can speak.
    participants: (params.participants ?? []).map((to, index) =>
      queuedParticipant(index, to, null, 'barge'),
    ),
  };
}

/**
 * Initial state for an INBOUND call. The caller's leg is leg A, already up
 * (Telnyx originated it toward us), so `legA` is set from birth and there is
 * no `leg_a_dialed` event — the first event is `leg_a_answered`, confirming
 * our answer command took.
 */
export function initialInboundState(params: {
  callId: string;
  /** The caller's number — the human on leg A. */
  caller: string;
  /** The number they dialed: ours. Feeds the follow-me loop guard. */
  ownNumber: string;
  /** Telnyx call_control_id of the caller's leg. */
  legA: string;
  mode: 'direct' | 'follow_me';
  forwardTargets: readonly string[];
  ringSecs: number;
  task: string;
  subject?: string | null | undefined;
  voice: string;
  now: number;
}): CallState {
  return {
    ...initialState({
      callId: params.callId,
      to: params.caller,
      task: params.task,
      subject: params.subject ?? null,
      voice: params.voice,
      amd: null,
      now: params.now,
    }),
    direction: 'inbound',
    inboundMode: params.mode,
    ownNumber: params.ownNumber,
    forwardTargets: params.forwardTargets,
    ringSecs: params.ringSecs,
    legA: params.legA,
  };
}

function inboundCfg(state: CallState): InboundConfig {
  return {
    forwardTargets: state.forwardTargets,
    ringSecs: state.ringSecs,
    // '' never matches an E.164 target, so a missing ownNumber merely skips
    // the self-forward exclusion instead of breaking the ladder.
    ownNumber: state.ownNumber ?? '',
  };
}

/**
 * Turn one InboundAction from the pure follow-me core into a transition.
 * `hangupLegF` names a forward leg that is still up and must be torn down
 * before whatever comes next — the answered-by-voicemail case.
 */
function applyInboundAction(
  state: CallState,
  action: InboundAction,
  opts: { attemptedNow: number; hangupLegF: string | null },
): ReduceResult {
  const pre: CallEffect[] = opts.hangupLegF
    ? [{ type: 'hangup_forward', legF: opts.hangupLegF }]
    : [];
  // Per-attempt fields reset for everything except a bridge, which keeps the
  // just-tried leg because that leg IS the call now.
  const cleared: CallState = {
    ...state,
    forwardAttempted: opts.attemptedNow,
    legF: null,
    forwardAnswered: false,
    forwardAmd: null,
  };
  switch (action.kind) {
    case 'ring':
      return {
        state: { ...cleared, phase: 'forwarding' },
        effects: [
          ...pre,
          {
            type: 'dial_forward',
            to: action.to,
            index: action.index,
            timeoutSecs: action.timeoutSecs,
          },
        ],
      };
    case 'bridge_human': {
      if (!state.legA || !state.legF) return { state, effects: [] };
      // A CONFERENCE, not a two-leg bridge, and created FROM LEG F.
      //
      // The old `POST /calls/{legA}/actions/bridge` joined exactly two legs, so
      // an operator could not add anyone to a forwarded call at all -- the same
      // ceiling that made the AI path a conference. The creator is leg F for the
      // same reason it is leg B there and it is the same rule, not a second one:
      // `end_conference_on_exit` exists only on `join`, and the leg that must
      // carry it is the CALLER (leg A), whose hangup has to end the call for
      // everyone. A creator cannot carry the flag, so the caller cannot create.
      //
      // Leg F is therefore the creator and joins WITHOUT the flag. The forward
      // human hanging up no longer tears the call down carrier-side, so the
      // `forward_hangup` branch below still emits `teardown` when
      // `bridgeRequested` -- that is what preserves today's behaviour, and the
      // inbound-flow tests assert both directions.
      return {
        state: { ...state, forwardAttempted: opts.attemptedNow, bridgeRequested: true },
        effects: [{ type: 'create_conference', legId: state.legF, leg: 'F' }],
      };
    }
    case 'ai_fallback':
      return {
        state: { ...cleared, phase: 'dialing_b', inboundFallbackReason: action.reason },
        // The deadline is armed HERE too, not only on the outbound path. The
        // caller has been on the line through the whole follow-me ladder; from
        // the moment we give up on humans and dial xAI they are in exactly the
        // window that stranded call 102dec69, and the clock starts now rather
        // than at answer so the ladder's own ringing does not eat the budget.
        effects: [...pre, { type: 'dial_leg_b' }, { type: 'arm_connect_deadline' }],
      };
    case 'reject':
      return {
        state: { ...cleared, phase: 'failed', failureReason: `inbound_reject: ${action.reason}` },
        effects: [...pre, { type: 'teardown', reason: action.reason }],
      };
    default: {
      const _never: never = action;
      return { state, effects: [] };
    }
  }
}

/**
 * Decide the current forward attempt once BOTH facts are in: the leg was
 * answered AND AMD has ruled on what answered it. Deciding on answer alone is
 * the bug this whole flow exists to prevent — a dead phone's voicemail
 * "answers" and the caller would be bridged into a beep.
 */
function maybeDecideForward(state: CallState): ReduceResult {
  if (!state.forwardAnswered || state.forwardAmd === null) return { state, effects: [] };
  const attemptedNow = state.forwardAttempted + 1;
  const action = nextInboundAction(inboundCfg(state), {
    attempted: attemptedNow,
    answered: true,
    amdResult: state.forwardAmd,
  });
  // Any non-bridge outcome abandons the current leg, so it gets hung up.
  const hangupLegF = action.kind === 'bridge_human' ? null : state.legF;
  return applyInboundAction(state, action, { attemptedNow, hangupLegF });
}

/** Find one roster row, or null. */
export function findParticipant(state: CallState, pid: string): Participant | null {
  return state.participants.find((participant) => participant.pid === pid) ?? null;
}

/** One roster row as every read surface renders it. */
export interface ParticipantView {
  readonly pid: string;
  readonly legId: string | null;
  readonly to: string;
  readonly label: string | null;
  readonly status: ParticipantStatus;
  /** Billable start. Carried on the wire so ONE place meters participants. */
  readonly answeredAt: number | null;
  readonly joinedAt: number | null;
  readonly leftAt: number | null;
  readonly muted: boolean;
  readonly held: boolean;
  readonly supervisorRole: SupervisorRole;
}

/**
 * Project one participant for the wire -- the SINGLE definition, shared by the
 * live Durable Object status and the archived-call view.
 *
 * Written once rather than inline at each surface because this codebase has
 * already paid for the alternative: four hand-written projections of one call
 * disagreed, and the console showed two different costs for the same call. The
 * same failure here would be a console whose live roster and archived roster
 * describe different people.
 *
 * `answeredAt` IS here even though nothing renders it, because the cost model
 * has to meter a LIVE participant against "now" and an ARCHIVED one against the
 * call's end -- two different denominators. Carrying the raw instants keeps
 * that decision in one function (`participantBillableMs`) instead of making the
 * Durable Object precompute a number against its own clock and the archive
 * precompute another against its own.
 */
export function participantView(participant: Participant): ParticipantView {
  return {
    pid: participant.pid,
    legId: participant.legId,
    to: participant.to,
    label: participant.label,
    status: participant.status,
    answeredAt: participant.answeredAt,
    joinedAt: participant.joinedAt,
    leftAt: participant.leftAt,
    muted: participant.muted,
    held: participant.held,
    supervisorRole: participant.supervisorRole,
  };
}

/**
 * Replace one roster row. Returns the unchanged state when `pid` names no row,
 * which is the right answer for a webhook about a participant this call does
 * not have -- a stale redelivery, or a leg from a call that has been reset.
 */
function withParticipant(
  state: CallState,
  pid: string,
  patch: (participant: Participant) => Participant,
): CallState {
  let found = false;
  const participants = state.participants.map((participant) => {
    if (participant.pid !== pid) return participant;
    found = true;
    return patch(participant);
  });
  return found ? { ...state, participants } : state;
}

/** Statuses that occupy a seat against MAX_PARTICIPANTS. */
const ACTIVE_PARTICIPANT: ReadonlySet<ParticipantStatus> = new Set<ParticipantStatus>([
  'queued',
  'dialing',
  'joined',
]);

/** How many participants currently hold a seat on this call. */
export function activeParticipantCount(state: CallState): number {
  return state.participants.filter((participant) => ACTIVE_PARTICIPANT.has(participant.status))
    .length;
}

/**
 * Mark a participant gone, exactly once.
 *
 * `leftAt` is stamped on the FIRST terminal signal and never moved, because two
 * different Telnyx events report the same departure -- `call.hangup` on the leg
 * and `conference.participant.left` -- and whichever arrives second must not
 * stretch the billable window.
 */
function endParticipant(
  state: CallState,
  pid: string,
  status: 'left' | 'failed',
  at: number,
): CallState {
  return withParticipant(state, pid, (participant) => {
    if (participant.status === 'left' || participant.status === 'failed') return participant;
    return { ...participant, status, leftAt: participant.leftAt ?? at };
  });
}

/**
 * Resolve a requested role into the exact pair of wire values `join` needs.
 *
 * The downgrade is the point. Telnyx: "Array of unique call_control_ids the
 * joining supervisor can whisper to. If none provided, the supervisor will join
 * the conference as a monitoring participant only." So a 'whisper' with an
 * empty target list is NOT a whisper -- it is a monitor, silently. Resolving it
 * here means the roster, the archive, and the console all report the role the
 * participant actually got, instead of a label the call never honoured.
 *
 * A whisper is heard by LEG A ONLY -- the human on the other end of the call.
 * That is the only target that makes a private channel: whispering to leg B
 * would be speaking to the AI, which would then answer out loud to everyone.
 */
function joinRole(
  state: CallState,
  role: SupervisorRole,
): { readonly supervisorRole: SupervisorRole; readonly whisperLegIds: readonly string[] } {
  if (role !== 'whisper') return { supervisorRole: role, whisperLegIds: [] };
  const legA = state.legA;
  if (!legA) return { supervisorRole: 'monitor', whisperLegIds: [] };
  return { supervisorRole: 'whisper', whisperLegIds: [legA] };
}

/**
 * Start the conference exactly once, and only when BOTH preconditions hold:
 *   - Telnyx has told us leg B is answered (media path exists), and
 *   - the xAI realtime session is configured (session.update + response.create sent).
 *
 * Connecting before the session is configured would join the human to a silent
 * leg; connecting before leg B answers has nothing to conference with.
 *
 * The effect is `create_conference` on LEG B and not a two-party bridge -- see
 * the long comment on that effect for why the leg it is created FROM is the
 * load-bearing part.
 */
function maybeConnect(state: CallState): ReduceResult {
  if (state.bridgeRequested) return { state, effects: [] };
  if (!state.legBAnswered || !state.xaiSessionReady) return { state, effects: [] };
  if (!state.legA || !state.legB) return { state, effects: [] };
  return {
    state: { ...state, bridgeRequested: true },
    effects: [{ type: 'create_conference', legId: state.legB, leg: 'B' }],
  };
}

export function reduce(prev: CallState, event: CallEvent): ReduceResult {
  // Once terminal, absorb everything. A late duplicate hangup or a trailing
  // transcript event must not resurrect a finished call. xAI can deliver a
  // final transcript after the hangup webhook, and Telnyx may save a recording
  // after the call has become terminal, so both are deliberate exceptions.
  if (isTerminal(prev.phase) && event.type !== 'recording_saved' && event.type !== 'transcript') {
    return { state: prev, effects: [] };
  }

  const state: CallState = { ...prev, updatedAt: event.at };

  switch (event.type) {
    case 'leg_a_dialed': {
      if (prev.legA) return { state: prev, effects: [] }; // duplicate
      return { state: { ...state, legA: event.legA, phase: 'dialing_a' }, effects: [] };
    }

    case 'leg_a_answered': {
      // Stamp the billable start ONCE. Telnyx documents that webhooks can be
      // duplicated and delivered out of order, so a redelivered answer must not
      // move the instant the meter started; first answer wins.
      const answered: CallState =
        prev.answeredAt === null ? { ...state, answeredAt: event.at } : state;
      // Inbound follow-me: the caller is live — start ringing humans, not xAI.
      // ('direct' mode falls through below and reuses the leg-B machinery.)
      if (prev.direction === 'inbound' && prev.inboundMode === 'follow_me') {
        if (prev.phase !== 'created') return { state: answered, effects: [] }; // duplicate
        const result = applyInboundAction(
          answered,
          nextInboundAction(inboundCfg(prev), { attempted: 0 }),
          {
            attemptedNow: 0,
            hangupLegF: null,
          },
        );
        return {
          ...result,
          effects: [...startMediaEffects(prev.recordingMode), ...result.effects],
        };
      }
      // Guard on legB, not on phase: a duplicate answer webhook after we have
      // already dialed must not dial a second SIP leg.
      if (prev.legB || prev.phase === 'dialing_b' || prev.phase === 'connecting') {
        return { state: answered, effects: [] };
      }
      return {
        state: { ...answered, phase: 'dialing_b' },
        effects: [
          ...startMediaEffects(prev.recordingMode),
          { type: 'dial_leg_b' },
          // Paired with dial_leg_b, never emitted apart from it: this is the
          // moment a live human starts waiting to hear something.
          { type: 'arm_connect_deadline' },
        ],
      };
    }

    case 'amd_result': {
      if (prev.amdResult === event.result) return { state, effects: [] };
      const next = { ...state, amdResult: event.result };
      // Telnyx often reports AMD a beat AFTER we have already configured the
      // xAI session. If the session is live, push the revised prompt.
      return {
        state: next,
        effects: prev.xaiSessionReady ? [{ type: 'refresh_instructions' as const }] : [],
      };
    }

    case 'leg_b_dialed': {
      if (prev.legB) return { state: prev, effects: [] };
      return { state: { ...state, legB: event.legB, phase: 'connecting' }, effects: [] };
    }

    case 'leg_b_answered': {
      if (prev.legBAnswered) return { state, effects: [] };
      return maybeConnect({ ...state, legBAnswered: true, phase: 'connecting' });
    }

    case 'xai_incoming': {
      if (prev.xaiCallId) return { state, effects: [] }; // already claimed
      return {
        state: { ...state, xaiCallId: event.xaiCallId, phase: 'connecting' },
        effects: [{ type: 'open_xai_ws', xaiCallId: event.xaiCallId }],
      };
    }

    case 'xai_session_ready': {
      if (prev.xaiSessionReady) return { state, effects: [] };
      return maybeConnect({ ...state, xaiSessionReady: true });
    }

    case 'bridge_confirmed': {
      // call.bridged fires for BOTH legs; the second one is a no-op.
      if (prev.phase === 'bridged') return { state, effects: [] };
      return { state: { ...state, phase: 'bridged' }, effects: [] };
    }

    case 'connect_deadline': {
      // The happy path wins the race: once the media exists this is a no-op,
      // and it must stay one -- a late timer must never cut a live call.
      // `bridgeRequested` (not `phase === 'bridged'`) is the guard because the
      // conference is created a beat before Telnyx confirms the bridge, and a
      // deadline landing in that gap would kill a call that is about to work.
      if (prev.bridgeRequested || prev.phase === 'bridged') return { state: prev, effects: [] };
      // Terminal phases were already absorbed at the top of reduce().
      //
      // The phase is carried into the reason because it names WHICH external
      // party went missing: 'dialing_b' = Telnyx never answered leg B,
      // 'connecting' = the SIP leg is up but xAI never completed the session
      // handshake. Without it the operator sees a timeout and cannot tell a
      // carrier problem from a model-provider problem.
      const reason = `connect_timeout:${prev.phase}`;
      return {
        state: { ...state, phase: 'failed', failureReason: reason },
        effects: [{ type: 'teardown', reason }],
      };
    }

    case 'forward_dialed': {
      if (prev.direction !== 'inbound' || prev.phase !== 'forwarding') {
        return { state: prev, effects: [] };
      }
      if (prev.legF === event.legF) return { state, effects: [] }; // duplicate
      return { state: { ...state, legF: event.legF }, effects: [] };
    }

    case 'forward_answered': {
      // Events carry the leg they are about; anything not about the CURRENT
      // forward leg is a stale redelivery from an attempt already resolved.
      if (prev.phase !== 'forwarding' || event.legF !== prev.legF) {
        return { state: prev, effects: [] };
      }
      if (prev.bridgeRequested || prev.forwardAnswered) return { state, effects: [] };
      return maybeDecideForward({ ...state, forwardAnswered: true });
    }

    case 'forward_amd': {
      if (prev.phase !== 'forwarding' || event.legF !== prev.legF) {
        return { state: prev, effects: [] };
      }
      if (prev.bridgeRequested || prev.forwardAmd === event.result) {
        return { state, effects: [] };
      }
      return maybeDecideForward({ ...state, forwardAmd: event.result });
    }

    case 'forward_hangup': {
      if (event.legF !== prev.legF) return { state: prev, effects: [] }; // stale leg
      // A bridged human hanging up ends the whole call (Telnyx's default tears
      // the far side down too; this just records it and cleans up).
      if (prev.bridgeRequested) {
        const cause = event.cause ? `forward_hangup:${event.cause}` : 'forward_hangup';
        return {
          state: { ...state, phase: 'completed' },
          effects: [{ type: 'teardown', reason: cause }],
        };
      }
      if (prev.phase !== 'forwarding') return { state: prev, effects: [] };
      // Rang out / declined / busy: this attempt is over. `answered` is
      // deliberately false even if an answer webhook arrived first — a leg
      // that is DOWN cannot be bridged, whatever AMD would have said.
      const attemptedNow = prev.forwardAttempted + 1;
      return applyInboundAction(
        state,
        nextInboundAction(inboundCfg(prev), { attempted: attemptedNow, answered: false }),
        { attemptedNow, hangupLegF: null },
      );
    }

    case 'forward_dial_failed': {
      if (prev.phase !== 'forwarding' || prev.legF !== null) return { state: prev, effects: [] };
      const attemptedNow = prev.forwardAttempted + 1;
      return applyInboundAction(
        state,
        nextInboundAction(inboundCfg(prev), { attempted: attemptedNow, answered: false }),
        { attemptedNow, hangupLegF: null },
      );
    }

    case 'conference_created': {
      if (prev.conferenceId) return { state, effects: [] }; // duplicate delivery
      if (!prev.legA) return { state: prev, effects: [] };
      const conferenceId = event.conferenceId;
      // Leg A joins with end_conference_on_exit -- see the create_conference
      // effect comment. This is the whole reason the conference is created from
      // leg B and not from leg A.
      const effects: CallEffect[] = [
        {
          type: 'join_conference',
          conferenceId,
          legId: prev.legA,
          endConferenceOnExit: true,
          pid: null,
          // Leg A is the call, not a supervisor of it. Null omits
          // `supervisor_role` from the body entirely rather than sending
          // 'barge', which keeps this request byte-identical to the one every
          // call made before roles existed.
          supervisorRole: null,
          whisperLegIds: [],
        },
      ];
      // Anyone the operator listed on the call request has been sitting in
      // 'queued' precisely because there was no conference to join. There is
      // one now.
      for (const participant of prev.participants) {
        if (participant.status !== 'queued') continue;
        effects.push({ type: 'dial_participant', pid: participant.pid, to: participant.to });
      }
      const participants = prev.participants.map((participant) =>
        participant.status === 'queued'
          ? { ...participant, status: 'dialing' as const }
          : participant,
      );
      return { state: { ...state, conferenceId, participants }, effects };
    }

    case 'participant_requested': {
      // ALREADY ON THE CALL -> no-op, and this is not merely tidiness. The add
      // arrives over HTTP, where a double-clicked button, a client retry after a
      // slow response, or a proxy replay all deliver the same request twice.
      // Without this the second one places a SECOND real phone call to a person
      // already talking, bills for it, and joins them to the conference twice.
      // Matched against ACTIVE rows only, so a number can be re-added after they
      // hang up -- which is a genuine thing an operator does.
      const alreadyOn = prev.participants.some(
        (participant) => participant.to === event.to && ACTIVE_PARTICIPANT.has(participant.status),
      );
      if (alreadyOn) return { state: prev, effects: [] };
      // LIFETIME budget, distinct from the concurrent cap below, and it closes a
      // real hole rather than padding. Rows are append-only, so add-then-drop
      // repeated on one long call grows `participants` without limit -- and the
      // state is persisted on EVERY event, so that is unbounded Durable Object
      // storage and an unbounded archive record.
      //
      // Worse, and silently: `pid` is `p${participants.length}` while
      // PARTICIPANT_ID_RE accepts at most three digits. Past a thousand rows the
      // minted pid stops decoding, so that participant's webhooks are rejected
      // at the boundary -- their leg is dialed and answered but never joined,
      // never tracked, and never torn down by anything except the conference
      // ending. A live billing leg nobody is watching.
      //
      // 25 mirrors DTMF_MAX_PRESSES_PER_CALL for the same reason: a loop has to
      // terminate even when every attempt is failing. A call that has genuinely
      // cycled 25 different people through it is pathological, and 25 is two
      // orders of magnitude clear of the pid ceiling.
      if (prev.participants.length >= MAX_PARTICIPANT_ROWS) {
        return { state: prev, effects: [] };
      }
      // A conference that has already ended cannot take a new participant, and
      // dialing one would place a real call into nothing.
      if (activeParticipantCount(prev) >= MAX_PARTICIPANTS) {
        return { state: prev, effects: [] };
      }
      const participant = queuedParticipant(
        prev.participants.length,
        event.to,
        event.label,
        event.supervisorRole,
      );
      const participants = [...prev.participants, participant];
      // No conference yet: the row stays 'queued' and conference_created will
      // dial it. This is the mid-call-add path only when the call is connected.
      if (!prev.conferenceId) {
        return { state: { ...state, participants }, effects: [] };
      }
      const dialing = participants.map((row) =>
        row.pid === participant.pid ? { ...row, status: 'dialing' as const } : row,
      );
      return {
        state: { ...state, participants: dialing },
        effects: [{ type: 'dial_participant', pid: participant.pid, to: participant.to }],
      };
    }

    case 'participant_dialed': {
      const row = findParticipant(prev, event.pid);
      if (!row || row.legId === event.legId) return { state, effects: [] }; // duplicate
      return {
        state: withParticipant(state, event.pid, (p) => ({ ...p, legId: event.legId })),
        effects: [],
      };
    }

    case 'participant_answered': {
      const row = findParticipant(prev, event.pid);
      if (!row || row.legId === null) return { state, effects: [] };
      // Already answered, or already gone: either way there is nothing to join.
      if (row.answeredAt !== null || row.status === 'left' || row.status === 'failed') {
        return { state, effects: [] };
      }
      const next = withParticipant(state, event.pid, (p) => ({ ...p, answeredAt: event.at }));
      // The conference can be gone by the time a slow answer lands (the subject
      // hung up while this leg was ringing). Joining nothing would strand a live
      // leg, so drop it instead.
      if (!prev.conferenceId) {
        return {
          state: endParticipant(next, event.pid, 'failed', event.at),
          effects: [{ type: 'drop_participant', pid: event.pid, legId: row.legId }],
        };
      }
      const role = joinRole(prev, row.supervisorRole);
      return {
        // The RESOLVED role is written back, so a 'whisper' that Telnyx will
        // treat as monitor-only is recorded as 'monitor' everywhere it is read.
        state: withParticipant(next, event.pid, (p) => ({
          ...p,
          supervisorRole: role.supervisorRole,
        })),
        effects: [
          {
            type: 'join_conference',
            conferenceId: prev.conferenceId,
            legId: row.legId,
            // FALSE, and this is the point of the whole feature: an escalation
            // participant hanging up must not end the subject's call.
            endConferenceOnExit: false,
            pid: event.pid,
            supervisorRole: role.supervisorRole,
            whisperLegIds: role.whisperLegIds,
          },
        ],
      };
    }

    case 'participant_joined': {
      const row = findParticipant(prev, event.pid);
      if (!row || row.status === 'joined') return { state, effects: [] }; // duplicate
      if (row.status === 'left' || row.status === 'failed') return { state, effects: [] };
      if (!prev.conferenceId) return { state, effects: [] };
      const next = withParticipant(state, event.pid, (p) => ({
        ...p,
        status: 'joined' as const,
        joinedAt: event.at,
      }));
      return {
        state: next,
        // ORDER IS DELIBERATE. The spoken notice goes into the conference audio,
        // so xAI HEARS it. Telling Grok who joined FIRST means the notice arrives
        // at a model that already knows a third party is on the line, instead of
        // one that may answer it as though the subject had spoken.
        effects: [
          { type: 'refresh_instructions' },
          { type: 'announce_participant', conferenceId: prev.conferenceId, pid: event.pid },
        ],
      };
    }

    case 'participant_left': {
      return { state: endParticipant(state, event.pid, 'left', event.at), effects: [] };
    }

    case 'participant_hangup': {
      const row = findParticipant(prev, event.pid);
      if (!row) return { state, effects: [] };
      // A leg that never answered did not "leave", it failed to arrive. The
      // distinction is not cosmetic: 'failed' rows carry answeredAt === null and
      // so contribute zero billable minutes.
      const status = row.answeredAt === null ? 'failed' : 'left';
      return { state: endParticipant(state, event.pid, status, event.at), effects: [] };
    }

    case 'participant_dial_failed': {
      return { state: endParticipant(state, event.pid, 'failed', event.at), effects: [] };
    }

    case 'participant_drop_requested': {
      const row = findParticipant(prev, event.pid);
      if (!row || row.legId === null) return { state, effects: [] };
      if (row.status === 'left' || row.status === 'failed') return { state, effects: [] };
      // The row is NOT marked left here. It is marked left by the hangup /
      // participant.left webhook that this drop causes, which is the moment the
      // leg actually stopped billing. Stamping it now would shorten the metered
      // window by however long the provider call takes.
      return {
        state,
        effects: [{ type: 'drop_participant', pid: event.pid, legId: row.legId }],
      };
    }

    case 'participant_mute_requested': {
      const row = findParticipant(prev, event.pid);
      if (!row || row.legId === null || row.status !== 'joined') return { state, effects: [] };
      if (row.muted === event.muted) return { state, effects: [] }; // already there
      if (!prev.conferenceId) return { state, effects: [] };
      return {
        state: withParticipant(state, event.pid, (p) => ({ ...p, muted: event.muted })),
        effects: [
          {
            type: 'set_participant_mute',
            conferenceId: prev.conferenceId,
            legId: row.legId,
            muted: event.muted,
          },
        ],
      };
    }

    case 'participant_hold_requested': {
      // Same four guards as mute, and they are not decoration here: a hold
      // effect built without a leg id would reach Telnyx as an EMPTY
      // `call_control_ids`, which it reads as "every participant" -- the
      // subject and the AI included.
      const row = findParticipant(prev, event.pid);
      if (!row || row.legId === null || row.status !== 'joined') return { state, effects: [] };
      if (row.held === event.held) return { state, effects: [] }; // already there
      if (!prev.conferenceId) return { state, effects: [] };
      return {
        state: withParticipant(state, event.pid, (p) => ({ ...p, held: event.held })),
        effects: [
          {
            type: 'set_participant_hold',
            conferenceId: prev.conferenceId,
            legId: row.legId,
            held: event.held,
          },
        ],
      };
    }

    case 'hangup': {
      const reason = event.cause
        ? `leg_${event.leg}_hangup:${event.cause}`
        : `leg_${event.leg}_hangup`;
      return {
        state: { ...state, phase: 'completed' },
        effects: [{ type: 'teardown', reason }],
      };
    }

    case 'failed': {
      return {
        state: { ...state, phase: 'failed', failureReason: event.reason },
        effects: [{ type: 'teardown', reason: event.reason }],
      };
    }

    case 'recording_saved': {
      const duplicate = prev.recordings.some(
        (recording) => recording.id === event.asset.id && recording.format === event.asset.format,
      );
      if (duplicate) return { state: prev, effects: [] };
      const recordings = [...prev.recordings, event.asset].slice(-MAX_RECORDING_ASSETS);
      return {
        state: { ...state, recordings },
        effects: [{ type: 'archive_recording', asset: event.asset }],
      };
    }

    case 'dtmf_received': {
      // *** ONLY THE LEG WE DIALED CONTROLS RECORDING. ***
      // Telnyx delivers a keypress from ANY leg on the call, and an escalation
      // participant is a third party we invited -- letting their keypad start
      // a recording of the person who invited them inverts who is in control.
      // Their press is dropped here and logged by the executor, so a real
      // press is distinguishable from a webhook that never arrived.
      if (event.leg !== 'A') return { state: prev, effects: [] };
      if (event.digit !== RECORDING_START_DTMF) return { state: prev, effects: [] };
      // 'off' is a refusal, not an absence: the operator said no recording on
      // this call, and muscle memory must not override that.
      if (prev.recordingMode === 'off') return { state: prev, effects: [] };
      // Idempotent. A held key repeats, and each repeat is its own webhook.
      if (prev.recordingStarted) return { state: prev, effects: [] };
      const effects: CallEffect[] = [{ type: 'start_recording' }];
      if (prev.conferenceId) {
        effects.push({
          type: 'announce_recording',
          conferenceId: prev.conferenceId,
          // Notice ON  -> everyone hears that recording began (disclosure).
          // Notice OFF -> only the operator hears it (the confirmation they
          // asked for), because they turned the announcement off deliberately.
          toEveryone: prev.noticeEnabled,
        });
      }
      return { state: { ...state, recordingStarted: true }, effects };
    }

    case 'transcript': {
      const entry: TranscriptEntry = { role: event.role, text: event.text, at: event.at };
      const next = [...prev.transcript, entry];
      // Keep the most recent N. Dropping the oldest is right for a phone call:
      // the tail is what a human reviewing "what did it just say" wants.
      const trimmed =
        next.length > MAX_TRANSCRIPT_ENTRIES
          ? next.slice(next.length - MAX_TRANSCRIPT_ENTRIES)
          : next;
      return { state: { ...state, transcript: trimmed }, effects: [] };
    }

    default: {
      // Exhaustiveness: if a new CallEvent variant is added and not handled,
      // this line fails to compile.
      const _never: never = event;
      return { state: prev, effects: [] };
    }
  }
}

/**
 * State as it may actually exist in Durable Object storage — written by ANY
 * previously deployed version of this Worker.
 *
 * `storage.get<CallState>()` is a CAST, not validation: a record written before
 * a field was added deserializes with that field `undefined` while TypeScript
 * still believes it is present. A call in flight across a deploy then hits the
 * new code with the old shape.
 */
/**
 * Fields added to CallState AFTER the first deploy, with the value an older
 * stored record should be given.
 *
 * This object is the SINGLE source of truth for the storage-shape gap: adding a
 * field to CallState means adding it here.
 *
 * The type does NOT enforce that — measured, not assumed: adding a field to
 * CallState and initialState while omitting it here still typechecks clean
 * (tsc rc=0). Nor can a test that merely ITERATES this object catch a deletion
 * from it, since removing an entry just removes its own case. The actual guard
 * is the key-set canary in test/availability.test.ts, which asserts that every
 * key of a fresh state is accounted for either here or in that test's explicit
 * NOT_HYDRATED list, and so fails on BOTH mistakes.
 */
export const HYDRATED_DEFAULTS = {
  // Recording controls (2026-08-31). A record written before them recorded
  // unconditionally, so 'auto' -- not the new 'on_demand' default -- is what
  // actually describes it. Hydrating those to on_demand would rewrite history.
  recordingMode: 'auto' as RecordingMode,
  noticeEnabled: true,
  recordingStarted: false,
  busy: [] as readonly { startMs: number; endMs: number; remote: boolean }[],
  windowDays: 7,
  slots: [] as readonly number[],
  slotMinutes: 30,
  // A record written before the deferred-call staleness guard existed had no
  // way to discard a snapshot, so false -- "we were not in the unknown state"
  // -- is what actually describes it, not a placeholder.
  availabilityUnknown: false,
  // Inbound fields (2026-08-27). 'outbound' is correct for every record that
  // predates them: only outbound calls existed when those were written.
  direction: 'outbound' as CallState['direction'],
  inboundMode: null as CallState['inboundMode'],
  ownNumber: null as string | null,
  forwardTargets: [] as readonly string[],
  ringSecs: DEFAULT_RING_SECS,
  forwardAttempted: 0,
  forwardAnswered: false,
  forwardAmd: null as string | null,
  legF: null as string | null,
  inboundFallbackReason: null as string | null,
  recordings: [] as readonly RecordingAsset[],
  // Added 2026-08-28 with the cost model. null is correct for every call in
  // flight across the deploy: their answer time was never recorded, and the
  // cost model reports `durationSource: 'total'` rather than inventing one.
  answeredAt: null as number | null,
  // Added 2026-08-29 with the call-log subject. A call already in flight when
  // this deploys was started without one, and null is the honest value -- the
  // archive then derives a label from its task rather than inventing a name.
  subject: null as string | null,
  // Added 2026-08-30 with conference support. A call in flight across this
  // deploy was connected with the OLD two-leg bridge, so it genuinely has no
  // conference and no participants -- null and [] are the facts about it, not
  // placeholders. The consequence is stated rather than hidden: such a call
  // cannot accept a participant until it ends, because there is no conference
  // to join one to, and `participant_requested` will queue a row that
  // conference_created never comes to dial.
  conferenceId: null as string | null,
  participants: [] as readonly Participant[],
};

type HydratedKey = keyof typeof HYDRATED_DEFAULTS;

/**
 * State as it may actually exist in Durable Object storage — written by ANY
 * previously deployed version of this Worker.
 *
 * `storage.get<CallState>()` is a CAST, not validation: a record written before
 * a field was added deserializes with that field `undefined` while TypeScript
 * still believes it is present. A call in flight across a deploy then hits the
 * new code with the old shape, and the first property access throws.
 */
export type PersistedCallState = Omit<CallState, HydratedKey> &
  Partial<Pick<CallState, Exclude<HydratedKey, 'participants'>>> & {
    /**
     * Rows as STORAGE may actually hold them, not as a fresh row looks.
     *
     * `readonly Participant[]` would be the same lie `storage.get<CallState>()`
     * tells at the top level: it asserts every row has every current field,
     * while a record written before a field existed simply does not. Typing the
     * array as PersistedParticipant is what makes `hydrateState` below fill
     * those rows instead of casting past them -- and what lets a test construct
     * a genuinely old row without an `as unknown as` to smuggle it in.
     */
    readonly participants?: readonly PersistedParticipant[];
  };

/**
 * Defaults for fields added to a ROSTER ROW after one was written.
 *
 * Separate from HYDRATED_DEFAULTS because the spread there is TOP-LEVEL ONLY:
 * `{ ...HYDRATED_DEFAULTS, ...stored }` fills a missing `participants` key, but
 * a PRESENT array of rows passes through untouched, however old those rows are.
 *
 * That gap is not reachable today -- every version of this Worker that has ever
 * been deployed predates `participants` entirely, so a stored record either has
 * no roster at all or was written by code that already sets both fields. It is
 * fixed anyway because the NEXT field added to `Participant` reopens it, and
 * the failure would be quiet: `supervisor_role: undefined` is dropped by
 * JSON.stringify, so the wire body stays correct while the console renders a
 * blank role and the archive records one -- source that reads right, a record
 * that is wrong.
 */
const HYDRATED_PARTICIPANT_DEFAULTS = {
  held: false,
  supervisorRole: 'barge' as SupervisorRole,
};

type HydratedParticipantKey = keyof typeof HYDRATED_PARTICIPANT_DEFAULTS;

/** One roster row as it may exist in storage, written by ANY prior version. */
export type PersistedParticipant = Omit<Participant, HydratedParticipantKey> &
  Partial<Pick<Participant, HydratedParticipantKey>>;

/** Fill defaults for fields added after a stored record was written. */
export function hydrateState(stored: PersistedCallState): CallState {
  const rows = stored.participants ?? HYDRATED_DEFAULTS.participants;
  return {
    ...HYDRATED_DEFAULTS,
    ...stored,
    participants: rows.map((row) => ({ ...HYDRATED_PARTICIPANT_DEFAULTS, ...row })),
  };
}
