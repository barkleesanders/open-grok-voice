// Worker entrypoint: webhook/API surfaces plus authenticated monitor ingress;
// call-control code does not speak SIP or process browser audio.
//
// The Worker is deliberately thin. It authenticates, verifies signatures,
// parses untrusted JSON with Zod, works out WHICH call an event belongs to,
// and forwards a typed CallEvent to that call's Durable Object. All ordering
// and all provider calls live in the DO.

import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import {
  AuthConfigurationError,
  createAuth,
  getOperatorSession,
  type OperatorSession,
  type OperatorUser,
} from './auth';
import { availabilityFromBusy, DEFAULT_AVAILABILITY, renderSlots } from './availability';
import { fetchCalcomSlots } from './calcom';
import {
  archivedStatusView,
  CALL_LOG_PREFIX,
  findArchiveKey,
  listCallLog,
  putCallLogRecord,
  readCallLogRecord,
  subjectProvenanceRecorded,
} from './call-log';
import { CallSession, MAX_CONCURRENT_OUTBOUND, REGISTRY_NAME } from './call-session';
import { renderConsolePage } from './console-ui';
import {
  type BillableCall,
  type BillableParticipant,
  type CallCost,
  COST_DISCLAIMER,
  estimateCallCost,
  participantBillableMs,
  type RateTable,
  ratesFrom,
} from './cost';
import { type CostWindow, isCostWindow, rollupCosts } from './cost-rollup';
import type { Env } from './env';
import { composeInstructions } from './instructions';
import { errText, log } from './log';
import { issueMediaToken, verifyMediaToken } from './media';
import { MonitorSession } from './monitor-session';
import {
  deletePreset,
  listPresets,
  MAX_PRESET_NAME_CHARS,
  readPreset,
  validPresetName,
  writePreset,
} from './presets';
import { recordingAssetFromWebhook } from './recordings';
import {
  acceptCallRequest,
  cancelScheduled,
  type DialPayload,
  fireDue,
  r2ScheduleStore,
  type ScheduleStore,
  toSummary,
  validScheduleId,
} from './schedule';
import { timingSafeEqual, verifyTelnyxSignature, verifyXaiSignature } from './signatures';
import type { CallEvent } from './state';
import {
  audioTypeAccepted,
  MAX_AUDIO_BYTES,
  MAX_AUDIO_SECONDS,
  transcribeAudio,
} from './transcribe';
import {
  AddParticipantRequestSchema,
  type CallRequest,
  CallRequestSchema,
  type ClientState,
  ConsoleCallRequestSchema,
  decodeClientState,
  inboundInitiated,
  PresetSaveRequestSchema,
  RECORDING_START_DTMF,
  ScriptPreviewRequestSchema,
  sipHeader,
  TelnyxWebhookSchema,
  XaiWebhookSchema,
} from './types';

export { CallSession, MonitorSession };

/** Deny every powerful feature. The default for anything that is not the console. */
const LOCKED_PERMISSIONS_POLICY = 'camera=(), geolocation=(), microphone=()';

/**
 * The console page, and ONLY the console page, may open a microphone.
 *
 * `microphone=()` is an EMPTY allowlist, which disables the feature for every
 * origin INCLUDING same-origin, so under the locked policy above the console's
 * dictation button could never work: `getUserMedia({audio:true})` rejects with
 * NotAllowedError before the browser ever shows a permission prompt. `(self)`
 * restores it for this origin alone; camera and geolocation stay denied.
 */
const CONSOLE_PERMISSIONS_POLICY = 'camera=(), geolocation=(), microphone=(self)';

export const app = new Hono<{ Bindings: Env }>();

app.use('*', async (c, next) => {
  await next();
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cross-Origin-Opener-Policy', 'same-origin');
  c.header('Cross-Origin-Resource-Policy', 'same-origin');
  // Deny every powerful feature by default. This runs AFTER the handler, so a
  // route that deliberately chose a policy (the console, which needs a
  // microphone) must not be overwritten here.
  if (!c.res.headers.has('Permissions-Policy')) {
    c.header('Permissions-Policy', LOCKED_PERMISSIONS_POLICY);
  }
});

async function privateResponseHeaders(c: Context<{ Bindings: Env }>, next: Next): Promise<void> {
  await next();
  c.header('Cache-Control', 'private, no-store');
  c.header('Vary', 'Cookie', { append: true });
}

app.use('/console', privateResponseHeaders);
app.use('/api/me', privateResponseHeaders);
app.use('/api/console/*', privateResponseHeaders);

function callStub(env: Env, callId: string): DurableObjectStub {
  return env.CALL_SESSION.get(env.CALL_SESSION.idFromName(callId));
}

function registryStub(env: Env): DurableObjectStub {
  return env.CALL_SESSION.get(env.CALL_SESSION.idFromName(REGISTRY_NAME));
}

/** Send a typed event to a call's DO. */
async function sendEvent(env: Env, callId: string, event: CallEvent): Promise<void> {
  const res = await callStub(env, callId).fetch('https://do/event', {
    method: 'POST',
    body: JSON.stringify(event),
  });
  if (!res.ok) {
    log('warn', 'do.event.rejected', {
      callId,
      eventType: event.type,
      status: res.status,
    });
  }
}

interface LiveCallListEntry {
  readonly callId: string;
  readonly to: string;
  readonly subject?: string | null;
  readonly startedAt?: number;
}

interface StartCallResult {
  readonly ok: boolean;
  readonly callId?: string;
  readonly detail?: string;
  /** Machine-stable refusal code for HTTP mapping (e.g. dial_locked). */
  readonly code?: 'dial_locked' | 'at_cap';
}

/** Shared call creation path for the legacy API-key and operator proxy routes. */
async function startCall(env: Env, payload: DialPayload): Promise<StartCallResult> {
  const req = payload.request;

  // Check concurrent cap and same-number dial lock FIRST, before allocating a UUID.
  try {
    const liveRes = await registryStub(env).fetch('https://do/registry/list-live');
    if (liveRes.ok) {
      const liveData = (await liveRes.json()) as { calls: LiveCallListEntry[] };
      const calls = Array.isArray(liveData.calls) ? liveData.calls : [];
      if (calls.length >= MAX_CONCURRENT_OUTBOUND) {
        log('warn', 'api.call.at_cap', {
          count: calls.length,
          cap: MAX_CONCURRENT_OUTBOUND,
        });
        return {
          ok: false,
          detail: `concurrent call limit reached (${MAX_CONCURRENT_OUTBOUND} active)`,
          code: 'at_cap',
        };
      }
      // Same E.164 already live: refuse unless force=true. Agents double-dial
      // the same destination when place races; the live registry is the source
      // of truth (same list the console "live calls" view uses).
      if (!req.force) {
        const existing = calls.find((entry) => entry.to === req.to);
        if (existing) {
          log('warn', 'api.call.dial_locked', {
            to: req.to,
            existingCallId: existing.callId,
          });
          return {
            ok: false,
            callId: existing.callId,
            detail: `dial_locked: live call already exists to ${req.to}`,
            code: 'dial_locked',
          };
        }
      }
    }
  } catch (err) {
    log('error', 'registry.list_live.failed', { error: errText(err) });
  }

  const callId = crypto.randomUUID();

  // Guardrail: warn if task asks for conferencing but no participants provided.
  // The agent CANNOT invent phone numbers, so a task that says "loop in billing"
  // with an empty participants array will fail - the operator needs to either
  // provide numbers up front or understand the AI will ask them for numbers.
  const taskLower = req.task.toLowerCase();
  const conferenceKeywords = [
    'conference',
    'loop in',
    'bring in',
    'add',
    'connect with',
    'get',
    'call',
  ];
  const participantKeywords = ['supervisor', 'manager', 'billing', 'doctor', 'nurse', 'someone'];
  const asksForConference =
    conferenceKeywords.some((kw) => taskLower.includes(kw)) &&
    participantKeywords.some((kw) => taskLower.includes(kw));

  if (asksForConference && (!req.participants || req.participants.length === 0)) {
    log('warn', 'api.call.conference_without_participants', {
      callId,
      taskPrefix: req.task.slice(0, 100),
    });
    // Return a clear message rather than silently accepting a call that cannot succeed
    return {
      ok: false,
      callId,
      detail:
        'Task asks to conference someone in, but no participant numbers provided. ' +
        'The AI can request numbers but cannot invent them. Either provide participant ' +
        'numbers in the "participants" array, or make it clear the AI should ask for them.',
    };
  }

  // Register BEFORE dialing. xAI's incoming-call webhook can, in principle,
  // arrive before our own dial response is parsed; the pending entry has to
  // exist first or fallback correlation would miss it.
  try {
    await registryStub(env).fetch('https://do/registry/register', {
      method: 'POST',
      body: JSON.stringify({ callId }),
    });
  } catch (err) {
    log('error', 'registry.register.failed', { callId, error: errText(err) });
  }

  try {
    const res = await callStub(env, callId).fetch('https://do/start', {
      method: 'POST',
      body: JSON.stringify({
        callId,
        to: req.to,
        task: req.task,
        subject: req.subject ?? null,
        voice: req.voice ?? env.DEFAULT_VOICE,
        amd: req.amd ?? null,
        busy: req.busy ?? [],
        windowDays: req.windowDays ?? 7,
        slots: req.slots ?? [],
        slotMinutes: req.slotMinutes ?? 30,
        participants: req.participants ?? [],
        recording: req.recording ?? 'on_demand',
        notice: req.notice ?? true,
        // Server-only. True means "this call was set up with a calendar and it
        // was discarded as untrustworthy", which the agent must be TOLD, not
        // left to infer from an empty slot list.
        availabilityUnknown: payload.availabilityUnknown,
      }),
    });
    if (!res.ok) {
      const detail = await res.text();
      log('error', 'api.call.start_failed', { callId, status: res.status });
      return { ok: false, callId, detail: detail.slice(0, 300) };
    }
    // Add to live registry after successful dial.
    try {
      await registryStub(env).fetch('https://do/registry/add-live', {
        method: 'POST',
        body: JSON.stringify({
          callId,
          to: req.to,
          subject: req.subject ?? null,
        }),
      });
    } catch (err) {
      log('warn', 'registry.add_live.failed', { callId, error: errText(err) });
    }
    log('info', 'api.call.accepted', { callId, to: req.to });
    return { ok: true, callId };
  } catch (err) {
    log('error', 'api.call.exception', { callId, error: errText(err) });
    return { ok: false, callId };
  }
}

