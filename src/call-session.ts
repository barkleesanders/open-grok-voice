// CallSession -- one Durable Object instance per outbound call.
//
// WHY A DURABLE OBJECT AT ALL: the xAI realtime WebSocket has to stay open for
// the whole call while HTTP webhooks from two different providers arrive on
// unrelated requests. A DO gives us (a) a single-threaded, strongly consistent
// place to run the state machine, and (b) a host for the socket. Cloudflare
// documents that "Outbound connections keep Durable Objects alive" -- an active
// outbound WebSocket blocks both hibernation and eviction -- so the socket
// survives the call with no keepalive of our own.
//
// WHY NO ALARM: Durable Object alarms are capped at 15 minutes. Any call-
// duration work hung off an alarm would be truncated mid-call on a 20-minute
// call. Every wake-up here is driven by an inbound webhook HTTP request, which
// Cloudflare documents as having NO duration limit.
//
// DUAL ROLE: this class also backs a single well-known instance named
// `__registry__` (see REGISTRY_NAME) used only as a strongly consistent
// pending-call registry. That keeps the Worker to ONE Durable Object class
// while avoiding KV's eventual consistency on the correlation path.

import {
  AVAILABILITY_UNKNOWN,
  availabilityFromBusy,
  DEFAULT_AVAILABILITY,
  renderSlots,
} from './availability';
import {
  archiveRecording,
  asciiMetadataValue,
  buildCallLogRecord,
  callLogKey,
  putCallLogRecord,
  recordingObjectKey,
  recordingUrlGuard,
  subjectProjection,
} from './call-log';
import { validateDtmfDigits } from './dtmf';
import { connectDeadlineMs, type Env } from './env';
import { contentRangeValue, parseRangeHeader, unsatisfiedContentRangeValue } from './http-range';
import {
  directInboundTask,
  inboundTask,
  isAllowlistedCaller,
  parseNumberList,
  ringSecsFromEnv,
} from './inbound';
import {
  buildInstructions,
  conferenceToolAvailable,
  keypadAvailable,
  POST_KEYPAD_TURN_INSTRUCTIONS,
  participantJoinNotice,
  recordingStartedNotice,
  sanitizeParticipantLabel,
} from './instructions';
import { errText, log } from './log';
import { issueMediaToken } from './media';
import { isRecordingUrlAllowed, type RecordingAsset } from './recordings';
import {
  type CallEffect,
  type CallEvent,
  type CallState,
  findParticipant,
  hydrateState,
  initialInboundState,
  initialState,
  isTerminal,
  type PersistedCallState,
  participantView,
  reduce,
} from './state';
import {
  answer,
  conferenceNoticeVoice,
  conferencePlay,
  conferenceSpeak,
  createConference,
  dial,
  endConference,
  hangup,
  joinConference,
  NOTICE_MEDIA_TTL_SECS,
  noticeRenderVoice,
  sendDtmf,
  setConferenceHold,
  setConferenceMute,
  startStreaming,
  startRecording as startTelnyxRecording,
  synthesizeSpeech,
  type TelnyxConfig,
  uploadMedia,
  xaiSipUri,
} from './telnyx';
import {
  encodeClientState,
  MAX_PARTICIPANTS,
  type RecordingMode,
  type SupervisorRole,
} from './types';
import {
  ADD_CONFERENCE_PARTICIPANT_TOOL_NAME,
  buildFunctionCallOutput,
  buildResponseCreate,
  buildSessionUpdate,
  classifyServerEvent,
  openRealtimeSocket,
  SEND_DTMF_TOOL_NAME,
} from './xai';

/** Per-digit tone length. 250ms is the Telnyx default; IVRs expect roughly this. */
const DTMF_DURATION_MILLIS = 250;

/**
 * Ceiling on keypresses for one call.
 *
 * Not defensive padding -- the failure that motivated this whole feature was a
 * menu that LOOPED. An agent told to keep working the tree, on a tree that
 * repeats, is a self-driving loop, and every turn of it is a live provider
 * command holding a billed call open on a hospital's phone line. Real
 * navigation is a handful of presses: a menu, a submenu, maybe an extension.
 * 25 is generous for that and still bounded.
 */
const DTMF_MAX_PRESSES_PER_CALL = 25;

/** How many keypresses this call has already spent. */
const DTMF_PRESS_COUNT_KEY = 'dtmfPressCount';

/**
 * Seconds an escalation participant's phone rings before Telnyx abandons it.
 *
 * ceiling: Telnyx's own `timeout_secs` default is 30, so this is that default
 * made EXPLICIT rather than a new policy -- an unanswered participant leg must
 * stop ringing on its own, because the operator's attention is on a live call
 * and nothing else would ever cancel it.
 */
const PARTICIPANT_RING_SECS = 30;

/**
 * The outcome of one tool call, as the model will see it.
 *
 * `output` is serialized to a JSON string before it goes on the wire, because
 * xAI documents `function_call_output.output` as a string, not an object.
 *
 * For conference tool, `digits` is empty string (not used), message contains the result.
 */
interface ToolResult {
  readonly output:
    | { readonly ok: true; readonly digits: string; readonly message: string }
    | { readonly ok: false; readonly error: string };
  /** Prompt override for the single turn that follows this result. */
  readonly followUpInstructions?: string | undefined;
}

/** Name of the singleton instance used as the pending-call registry. */
export const REGISTRY_NAME = '__registry__';

const STATE_KEY = 'state';
const PENDING_KEY = 'pending';
/** A pending entry older than this is stale and will never be claimed. */
const PENDING_TTL_MS = 120_000;
/** Live (non-terminal) calls tracked for concurrent cap enforcement. */
const LIVE_CALLS_KEY = 'liveCalls';
/** Maximum concurrent outbound calls. Enforced in Worker startCall. */
export const MAX_CONCURRENT_OUTBOUND = 5;
/** Where this call's archive coordinates live once the call has ended. */
const LOG_ANCHOR_KEY = 'callLogAnchor';
/**
 * R2 keys whose recording bytes are CONFIRMED stored.
 *
 * Kept separately from CallState.recordings because those two answer different
 * questions: `recordings` means "Telnyx told us a recording exists", this means
 * "we have the bytes". Only the second one can honestly drive a play button
 * once the provider's signed URL has expired.
 */
const ARCHIVED_KEYS_KEY = 'archivedRecordingKeys';

/**
 * Everything one conference join needs, as ONE object.
 *
 * Six positional parameters -- four of which are strings or booleans -- is a
 * call site where two arguments can be transposed and still compile. The one
 * that would hurt is `endConferenceOnExit`: swap it with any other boolean and
 * an escalation participant hanging up ends the subject's call.
 */
interface JoinConfArgs {
  readonly conferenceId: string;
  readonly legId: string;
  readonly endConferenceOnExit: boolean;
  readonly pid: string | null;
  readonly supervisorRole: SupervisorRole | null;
  readonly whisperLegIds: readonly string[];
}

/**
 * The archive coordinates for this call, pinned at the terminal transition.
 *
 * This is the idempotency guard for the R2 call log. The archive is written
 * more than once by design — first at teardown, then again each time a
 * recording lands afterwards (Telnyx saves recordings AFTER the call is over,
 * which is why `recording_saved` is one of the two events the reducer lets
 * through a terminal phase). Every one of those writes has to land on the SAME
 * object, or the console's list would grow a duplicate row per recording. So
 * the key and the end time are computed once, persisted here before the first
 * R2 put, and reused verbatim by every later write; an R2 put on an existing
 * key overwrites in place.
 */
interface CallLogAnchor {
  readonly key: string;
  readonly endedAt: number;
  readonly reason: string;
}

interface PendingEntry {
  readonly callId: string;
  readonly at: number;
}

interface LiveCallEntry {
  readonly callId: string;
  readonly to: string;
  readonly subject: string | null;
  readonly startedAt: number;
}

export interface StartArgs {
  /** Correlation id chosen by the Worker; also the DO's idFromName() key. */
  readonly callId: string;
  readonly to: string;
  readonly task: string;
  /** Operator's name for the call. Archived and displayed; never sent to Grok. */
  readonly subject?: string | null | undefined;
  readonly busy?: readonly { startMs: number; endMs: number; remote: boolean }[];
  readonly windowDays?: number;
  /**
   * cal.com bookable start times, epoch ms.
   *
   * DECLARED HERE BECAUSE IT WAS NOT, AND THAT WAS A SILENT DROP. The Worker
   * has sent `slots` and `slotMinutes` in this body since cal.com support
   * shipped, but StartArgs never named them and `initialState` was never given
   * them -- so `state.slots` was ALWAYS empty and the cal.com branch of
   * `availabilityText` below was unreachable on every real call. The agent
   * silently fell back to computed busy windows, which is the very shape
   * cal.com was adopted to stop it reading aloud.
   */
  readonly slots?: readonly number[];
  /** Appointment length for `slots`. Dropped alongside `slots`; see above. */
  readonly slotMinutes?: number;
  /**
   * True when this call was set up WITH calendar data that was then discarded
   * as too stale to trust. Server-only: the scheduler sets it, no caller can.
   */
  readonly availabilityUnknown?: boolean;
  readonly voice: string;
  readonly amd: string | null;
  /** Numbers to conference in once the call connects. */
  readonly participants?: readonly string[];
  /** When this call records. Absent means on_demand (the schema's default). */
  readonly recording?: RecordingMode | undefined;
  /** Whether the join notice plays. Absent means true. */
  readonly notice?: boolean | undefined;
}

export interface InboundStartArgs {
  /** Correlation id chosen by the Worker; also the DO's idFromName() key. */
  readonly callId: string;
  /** Telnyx call_control_id of the caller's already-ringing leg. */
  readonly callControlId: string;
  /** Caller's number as Telnyx reports it. */
  readonly from: string;
  /** The number they dialed — ours. */
  readonly to: string;
}

/**
 * Render availability for a live call. Returns null when the caller sent no
 * busy geometry, so `buildInstructions` omits the section entirely rather than
 * asserting an empty schedule the agent would then offer against.
 */