function scheduleStore(env: Env): ScheduleStore | null {
  return env.CALL_LOGS ? r2ScheduleStore(env.CALL_LOGS) : null;
}

function apiKeyRejected(env: Env, provided: string): boolean {
  return !env.APP_API_KEY || provided.length === 0 || !timingSafeEqual(provided, env.APP_API_KEY);
}

interface PlaceBody {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function placeCall(env: Env, req: CallRequest, now: number): Promise<PlaceBody> {
  if (req.runAt === undefined) {
    const result = await startCall(env, { request: req, availabilityUnknown: false });
    if (!result.ok) {
      // 409 for dial_locked / concurrent cap; 502 for other start failures.
      if (result.code === 'dial_locked') {
        return {
          status: 409,
          body: {
            error: 'dial_locked',
            callId: result.callId,
            detail: result.detail,
          },
        };
      }
      const isCap = result.code === 'at_cap' || result.detail?.includes('concurrent call limit');
      return {
        status: isCap ? 409 : 502,
        body: {
          error: isCap ? 'concurrent call limit reached' : 'failed to start call',
          ...(result.detail ? { detail: result.detail } : {}),
          ...(result.callId ? { callId: result.callId } : {}),
        },
      };
    }
    return { status: 202, body: { callId: result.callId, status: 'dialing' } };
  }
  const store = scheduleStore(env);
  if (!store) return { status: 503, body: { error: 'schedule store is not configured' } };
  const accepted = await acceptCallRequest(req, {
    store,
    dial: (body) => startCall(env, body),
    now,
  });
  if (accepted.kind === 'error') {
    return { status: accepted.status, body: { error: accepted.error } };
  }
  if (accepted.kind !== 'scheduled') {
    return { status: 502, body: { error: 'failed to start call' } };
  }
  return {
    status: 202,
    body: {
      scheduleId: accepted.job.id,
      status: 'scheduled',
      runAt: accepted.job.runAt,
      to: accepted.job.to,
      timeZone: accepted.job.timeZone,
      // The check the caller currently has no way to perform. `gvb call
      // schedule --run-at <epoch-ms>` makes the CALLER compute epoch ms with
      // nothing to compare it against, so naive arithmetic across a DST
      // boundary lands an hour off and nothing says so. Echoing the resolved
      // wall-clock time turns that into a one-glance confirmation.
      runAtLocal: localWallClock(accepted.job.runAt, accepted.job.timeZone),
    },
  };
}

/** Wall-clock rendering of an instant in a job's own zone, for API echo. */
function localWallClock(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(ms));
}

/**
 * cal.com username for fire-time slot re-resolution, from SERVER config.
 *
 * Read off CALCOM_BOOKING_URL rather than accepted from the caller: the caller
 * chooses the event type (an appointment length), never whose calendar is read.
 */
function calcomUsername(env: Env): string | null {
  try {
    const path = new URL(env.CALCOM_BOOKING_URL).pathname.replace(/^\/+|\/+$/g, '');
    return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(path) ? path : null;
  } catch {
    return null;
  }
}

export async function runDueSchedules(env: Env, now: number): Promise<void> {
  const store = scheduleStore(env);
  if (!store) {
    log('warn', 'schedule.tick.unconfigured', {});
    return;
  }
  const username = calcomUsername(env);
  const result = await fireDue(store, now, (body) => startCall(env, body), {
    // Re-resolving cal.com in the Worker needs NO credential -- the slots
    // endpoint is public and unauthenticated (verified live 2026-09-01). This
    // is deliberately the only availability source the Worker refreshes:
    // Google busy geometry stays caller-side, because the token that could read
    // it carries ~45 scopes and a Worker holding it would make a Worker
    // compromise a full Google-account compromise.
    resolver: username === null ? null : { fetchSlots: fetchCalcomSlots, username },
  });
  log('info', 'schedule.tick', {
    dialed: result.dialed,
    skipped: result.skipped,
    failed: result.failed,
    late: result.late,
    quiet: result.quiet,
    stranded: result.stranded,
    pruned: result.pruned,
  });
}