export function availabilityText(state: CallState, bookingUrl: string): string | null {
  const now = Date.now();
  // Checked FIRST and unconditionally. This call was set up with a calendar
  // and lost it, so an empty slot list here is IGNORANCE, not an empty
  // schedule -- and staying silent about it is what lets the agent invent a
  // time next to a task that asks for one.
  if (state.availabilityUnknown) return AVAILABILITY_UNKNOWN;
  // cal.com slots are PREFERRED: they carry the real per-day working hours and
  // are already discrete bookable times, so the agent cannot read a window
  // aloud as if it were the appointment. The busy-window path stays as the
  // fallback for when no cal.com data was supplied.
  if (state.slots.length > 0) {
    return renderSlots(state.slots, DEFAULT_AVAILABILITY, now, {
      slotMinutes: state.slotMinutes,
      bookingUrl,
      requiresConfirmation: true,
    });
  }
  if (state.busy.length === 0) return null;
  return availabilityFromBusy(state.busy, now, state.windowDays);
}

/**
 * Labels of everyone currently ON the conference besides the subject and the AI.
 *
 * Only 'joined' rows count. A participant whose phone is still ringing has not
 * heard anything and is not on the line, so telling the agent they are there
 * would have it address a person who cannot answer.
 *
 * A row with no operator label yields '' on purpose: `participantsDirective`
 * renders that as "an unnamed participant" rather than falling back to the
 * phone NUMBER, which would put a real person's number into the system prompt
 * for no benefit the agent can use.
 */
function joinedParticipantLabels(state: CallState): readonly string[] {
  return state.participants
    .filter((participant) => participant.status === 'joined')
    .map((participant) => sanitizeParticipantLabel(participant.label) ?? '');
}

/**
 * Should this call be offered the keypad tool?
 *
 * Outbound only. The tool plays tones at leg A's remote party. On a call we
 * placed that is the phone tree we are trying to get through; on a call that
 * came TO us it is a live human, and firing tones at them is noise at best.
 */
function dtmfToolEnabled(state: CallState): boolean {
  // Derived from the prompt's own rule, never re-decided here: the agent is
  // told about the keypad and given the keypad by the same predicate.
  return keypadAvailable(state.direction);
}

/**
 * Should this call be offered the conference tool?
 *
 * Outbound only. The tool exists for calls where the agent is actively working
 * toward a goal that may require bringing someone else in. On inbound calls
 * the agent is message-taking, and conferencing is not part of that workflow.
 */
function conferenceToolEnabled(state: CallState): boolean {
  // Derived from the prompt's own rule, like dtmfToolEnabled above.
  return conferenceToolAvailable(state.direction);
}

/**
 * The headers every recording response carries, ranged or not.
 *
 * `private, no-store` and `nosniff` are not boilerplate here: these bytes are a
 * recording of a real phone call, so they must never enter a shared cache and
 * must never be content-sniffed into something scriptable. Mutable on purpose —
 * the callers add Content-Length / Content-Range / ETag on top.
 */
function recordingHeaders(format: 'wav' | 'mp3'): Record<string, string> {
  return {
    'Content-Type': format === 'wav' ? 'audio/wav' : 'audio/mpeg',
    'Cache-Control': 'private, no-store',
    'Content-Disposition': 'inline',
    'X-Content-Type-Options': 'nosniff',
    // These responses now differ by request header, so say so. `no-store`
    // already stops any correct cache from storing them, which is why this is
    // belt-and-braces rather than a live fix -- but the two guards protect
    // against different mistakes. Drop or weaken the Cache-Control (enable the
    // Workers cache, add a CDN, put this behind a proxy that rewrites it) and
    // without `Vary` a cache is entitled to serve one client's 206 slice to the
    // next client's unranged request. That failure is silent and looks like a
    // corrupt recording, so the header is cheaper than the diagnosis.
    Vary: 'Range',
  };
}

export class CallSession {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;
  /** Live xAI control socket. Null until `open_xai_ws` runs. */
  private ws: WebSocket | null = null;
  private cached: CallState | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  private telnyxConfig(): TelnyxConfig {
    return {
      apiKey: this.env.TELNYX_API_KEY,
      connectionId: this.env.TELNYX_CONNECTION_ID,
      from: this.env.TELNYX_FROM_NUMBER,
    };
  }

  private async load(): Promise<CallState | null> {
    if (this.cached) return this.cached;
    const stored = await this.ctx.storage.get<PersistedCallState>(STATE_KEY);
    // Hydrate: a record written by an older deploy is missing newer fields.
    this.cached = stored === undefined ? null : hydrateState(stored);
    return this.cached;
  }