function nonce(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function authConfigurationAvailable(env: Env): boolean {
  try {
    createAuth(env);
    return true;
  } catch (err) {
    if (err instanceof AuthConfigurationError) return false;
    log('error', 'auth.configuration.failed', { error: errText(err) });
    return false;
  }
}

type Gate =
  | { readonly ok: true; readonly user: OperatorUser }
  | { readonly ok: false; readonly response: Response };

async function operatorGate(c: Context<{ Bindings: Env }>): Promise<Gate> {
  // Standing APP_API_KEY (x-api-key) is enough for agent/MCP console archive
  // list+get — same privilege as POST /call. Browser session cookie remains
  // valid for the human console; agents must not depend on a live Google cookie.
  const provided = c.req.header('x-api-key') ?? '';
  if (!apiKeyRejected(c.env, provided)) {
    return { ok: true, user: { name: 'api-key', image: null } };
  }
  const session: OperatorSession = await getOperatorSession(c.env, c.req.raw);
  if (session.kind === 'config_error') {
    log('error', 'auth.route.not_configured', { path: new URL(c.req.url).pathname });
    return { ok: false, response: c.json({ error: 'operator auth is not configured' }, 503) };
  }
  if (session.kind !== 'authorized') {
    return { ok: false, response: c.json({ error: 'unauthorized' }, 401) };
  }
  return { ok: true, user: session.user };
}

function opaqueCallId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function mediaTokenFromRequest(request: Request): string | null {
  const bearer = request.headers.get('Authorization');
  if (bearer?.startsWith('Bearer ')) return bearer.slice('Bearer '.length).trim() || null;
  return new URL(request.url).searchParams.get('token');
}

function securityHeaders(
  c: Context<{ Bindings: Env }>,
  contentSecurityPolicy: string,
  permissionsPolicy: string,
): void {
  c.header('Content-Security-Policy', contentSecurityPolicy);
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Permissions-Policy', permissionsPolicy);
}

// --- Health ----------------------------------------------------------------

app.get('/health', (c) => c.json({ ok: true, service: 'open-grok-voice' }));

// --- Better Auth ------------------------------------------------------------

/** Better Auth owns both OAuth callbacks and session-cookie writes. */
app.on(['GET', 'POST'], '/api/auth/*', async (c) => {
  try {
    const auth = createAuth(c.env);
    return await auth.handler(c.req.raw);
  } catch (err) {
    if (err instanceof AuthConfigurationError) {
      log('error', 'auth.route.not_configured', { path: new URL(c.req.url).pathname });
      return c.json({ error: 'operator auth is not configured' }, 503);
    }
    log('error', 'auth.route.failed', { error: errText(err) });
    return c.json({ error: 'operator auth unavailable' }, 503);
  }
});

// --- Operator console ------------------------------------------------------

app.get('/console', async (c) => {
  const session = await getOperatorSession(c.env, c.req.raw);
  let mode: 'login' | 'authorized' | 'config_error';
  let user: OperatorUser | null = null;
  let status: 200 | 503 = 200;
  if (session.kind === 'authorized') {
    mode = 'authorized';
    user = session.user;
  } else if (session.kind === 'config_error' || !authConfigurationAvailable(c.env)) {
    mode = 'config_error';
    status = 503;
  } else {
    mode = 'login';
  }
  const pageNonce = nonce();
  securityHeaders(
    c,
    `default-src 'none'; script-src 'nonce-${pageNonce}'; style-src 'nonce-${pageNonce}'; img-src 'self' data:; connect-src 'self'; media-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'`,
    CONSOLE_PERMISSIONS_POLICY,
  );
  return c.html(renderConsolePage(pageNonce, mode, user), status);
});

app.get('/api/me', async (c) => {
  const gate = await operatorGate(c);
  if (!gate.ok) return gate.response;
  return c.json({ authenticated: true, user: gate.user });
});

/** The rate table in force for this request, with operator [vars] applied. */
function ratesForEnv(env: Env): RateTable {
  return ratesFrom({
    ...(env.RATE_XAI_PER_MIN === undefined ? {} : { RATE_XAI_PER_MIN: env.RATE_XAI_PER_MIN }),
    ...(env.RATE_TELNYX_LEG_PER_MIN === undefined
      ? {}
      : { RATE_TELNYX_LEG_PER_MIN: env.RATE_TELNYX_LEG_PER_MIN }),
    ...(env.RATE_TELNYX_SIP_PER_MIN === undefined
      ? {}
      : { RATE_TELNYX_SIP_PER_MIN: env.RATE_TELNYX_SIP_PER_MIN }),
    ...(env.RATE_TELNYX_RECORDING_PER_MIN === undefined
      ? {}
      : { RATE_TELNYX_RECORDING_PER_MIN: env.RATE_TELNYX_RECORDING_PER_MIN }),
    ...(env.RATE_TELNYX_MEDIA_STREAM_PER_MIN === undefined
      ? {}
      : { RATE_TELNYX_MEDIA_STREAM_PER_MIN: env.RATE_TELNYX_MEDIA_STREAM_PER_MIN }),
    ...(env.RATE_TELNYX_AMD_PER_CALL === undefined
      ? {}
      : { RATE_TELNYX_AMD_PER_CALL: env.RATE_TELNYX_AMD_PER_CALL }),
  });
}

/** The subset of a status payload a cost can be derived from. */
interface CostableStatus {
  readonly phase: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly answeredAt: number | null;
  readonly recorded: boolean;
  /**
   * Whether this payload comes from code that RECORDS answer times.
   *
   * Decided from the archive's schema tag when there is one, and only from key
   * presence for the live Durable Object status, which has no schema and always
   * records the field.
   */
  readonly schemaKnowsAnswer: boolean;
  /** Raw participant timestamps; the cost model does the metering. */
  readonly participants: readonly BillableParticipant[];
}

/**
 * Read the cost-bearing fields out of a status payload.
 *
 * Deliberately a NAMED, targeted parser rather than a generic object guard: it
 * names exactly the six fields this feature needs and rejects anything whose
 * types do not match, so a shape change upstream surfaces as "no cost shown"
 * rather than as a plausible number derived from undefined.
 */
function costableStatus(payload: unknown): CostableStatus | null {
  if (payload === null || typeof payload !== 'object') return null;
  const record: Record<string, unknown> = { ...payload };
  const phase = record['phase'];
  const createdAt = record['createdAt'];
  const updatedAt = record['updatedAt'];
  const answeredAt = record['answeredAt'];
  if (typeof phase !== 'string') return null;
  if (typeof createdAt !== 'number' || typeof updatedAt !== 'number') return null;
  if (answeredAt !== null && typeof answeredAt !== 'number' && answeredAt !== undefined) {
    return null;
  }
  const recordings = record['recordings'];
  const recorded =
    Array.isArray(recordings) &&
    recordings.some(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        (entry as { available?: unknown }).available === true,
    );
  // An archived record carries its schema; the live DO status does not. Prefer
  // the tag, because archivedStatusView always emits an `answeredAt` key and so
  // key presence alone cannot tell a schema-1 record apart from a schema-2 one.
  const schema = record['schema'];
  // A null answeredAt is only trustworthy as "never answered" when the record
  // POSITIVELY DECLARES it knows about answer times. There is deliberately no
  // fallback, because on both paths a missing tag is indistinguishable from a
  // recorded null:
  //   - archived: archivedStatusView emits `answeredAt` unconditionally, so the
  //     key is always present whatever the record knows.
  //   - live DO: load() hydrates a legacy persisted state over initialState,
  //     which sets `answeredAt: null` (src/state.ts:237) — so a state written
  //     before the field existed comes back as an explicit null.
  // Key presence therefore proves nothing on EITHER path, and reading it as
  // "never answered" zeroes a real call. Measured in production 2026-08-28,
  // call 8e386c3f: detail $0.00 (durationSource "unanswered") beside a list
  // showing $0.202813 for the same call — all ten archived calls read $0.00.
  //
  // The cost of no fallback is stated rather than hidden: a genuinely
  // unanswered call read from the LIVE DO before it is archived now meters over
  // wall time instead of zero, which OVERSTATES a short ring by a fraction of a
  // cent. Its schema-2 archive record prices it at zero the moment it lands.
  // That asymmetry is the right way round -- overstating a rang-out call by
  // ~$0.01 is recoverable, printing $0.00 for a two-minute conversation is the
  // failure that makes the whole panel untrustworthy.
  const schemaKnowsAnswer = typeof schema === 'number' && schema >= 2;
  return {
    phase,
    createdAt,
    updatedAt,
    answeredAt: typeof answeredAt === 'number' ? answeredAt : null,
    recorded,
    schemaKnowsAnswer,
    participants: billableParticipants(record['participants']),
  };
}

/**
 * Read the participant timestamps a cost needs out of a status payload.
 *
 * Named and narrow for the same reason `costableStatus` is: a roster entry that
 * does not have the shape this needs is DROPPED rather than coerced, so an
 * upstream change surfaces as a participant line of zero instead of a plausible
 * number derived from undefined. A payload with no participants key at all --
 * every call archived before conference support -- yields an empty list, which
 * prices at zero, which is the truth about those calls.
 */
function billableParticipants(raw: unknown): readonly BillableParticipant[] {
  if (!Array.isArray(raw)) return [];
  const out: BillableParticipant[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const row: Record<string, unknown> = { ...entry };
    const answeredAt = row['answeredAt'];
    const leftAt = row['leftAt'];
    out.push({
      answeredAt: typeof answeredAt === 'number' ? answeredAt : null,
      leftAt: typeof leftAt === 'number' ? leftAt : null,
    });
  }
  return out;
}

/** True once a call can no longer accrue cost. */
function terminalPhase(phase: string): boolean {
  return phase === 'completed' || phase === 'failed';
}

interface StatusCost {
  readonly cost: CallCost;
  /** The call is still running, so this is spend SO FAR, not a final figure. */
  readonly inProgress: boolean;
}

/**
 * Price one call from its status payload.
 *
 * A live call is metered up to NOW, which is why the result says so: showing a
 * running total without saying it is running invites reading it as final.
 */
function costForStatus(status: CostableStatus, rates: RateTable, now: number): StatusCost {
  const inProgress = !terminalPhase(status.phase);
  const endedAt = inProgress ? Math.max(now, status.createdAt) : status.updatedAt;
  const call: BillableCall = {
    startedAt: status.createdAt,
    endedAt,
    answeredAt: status.answeredAt,
    durationMs: Math.max(0, endedAt - status.createdAt),
    // Only a payload that KNOWS about answer times may report "never answered".
    // For an older archived record a null means "not recorded", and treating
    // that as unanswered would silently price real calls at zero.
    answered: status.schemaKnowsAnswer ? status.answeredAt !== null : true,
    // Metered against the SAME endedAt the call is -- so a participant still on
    // the line when a live call is polled bills to now, and one on a finished
    // call bills to the moment it ended.
    participantBillableMs: participantBillableMs(status.participants, endedAt),
  };
  return {
    cost: estimateCallCost({ call, rates, recorded: status.recorded, now }),
    inProgress,
  };
}

/** Attach a cost block to a status payload, or leave it untouched if unpriceable. */
function withCost(payload: unknown, rates: RateTable, now: number): unknown {
  const status = costableStatus(payload);
  if (status === null || payload === null || typeof payload !== 'object') return payload;
  const { cost, inProgress } = costForStatus(status, rates, now);
  return { ...payload, cost: { ...cost, inProgress, disclaimer: COST_DISCLAIMER } };
}

app.post('/api/console/calls', async (c) => {
  const gate = await operatorGate(c);
  if (!gate.ok) return gate.response;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'body must be JSON' }, 400);
  }
  const parsed = ConsoleCallRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'invalid request', issues: parsed.error.issues.map((issue) => issue.message) },
      400,
    );
  }
  const placed = await placeCall(c.env, parsed.data, Date.now());
  if (placed.body['status'] === 'scheduled') {
    const scheduleId = placed.body['scheduleId'];
    log('info', 'console.schedule.accepted', {
      scheduleId: typeof scheduleId === 'string' ? scheduleId : null,
    });
  } else {
    const callId = placed.body['callId'];
    if (typeof callId === 'string') log('info', 'console.call.accepted', { callId });
  }
  return c.json(placed.body, placed.status as 202 | 400 | 409 | 502 | 503);
});

app.get('/api/console/schedules', async (c) => {
  const gate = await operatorGate(c);
  if (!gate.ok) return gate.response;
  const store = scheduleStore(c.env);
  if (!store) return c.json({ error: 'schedule store is not configured' }, 503);
  const jobs = await store.list();
  return c.json({ schedules: jobs.map(toSummary) });
});

app.delete('/api/console/schedules/:id', async (c) => {
  const gate = await operatorGate(c);
  if (!gate.ok) return gate.response;
  const id = c.req.param('id');
  if (!validScheduleId(id)) return c.json({ error: 'invalid schedule id' }, 400);
  const store = scheduleStore(c.env);
  if (!store) return c.json({ error: 'schedule store is not configured' }, 503);
  const result = await cancelScheduled(store, id, Date.now());
  if (!result.ok) {
    return c.json({ error: result.error }, result.error === 'not found' ? 404 : 409);
  }
  return c.json({ scheduleId: result.job.id, status: result.job.status });
});

/** Default and maximum rows per page of the console's call log. */
const CALL_LOG_PAGE_DEFAULT = 25;
const CALL_LOG_PAGE_MAX = 100;

function callLogLimit(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return CALL_LOG_PAGE_DEFAULT;
  return Math.min(parsed, CALL_LOG_PAGE_MAX);
}

/**
 * Enumerate finished calls, newest first.
 *
 * This is the route the console never had: a Durable Object is addressed by
 * idFromName(callId) and nothing lists those names, so before the R2 archive a
 * call became unreachable the moment its callId left the browser.
 */
app.get('/api/console/calls', async (c) => {
  const gate = await operatorGate(c);
  if (!gate.ok) return gate.response;
  const bucket = c.env.CALL_LOGS;
  if (!bucket) {
    log('warn', 'calllog.list.unavailable', {});
    return c.json({ error: 'call log is not configured' }, 503);
  }
  try {
    const page = await listCallLog(bucket, {
      limit: callLogLimit(c.req.query('limit')),
      cursor: c.req.query('cursor'),
    });
    // Priced at READ time from the stored duration, which is what makes every
    // call already in the bucket carry a cost with no backfill.
    const rates = ratesForEnv(c.env);
    const now = Date.now();
    return c.json({
      ...page,
      calls: page.calls.map((row) => {
        const endedAt = row.endedAt;
        if (endedAt === null) return row;
        const knowsAnswer = row.schema !== null && row.schema >= 2;
        const cost = estimateCallCost({
          call: {
            startedAt: endedAt - (row.durationMs ?? 0),
            endedAt,
            answeredAt: row.answeredAt,
            durationMs: row.durationMs ?? 0,
            answered: knowsAnswer ? row.answeredAt !== null : true,
            // Read from R2 custom metadata, written by the SAME
            // participantBillableMs the detail route computes from the roster.
            // null means the object predates conferences: no participants, so
            // zero is the fact rather than a missing value.
            participantBillableMs: row.participantBillableMs ?? 0,
          },
          rates,
          recorded: row.recorded,
          now,
        });
        return { ...row, cost };
      }),
      disclaimer: COST_DISCLAIMER,
    });
  } catch (err) {
    log('error', 'calllog.list.failed', { error: errText(err) });
    return c.json({ error: 'call log unavailable' }, 502);
  }
});

/**
 * List live (non-terminal) calls for parallel call management.
 *
 * Returns all calls currently in non-terminal phases. This is the endpoint
 * the multi-call console UI polls and CoS uses to enumerate active calls.
 */
app.get('/api/console/calls/live', async (c) => {
  const gate = await operatorGate(c);
  if (!gate.ok) return gate.response;
  try {
    const res = await registryStub(c.env).fetch('https://do/registry/list-live');
    if (!res.ok) {
      log('warn', 'live_calls.list.failed', { status: res.status });
      return c.json({ error: 'live calls unavailable' }, 502);
    }
    const data = (await res.json()) as { calls: unknown[] };
    return c.json({ calls: data.calls ?? [] });
  } catch (err) {
    log('error', 'live_calls.list.exception', { error: errText(err) });
    return c.json({ error: 'live calls unavailable' }, 502);
  }
});

app.get('/api/console/calls/:id/recording/:format', async (c) => {
  const gate = await operatorGate(c);
  if (!gate.ok) return gate.response;
  const callId = c.req.param('id');
  const format = c.req.param('format');
  if (!opaqueCallId(callId) || (format !== 'wav' && format !== 'mp3')) {
    return c.json({ error: 'invalid recording request' }, 400);
  }
  // Forward the browser's Range INTO the Durable Object. Without this the DO
  // never sees that a range was asked for, answers a bare 200 of unknown
  // length, and the console's scrub bar stays inert because
  // HTMLMediaElement.seekable is only populated from a range-capable response.
  const range = c.req.header('Range');
  const res = await callStub(c.env, callId).fetch(`https://do/recording?format=${format}`, {
    ...(range === undefined ? {} : { headers: { Range: range } }),
  });
  // Pass the DO's status and range headers through unchanged. Rewriting the
  // status to 200 here, or dropping Content-Range, would undo the work on the
  // other side of this subrequest: a 206 body served under a 200 status is a
  // truncated file as far as the player is concerned.
  const headers: Record<string, string> = {
    'Content-Type': res.headers.get('Content-Type') ?? 'application/json',
    // These recordings are PII. They must not enter any shared cache, and must
    // not be sniffed into a scriptable type, whatever the range negotiation did.
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    // Set here, not merely forwarded: the allowlist below is what reaches the
    // browser, so a Vary set only inside the DO would be silently dropped at
    // this hop. Stated unconditionally alongside the other two invariants
    // because all three answer the same question -- what a cache is allowed to
    // do with a response whose body depends on the request headers.
    Vary: 'Range',
  };
  for (const header of ['Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag'] as const) {
    const value = res.headers.get(header);
    if (value !== null) headers[header] = value;
  }
  return new Response(res.body, { status: res.status, headers });
});

app.get('/api/console/calls/:id', async (c) => {
  const gate = await operatorGate(c);
  if (!gate.ok) return gate.response;
  const callId = c.req.param('id');
  if (!opaqueCallId(callId)) return c.json({ error: 'invalid call id' }, 400);
  const res = await callStub(c.env, callId).fetch('https://do/status');
  const rates = ratesForEnv(c.env);
  const now = Date.now();
  // Durable Object storage is the live source and normally answers. The R2
  // archive is the fallback for a call whose DO state is gone, and it is also
  // what makes the archive readable end to end rather than write-only.
  if (res.status === 404) {
    const archived = await archivedCall(c.env, callId);
    if (archived) return c.json(withCost(archived, rates, now));
  }
  if (res.status !== 200) {
    return new Response(res.body, {
      status: res.status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
    });
  }
  let payload: unknown;
  try {
    payload = await res.json();
  } catch (err) {
    // A status body we cannot read is not worth failing the request over, but
    // it must not be reported as a priced call either.
    log('warn', 'console.status.unreadable', { callId, error: errText(err) });
    return c.json({ error: 'call status unavailable' }, 502);
  }
  return c.json(withCost(payload, rates, now));
});

/**
 * Estimated spend over a period.
 *
 * Covers EVERY archived call, including everything recorded before the cost
 * model existed, because the price is derived from the stored duration rather
 * than read from a field that would have needed backfilling.
 */
app.get('/api/console/costs', async (c) => {
  const gate = await operatorGate(c);
  if (!gate.ok) return gate.response;
  const requested = c.req.query('window');
  const window: CostWindow = isCostWindow(requested) ? requested : 'month';
  const bucket = c.env.CALL_LOGS;
  if (!bucket) {
    log('warn', 'cost.rollup.unavailable', {});
    return c.json({ error: 'call log is not configured' }, 503);
  }
  try {
    const rollup = await rollupCosts({
      bucket,
      window,
      rates: ratesForEnv(c.env),
      now: Date.now(),
    });
    return c.json({ ...rollup, disclaimer: COST_DISCLAIMER });
  } catch (err) {
    log('error', 'cost.rollup.failed', { window, error: errText(err) });
    return c.json({ error: 'cost rollup unavailable' }, 502);
  }
});

/** Read one finished call out of the R2 archive, in the live status shape. */
async function archivedCall(env: Env, callId: string): Promise<Record<string, unknown> | null> {
  const bucket = env.CALL_LOGS;
  if (!bucket) return null;
  try {
    const key = await findArchiveKey(bucket, callId);
    if (!key) return null;
    const record = await readCallLogRecord(bucket, key);
    return record ? archivedStatusView(record) : null;
  } catch (err) {
    log('warn', 'calllog.detail.failed', { callId, error: errText(err) });
    return null;
  }
}

/**
 * Pages scanned by one backfill run. 5,000 objects covers the whole bucket many
 * times over; the bound exists so a maintenance route can never become an
 * unbounded scan on an authenticated request path.
 */
const MAX_BACKFILL_PAGES = 5;