  private async save(state: CallState): Promise<void> {
    this.cached = state;
    await this.ctx.storage.put(STATE_KEY, state);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case '/start':
          return await this.handleStart(request);
        case '/inbound-start':
          return await this.handleInboundStart(request);
        case '/event':
          return await this.handleEvent(request);
        case '/status':
          return await this.handleStatus(url.searchParams.get('view') === 'legacy');
        case '/operator/hangup':
          return await this.handleOperatorHangup();
        case '/operator/dtmf':
          return await this.handleOperatorDtmf(request);
        case '/participants/add':
          return await this.handleAddParticipant(request);
        case '/participants/drop':
          return await this.handleDropParticipant(request);
        case '/participants/mute':
          return await this.handleMuteParticipant(request);
        case '/participants/hold':
          return await this.handleHoldParticipant(request);
        case '/recording':
          return await this.handleRecording(
            url.searchParams.get('format'),
            request.headers.get('Range'),
          );
        case '/registry/register':
          return await this.handleRegistryRegister(request);
        case '/registry/claim':
          return await this.handleRegistryClaim();
        case '/registry/add-live':
          return await this.handleRegistryAddLive(request);
        case '/registry/remove-live':
          return await this.handleRegistryRemoveLive(request);
        case '/registry/list-live':
          return await this.handleRegistryListLive();
        default:
          return new Response('not found', { status: 404 });
      }
    } catch (err) {
      log('error', 'do.fetch.unhandled', {
        path: url.pathname,
        error: errText(err),
      });
      return Response.json({ error: 'internal error' }, { status: 500 });
    }
  }

  // --- Call lifecycle ------------------------------------------------------

  private async handleStart(request: Request): Promise<Response> {
    const existing = await this.load();
    if (existing) {
      // Idempotent: a retried POST /call with the same id must not dial twice.
      return Response.json({ callId: existing.callId, phase: existing.phase });
    }
    const args = (await request.json()) as StartArgs;
    const now = Date.now();
    const callId = args.callId;

    let state = initialState({
      callId,
      to: args.to,
      task: args.task,
      subject: args.subject ?? null,
      busy: args.busy ?? [],
      windowDays: args.windowDays ?? 7,
      slots: args.slots ?? [],
      slotMinutes: args.slotMinutes ?? 30,
      availabilityUnknown: args.availabilityUnknown ?? false,
      voice: args.voice,
      amd: args.amd,
      participants: args.participants ?? [],
      recordingMode: args.recording ?? 'on_demand',
      noticeEnabled: args.notice ?? true,
      now,
    });
    await this.save(state);

    const commandId = crypto.randomUUID();
    const dialResult = await dial(this.telnyxConfig(), {
      to: args.to,
      clientState: encodeClientState({ callId, leg: 'A' }),
      commandId,
      webhookUrl: `${this.env.PUBLIC_BASE_URL}/telnyx-webhook`,
      answeringMachineDetection: args.amd ?? undefined,
    });

    state = await this.apply({
      type: 'leg_a_dialed',
      legA: dialResult.callControlId,
      at: Date.now(),
    });
    log('info', 'call.started', { callId, to: args.to });
    return Response.json({ callId, phase: state.phase });
  }

  /**
   * Adopt a caller-originated leg (inbound call to our number).
   *
   * Order is load-bearing: state is SAVED first, then the answer command runs.
   * Telnyx redelivers webhooks, and every delivery of call.initiated mints a
   * fresh callId in the Worker — so a duplicate delivery reaches a SECOND DO
   * whose answer command fails (the call is already answered, with the first
   * DO's client_state attached). That loser must vanish WITHOUT applying a
   * 'failed' event: 'failed' runs teardown, and teardown would hang up the
   * live call the winner is handling.
   */
  private async handleInboundStart(request: Request): Promise<Response> {
    const existing = await this.load();
    if (existing) {
      return Response.json({ callId: existing.callId, phase: existing.phase });
    }
    const args = (await request.json()) as InboundStartArgs;
    const now = Date.now();

    const allowlist = parseNumberList(this.env.INBOUND_ALLOWLIST);
    const mode = isAllowlistedCaller(args.from, allowlist) ? 'direct' : 'follow_me';
    const forwardTargets = parseNumberList(this.env.FORWARD_TARGETS);
    // Availability is null today: inbound calls carry no busy/slot geometry
    // (that arrives caller-side on the outbound path). inboundTask degrades
    // to plain message-taking, which is the right floor.
    const task = mode === 'direct' ? directInboundTask() : inboundTask(null);

    const state = initialInboundState({
      callId: args.callId,
      // args.from is the CALLER's SIP identity. The webhook signature proves
      // Telnyx sent it, not that the caller is honest about it, and the E.164
      // regex in types.ts guards only the outbound /call body -- nothing
      // validates this. Until 2026-08-29 redactPhone incidentally constrained
      // it on the way to the console; removing the masking removed that, so
      // the constraint is now explicit and at the boundary rather than in
      // each of the three projections that read state.to.
      caller: asciiMetadataValue(args.from),
      ownNumber: args.to,
      legA: args.callControlId,
      mode,
      forwardTargets,
      ringSecs: ringSecsFromEnv(this.env.INBOUND_RING_SECS),
      task,
      voice: this.env.DEFAULT_VOICE,
      now,
    });
    await this.save(state);

    try {
      await answer(this.telnyxConfig(), args.callControlId, {
        clientState: encodeClientState({ callId: args.callId, leg: 'A' }),
        commandId: crypto.randomUUID(),
      });
    } catch (err) {
      log('warn', 'inbound.answer.failed', { callId: args.callId, error: errText(err) });
      this.cached = null;
      await this.ctx.storage.delete(STATE_KEY);
      return Response.json({ error: 'answer failed' }, { status: 409 });
    }

    log('info', 'inbound.call.started', {
      callId: args.callId,
      mode,
      from: args.from,
      forwardTargets: forwardTargets.length,
    });
    return Response.json({ callId: args.callId, phase: state.phase, mode });
  }

  private async handleEvent(request: Request): Promise<Response> {
    const event = (await request.json()) as CallEvent;
    const state = await this.apply(event);
    return Response.json({ phase: state.phase });
  }

  private async handleStatus(includeLegacyFields: boolean): Promise<Response> {
    const state = await this.load();
    if (!state) return Response.json({ error: 'unknown call' }, { status: 404 });
    const safeStatus = {
      callId: state.callId,
      phase: state.phase,
      to: state.to,
      // A LIVE call has to name itself the same way an ARCHIVED one does, or
      // the console's detail panel would go blank at the moment the call ends
      // and the DO hands over to the archive. Spread from the same
      // subjectProjection the archive uses -- four projections drop this field
      // if each is left to decide for itself, which is how the list and detail
      // routes once reported two different costs for one call. The pair also
      // carries WHO wrote the label: a live call started without a subject
      // shows a derived one, and the console must not present that as a name
      // the operator chose.
      ...subjectProjection({ subject: state.subject, task: state.task }),
      task: state.task,
      direction: state.direction,
      inboundMode: state.inboundMode,
      forwardAttempted: state.forwardAttempted,
      inboundFallbackReason: state.inboundFallbackReason,
      voice: state.voice,
      amdResult: state.amdResult,
      failureReason: state.failureReason,
      createdAt: state.createdAt,
      // The billable start. The console prices a call from ANSWER, not from
      // dial, so this has to cross the DO boundary or the estimate silently
      // includes ring time.
      answeredAt: state.answeredAt,
      updatedAt: state.updatedAt,
      transcript: state.transcript,
      // The SAME projection buildCallLogRecord uses, so the roster does not
      // change shape at the instant a call ends and the console switches from
      // the live status to the archive.
      participants: state.participants.map(participantView),
      conferenceId: state.conferenceId,
      recordings: state.recordings.map((recording) => ({
        format: recording.format,
        channels: recording.channels,
        available: true,
      })),
      monitoring: {
        available: Boolean(this.env.MONITOR_SESSION && this.env.BETTER_AUTH_SECRET && state.legA),
        track: 'both_tracks',
        codec: 'PCMU',
      },
    };
    // Keep the API-key endpoint compatible with its original machine-facing
    // response while the console and every browser route use safeStatus only.
    return Response.json(
      includeLegacyFields ? { ...safeStatus, xaiCallId: state.xaiCallId } : safeStatus,
    );
  }

  private async handleOperatorHangup(): Promise<Response> {
    const state = await this.load();
    if (!state) return Response.json({ error: 'unknown call' }, { status: 404 });
    const next = await this.apply({
      type: 'hangup',
      leg: 'A',
      cause: 'operator',
      at: Date.now(),
    });
    return Response.json({ phase: next.phase });
  }

  /**
   * Operator / API-key DTMF on leg A. Same digits validator and per-call press
   * budget as the agent send_dtmf tool — tones go to the PSTN subject, not xAI.
   */
  private async handleOperatorDtmf(request: Request): Promise<Response> {
    const state = await this.load();
    if (!state) return Response.json({ error: 'unknown call' }, { status: 404 });
    if (isTerminal(state.phase)) {
      return Response.json({ error: 'call has ended' }, { status: 409 });
    }
    const legA = state.legA;
    if (!legA) {
      return Response.json({ error: 'leg A is not connected yet' }, { status: 409 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'body must be JSON' }, { status: 400 });
    }
    const digitsRaw =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)['digits']
        : undefined;
    const validated = validateDtmfDigits(digitsRaw);
    if (!validated.ok) {
      log('warn', 'operator.dtmf.rejected', { callId: state.callId, reason: validated.reason });
      return Response.json({ error: validated.reason }, { status: 400 });
    }
    const digits = validated.digits;

    const pressed = (await this.ctx.storage.get<number>(DTMF_PRESS_COUNT_KEY)) ?? 0;
    if (pressed >= DTMF_MAX_PRESSES_PER_CALL) {
      log('warn', 'operator.dtmf.refused.budget', { callId: state.callId, pressed });
      return Response.json(
        { error: 'the keypad limit for this call has been reached' },
        { status: 409 },
      );
    }
    await this.ctx.storage.put(DTMF_PRESS_COUNT_KEY, pressed + 1);

    try {
      const status = await sendDtmf(this.telnyxConfig(), legA, {
        digits,
        clientState: encodeClientState({ callId: state.callId, leg: 'A' }),
        commandId: crypto.randomUUID(),
        durationMillis: DTMF_DURATION_MILLIS,
      });
      log('info', 'operator.dtmf.sent', {
        callId: state.callId,
        leg: 'A',
        digits,
        status,
        pressesUsed: pressed + 1,
      });
      return Response.json({ ok: true, digits, pressesUsed: pressed + 1 });
    } catch (err) {
      log('error', 'operator.dtmf.failed', {
        callId: state.callId,
        leg: 'A',
        digits,
        error: errText(err),
      });
      return Response.json({ error: 'the keypress could not be sent' }, { status: 502 });
    }
  }

  /**
   * Conference a number into this call.
   *
   * The E.164 shape was already checked by the route's zod schema; what can
   * only be decided HERE is whether the call can take another participant, and
   * that is answered by the reducer rather than re-derived. The reducer refusing
   * shows up as an unchanged roster, which is what the 409 below reports.
   */
  private async handleAddParticipant(request: Request): Promise<Response> {
    const state = await this.load();
    if (!state) return Response.json({ error: 'unknown call' }, { status: 404 });
    if (isTerminal(state.phase)) {
      return Response.json({ error: 'call has ended' }, { status: 409 });
    }
    const body = (await request.json()) as {
      to: string;
      label?: string | null;
      supervisorRole?: SupervisorRole | null;
    };
    const before = state.participants.length;
    const next = await this.apply({
      type: 'participant_requested',
      to: body.to,
      label: sanitizeParticipantLabel(body.label ?? null),
      // The Worker has already validated this against SupervisorRoleSchema, so
      // an absent value here means the caller did not ask for a role -- not
      // that an invalid one was dropped.
      supervisorRole: body.supervisorRole ?? 'barge',
      at: Date.now(),
    });
    if (next.participants.length === before) {
      return Response.json(
        { error: `at most ${MAX_PARTICIPANTS} participants per call` },
        { status: 409 },
      );
    }
    const added = next.participants[next.participants.length - 1];
    if (!added) return Response.json({ error: 'could not add participant' }, { status: 500 });
    return Response.json({ participant: participantView(added) });
  }

  private async handleDropParticipant(request: Request): Promise<Response> {
    const state = await this.load();
    if (!state) return Response.json({ error: 'unknown call' }, { status: 404 });
    const body = (await request.json()) as { legId: string };
    const target = state.participants.find((participant) => participant.legId === body.legId);
    if (!target) return Response.json({ error: 'unknown participant' }, { status: 404 });
    await this.apply({ type: 'participant_drop_requested', pid: target.pid, at: Date.now() });
    return Response.json({ dropped: true, pid: target.pid });
  }

  private async handleMuteParticipant(request: Request): Promise<Response> {
    const state = await this.load();
    if (!state) return Response.json({ error: 'unknown call' }, { status: 404 });
    const body = (await request.json()) as { legId: string; muted: boolean };
    const target = state.participants.find((participant) => participant.legId === body.legId);
    if (!target) return Response.json({ error: 'unknown participant' }, { status: 404 });
    const next = await this.apply({
      type: 'participant_mute_requested',
      pid: target.pid,
      muted: body.muted === true,
      at: Date.now(),
    });
    const updated = findParticipant(next, target.pid);
    return Response.json({ pid: target.pid, muted: updated?.muted ?? target.muted });
  }

  private async handleHoldParticipant(request: Request): Promise<Response> {
    const state = await this.load();
    if (!state) return Response.json({ error: 'unknown call' }, { status: 404 });
    const body = (await request.json()) as { legId: string; held: boolean };
    // MATCH ON THE ROSTER FIRST, exactly as mute and drop do, and here it is a
    // safety property rather than a lookup: an unmatched leg id returns 404
    // instead of reaching a hold command, and a hold command that reached
    // Telnyx without a leg id would carry an empty `call_control_ids` -- which
    // Telnyx reads as EVERY participant, freezing the subject and the AI.
    const target = state.participants.find((participant) => participant.legId === body.legId);
    if (!target) return Response.json({ error: 'unknown participant' }, { status: 404 });
    const next = await this.apply({
      type: 'participant_hold_requested',
      pid: target.pid,
      held: body.held === true,
      at: Date.now(),
    });
    const updated = findParticipant(next, target.pid);
    return Response.json({ pid: target.pid, held: updated?.held ?? target.held });
  }

  private async handleRecording(
    format: string | null,
    rangeHeader: string | null,
  ): Promise<Response> {
    if (format !== 'wav' && format !== 'mp3') {
      return Response.json({ error: 'unsupported recording format' }, { status: 400 });
    }
    const state = await this.load();
    if (!state) return Response.json({ error: 'unknown call' }, { status: 404 });
    const asset = [...state.recordings].reverse().find((recording) => recording.format === format);
    if (!asset) return Response.json({ error: 'recording unavailable' }, { status: 404 });

    // R2 first. The provider URL below is a SIGNED, short-lived capability, so
    // once it expires the archived copy is the only thing that can still play.
    const archived = await this.readArchivedRecording(asset, state.callId, format, rangeHeader);
    if (archived) return archived;

    if (!isRecordingUrlAllowed(asset.url, this.env)) {
      return Response.json({ error: 'recording unavailable' }, { status: 404 });
    }
    let providerResponse: Response;
    try {
      // 'manual', NOT 'error'. workerd does not implement redirect:'error' —
      // it throws a TypeError at the call, so this proxy has been answering 502
      // for every playback since it shipped (found 2026-08-28 by probing the
      // real bucket; node's fetch implements 'error', so the unit tests were
      // blind to it). The intent is unchanged: the provider URL is a signed
      // capability and must not be handed to the browser or followed to an
      // arbitrary host, so a 3xx is refused below rather than followed.
      providerResponse = await fetch(asset.url, {
        redirect: 'manual',
        // Forward the browser's Range verbatim. Telnyx is free to answer 200
        // instead; the passthrough below reports whichever it actually sent
        // rather than synthesising a 206 this Worker cannot back with bytes.
        ...(rangeHeader === null ? {} : { headers: { Range: rangeHeader } }),
      });
    } catch (err) {
      log('warn', 'recording.proxy.fetch_failed', { callId: state.callId, error: errText(err) });
      return Response.json({ error: 'recording unavailable' }, { status: 502 });
    }
    if (providerResponse.status >= 300 && providerResponse.status < 400) {
      log('warn', 'recording.proxy.redirected', {
        callId: state.callId,
        status: providerResponse.status,
      });
      return Response.json({ error: 'recording unavailable' }, { status: 410 });
    }
    // 416 is a real answer to a real question, not a failure: the client asked
    // for bytes past the end. Passing it through (with the provider's own
    // Content-Range, which carries the true length) lets the player correct
    // itself. Folding it into 410 would tell the console the audio is gone.
    if (providerResponse.status === 416) {
      const contentRange = providerResponse.headers.get('Content-Range');
      return new Response(null, {
        status: 416,
        headers: {
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
          'Accept-Ranges': 'bytes',
          // A 416 is caused BY the Range header, so it varies by it too.
          Vary: 'Range',
          ...(contentRange === null ? {} : { 'Content-Range': contentRange }),
        },
      });
    }
    if (!providerResponse.ok || !providerResponse.body) {
      log('warn', 'recording.proxy.provider_failed', {
        callId: state.callId,
        status: providerResponse.status,
      });
      return Response.json({ error: 'recording unavailable' }, { status: 410 });
    }
    log('info', 'recording.proxy.served', {
      callId: state.callId,
      format,
      status: providerResponse.status,
    });
    const headers = recordingHeaders(format);
    // Report what the PROVIDER did, not what the client asked for. Telnyx may
    // answer 200 to a ranged request; claiming 206 in that case would tell the
    // browser it holds a slice when it holds the whole file, and the player
    // would then seek against a length that does not describe the body.
    const status = providerResponse.status === 206 ? 206 : 200;
    for (const header of ['Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag'] as const) {
      const value = providerResponse.headers.get(header);
      if (value !== null) headers[header] = value;
    }
    // Telnyx advertises nothing about ranges on a plain 200. Saying
    // 'Accept-Ranges: none' is the honest signal: it tells the media element not
    // to expect seeking on this path, instead of leaving it to guess.
    if (status === 200 && headers['Accept-Ranges'] === undefined) {
      headers['Accept-Ranges'] = 'none';
    }
    return new Response(providerResponse.body, { status, headers });
  }

  /**
   * Stream an archived recording out of R2, or null when it is not there yet.
   *
   * Answers ranged requests with a real 206. Without that the console's scrub
   * bar is dead: a media element populates `seekable` only from a response that
   * declares `Accept-Ranges` and a length, so a bare 200 of unknown size renders
   * a slider that cannot be dragged.
   *
   * WHY head() BEFORE get(): `Content-Range` needs the TOTAL object size as its
   * denominator, and the Workers docs do not state whether `R2Object.size` is
   * the full size or the served slice on a ranged get (checked
   * developers.cloudflare.com/r2/api/workers/workers-api-reference/, 2026-08-28:
   * `size` is documented only as "Size of the object in bytes", with no ranged
   * qualification). head() is never ranged, so its `size` is unambiguous under
   * either reading. Clamping the request against that size also guarantees the
   * range we ask for is fully satisfiable, so `Content-Length` is exact rather
   * than a hope about what R2 returned. One extra metadata read is a cheap price
   * for a header that is either right or corrupts playback.
   */
  private async readArchivedRecording(
    asset: RecordingAsset,
    callId: string,
    format: 'wav' | 'mp3',
    rangeHeader: string | null,
  ): Promise<Response | null> {
    const bucket = this.env.CALL_LOGS;
    if (!bucket) return null;
    const key = recordingObjectKey(callId, asset);

    // No Range: one get, and `size` on an unranged object is unambiguous.
    if (rangeHeader === null) {
      let object: R2ObjectBody | null;
      try {
        object = await bucket.get(key);
      } catch (err) {
        // Fall through to the provider proxy: a bucket hiccup must not turn a
        // playable recording into a 502.
        log('warn', 'recording.archive.read_failed', { callId, error: errText(err) });
        return null;
      }
      if (!object) return null;
      log('info', 'recording.archive.served', { callId, format, status: 200 });
      return new Response(object.body, {
        status: 200,
        headers: {
          ...recordingHeaders(format),
          'Accept-Ranges': 'bytes',
          'Content-Length': String(object.size),
          ETag: object.httpEtag,
        },
      });
    }

    let head: R2Object | null;
    try {
      head = await bucket.head(key);
    } catch (err) {
      log('warn', 'recording.archive.read_failed', { callId, error: errText(err) });
      return null;
    }
    if (!head) return null;

    const size = head.size;
    const requested = parseRangeHeader(rangeHeader, size);

    if (requested.kind === 'unsatisfiable') {
      log('info', 'recording.archive.range_unsatisfiable', { callId, format, size });
      return new Response(null, {
        status: 416,
        headers: {
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
          'Accept-Ranges': 'bytes',
          // A 416 is caused BY the Range header, so it varies by it too.
          Vary: 'Range',
          'Content-Range': unsatisfiedContentRangeValue(size),
        },
      });
    }

    // A header we deliberately ignore (malformed, or multi-range) falls back to
    // the whole object, which RFC 9110 permits and every player handles.
    const options: R2GetOptions =
      requested.kind === 'range'
        ? { range: { offset: requested.offset, length: requested.length } }
        : {};
    let object: R2ObjectBody | null;
    try {
      object = await bucket.get(key, options);
    } catch (err) {
      log('warn', 'recording.archive.read_failed', { callId, error: errText(err) });
      return null;
    }
    if (!object) return null;

    if (requested.kind === 'none') {
      log('info', 'recording.archive.served', { callId, format, status: 200 });
      return new Response(object.body, {
        status: 200,
        headers: {
          ...recordingHeaders(format),
          'Accept-Ranges': 'bytes',
          'Content-Length': String(size),
          ETag: head.httpEtag,
        },
      });
    }

    log('info', 'recording.archive.served', {
      callId,
      format,
      status: 206,
      offset: requested.offset,
      length: requested.length,
    });
    return new Response(object.body, {
      status: 206,
      headers: {
        ...recordingHeaders(format),
        'Accept-Ranges': 'bytes',
        'Content-Length': String(requested.length),
        'Content-Range': contentRangeValue(requested.offset, requested.length, size),
        ETag: head.httpEtag,
      },
    });
  }

  /** Reduce one event, persist, then run the resulting effects. */
  private async apply(event: CallEvent): Promise<CallState> {
    const prev = await this.load();
    if (!prev) {
      log('warn', 'do.event.no_state', { eventType: event.type });
      throw new Error('call state not initialized');
    }
    const { state, effects } = reduce(prev, event);
    await this.save(state);
    log('info', 'call.transition', {
      callId: state.callId,
      eventType: event.type,
      phase: state.phase,
      effects: effects.length,
    });
    for (const effect of effects) {
      await this.runEffect(effect, state);
    }
    return state;
  }

  private async runEffect(effect: CallEffect, state: CallState): Promise<void> {
    switch (effect.type) {
      case 'dial_leg_b':
        await this.dialLegB(state);
        return;
      case 'arm_connect_deadline':
        this.armConnectDeadline(state);
        return;
      case 'open_xai_ws':
        await this.openXaiSocket(effect.xaiCallId, state);
        return;
      case 'refresh_instructions':
        this.refreshInstructions(state);
        return;
      case 'teardown':
        await this.teardown(effect.reason, state);
        return;
      case 'dial_forward':
        await this.dialForward(effect.to, effect.index, effect.timeoutSecs, state);
        return;
      case 'hangup_forward':
        await this.hangupForward(effect.legF, state.callId);
        return;
      case 'start_monitor':
        await this.startMonitor(state);
        return;
      case 'start_recording':
        await this.startRecording(state);
        return;
      case 'announce_recording':
        await this.announceRecording(effect.conferenceId, effect.toEveryone, state);
        return;
      case 'archive_recording':
        this.beginRecordingArchive(effect.asset, state);
        return;
      case 'create_conference':
        await this.createConf(effect.legId, effect.leg, state);
        return;
      case 'join_conference':
        await this.joinConf(
          {
            conferenceId: effect.conferenceId,
            legId: effect.legId,
            endConferenceOnExit: effect.endConferenceOnExit,
            pid: effect.pid,
            supervisorRole: effect.supervisorRole,
            whisperLegIds: effect.whisperLegIds,
          },
          state,
        );
        return;
      case 'dial_participant':
        await this.dialParticipant(effect.pid, effect.to, state);
        return;
      case 'drop_participant':
        await this.dropParticipant(effect.pid, effect.legId, state.callId);
        return;
      case 'set_participant_mute':
        await this.setParticipantMute(
          effect.conferenceId,
          effect.legId,
          effect.muted,
          state.callId,
        );
        return;
      case 'set_participant_hold':
        await this.setParticipantHold(effect.conferenceId, effect.legId, effect.held, state.callId);
        return;
      case 'end_conference':
        await this.endConf(effect.conferenceId, state.callId);
        return;
      case 'announce_participant':
        await this.announceParticipant(effect.conferenceId, effect.pid, state);
        return;
      default: {
        const _never: never = effect;
        return;
      }
    }
  }

  private monitorStub(callId: string): DurableObjectStub | null {
    const namespace = this.env.MONITOR_SESSION;
    return namespace ? namespace.get(namespace.idFromName(callId)) : null;
  }

  /** Start Telnyx's monitor-only both-track stream after leg A answers. */
  private async startMonitor(state: CallState): Promise<void> {
    const monitor = this.monitorStub(state.callId);
    if (!monitor || !state.legA || !this.env.BETTER_AUTH_SECRET) {
      log('warn', 'monitor.start.unavailable', { callId: state.callId });
      return;
    }
    try {
      const token = await issueMediaToken(this.env.BETTER_AUTH_SECRET, state.callId, 'ingress');
      const streamUrl = new URL(this.env.PUBLIC_BASE_URL);
      streamUrl.protocol = 'wss:';
      streamUrl.pathname = `${streamUrl.pathname.replace(/\/+$/, '')}/telnyx-media/${encodeURIComponent(state.callId)}`;
      await startStreaming(this.telnyxConfig(), state.legA, {
        streamUrl: streamUrl.toString(),
        streamTrack: 'both_tracks',
        streamCodec: 'PCMU',
        streamAuthToken: token,
        clientState: encodeClientState({ callId: state.callId, leg: 'A' }),
        commandId: crypto.randomUUID(),
      });
      log('info', 'monitor.start.requested', { callId: state.callId });
    } catch (err) {
      // Monitoring is additive. A provider stream failure must never fail a
      // live call or make the call-control state machine retry indefinitely.
      log('warn', 'monitor.start.failed', { callId: state.callId, error: errText(err) });
    }
  }

  /** Start the requested post-call format; Telnyx emits recording.saved later. */
  private async startRecording(state: CallState): Promise<void> {
    if (!state.legA) {
      log('warn', 'recording.start.unavailable', { callId: state.callId });
      return;
    }
    const format = this.env.RECORDING_FORMAT?.toLowerCase() === 'mp3' ? 'mp3' : 'wav';
    try {
      await startTelnyxRecording(this.telnyxConfig(), state.legA, {
        format,
        channels: 'dual',
        clientState: encodeClientState({ callId: state.callId, leg: 'A' }),
        commandId: crypto.randomUUID(),
      });
      log('info', 'recording.start.requested', { callId: state.callId, format });
    } catch (err) {
      log('warn', 'recording.start.failed', { callId: state.callId, format, error: errText(err) });
    }
  }

  /**
   * Bound the window in which a live human hears nothing.
   *
   * NOT a Durable Object alarm, on purpose. Alarms cap at 15 minutes and would
   * truncate a long call (see the class comment); this is a plain in-memory
   * timer, which is sound here because the DO is continuously handling call
   * webhooks across this window and, from the moment the xAI socket opens, an
   * active outbound WebSocket blocks both hibernation and eviction.
   *
   * The timer is fire-and-forget and deliberately NOT cancelled when the call
   * connects: `reduce` makes a late `connect_deadline` a no-op once the call is
   * bridged or terminal, so correctness lives in the reducer -- one place --
   * rather than in cancellation bookkeeping spread across every success path.
   * A cancel we forgot to wire would silently disarm the guard; a no-op event
   * cannot.
   */
  private armConnectDeadline(state: CallState): void {
    const ms = connectDeadlineMs(this.env);
    const callId = state.callId;
    this.ctx.waitUntil(
      (async () => {
        await scheduler.wait(ms);
        await this.apply({ type: 'connect_deadline', at: Date.now() });
      })().catch((err) => {
        log('error', 'connect.deadline.failed', { callId, error: errText(err) });
      }),
    );
  }

  /**
   * Dial the SIP leg into xAI.
   *
   * The callId rides along in a `User-to-User` SIP header (the only header name
   * Telnyx permits) so that, IF xAI surfaces inbound SIP headers on the
   * incoming-call webhook, correlation is exact. Because that pass-through is
   * unverified, we ALSO register the call in the singleton registry as a
   * fallback -- see CallRouter usage in index.ts.
   */
  private async dialLegB(state: CallState): Promise<void> {
    // Outbound calls register in the Worker at POST /call time. Inbound calls
    // register HERE, immediately before the SIP dial: the follow-me ladder can
    // run longer than PENDING_TTL_MS, so an entry made at answer time could be
    // stale by the moment xAI's incoming-call webhook needs to claim it.
    if (state.direction === 'inbound') {
      try {
        const registry = this.env.CALL_SESSION.get(this.env.CALL_SESSION.idFromName(REGISTRY_NAME));
        await registry.fetch('https://do/registry/register', {
          method: 'POST',
          body: JSON.stringify({ callId: state.callId }),
        });
      } catch (err) {
        // Non-fatal: the User-to-User SIP header remains the primary path.
        log('error', 'registry.register.failed', { callId: state.callId, error: errText(err) });
      }
    }
    const target = xaiSipUri(this.env.XAI_PHONE_NUMBER, this.env.XAI_SIP_HOST);
    try {
      const result = await dial(this.telnyxConfig(), {
        to: target,
        clientState: encodeClientState({ callId: state.callId, leg: 'B' }),
        commandId: crypto.randomUUID(),
        webhookUrl: `${this.env.PUBLIC_BASE_URL}/telnyx-webhook`,
        sipHeaders: [{ name: 'User-to-User', value: state.callId }],
        linkTo: state.legA ?? undefined,
      });
      await this.apply({ type: 'leg_b_dialed', legB: result.callControlId, at: Date.now() });
    } catch (err) {
      log('error', 'call.leg_b.dial_failed', {
        callId: state.callId,
        error: errText(err),
      });
      await this.apply({ type: 'failed', reason: `leg_b_dial: ${errText(err)}`, at: Date.now() });
    }
  }

  /**
   * Ring one follow-me target. AMD runs on THIS leg because "answered" from
   * the carrier includes the target's own voicemail — the verdict is what
   * separates bridging the caller to a human from dumping them into a beep.
   */
  private async dialForward(
    to: string,
    index: number,
    timeoutSecs: number,
    state: CallState,
  ): Promise<void> {
    try {
      const result = await dial(this.telnyxConfig(), {
        to,
        clientState: encodeClientState({ callId: state.callId, leg: 'F' }),
        commandId: crypto.randomUUID(),
        webhookUrl: `${this.env.PUBLIC_BASE_URL}/telnyx-webhook`,
        answeringMachineDetection: 'detect',
        timeoutSecs,
        linkTo: state.legA ?? undefined,
      });
      log('info', 'inbound.forward.dialed', { callId: state.callId, index });
      await this.apply({ type: 'forward_dialed', legF: result.callControlId, at: Date.now() });
    } catch (err) {
      log('error', 'inbound.forward.dial_failed', {
        callId: state.callId,
        index,
        error: errText(err),
      });
      // Advances the ladder (next target, or the AI) — never strands the caller.
      await this.apply({ type: 'forward_dial_failed', at: Date.now() });
    }
  }

  /** Hang up an abandoned forward leg (its voicemail answered). Best-effort. */
  private async hangupForward(legF: string, callId: string): Promise<void> {
    try {
      await hangup(this.telnyxConfig(), legF, crypto.randomUUID());
      log('info', 'inbound.forward.hangup', { callId });
    } catch (err) {
      // Already down (e.g. voicemail box disconnected first) is fine.
      log('info', 'inbound.forward.hangup_noop', { callId, error: errText(err) });
    }
  }

  private async openXaiSocket(xaiCallId: string, state: CallState): Promise<void> {
    if (this.ws) {
      log('warn', 'xai.ws.already_open', { callId: state.callId });
      return;
    }
    let socket: WebSocket;
    try {
      socket = await openRealtimeSocket(this.env.XAI_API_KEY, xaiCallId);
    } catch (err) {
      log('error', 'xai.ws.open_failed', { callId: state.callId, error: errText(err) });
      await this.apply({ type: 'failed', reason: `xai_ws: ${errText(err)}`, at: Date.now() });
      return;
    }
    this.ws = socket;

    socket.addEventListener('message', (evt: MessageEvent) => {
      const raw = typeof evt.data === 'string' ? evt.data : '';
      if (!raw) return; // binary audio frame; we never carry audio
      this.ctx.waitUntil(this.onServerEvent(raw));
    });
    socket.addEventListener('close', (evt: CloseEvent) => {
      log('info', 'xai.ws.close', { code: evt.code, reason: evt.reason.slice(0, 120) });
      this.ws = null;
    });
    socket.addEventListener('error', () => {
      log('error', 'xai.ws.error', { callId: state.callId });
      this.ws = null;
    });

    // THIS is the whole trick: inject this call's task into the session.
    const instructions = buildInstructions({
      task: state.task,
      direction: state.direction,
      amdResult: state.amdResult,
      // Evaluated HERE, not at dial time: the window starts at the moment the
      // call is actually live, so any slot that elapsed while the phone was
      // ringing has already dropped out of the offer.
      availability: availabilityText(state, this.env.CALCOM_BOOKING_URL),
      // Who ELSE is on the line. This is the channel the join notice rides:
      // participant_joined emits refresh_instructions, which lands here.
      participants: joinedParticipantLabels(state),
    });
    socket.send(
      JSON.stringify(
        buildSessionUpdate({
          voice: state.voice,
          instructions,
          inputTranscription: this.env.XAI_INPUT_TRANSCRIPTION !== 'false',
          dtmfTool: dtmfToolEnabled(state),
          conferenceTool: conferenceToolEnabled(state),
        }),
      ),
    );
    socket.send(JSON.stringify(buildResponseCreate()));
    log('info', 'xai.session.configured', {
      callId: state.callId,
      voice: state.voice,
      instructionsChars: instructions.length,
    });
  }

  private async onServerEvent(raw: string): Promise<void> {
    const event = classifyServerEvent(raw);
    switch (event.kind) {
      case 'session_ready':
        await this.apply({ type: 'xai_session_ready', at: Date.now() });
        return;
      case 'transcript':
        await this.apply({
          type: 'transcript',
          role: event.role,
          text: event.text,
          at: Date.now(),
        });
        return;
      case 'function_call':
        await this.handleFunctionCall(event.name, event.callId, event.args);
        return;
      case 'error':
        log('error', 'xai.server_event.error', { message: event.message.slice(0, 300) });
        return;
      case 'ignored':
        return;
      default: {
        const _never: never = event;
        return;
      }
    }
  }

  /**
   * Run a model-requested tool and hand the result back over the same socket.
   *
   * The reply is two messages, in the documented order: a
   * `conversation.item.create` carrying `function_call_output`, then
   * `response.create` so the model resumes. A tool that fails still gets a
   * RESULT rather than silence -- a model left waiting on a call it made will
   * usually stall or start improvising, and on a live phone call either is
   * worse than being told plainly that the keypress did not go through.
   *
   * KNOWN LIMITATION, stated rather than hidden: xAI documents that when the
   * model emits SEVERAL function calls in one turn, every output must be sent
   * before a SINGLE `response.create`. Each call is answered independently
   * here, so a parallel pair would produce two. With one single-purpose tool
   * that is not reachable today; it would have to be revisited before a second
   * tool is added.
   */
  private async handleFunctionCall(name: string, callId: string, args: string): Promise<void> {
    const result = await this.runTool(name, args);
    const socket = this.ws;
    if (!socket) {
      log('warn', 'tool.result.no_socket', { tool: name });
      return;
    }
    // `output` is documented as a JSON *string*, not an object.
    socket.send(JSON.stringify(buildFunctionCallOutput(callId, JSON.stringify(result.output))));
    socket.send(JSON.stringify(buildResponseCreate(result.followUpInstructions)));
  }

  /** Dispatch one tool call. Never throws: every path yields a result object. */
  private async runTool(name: string, args: string): Promise<ToolResult> {
    if (name === SEND_DTMF_TOOL_NAME) {
      return await this.runSendDtmf(args);
    }
    if (name === ADD_CONFERENCE_PARTICIPANT_TOOL_NAME) {
      return await this.runAddConferenceParticipant(args);
    }
    // The name is model-supplied and unbounded, so it is truncated before it
    // reaches the log or the error string -- the same treatment
    // `xai.server_event.error` already gives provider-supplied text.
    const safeName = name.slice(0, 64);
    log('warn', 'tool.unknown', { tool: safeName });
    return { output: { ok: false, error: `unknown tool: ${safeName}` } };
  }

  /** Validate, then play the requested tones toward the IVR on LEG A. */
  private async runSendDtmf(args: string): Promise<ToolResult> {
    const state = await this.load();
    if (!state) {
      return { output: { ok: false, error: 'call is no longer active' } };
    }
    if (!dtmfToolEnabled(state)) {
      log('warn', 'dtmf.refused.inbound', { callId: state.callId });
      return { output: { ok: false, error: 'the keypad is not available on this call' } };
    }
    // LEG A, and only leg A. Leg B is the SIP leg into xAI, so sending there
    // would play the tones at the model instead of at the phone tree.
    const legA = state.legA;
    if (!legA) {
      log('warn', 'dtmf.refused.no_leg', { callId: state.callId });
      return { output: { ok: false, error: 'the call is not connected yet' } };
    }

    let parsed: unknown;
    try {
      parsed = args.trim().length > 0 ? JSON.parse(args) : {};
    } catch {
      log('warn', 'dtmf.rejected', { callId: state.callId, reason: 'unparseable arguments' });
      return { output: { ok: false, error: 'arguments were not valid JSON' } };
    }
    const digitsRaw =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)['digits']
        : undefined;

    const validated = validateDtmfDigits(digitsRaw);
    if (!validated.ok) {
      log('warn', 'dtmf.rejected', { callId: state.callId, reason: validated.reason });
      return { output: { ok: false, error: validated.reason } };
    }
    const digits = validated.digits;

    const pressed = (await this.ctx.storage.get<number>(DTMF_PRESS_COUNT_KEY)) ?? 0;
    if (pressed >= DTMF_MAX_PRESSES_PER_CALL) {
      log('warn', 'dtmf.refused.budget', { callId: state.callId, pressed });
      return {
        output: { ok: false, error: 'the keypad limit for this call has been reached' },
      };
    }
    // Counted BEFORE the send, so a provider call that times out still spends
    // its budget. A loop must terminate even when every attempt is failing.
    await this.ctx.storage.put(DTMF_PRESS_COUNT_KEY, pressed + 1);

    try {
      const status = await sendDtmf(this.telnyxConfig(), legA, {
        digits,
        clientState: encodeClientState({ callId: state.callId, leg: 'A' }),
        commandId: crypto.randomUUID(),
        durationMillis: DTMF_DURATION_MILLIS,
      });
      // The seam worth instrumenting: WHICH digits went to WHICH leg, and what
      // the provider said. send_dtmf fires no webhook, so if this line is not
      // in the log there is no other evidence the tones were ever played.
      log('info', 'dtmf.sent', {
        callId: state.callId,
        leg: 'A',
        digits,
        status,
        pressesUsed: pressed + 1,
      });
      return {
        output: { ok: true, digits, message: `Pressed ${digits}. Now listen.` },
        followUpInstructions: POST_KEYPAD_TURN_INSTRUCTIONS,
      };
    } catch (err) {
      log('error', 'dtmf.failed', { callId: state.callId, leg: 'A', digits, error: errText(err) });
      return { output: { ok: false, error: 'the keypress could not be sent' } };
    }
  }

  /** Conference a third party into the live call via the AI tool. */
  private async runAddConferenceParticipant(args: string): Promise<ToolResult> {
    const state = await this.load();
    if (!state) {
      return { output: { ok: false, error: 'call is no longer active' } };
    }
    if (!conferenceToolEnabled(state)) {
      log('warn', 'conference.refused.inbound', { callId: state.callId });
      return { output: { ok: false, error: 'conferencing is not available on this call' } };
    }
    if (isTerminal(state.phase)) {
      return { output: { ok: false, error: 'the call has already ended' } };
    }

    let parsed: unknown;
    try {
      parsed = args.trim().length > 0 ? JSON.parse(args) : {};
    } catch {
      log('warn', 'conference.tool.rejected', { callId: state.callId, reason: 'unparseable' });
      return { output: { ok: false, error: 'arguments were not valid JSON' } };
    }

    const obj =
      typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const phoneNumber = obj['phone_number'];
    const label = obj['label'];

    // Validate phone_number (required)
    if (typeof phoneNumber !== 'string' || phoneNumber.trim().length === 0) {
      log('warn', 'conference.tool.rejected', {
        callId: state.callId,
        reason: 'missing phone_number',
      });
      return { output: { ok: false, error: 'phone_number is required' } };
    }

    const e164 = phoneNumber.trim();
    // Same E.164 validation the routes use
    if (!/^\+[1-9]\d{6,14}$/.test(e164)) {
      log('warn', 'conference.tool.rejected', { callId: state.callId, reason: 'invalid E.164' });
      return { output: { ok: false, error: 'phone_number must be E.164, e.g. +14155550123' } };
    }

    // Validate label (optional)
    const cleanLabel = typeof label === 'string' ? sanitizeParticipantLabel(label) : null;

    // Check participant cap
    if (state.participants.length >= MAX_PARTICIPANTS) {
      log('warn', 'conference.tool.refused.cap', {
        callId: state.callId,
        count: state.participants.length,
      });
      return {
        output: { ok: false, error: `at most ${MAX_PARTICIPANTS} participants per call` },
      };
    }

    // Request the participant be added (same event the console uses)
    const before = state.participants.length;
    try {
      await this.apply({
        type: 'participant_requested',
        to: e164,
        label: cleanLabel,
        supervisorRole: 'barge',
        at: Date.now(),
      });
      const after = (await this.load())?.participants.length ?? before;
      if (after === before) {
        // Reducer refused it (cap reached)
        return {
          output: { ok: false, error: `at most ${MAX_PARTICIPANTS} participants per call` },
        };
      }
      log('info', 'conference.tool.requested', {
        callId: state.callId,
        to: e164,
        label: cleanLabel,
      });
      const who = cleanLabel ?? e164;
      return {
        output: {
          ok: true,
          digits: '',
          message: `Dialing ${who}. They will join when they answer.`,
        },
      };
    } catch (err) {
      log('error', 'conference.tool.failed', {
        callId: state.callId,
        to: e164,
        error: errText(err),
      });
      return { output: { ok: false, error: 'could not conference the participant' } };
    }
  }

  /** Re-send session.update with instructions rebuilt from current state. */
  private refreshInstructions(state: CallState): void {
    if (!this.ws) return;
    const instructions = buildInstructions({
      task: state.task,
      direction: state.direction,
      amdResult: state.amdResult,
      // Evaluated HERE, not at dial time: the window starts at the moment the
      // call is actually live, so any slot that elapsed while the phone was
      // ringing has already dropped out of the offer.
      availability: availabilityText(state, this.env.CALCOM_BOOKING_URL),
      // Who ELSE is on the line. This is the channel the join notice rides:
      // participant_joined emits refresh_instructions, which lands here.
      participants: joinedParticipantLabels(state),
    });
    this.ws.send(
      JSON.stringify(
        buildSessionUpdate({
          voice: state.voice,
          instructions,
          inputTranscription: this.env.XAI_INPUT_TRANSCRIPTION !== 'false',
          dtmfTool: dtmfToolEnabled(state),
          conferenceTool: conferenceToolEnabled(state),
        }),
      ),
    );
    log('info', 'xai.session.refreshed', {
      callId: state.callId,
      amdResult: state.amdResult,
    });
  }

  // --- Conference ------------------------------------------------------------

  /**
   * Create the conference from the non-leg-A leg and record its id.
   *
   * A failure here fails the CALL, exactly as a failed bridge did: without a
   * conference the two answered legs have no media path between them, which is
   * a silent call the operator pays for. Failing loudly tears both down. That
   * is true on both paths -- the AI path leaves a subject listening to nothing,
   * and the follow-me path leaves a caller and the human who answered unable to
   * hear each other.
   */
  private async createConf(legId: string, leg: 'B' | 'F', state: CallState): Promise<void> {
    try {
      const conferenceId = await createConference(this.telnyxConfig(), {
        callControlId: legId,
        // The callId is already unique per call and is what every log line and
        // webhook is keyed by, so it doubles as the conference name.
        name: state.callId,
        // The CREATOR'S OWN leg letter, not a hardcoded 'B'. This client_state
        // is what Telnyx echoes on that leg's later webhooks, so stamping 'B'
        // onto a follow-me forward leg would route its hangup into the leg-B
        // branch of telnyxEventToCallEvent -- and `hangup` completes the call,
        // so the caller would be told the conversation had ended.
        clientState: encodeClientState({ callId: state.callId, leg }),
        commandId: crypto.randomUUID(),
        // Leg A + leg B + the escalation cap. Telnyx counts EVERY leg, so this
        // is not MAX_PARTICIPANTS on its own.
        maxParticipants: 2 + MAX_PARTICIPANTS,
      });
      log('info', 'conference.created', { callId: state.callId, conferenceId, creator: leg });
      await this.apply({ type: 'conference_created', conferenceId, at: Date.now() });
    } catch (err) {
      log('error', 'conference.create.failed', { callId: state.callId, error: errText(err) });
      await this.apply({
        type: 'failed',
        reason: `conference_create: ${errText(err)}`,
        at: Date.now(),
      });
    }
  }

  /**
   * Join one leg to the conference.
   *
   * The two callers are NOT symmetric and the failure handling says so. Leg A
   * (pid null, endConferenceOnExit true) is the call itself -- if it cannot
   * join, there is no call, so the failure propagates. A PARTICIPANT that
   * cannot join is one person who did not make it onto an otherwise healthy
   * call, so their leg is hung up and the roster records the failure while the
   * subject and the AI keep talking.
   */
  private async joinConf(args: JoinConfArgs, state: CallState): Promise<void> {
    const { conferenceId, legId, endConferenceOnExit, pid } = args;
    const clientState =
      pid === null
        ? encodeClientState({ callId: state.callId, leg: 'A' })
        : encodeClientState({ callId: state.callId, leg: 'P', pid });
    try {
      await joinConference(this.telnyxConfig(), conferenceId, {
        callControlId: legId,
        clientState,
        commandId: crypto.randomUUID(),
        endConferenceOnExit,
        supervisorRole: args.supervisorRole,
        whisperCallControlIds: args.whisperLegIds,
      });
      log('info', 'conference.join.requested', {
        callId: state.callId,
        conferenceId,
        pid,
        endConferenceOnExit,
        supervisorRole: args.supervisorRole,
      });
    } catch (err) {
      log('error', 'conference.join.failed', {
        callId: state.callId,
        conferenceId,
        pid,
        error: errText(err),
      });
      if (pid === null) {
        await this.apply({
          type: 'failed',
          reason: `conference_join: ${errText(err)}`,
          at: Date.now(),
        });
        return;
      }
      // Their leg is up and answered but in no conference: nobody can hear
      // them and they can hear nobody, while the leg bills. Hang it up.
      await this.hangupLeg(legId, state.callId, 'participant join failed');
      await this.apply({ type: 'participant_dial_failed', pid, at: Date.now() });
    }
  }

  /**
   * Ring one escalation participant.
   *
   * NO answering-machine detection, unlike the follow-me ladder. AMD exists
   * there to decide whether a caller may be bridged to what answered; here the
   * operator has named a specific person to bring onto a call already in
   * progress, and the extra $0.002 plus the detection delay buy nothing. If
   * their voicemail picks up, the operator can see it on the roster and drop it.
   */
  private async dialParticipant(pid: string, to: string, state: CallState): Promise<void> {
    try {
      const result = await dial(this.telnyxConfig(), {
        to,
        clientState: encodeClientState({ callId: state.callId, leg: 'P', pid }),
        commandId: crypto.randomUUID(),
        webhookUrl: `${this.env.PUBLIC_BASE_URL}/telnyx-webhook`,
        timeoutSecs: PARTICIPANT_RING_SECS,
        linkTo: state.legA ?? undefined,
      });
      log('info', 'participant.dialed', { callId: state.callId, pid });
      await this.apply({
        type: 'participant_dialed',
        pid,
        legId: result.callControlId,
        at: Date.now(),
      });
    } catch (err) {
      log('error', 'participant.dial_failed', { callId: state.callId, pid, error: errText(err) });
      await this.apply({ type: 'participant_dial_failed', pid, at: Date.now() });
    }
  }

  /**
   * Drop a participant by HANGING UP their leg.
   *
   * Deliberately not the conference `leave` action, which Telnyx documents as
   * moving the leg "back to PARKED state" -- still up, still billing, connected
   * to nothing. The roster row is not marked left here either: the hangup
   * webhook this causes is what stamps `leftAt`, and that is the instant the
   * leg actually stopped costing money.
   */
  private async dropParticipant(pid: string, legId: string, callId: string): Promise<void> {
    await this.hangupLeg(legId, callId, `participant ${pid} dropped`);
  }

  private async setParticipantMute(
    conferenceId: string,
    legId: string,
    muted: boolean,
    callId: string,
  ): Promise<void> {
    try {
      await setConferenceMute(this.telnyxConfig(), conferenceId, { callControlId: legId, muted });
      log('info', 'participant.mute', { callId, muted });
    } catch (err) {
      // Best-effort: a failed mute must not end a live call. The roster already
      // shows the requested state, so the console reflects the intent; the
      // operator can retry.
      log('warn', 'participant.mute.failed', { callId, muted, error: errText(err) });
    }
  }

  /**
   * Hold or unhold ONE participant.
   *
   * Non-fatal on failure for the same reason mute is: the call is fine, one
   * control did not take, and killing a live conversation over it would be a
   * far worse outcome than a stale button.
   */
  private async setParticipantHold(
    conferenceId: string,
    legId: string,
    held: boolean,
    callId: string,
  ): Promise<void> {
    try {
      await setConferenceHold(this.telnyxConfig(), conferenceId, { callControlId: legId, held });
      log('info', 'participant.hold.requested', { callId, held });
    } catch (err) {
      log('warn', 'participant.hold.failed', { callId, held, error: errText(err) });
    }
  }

  /** End the conference and terminate every remaining participant. Best-effort. */
  private async endConf(conferenceId: string, callId: string): Promise<void> {
    try {
      await endConference(this.telnyxConfig(), conferenceId, crypto.randomUUID());
      log('info', 'conference.ended', { callId, conferenceId });
    } catch (err) {
      // Expected whenever end_conference_on_exit already did the job -- the
      // conference is gone, so ending it 404s. That is the success path for the
      // carrier-side guarantee, not a failure.
      log('info', 'conference.end.noop', { callId, error: errText(err) });
    }
  }

  /**
   * Speak the join notice to everyone on the conference.
   *
   * SPOKEN IN THE CALL'S OWN AGENT VOICE by default (`xAI.<voice>`), not a
   * stranger's. A different TTS voice cutting into a live conversation is
   * jarring, and this costs nothing to avoid -- Telnyx exposes xAI as a TTS
   * provider, verified live on this account (see conferenceNoticeVoice).
   *
   * WHY TELNYX SPEAKS IT AND NOT GROK, which would also give one voice: this is
   * a CONSENT notice, and Telnyx's `speak` is deterministic -- exactly those
   * words, at that moment, guaranteed by the carrier. Asking the model to say it
   * would make the notice a best-effort behaviour of a language model: it could
   * paraphrase it, be talked over, or queue behind whatever turn is in flight
   * while the new arrival listens to something confidential. Worse, forcing
   * specific words needs a per-response `instructions` override, which was
   * MEASURED (2026-08-28) to REPLACE the session prompt for that turn -- running
   * the announcement turn with the identity line and guardrails stripped.
   *
   * BEST-EFFORT: a failed announcement costs the notice, never the call.
   */
  private async announceParticipant(
    conferenceId: string,
    pid: string,
    state: CallState,
  ): Promise<void> {
    const participant = findParticipant(state, pid);
    if (!participant) return;
    // The operator can switch the notice off for the whole call. Logged, so a
    // silent join is distinguishable from an announcement that failed.
    if (!state.noticeEnabled) {
      log('info', 'participant.announce.suppressed', { callId: state.callId, pid });
      return;
    }
    // The recording clause is only true when recording actually started --
    // under the default on_demand mode it has not.
    const notice = participantJoinNotice(participant.label, state.recordingStarted);
    const cfg = this.telnyxConfig();
    let how: 'played' | 'spoke';
    try {
      // PRIMARY: render in the call's OWN voice, then play the file. This is
      // the only path that can use the agent's actual voice -- Telnyx's
      // conference `speak` accepts five xAI voices and the Worker's default is
      // not one of them (CONFERENCE_SPEAK_XAI_VOICES).
      await this.renderAndPlay(cfg, conferenceId, notice, state);
      how = 'played';
    } catch (renderErr) {
      log('warn', 'participant.announce.render_failed', {
        callId: state.callId,
        pid,
        error: errText(renderErr),
      });
      try {
        // FALLBACK: a consent notice in a house voice beats no consent notice.
        // This is the ONLY reason the `speak` path survives.
        await conferenceSpeak(cfg, conferenceId, {
          payload: notice,
          voice: conferenceNoticeVoice(state.voice, this.env.CONFERENCE_NOTICE_VOICE),
          commandId: crypto.randomUUID(),
        });
        how = 'spoke';
      } catch (err) {
        log('warn', 'participant.announce.failed', {
          callId: state.callId,
          pid,
          error: errText(err),
        });
        // Deliberately NO transcript entry here. The record has to say what
        // was actually heard on the call, and nothing was.
        return;
      }
    }
    log('info', 'participant.announced', { callId: state.callId, pid, how });
    // The notice is carrier-side TTS: it never travels over the xAI socket, so
    // no `response.output_audio_transcript.done` will ever carry it and the
    // transcript would otherwise show a participant joining in silence. Now
    // that the notice carries the AGENT'S OWN VOICE, that gap is worse
    // than cosmetic -- a reader would hear the agent say something the record
    // does not contain. `system` is the transcript role for exactly this: text
    // that was heard but was not said by either party.
    await this.apply({ type: 'transcript', role: 'system', text: notice, at: Date.now() });
  }

  /**
   * Render the notice in the call's own voice and play it into the conference.
   *
   * Three carrier calls, and each one has to succeed for anyone to hear
   * anything, so this throws rather than degrading silently -- the caller owns
   * the fallback. A `play` 200 means Telnyx ACCEPTED the command, the same
   * guarantee the old `speak` gave; neither endpoint tells us the audio
   * reached anybody's ear.
   *
   * The media object is uploaded under a fresh UUID each time rather than a
   * name derived from the text. Telnyx documents no 409 and no upsert
   * behaviour for a repeated `media_name`, so reusing one would be building on
   * an undocumented semantic; a unique name plus NOTICE_MEDIA_TTL_SECS costs
   * one re-render per join and leaves nothing behind.
   */
  private async renderAndPlay(
    cfg: TelnyxConfig,
    conferenceId: string,
    notice: string,
    state: CallState,
    callControlIds?: readonly string[] | undefined,
  ): Promise<void> {
    const bytes = await synthesizeSpeech(cfg, {
      text: notice,
      voice: noticeRenderVoice(state.voice, this.env.CONFERENCE_NOTICE_VOICE),
    });
    const mediaName = `notice-${crypto.randomUUID()}`;
    await uploadMedia(cfg, { bytes, mediaName, ttlSecs: NOTICE_MEDIA_TTL_SECS });
    await conferencePlay(cfg, conferenceId, {
      mediaName,
      commandId: crypto.randomUUID(),
      callControlIds,
    });
  }

  /**
   * Say that recording just started.
   *
   * Reuses the same render-and-play path as the join notice, so it speaks in
   * the call's own agent voice across the full xAI catalog rather than the
   * five voices `speak` accepts.
   *
   * Best-effort by the same reasoning: the recording itself is the thing that
   * matters, and a failed announcement must not prevent it. But unlike the
   * join notice this one does NOT fall back to `speak` -- a disclosure the
   * operator scoped to themselves must never escape to the whole conference
   * because the primary path failed, and `speak`'s leg scoping is a separate
   * contract from `play`'s.
   */
  private async announceRecording(
    conferenceId: string,
    toEveryone: boolean,
    state: CallState,
  ): Promise<void> {
    const notice = recordingStartedNotice();
    const scope = toEveryone ? undefined : state.legA ? [state.legA] : undefined;
    // A scoped announcement with no leg to scope TO would broadcast. Refuse.
    if (!toEveryone && !scope) {
      log('warn', 'recording.announce.no_scope', { callId: state.callId });
      return;
    }
    try {
      await this.renderAndPlay(this.telnyxConfig(), conferenceId, notice, state, scope);
      log('info', 'recording.announced', { callId: state.callId, toEveryone });
    } catch (err) {
      log('warn', 'recording.announce.failed', {
        callId: state.callId,
        toEveryone,
        error: errText(err),
      });
      return;
    }
    // Only a disclosure everyone heard belongs in the shared record. A private
    // confirmation was heard by one leg and the transcript must not imply the
    // others were told.
    if (toEveryone) {
      await this.apply({ type: 'transcript', role: 'system', text: notice, at: Date.now() });
    }
  }

  /** Hang up one leg, tolerating a leg that is already down. */
  private async hangupLeg(legId: string, callId: string, why: string): Promise<void> {
    try {
      await hangup(this.telnyxConfig(), legId, crypto.randomUUID());
      log('info', 'call.leg.hangup', { callId, why });
    } catch (err) {
      log('info', 'call.leg.hangup_noop', { callId, why, error: errText(err) });
    }
  }

  // --- Durable archive ------------------------------------------------------

  /**
   * Copy a saved recording into R2 without blocking the webhook response.
   *
   * `waitUntil` rather than `await`: the download is the size of the whole call
   * and Telnyx is waiting on a 200 for a webhook it will otherwise redeliver.
   * The call log is rewritten afterwards so the archived record names the
   * recording it now owns.
   */
  private beginRecordingArchive(asset: RecordingAsset, state: CallState): void {
    const bucket = this.env.CALL_LOGS;
    if (!bucket) return;
    this.ctx.waitUntil(
      (async () => {
        const key = await archiveRecording(
          bucket,
          asset,
          state.callId,
          recordingUrlGuard(this.env),
        );
        // Record the outcome, not the intent. A null here means the bytes did
        // not land, and the archive must say so rather than advertise a
        // playback that would 404.
        if (key) await this.rememberArchivedKey(key);
        // Recordings arrive AFTER teardown, so the record written at teardown
        // listed none. Rewrite it at the same key now that one exists.
        if (isTerminal(state.phase)) {
          await this.writeCallLog(state, state.failureReason ?? `phase:${state.phase}`);
        }
      })(),
    );
  }

  /** Append one confirmed-stored recording key, without duplicating it. */
  private async rememberArchivedKey(key: string): Promise<void> {
    const stored = (await this.ctx.storage.get<string[]>(ARCHIVED_KEYS_KEY)) ?? [];
    if (stored.includes(key)) return;
    await this.ctx.storage.put(ARCHIVED_KEYS_KEY, [...stored, key]);
  }

  /**
   * Write this call's archive record to R2. Safe to call repeatedly.
   *
   * The anchor persisted on the first call pins both the object key and the
   * recorded end time, so every later write overwrites that one object instead
   * of adding a row. A failure is logged and swallowed: losing the archive must
   * never change how a call ends.
   */
  private async writeCallLog(state: CallState, fallbackReason: string): Promise<void> {
    const bucket = this.env.CALL_LOGS;
    if (!bucket) return;
    let anchor = await this.ctx.storage.get<CallLogAnchor>(LOG_ANCHOR_KEY);
    if (!anchor) {
      anchor = {
        key: callLogKey(state.callId, state.updatedAt),
        endedAt: state.updatedAt,
        reason: fallbackReason,
      };
      await this.ctx.storage.put(LOG_ANCHOR_KEY, anchor);
    }
    const record = buildCallLogRecord({
      state,
      teardownReason: anchor.reason,
      archivedKeys: (await this.ctx.storage.get<string[]>(ARCHIVED_KEYS_KEY)) ?? [],
      // The archive holds the full number, the same one the console shows.
      // Masking was removed 2026-08-29 at the operator's explicit request:
      // a campaign dialing many targets inside one area code cannot be read
      // from a country code and two digits.
      to: state.to,
      endedAt: anchor.endedAt,
    });
    await putCallLogRecord(bucket, anchor.key, record);
  }

  private async teardown(reason: string, state: CallState): Promise<void> {
    log('info', 'call.teardown', { callId: state.callId, reason });
    // Archive FIRST. The hangup loop below makes up to three provider calls
    // that can each stall, and this record is the only durable, enumerable
    // trace the call leaves behind.
    await this.writeCallLog(state, reason);
    // Remove from live registry for concurrent cap tracking.
    try {
      const registry = this.env.CALL_SESSION.get(this.env.CALL_SESSION.idFromName(REGISTRY_NAME));
      await registry.fetch('https://do/registry/remove-live', {
        method: 'POST',
        body: JSON.stringify({ callId: state.callId }),
      });
    } catch (err) {
      log('warn', 'registry.remove_live.failed', { callId: state.callId, error: errText(err) });
    }
    const monitor = this.monitorStub(state.callId);
    if (monitor) {
      try {
        await monitor.fetch(`https://monitor/close?callId=${encodeURIComponent(state.callId)}`, {
          method: 'POST',
        });
      } catch (err) {
        log('warn', 'monitor.close.failed', { callId: state.callId, error: errText(err) });
      }
    }
    if (this.ws) {
      try {
        this.ws.close(1000, 'call ended');
      } catch (err) {
        log('warn', 'xai.ws.close_failed', { error: errText(err) });
      }
      this.ws = null;
    }
    // END THE CONFERENCE FIRST. Telnyx documents `end` as "End a conference and
    // terminate all active participants", so this is the one command that
    // reaches EVERY leg including ones this DO may not have a call_control_id
    // for. It is belt-and-braces behind `end_conference_on_exit: true` on leg A,
    // which is the primary guarantee; on the paths that flag does not cover --
    // a `failed` event before leg A ever joined, an operator hangup, a teardown
    // triggered by the xAI side -- this is what stops participants being left
    // parked and billing.
    if (state.conferenceId) {
      await this.endConf(state.conferenceId, state.callId);
    }
    // Best-effort: hang up any leg still up. Telnyx's default (we do not set
    // park_after_unbridge) already tears down the far side of a bridged pair,
    // so this mostly matters when we failed BEFORE connecting.
    //
    // PARTICIPANT LEGS ARE IN THIS LIST. They were not before conferences
    // existed, and leaving them out is exactly the leak this feature could
    // introduce: an escalation leg is a real outbound PSTN call, so one missed
    // by teardown bills until the far end hangs up on its own.
    const participantLegs = state.participants
      .filter((participant) => participant.status !== 'left' && participant.status !== 'failed')
      .map((participant) => participant.legId);
    for (const leg of [state.legA, state.legB, state.legF, ...participantLegs]) {
      if (!leg) continue;
      try {
        await hangup(this.telnyxConfig(), leg, crypto.randomUUID());
      } catch (err) {
        // A leg that already ended returns an error; that is expected, not fatal.
        log('info', 'call.hangup.noop', { error: errText(err) });
      }
    }
  }

  // --- Registry role (singleton instance only) ------------------------------

  /**
   * Record that a call is waiting for xAI's incoming-call webhook.
   * Used only on the `__registry__` instance.
   */
  private async handleRegistryRegister(request: Request): Promise<Response> {
    const body = (await request.json()) as { callId: string };
    const now = Date.now();
    const pending = (await this.ctx.storage.get<PendingEntry[]>(PENDING_KEY)) ?? [];
    const fresh = pending.filter((p) => now - p.at < PENDING_TTL_MS);
    fresh.push({ callId: body.callId, at: now });
    await this.ctx.storage.put(PENDING_KEY, fresh);
    log('info', 'registry.register', { callId: body.callId, depth: fresh.length });
    return Response.json({ ok: true, depth: fresh.length });
  }

  /**
   * Claim the OLDEST non-stale pending call.
   *
   * LIMITATION, stated plainly: with several outbound calls in flight at once
   * and no SIP header pass-through from xAI, this FIFO claim can mis-pair a
   * call with the wrong task. It is correct for serial calling and is only the
   * fallback -- the User-to-User SIP header is the exact path when available.
   */
  private async handleRegistryClaim(): Promise<Response> {
    const now = Date.now();
    const pending = (await this.ctx.storage.get<PendingEntry[]>(PENDING_KEY)) ?? [];
    const fresh = pending.filter((p) => now - p.at < PENDING_TTL_MS);
    const claimed = fresh.shift();
    await this.ctx.storage.put(PENDING_KEY, fresh);
    if (!claimed) {
      log('warn', 'registry.claim.empty', {});
      return Response.json({ callId: null }, { status: 404 });
    }
    log('info', 'registry.claim.ok', { callId: claimed.callId, remaining: fresh.length });
    return Response.json({ callId: claimed.callId });
  }

  /**
   * Add a live call to the registry for concurrent cap enforcement.
   * Used only on the `__registry__` instance.
   */
  private async handleRegistryAddLive(request: Request): Promise<Response> {
    const body = (await request.json()) as { callId: string; to: string; subject?: string };
    const live = (await this.ctx.storage.get<LiveCallEntry[]>(LIVE_CALLS_KEY)) ?? [];
    const exists = live.find((entry) => entry.callId === body.callId);
    if (exists) {
      return Response.json({ ok: true, count: live.length });
    }
    live.push({
      callId: body.callId,
      to: body.to,
      subject: body.subject ?? null,
      startedAt: Date.now(),
    });
    await this.ctx.storage.put(LIVE_CALLS_KEY, live);
    log('info', 'registry.add_live', { callId: body.callId, count: live.length });
    return Response.json({ ok: true, count: live.length });
  }

  /**
   * Remove a terminated call from the live registry.
   * Used only on the `__registry__` instance.
   */
  private async handleRegistryRemoveLive(request: Request): Promise<Response> {
    const body = (await request.json()) as { callId: string };
    const live = (await this.ctx.storage.get<LiveCallEntry[]>(LIVE_CALLS_KEY)) ?? [];
    const filtered = live.filter((entry) => entry.callId !== body.callId);
    await this.ctx.storage.put(LIVE_CALLS_KEY, filtered);
    log('info', 'registry.remove_live', { callId: body.callId, remaining: filtered.length });
    return Response.json({ ok: true, count: filtered.length });
  }

  /**
   * List all live (non-terminal) calls for console and API.
   * Used only on the `__registry__` instance.
   */
  private async handleRegistryListLive(): Promise<Response> {
    const live = (await this.ctx.storage.get<LiveCallEntry[]>(LIVE_CALLS_KEY)) ?? [];
    return Response.json({ calls: live });
  }
}

/** True when this state should stop accepting new events. */
export function callIsOver(state: CallState): boolean {
  return isTerminal(state.phase);
}