/**
 * Give already-archived calls the subject their rows render.
 *
 * WHY THIS ROUTE EXISTS AT ALL: the subject is read from R2 CUSTOM METADATA so
 * a page of rows costs one `list()`. Every object written before schema 3 has
 * the task in its BODY and nothing in its metadata, so shipping the renderer
 * alone would change nothing for calls that already happened -- the console
 * would look exactly as it does now and the fix would appear not to work.
 *
 * WHY NOT LAZY HYDRATION IN THE LIST ROUTE: that would be a GET per legacy row
 * on every console load, forever, because reading does not fix anything. That
 * is precisely the O(calls) fan-out on a request path that listCallLog and
 * rollupCosts are both written to avoid. This fixes each object once.
 *
 * WHAT IT SKIPS ON, AND WHY NOT "ALREADY HAS A SUBJECT": that was the previous
 * condition, and after this change it would be exactly backwards. The first run
 * of this route wrote a DERIVED label into the plain `subject` key, where
 * nothing recorded that a machine had written it -- so every one of those
 * objects both HAS a subject and NEEDS rewriting. The condition is therefore
 * "does this object record WHO wrote its subject", which those objects do not.
 *
 * Still idempotent: the rewrite stamps `subjectSource`, so a second run
 * recognizes the marker and skips. subjectProvenanceRecorded is the single
 * definition of that check, shared with the reader, so the two cannot drift
 * into a loop where one writes what the other refuses to recognize.
 *
 * IT MUST NOT TOUCH `schema`. The tag describes the BODY, and a backfilled
 * record's body still has no explicit subject. Bumping it to 3 would tell the
 * cost model the record knows its own answer time; a schema-1 record has no
 * answeredAt, so the model would read null as "never answered" and price a real
 * call at $0.00 -- the exact bug that reached production on 2026-08-28.
 */
app.post('/api/console/calls/backfill-subjects', async (c) => {
  const gate = await operatorGate(c);
  if (!gate.ok) return gate.response;
  const bucket = c.env.CALL_LOGS;
  if (!bucket) return c.json({ error: 'call log is not configured' }, 503);

  let scanned = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  try {
    let cursor: string | undefined;
    for (let page = 0; page < MAX_BACKFILL_PAGES; page += 1) {
      const listed: R2Objects = await bucket.list({
        prefix: CALL_LOG_PREFIX,
        limit: 1000,
        include: ['customMetadata'],
        ...(cursor ? { cursor } : {}),
      });
      for (const object of listed.objects) {
        scanned += 1;
        // Provenance already recorded. Reading the body to confirm would defeat
        // the point of doing this from list metadata.
        if (subjectProvenanceRecorded(object.customMetadata)) {
          skipped += 1;
          continue;
        }
        const record = await readCallLogRecord(bucket, object.key);
        if (!record) {
          failed += 1;
          continue;
        }
        // The record goes back VERBATIM, and the BODY is the authority on
        // provenance: `record.subject` is what the operator supplied, or null.
        // listMetadata re-derives both keys from it, so a legacy object gets
        // `derived` and a genuinely named one gets `operator` -- neither is
        // guessed from the metadata this route is repairing.
        const ok = await putCallLogRecord(bucket, object.key, record);
        if (ok) updated += 1;
        else failed += 1;
      }
      if (!listed.truncated) {
        return c.json({ scanned, updated, skipped, failed, complete: true });
      }
      cursor = listed.cursor;
    }
    // Ran out of pages before running out of objects. Say so rather than
    // reporting a partial pass as a finished one.
    log('warn', 'calllog.backfill.truncated', { scanned });
    return c.json({ scanned, updated, skipped, failed, complete: false });
  } catch (err) {
    log('error', 'calllog.backfill.failed', { error: errText(err) });
    return c.json({ error: 'backfill failed', scanned, updated, skipped, failed }, 502);
  }
});

app.post('/api/console/calls/:id/hangup', async (c) => {
  const gate = await operatorGate(c);
  if (!gate.ok) return gate.response;
  const callId = c.req.param('id');
  if (!opaqueCallId(callId)) return c.json({ error: 'invalid call id' }, 400);
  const res = await callStub(c.env, callId).fetch('https://do/operator/hangup', { method: 'POST' });
  return new Response(res.body, {
    status: res.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
});

app.post('/api/console/calls/:id/dtmf', async (c) => {
  const gate = await operatorGate(c);
  if (!gate.ok) return gate.response;
  const callId = c.req.param('id');
  if (!opaqueCallId(callId)) return c.json({ error: 'invalid call id' }, 400);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'body must be JSON' }, 400);
  }
  const res = await callStub(c.env, callId).fetch('https://do/operator/dtmf', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

// --- Conference participants -------------------------------------------------

/**
 * Forward a participant command to a call's Durable Object.
 *
 * Shared by the console and the API-key surfaces so the two cannot drift into
 * accepting different bodies or reporting different errors for the same action.
 * Every participant mutation goes through the DO because the roster and the cap
 * live in the reducer -- the Worker validates SHAPE, the reducer decides POLICY.
 */
async function participantCommand(
  env: Env,
  callId: string,
  path: '/participants/add' | '/participants/drop' | '/participants/mute' | '/participants/hold',
  body: Record<string, unknown>,
): Promise<Response> {
  const res = await callStub(env, callId).fetch(`https://do${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return new Response(res.body, {
    status: res.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

/**
 * Telnyx call_control_ids are opaque provider strings, so this bounds LENGTH and
 * CHARSET rather than pretending to know their grammar. It exists to stop a
 * path segment of arbitrary bytes reaching a provider URL or a log line, not to
 * validate that the id is real -- the DO answers that by looking it up on the
 * roster and returning 404 when it is not there.
 *
 * ':' IS LOAD-BEARING AND WAS MISSING. Every real Telnyx call_control_id is
 * VERSION-PREFIXED -- measured on a live call 2026-08-30:
 *   v3:GkLIkATR7cCiH0PrdkxzJifm0iSrddSeZrGhRW54ALM_rFdVugxdFA
 * Without the colon this predicate rejected EVERY id Telnyx actually mints, so
 * all six participant control routes (drop, mute/unmute, hold/unhold, on both
 * the console and the API-key surface) returned 400 for the only value that
 * could ever have worked. The DO was correct throughout -- it matches on
 * `participant.legId` -- the route simply never let a real one reach it.
 *
 * It shipped past 565 green tests because every fixture was hand-written to the
 * shape of this regex ('legA-cc', 'legB-xai', 'legP0-cc') and not one contained
 * a colon: the suite proved the two halves agreed with each other rather than
 * with Telnyx. The guard against a repeat is in test/conference-controls.test.ts,
 * which asserts this predicate against the REAL captured id above.
 */
function plausibleLegId(value: string): boolean {
  return value.length > 0 && value.length <= 200 && /^[A-Za-z0-9_=+/:-]+$/.test(value);
}

async function readJsonBody(c: Context<{ Bindings: Env }>): Promise<unknown | undefined> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

app.post('/api/console/calls/:id/participants', async (c) => {
  const gate = await operatorGate(c);
  if (!gate.ok) return gate.response;
  const callId = c.req.param('id');
  if (!opaqueCallId(callId)) return c.json({ error: 'invalid call id' }, 400);
  const body = await readJsonBody(c);
  if (body === undefined) return c.json({ error: 'body must be JSON' }, 400);
  const parsed = AddParticipantRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'invalid request', issues: parsed.error.issues.map((issue) => issue.message) },
      400,
    );
  }
  log('info', 'participant.add.requested', { callId });
  return await participantCommand(c.env, callId, '/participants/add', {
    to: parsed.data.to,
    label: parsed.data.label ?? null,
    supervisorRole: parsed.data.supervisorRole ?? null,
  });
});

app.delete('/api/console/calls/:id/participants/:legId', async (c) => {
  const gate = await operatorGate(c);
  if (!gate.ok) return gate.response;
  const callId = c.req.param('id');
  const legId = c.req.param('legId');
  if (!opaqueCallId(callId) || !plausibleLegId(legId)) {
    return c.json({ error: 'invalid participant request' }, 400);
  }
  log('info', 'participant.drop.requested', { callId });
  return await participantCommand(c.env, callId, '/participants/drop', { legId });
});

app.post('/api/console/calls/:id/participants/:legId/:action{mute|unmute}', async (c) => {
  const gate = await operatorGate(c);
  if (!gate.ok) return gate.response;
  const callId = c.req.param('id');
  const legId = c.req.param('legId');
  if (!opaqueCallId(callId) || !plausibleLegId(legId)) {
    return c.json({ error: 'invalid participant request' }, 400);
  }
  const muted = c.req.param('action') === 'mute';
  return await participantCommand(c.env, callId, '/participants/mute', { legId, muted });
});

/**
 * Hold and unhold ONE participant.
 *
 * The leg id is in the PATH and `plausibleLegId` refuses an empty one, which is
 * the first of three places this route's footgun is closed: Telnyx reads an
 * empty `call_control_ids` on `hold` as "every participant", so a hold that
 * lost its target would freeze the subject and the AI as well. The DO then
 * refuses a leg that is not on the roster, and the client always sends a
 * one-element array.
 */
app.post('/api/console/calls/:id/participants/:legId/:action{hold|unhold}', async (c) => {
  const gate = await operatorGate(c);
  if (!gate.ok) return gate.response;
  const callId = c.req.param('id');
  const legId = c.req.param('legId');
  if (!opaqueCallId(callId) || !plausibleLegId(legId)) {
    return c.json({ error: 'invalid participant request' }, 400);
  }
  const held = c.req.param('action') === 'hold';
  return await participantCommand(c.env, callId, '/participants/hold', { legId, held });
});

app.post('/api/console/calls/:id/media-token', async (c) => {
  const gate = await operatorGate(c);
  if (!gate.ok) return gate.response;
  const callId = c.req.param('id');
  if (!opaqueCallId(callId)) return c.json({ error: 'invalid call id' }, 400);
  if (!c.env.MONITOR_SESSION || !c.env.BETTER_AUTH_SECRET) {
    log('warn', 'monitor.token.unavailable', { callId });
    return c.json({ error: 'monitor is not configured' }, 503);
  }
  const status = await callStub(c.env, callId).fetch('https://do/status');
  if (!status.ok) return c.json({ error: 'unknown call' }, status.status === 404 ? 404 : 502);
  try {
    const token = await issueMediaToken(c.env.BETTER_AUTH_SECRET, callId, 'browser');
    log('info', 'monitor.token.issued', { callId });
    return c.json({ token, expiresIn: 90 });
  } catch (err) {
    log('error', 'monitor.token.failed', { callId, error: errText(err) });
    return c.json({ error: 'monitor unavailable' }, 503);
  }
});

app.get('/api/console/calls/:id/monitor', async (c) => {
  const gate = await operatorGate(c);
  if (!gate.ok) return gate.response;
  const request = c.req.raw;
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return c.text('websocket upgrade required', 426);
  }
  const callId = c.req.param('id');
  const token = mediaTokenFromRequest(request);
  if (
    !opaqueCallId(callId) ||
    !(await verifyMediaToken(c.env.BETTER_AUTH_SECRET, token, callId, 'browser'))
  ) {
    log('warn', 'monitor.browser.bad_token', { callId: callId || 'missing' });
    return c.text('unauthorized', 401);
  }
  const monitor = c.env.MONITOR_SESSION;
  if (!monitor) return c.json({ error: 'monitor is not configured' }, 503);
  const target = new URL(request.url);
  target.pathname = '/browser';
  target.search = '';
  target.searchParams.set('callId', callId);
  target.searchParams.set('token', token as string);
  return monitor.get(monitor.idFromName(callId)).fetch(new Request(target, request));
});

// --- Script preview (read-only) ---------------------------------------------

/**
 * Show the operator the EXACT prompt this task would produce.
 *
 * Read-only by construction. The browser sends only the task string, and the
 * response is composed here by `composeInstructions` — the same function
 * `CallSession` uses to build `session.update.instructions`. There is no route
 * that accepts a instructions blob, so the console cannot author one; it can
 * only see what its task becomes.
 *
 * POST rather than GET because a task may be 16 KB, which does not fit a URL.
 * It has no side effects.
 */
app.post('/api/console/script-preview', async (c) => {
  const gate = await operatorGate(c);
  if (!gate.ok) return gate.response;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'body must be JSON' }, 400);
  }
  const parsed = ScriptPreviewRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'invalid request', issues: parsed.error.issues.map((issue) => issue.message) },
      400,
    );
  }
  // Console calls are always outbound, and AMD has not reported at dial time.
  // Availability is now included when calendar data is present.
  const now = Date.now();
  let availability: string | null = null;

  // Prefer cal.com slots when provided
  if (parsed.data.slots && parsed.data.slots.length > 0) {
    availability = renderSlots(parsed.data.slots, DEFAULT_AVAILABILITY, now, {
      slotMinutes: parsed.data.slotMinutes ?? 30,
      bookingUrl: c.env.CALCOM_BOOKING_URL,
      requiresConfirmation: true,
    });
  } else if (parsed.data.busy && parsed.data.busy.length > 0) {
    // Fallback to busy/free windows
    availability = availabilityFromBusy(parsed.data.busy, now, parsed.data.windowDays ?? 7);
  }

  const segments = composeInstructions({
    task: parsed.data.task,
    direction: 'outbound',
    amdResult: parsed.data.voicemail === true ? 'machine' : null,
    availability,
  });
  return c.json({ segments, text: segments.map((segment) => segment.text).join('\n') });
});

// --- Saved task presets -----------------------------------------------------

/** Presets live in the call-log bucket; without it the panel reports unconfigured. */
function presetBucket(c: Context<{ Bindings: Env }>): R2Bucket | null {
  return c.env.CALL_LOGS ?? null;
}

app.get('/api/console/presets', async (c) => {
  const gate = await operatorGate(c);
  if (!gate.ok) return gate.response;
  const bucket = presetBucket(c);
  if (!bucket) return c.json({ error: 'presets are not configured' }, 503);
  try {
    return c.json({ presets: await listPresets(bucket) });
  } catch (err) {
    log('error', 'preset.list.failed', { error: errText(err) });
    return c.json({ error: 'presets unavailable' }, 502);
  }
});

app.get('/api/console/presets/:name', async (c) => {
  const gate = await operatorGate(c);
  if (!gate.ok) return gate.response;
  const name = c.req.param('name');
  if (!validPresetName(name)) return c.json({ error: 'invalid preset name' }, 400);
  const bucket = presetBucket(c);
  if (!bucket) return c.json({ error: 'presets are not configured' }, 503);
  const record = await readPreset(bucket, name);
  if (!record) return c.json({ error: 'unknown preset' }, 404);
  return c.json(record);
});

app.put('/api/console/presets/:name', async (c) => {
  const gate = await operatorGate(c);
  if (!gate.ok) return gate.response;
  const name = c.req.param('name');
  if (!validPresetName(name)) {
    return c.json(
      {
        error: `preset name must be 1-${MAX_PRESET_NAME_CHARS} characters: letters, digits, spaces, dot, underscore, hyphen; starting with a letter or digit`,
      },
      400,
    );
  }
  const bucket = presetBucket(c);
  if (!bucket) return c.json({ error: 'presets are not configured' }, 503);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'body must be JSON' }, 400);
  }
  const parsed = PresetSaveRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'invalid request', issues: parsed.error.issues.map((issue) => issue.message) },
      400,
    );
  }
  const result = await writePreset(bucket, name, parsed.data.task);
  if (!result.ok) {
    if (result.reason === 'too_many') return c.json({ error: 'preset limit reached' }, 409);
    if (result.reason === 'invalid_name') return c.json({ error: 'invalid preset name' }, 400);
    return c.json({ error: 'could not save preset' }, 502);
  }
  return c.json(result.record, 200);
});

app.delete('/api/console/presets/:name', async (c) => {
  const gate = await operatorGate(c);
  if (!gate.ok) return gate.response;
  const name = c.req.param('name');
  if (!validPresetName(name)) return c.json({ error: 'invalid preset name' }, 400);
  const bucket = presetBucket(c);
  if (!bucket) return c.json({ error: 'presets are not configured' }, 503);
  const deleted = await deletePreset(bucket, name);
  if (!deleted) return c.json({ error: 'could not delete preset' }, 502);
  return c.json({ deleted: true });
});

// --- Operator dictation -----------------------------------------------------

/**
 * Transcribe a short recording of the operator into text for the task box.
 *
 * The body is raw audio, not JSON: the browser already holds a Blob, and
 * base64-ing it there only to decode it here would inflate the upload by a
 * third for nothing. Bytes are held in memory for this request and never
 * written anywhere.
 *
 * Every failure mode below gets its own status so the console can say what
 * actually happened; a mic button that silently does nothing is the specific
 * outcome this is written to avoid.
 */
app.post('/api/console/transcribe', async (c) => {
  const gate = await operatorGate(c);
  if (!gate.ok) return gate.response;
  const ai = c.env.AI;
  if (!ai) {
    log('warn', 'transcribe.unavailable', {});
    return c.json({ error: 'transcription is not configured' }, 503);
  }
  if (!audioTypeAccepted(c.req.header('Content-Type') ?? null)) {
    return c.json({ error: 'unsupported audio type' }, 415);
  }
  // Trust the declared length only to reject early; the real check is on the
  // bytes actually read, because Content-Length is caller-supplied.
  const declared = Number(c.req.header('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES) {
    return c.json({ error: 'recording is too large' }, 413);
  }
  const audio = new Uint8Array(await c.req.arrayBuffer());
  if (audio.length === 0) return c.json({ error: 'recording is empty' }, 400);
  if (audio.length > MAX_AUDIO_BYTES) return c.json({ error: 'recording is too large' }, 413);

  const result = await transcribeAudio(ai, audio);
  if (result.ok) return c.json({ text: result.text, durationSeconds: result.durationSeconds });
  if (result.reason === 'no_speech') return c.json({ error: 'no speech detected' }, 422);
  if (result.reason === 'too_long') {
    return c.json({ error: `recording is longer than ${MAX_AUDIO_SECONDS} seconds` }, 413);
  }
  return c.json({ error: 'transcription failed' }, 502);
});

/** Public provider ingress: authentication is the short-lived Telnyx token. */
app.get('/telnyx-media/:id', async (c) => {
  const request = c.req.raw;
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return c.text('websocket upgrade required', 426);
  }
  const callId = c.req.param('id');
  const token = mediaTokenFromRequest(request);
  if (
    !opaqueCallId(callId) ||
    !(await verifyMediaToken(c.env.BETTER_AUTH_SECRET, token, callId, 'ingress'))
  ) {
    log('warn', 'monitor.telnyx.bad_token', { callId: callId || 'missing' });
    return c.text('unauthorized', 401);
  }
  const monitor = c.env.MONITOR_SESSION;
  if (!monitor) return c.json({ error: 'monitor is not configured' }, 503);
  const target = new URL(request.url);
  target.pathname = '/telnyx';
  target.search = '';
  target.searchParams.set('callId', callId);
  target.searchParams.set('token', token as string);
  return monitor.get(monitor.idFromName(callId)).fetch(new Request(target, request));
});

// --- POST /call ------------------------------------------------------------

app.post('/call', async (c) => {
  const env = c.env;
  const provided = c.req.header('x-api-key') ?? '';
  if (!env.APP_API_KEY || provided.length === 0 || !timingSafeEqual(provided, env.APP_API_KEY)) {
    log('warn', 'api.auth.rejected', {});
    return c.json({ error: 'unauthorized' }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'body must be JSON' }, 400);
  }
  const parsed = CallRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'invalid request', issues: parsed.error.issues.map((i) => i.message) },
      400,
    );
  }
  const placed = await placeCall(env, parsed.data, Date.now());
  return c.json(placed.body, placed.status as 202 | 400 | 409 | 502 | 503);
});

app.get('/call/schedules', async (c) => {
  const env = c.env;
  if (apiKeyRejected(env, c.req.header('x-api-key') ?? '')) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const store = scheduleStore(env);
  if (!store) return c.json({ error: 'schedule store is not configured' }, 503);
  const jobs = await store.list();
  return c.json({ schedules: jobs.map(toSummary) });
});

app.delete('/call/schedules/:id', async (c) => {
  const env = c.env;
  if (apiKeyRejected(env, c.req.header('x-api-key') ?? '')) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const id = c.req.param('id');
  if (!validScheduleId(id)) return c.json({ error: 'invalid schedule id' }, 400);
  const store = scheduleStore(env);
  if (!store) return c.json({ error: 'schedule store is not configured' }, 503);
  const result = await cancelScheduled(store, id, Date.now());
  if (!result.ok) {
    return c.json({ error: result.error }, result.error === 'not found' ? 404 : 409);
  }
  return c.json({ scheduleId: result.job.id, status: result.job.status });
});

// --- GET /call/:id ---------------------------------------------------------

app.get('/call/:id', async (c) => {
  const env = c.env;
  const provided = c.req.header('x-api-key') ?? '';
  if (!env.APP_API_KEY || !timingSafeEqual(provided, env.APP_API_KEY)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const id = c.req.param('id');
  // Legacy machine clients historically receive xAI's call id. The console
  // calls the safe status projection above and never uses this route.
  const res = await callStub(env, id).fetch('https://do/status?view=legacy');
  return new Response(res.body, { status: res.status, headers: res.headers });
});

// --- DTMF on the API-key surface ---------------------------------------------
//
// Same DO operator/dtmf path as the console. Digits validated in the DO.

app.post('/call/:id/dtmf', async (c) => {
  if (apiKeyRejected(c.env, c.req.header('x-api-key') ?? '')) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const callId = c.req.param('id');
  if (!opaqueCallId(callId)) return c.json({ error: 'invalid call id' }, 400);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'body must be JSON' }, 400);
  }
  const res = await callStub(c.env, callId).fetch('https://do/operator/dtmf', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

// --- Participants on the API-key surface -------------------------------------
//
// Mirrors the console routes above so a script driving /call is not forced into
// a browser session to use half the feature. Same DO, same reducer, same cap --
// only the authentication differs.

app.post('/call/:id/participants', async (c) => {
  if (apiKeyRejected(c.env, c.req.header('x-api-key') ?? '')) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const callId = c.req.param('id');
  if (!opaqueCallId(callId)) return c.json({ error: 'invalid call id' }, 400);
  const body = await readJsonBody(c);
  if (body === undefined) return c.json({ error: 'body must be JSON' }, 400);
  const parsed = AddParticipantRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'invalid request', issues: parsed.error.issues.map((issue) => issue.message) },
      400,
    );
  }
  return await participantCommand(c.env, callId, '/participants/add', {
    to: parsed.data.to,
    label: parsed.data.label ?? null,
    supervisorRole: parsed.data.supervisorRole ?? null,
  });
});

app.delete('/call/:id/participants/:legId', async (c) => {
  if (apiKeyRejected(c.env, c.req.header('x-api-key') ?? '')) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const callId = c.req.param('id');
  const legId = c.req.param('legId');
  if (!opaqueCallId(callId) || !plausibleLegId(legId)) {
    return c.json({ error: 'invalid participant request' }, 400);
  }
  return await participantCommand(c.env, callId, '/participants/drop', { legId });
});

app.post('/call/:id/participants/:legId/:action{mute|unmute}', async (c) => {
  if (apiKeyRejected(c.env, c.req.header('x-api-key') ?? '')) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const callId = c.req.param('id');
  const legId = c.req.param('legId');
  if (!opaqueCallId(callId) || !plausibleLegId(legId)) {
    return c.json({ error: 'invalid participant request' }, 400);
  }
  const muted = c.req.param('action') === 'mute';
  return await participantCommand(c.env, callId, '/participants/mute', { legId, muted });
});

app.post('/call/:id/participants/:legId/:action{hold|unhold}', async (c) => {
  if (apiKeyRejected(c.env, c.req.header('x-api-key') ?? '')) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const callId = c.req.param('id');
  const legId = c.req.param('legId');
  if (!opaqueCallId(callId) || !plausibleLegId(legId)) {
    return c.json({ error: 'invalid participant request' }, 400);
  }
  const held = c.req.param('action') === 'hold';
  return await participantCommand(c.env, callId, '/participants/hold', { legId, held });
});

// --- POST /telnyx-webhook --------------------------------------------------

/**
 * Map a Telnyx event onto our domain event.
 * Returns null for events we deliberately ignore (call.initiated on legs WE
 * originated, greeting events, everything else Telnyx may add later).
 *
 * Forward-leg ('F') events carry their call_control_id: several forward legs
 * share the leg letter over one call's lifetime, so the reducer needs the id
 * to tell a live attempt from a stale redelivery of a finished one.
 */
export function telnyxEventToCallEvent(
  clientState: ClientState,
  eventType: string,
  payload: {
    call_control_id?: string | undefined;
    hangup_cause?: string | undefined;
    result?: string | undefined;
    digit?: string | undefined;
  },
  at: number,
): CallEvent | null {
  // *** THE WHOLE CLIENT STATE, NOT JUST THE LEG LETTER. ***
  //
  // This function used to take `leg: 'A' | 'B' | 'F'`, and the leg-A/B branch
  // below is written as `leg === 'A' ? leg_a_answered : leg_b_answered`. Add a
  // fourth letter to that union and a PARTICIPANT answering compiles cleanly
  // into `leg_b_answered` -- the reducer would treat a stranger's phone being
  // picked up as the xAI SIP leg coming up, and `call.hangup` on that
  // participant would emit `hangup`, which COMPLETES THE CALL. One escalation
  // participant putting the phone down would hang up on the subject.
  //
  // Taking the discriminated union makes that unwritable: the participant arm
  // has to be handled before the compiler will accept the rest, and `hangup`'s
  // own `leg: 'A' | 'B'` refuses a participant leg outright.
  const leg = clientState.leg;
  // DTMF is handled BEFORE the per-leg branches, for every leg, because the
  // question "who pressed it" is a POLICY decision the reducer owns -- not a
  // routing one. Dropping a participant's press here instead would leave no
  // record that it happened, and "the participant's keypress was ignored" and
  // "Telnyx never delivered a webhook" would look identical in the logs.
  if (eventType === 'call.dtmf.received') {
    return payload.digit ? { type: 'dtmf_received', digit: payload.digit, leg, at } : null;
  }
  if (leg === 'P') {
    const pid = clientState.pid;
    switch (eventType) {
      case 'call.answered':
        return { type: 'participant_answered', pid, at };
      case 'conference.participant.joined':
        return { type: 'participant_joined', pid, at };
      case 'conference.participant.left':
        return { type: 'participant_left', pid, at };
      case 'call.hangup':
        return { type: 'participant_hangup', pid, cause: payload.hangup_cause ?? null, at };
      default:
        return null;
    }
  }
  if (leg === 'F') {
    const legF = payload.call_control_id;
    if (!legF) return null; // cannot attribute to an attempt
    switch (eventType) {
      case 'call.answered':
        return { type: 'forward_answered', legF, at };
      case 'call.bridged':
        return { type: 'bridge_confirmed', at };
      case 'call.hangup':
        return { type: 'forward_hangup', legF, cause: payload.hangup_cause ?? null, at };
      case 'call.machine.detection.ended':
      case 'call.machine.premium.detection.ended':
        return payload.result ? { type: 'forward_amd', legF, result: payload.result, at } : null;
      default:
        return null;
    }
  }
  switch (eventType) {
    case 'call.answered':
      return leg === 'A' ? { type: 'leg_a_answered', at } : { type: 'leg_b_answered', at };
    case 'call.bridged':
      return { type: 'bridge_confirmed', at };
    // A conference join REPLACES the old two-leg bridge for the AI path, and
    // Telnyx does not emit `call.bridged` for it -- the documented webhooks for
    // a conference are conference.created / participant.joined / participant.left
    // / ended. Without this line the phase would never reach 'bridged' and the
    // console would sit on 'connecting' for the whole of a working call.
    // `call.bridged` above is KEPT because the inbound follow-me path still
    // performs a real two-leg bridge; both map to the same idempotent event.
    case 'conference.participant.joined':
      return leg === 'A' ? { type: 'bridge_confirmed', at } : null;
    case 'call.hangup':
      return { type: 'hangup', leg, cause: payload.hangup_cause ?? null, at };
    case 'call.machine.detection.ended':
    case 'call.machine.premium.detection.ended':
      return payload.result ? { type: 'amd_result', result: payload.result, at } : null;
    default:
      // Deliberately includes `conference.ended`. Teardown is driven by leg
      // hangups, which are the authoritative signal that a call is over; a
      // conference can end while its legs are still up (Telnyx expires one
      // after four hours, and `duration_minutes` can end one early), and
      // treating that as the call ending would tear down live legs.
      return null;
  }
}

app.post('/telnyx-webhook', async (c) => {
  const env = c.env;
  // Exact bytes. Telnyx: "Verification requires the exact body bytes received
  // by the server. Do not parse and reserialize JSON before verification."
  const raw = await c.req.text();
  const allowUnsigned = env.ALLOW_UNSIGNED_WEBHOOKS === 'true';

  if (!allowUnsigned) {
    const ok = await verifyTelnyxSignature(
      raw,
      c.req.header('telnyx-signature-ed25519') ?? null,
      c.req.header('telnyx-timestamp') ?? null,
      env.TELNYX_PUBLIC_KEY,
    );
    if (!ok) {
      log('warn', 'telnyx.webhook.bad_signature', {});
      return c.json({ error: 'bad signature' }, 401);
    }
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }
  const parsed = TelnyxWebhookSchema.safeParse(json);
  if (!parsed.success) {
    log('warn', 'telnyx.webhook.unparseable', { issues: parsed.error.issues.length });
    return c.json({ ok: true }, 200); // ack: retrying will not help
  }

  const { event_type: eventType, payload } = parsed.data.data;

  if (eventType === 'call.recording.saved') {
    const recordingState = decodeClientState(payload.client_state);
    if (recordingState?.leg !== 'A') {
      log('warn', 'recording.webhook.unattributed', {});
      return c.json({ ok: true }, 200);
    }
    const asset = recordingAssetFromWebhook(payload, env);
    if (!asset) {
      log('warn', 'recording.webhook.invalid_asset', { callId: recordingState.callId });
      return c.json({ ok: true }, 200);
    }
    log('info', 'recording.webhook.received', {
      callId: recordingState.callId,
      format: asset.format,
      channels: asset.channels,
    });
    await sendEvent(env, recordingState.callId, {
      type: 'recording_saved',
      asset,
      at: Date.now(),
    });
    return c.json({ ok: true }, 200);
  }

  const clientState = decodeClientState(payload.client_state);
  if (!clientState) {
    // No client_state means Telnyx originated this leg, not us. The one such
    // event we act on is a caller dialing OUR number: answer it and route.
    const inbound = inboundInitiated(eventType, payload);
    if (inbound) {
      const callId = crypto.randomUUID();
      log('info', 'telnyx.inbound.initiated', {
        callId,
        from: inbound.from,
        to: inbound.to,
      });
      try {
        const res = await callStub(env, callId).fetch('https://do/inbound-start', {
          method: 'POST',
          body: JSON.stringify({
            callId,
            callControlId: inbound.callControlId,
            from: inbound.from,
            to: inbound.to,
          }),
        });
        // 409 is the duplicate-delivery path: another DO already answered.
        if (!res.ok) log('warn', 'inbound.start.rejected', { callId, status: res.status });
      } catch (err) {
        log('error', 'inbound.start.exception', { callId, error: errText(err) });
      }
      return c.json({ ok: true }, 200);
    }
    // Not one of our legs (or a Telnyx-generated event with no state).
    log('info', 'telnyx.webhook.no_client_state', { eventType });
    return c.json({ ok: true }, 200);
  }

  const event = telnyxEventToCallEvent(clientState, eventType, payload, Date.now());
  if (!event) {
    log('debug', 'telnyx.webhook.ignored', { eventType, leg: clientState.leg });
    return c.json({ ok: true }, 200);
  }

  log('info', 'telnyx.webhook.received', {
    eventType,
    leg: clientState.leg,
    callId: clientState.callId,
    // *** THE DIGIT ITSELF IS NEVER LOGGED. ***
    // An operator navigating an IVR types account numbers, card digits and
    // PINs on this same keypad, and every one of those presses arrives here as
    // its own webhook. Telnyx ships `redact_dtmf_debug_logging` on the Call
    // Control Application for exactly this reason. What is logged is the ONE
    // bit the operator's own feature needs -- did this press match the
    // recording key -- which separates "no webhook arrived" (dtmf_type
    // mismatch on the application, the likeliest dead-on-arrival cause) from
    // "arrived but was the wrong key" from "right key, wrong leg", without
    // putting a single dialed digit into log retention.
    ...(event.type === 'dtmf_received'
      ? { dtmfIsRecordingKey: event.digit === RECORDING_START_DTMF }
      : {}),
  });
  await sendEvent(env, clientState.callId, event);
  return c.json({ ok: true }, 200);
});

// --- POST /xai-webhook -----------------------------------------------------

app.post('/xai-webhook', async (c) => {
  const env = c.env;
  const raw = await c.req.text();
  const allowUnsigned = env.ALLOW_UNSIGNED_WEBHOOKS === 'true';

  if (!allowUnsigned) {
    const ok = await verifyXaiSignature(
      raw,
      c.req.header('webhook-id') ?? null,
      c.req.header('webhook-timestamp') ?? null,
      c.req.header('webhook-signature') ?? null,
      env.XAI_WEBHOOK_SECRET,
    );
    if (!ok) {
      log('warn', 'xai.webhook.bad_signature', {});
      return c.json({ error: 'bad signature' }, 401);
    }
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }
  const parsed = XaiWebhookSchema.safeParse(json);
  if (!parsed.success) {
    log('warn', 'xai.webhook.unparseable', { issues: parsed.error.issues.length });
    return c.json({ ok: true }, 200);
  }

  if (parsed.data.type !== 'realtime.call.incoming') {
    log('info', 'xai.webhook.ignored_type', { type: parsed.data.type });
    return c.json({ ok: true }, 200);
  }

  const xaiCallId = parsed.data.data?.call_id;
  if (!xaiCallId) {
    log('warn', 'xai.webhook.no_call_id', {});
    return c.json({ ok: true }, 200);
  }

  const callId = await correlateXaiCall(env, parsed.data.data?.sip_headers);
  if (!callId) {
    log('error', 'xai.webhook.uncorrelated', { xaiCallId });
    // 200 so xAI does not retry: a retry cannot fix a missing correlation.
    return c.json({ ok: true, correlated: false }, 200);
  }

  log('info', 'xai.webhook.correlated', { callId, xaiCallId });
  await sendEvent(env, callId, { type: 'xai_incoming', xaiCallId, at: Date.now() });
  return c.json({ ok: true }, 200);
});

/**
 * Work out which of our calls this inbound xAI call is.
 *
 * PRIMARY: the `User-to-User` SIP header we set on the leg-B dial. Exact, and
 * safe under concurrency -- but whether xAI forwards inbound custom SIP headers
 * into the webhook is UNVERIFIED (see README "Unverified").
 *
 * FALLBACK: claim the oldest pending call from the registry. Correct for
 * serial calling; can mis-pair under true concurrency.
 */
async function correlateXaiCall(
  env: Env,
  headers: ReadonlyArray<{ name: string; value: string }> | undefined,
): Promise<string | null> {
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const uu = sipHeader(headers, 'User-to-User');
  if (uu) {
    // Some carriers append encoding params, e.g. "<id>;encoding=hex".
    const candidate = (uu.split(';')[0] ?? '').trim();
    if (uuidRe.test(candidate)) {
      log('info', 'xai.correlate.via_sip_header', { callId: candidate });
      return candidate;
    }
    log('warn', 'xai.correlate.sip_header_unusable', {});
  }

  try {
    const res = await registryStub(env).fetch('https://do/registry/claim', { method: 'POST' });
    if (!res.ok) return null;
    const body = (await res.json()) as { callId: string | null };
    if (body.callId) log('info', 'xai.correlate.via_registry', { callId: body.callId });
    return body.callId;
  } catch (err) {
    log('error', 'xai.correlate.registry_error', { error: errText(err) });
    return null;
  }
}

export default {
  fetch: app.fetch.bind(app),
  scheduled: (controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(runDueSchedules(env, controller.scheduledTime));
  },
};
