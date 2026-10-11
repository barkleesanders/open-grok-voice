// Deferred outbound-call jobs.
//
// A scheduled call is NOT a live CallSession. Jobs persist here until run-at,
// then a short claim-then-dial hands them to startCall. Durable Object alarms
// are a 15-minute EXECUTION cap (see call-session.ts); the horizon is the
// stored runAt, and the Worker cron wakes this module every minute.

import {
  type BusyInput,
  DEFAULT_AVAILABILITY,
  filterSlotsByTravel,
  isValidTimeZone,
  localHourOf,
  withinCallingHours,
} from './availability';
import type { FetchSlotsInput } from './calcom';
import { errText, log } from './log';
import { CALCOM_SLUG_PATTERN, type CallRequest } from './types';

export const SCHEDULE_PREFIX = 'schedules/';
const SCHEDULE_SUFFIX = '.json';

/** Upper bound on stored jobs. Same rationale as MAX_PRESETS. */
export const MAX_SCHEDULES = 50;

/** How far ahead a run-at may be. Matches Lob's send_date window. */
export const MAX_HORIZON_MS = 180 * 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How late a due job may be dialed before it is failed instead.
 *
 * WHY A BOUND IS NEEDED AT ALL -- and the justification is documented
 * behaviour, not a characterisation of cron reliability. Cloudflare documents
 * NO retry for a scheduled invocation that throws or exceeds its 15-minute
 * wall time (developers.cloudflare.com cron-triggers + platform/limits,
 * retrieved 2026-09-01: neither page states any retry or redelivery). A tick
 * that fails is simply gone. `fireDue` selects on `runAt <= now` with no upper
 * bound, so a job's dial time is bounded only by the NEXT SUCCESSFUL tick --
 * which a Worker exception, a deploy gap, or a lost CAS race can push
 * arbitrarily far out. A job set for 2pm Tuesday would then ring a real person
 * at 3am Wednesday, and nothing in the code would have been wrong.
 *
 * CEILING: the configured tick is `crons = ["* * * * *"]` (wrangler.toml), i.e.
 * one minute, which is also Cloudflare's documented minimum granularity. So the
 * expected lateness of a healthy system is < 60s and 15 minutes is 15 missed
 * ticks.
 *
 * CORPUS: not measured. This deployment has no recorded distribution of tick
 * gaps, so 15 minutes is a POLICY choice and is named as one. It is the
 * largest slip under which "the 2 o'clock call" is still the 2 o'clock call.
 * It is deliberately NOT the only wrong-hour guard: `withinCallingHours` is
 * checked at dial time as well, so a slip that somehow exceeds this still
 * cannot produce a 3am call.
 */
export const MAX_LATENESS_MS = 15 * 60 * 1000;

/**
 * How stale a stored availability snapshot may be before it is discarded.
 *
 * CEILING (derived, not guessed): the snapshot describes
 * `[createdAt, createdAt + windowDays*DAY)`. At dial time the call needs
 * `[now, now + windowDays*DAY)`. The part the snapshot never saw is exactly
 * the trailing `now - createdAt` of the call's window, so once
 * `now - createdAt >= windowDays*DAY` the two windows do not overlap AT ALL --
 * and `freeSlots` then reports EVERY working hour of the call's window as
 * open, because no stored interval intersects it. That is not a degraded
 * answer, it is a fabricated free calendar, and
 * `test/schedule-availability.test.ts` pins it with the real renderer.
 * `busyMaxAgeMs` enforces that derived ceiling regardless of this constant.
 * Stated honestly: for every LEGAL windowDays (the schema allows 1-30, so at
 * least 24h) the 4-hour policy value is the binding term and the derived
 * ceiling never fires today. It is there to bound a FUTURE edit -- raise this
 * constant past a day and a short-window job stays clamped to the point where
 * its snapshot carries no information about the call at all.
 *
 * CORPUS: not measured. There is no recorded distribution of how quickly this
 * operator's calendar changes, so 4 hours is a POLICY choice, stated as one:
 * short enough that a snapshot taken this morning is never replayed against
 * this evening's calendar, long enough that the common "schedule it for later
 * today" case still carries real busy geometry for travel filtering.
 */
export const MAX_BUSY_STALENESS_MS = 4 * 60 * 60 * 1000;

/**
 * How long a job stays readable after it reaches a terminal status.
 *
 * MAX_SCHEDULES caps PENDING jobs only, so without this every fired,
 * cancelled and failed job accumulates in R2 forever -- and `list()` issues one
 * `get()` per stored object on EVERY minute tick, so the cost of the cron grows
 * without bound and never comes back down. Pattern #11 of the signal-logic
 * audit ("dedup keys persist forever; no healthy reset").
 *
 * 30 days rather than something shorter because a `fired` job's real record is
 * the permanent call archive under `calls/`, while `cancelled` and `failed`
 * jobs have NO other record -- this row is the only evidence they existed, so
 * it has to outlive a monthly review. Retention starts at the TERMINAL
 * transition, so it never truncates the 180-day pending horizon.
 */
export const TERMINAL_RETENTION_MS = 30 * DAY_MS;

/**
 * How long a job may sit `claimed` before it is written off as failed.
 *
 * `claimed` is an INTERMEDIATE status that `tryClaim` refuses to re-claim, so a
 * job stranded there is unreachable forever: nothing re-dials it and nothing
 * reports it. It gets there if the tick dies between the claim write and the
 * status write. It is failed rather than re-dialed on purpose -- the claim
 * write proves only that we were ABOUT to dial, so a retry could place a second
 * real phone call to someone who already got the first.
 *
 * One tick is 60s; two minutes is two missed ticks, which is well past any
 * legitimate claim-to-dial gap (the dial is one subrequest).
 */
export const CLAIM_TIMEOUT_MS = 2 * 60 * 1000;

export type ScheduleStatus = 'pending' | 'claimed' | 'fired' | 'cancelled' | 'failed';

export interface ScheduleJob {
  readonly id: string;
  readonly to: string;
  readonly task: string;
  readonly subject: string | null;
  readonly voice: string | null;
  readonly amd: string | null;
  readonly busy: readonly { startMs: number; endMs: number; remote: boolean }[];
  readonly windowDays: number;
  readonly slots: readonly number[];
  readonly slotMinutes: number;
  /**
   * Numbers to conference in once the scheduled call connects.
   *
   * Stored because the alternative is a SILENT LOSS: the console's new-call
   * form takes participants and a run-at time in the same panel, and a job that
   * did not carry them would fire a call the operator believed had three people
   * on it and place it with one. Absent on every job written before this field
   * existed, which is why the reader below defaults it to [].
   */
  readonly participants: readonly string[];
  /**
   * cal.com event-type slug this job's slots came from, or null.
   *
   * Stored so the fire path can RE-RESOLVE the slots instead of replaying the
   * frozen ones. `slots` is a list of specific instants; three weeks later the
   * ones still in the future have very likely been booked by someone else, and
   * an agent reading them aloud is offering times that are gone. The slug is
   * the one thing needed to ask cal.com again, and it cannot be inferred from
   * the numbers. Null on every job written before this field existed, which
   * degrades that job to the staleness bound below -- not to a stale offer.
   */
  readonly calcomEventTypeSlug: string | null;
  /**
   * IANA zone the operator chose `runAt` in.
   *
   * `runAt` is epoch ms, which cannot answer "is 03:00 a civil hour to ring
   * this person" -- and that question is asked twice, at accept time and again
   * at dial time. Absent on jobs written before this field existed; the reader
   * defaults it to DEFAULT_AVAILABILITY.timeZone, which is the zone those jobs
   * were in fact scheduled in (this Worker has one operator, in that zone), so
   * the default is a statement of fact about them rather than a placeholder.
   */
  readonly timeZone: string;
  readonly runAt: number;
  readonly status: ScheduleStatus;
  readonly createdAt: number;
  readonly claimedAt: number | null;
  readonly firedAt: number | null;
  readonly firedCallId: string | null;
  readonly failedDetail: string | null;
}

/** Operator/Hermes list row: no full task body. */
export interface ScheduleSummary {
  readonly id: string;
  readonly to: string;
  readonly runAt: number;
  readonly status: ScheduleStatus;
  readonly subject: string | null;
  readonly task: string;
  readonly createdAt: number;
  readonly firedCallId: string | null;
  /**
   * The zone `runAt` was chosen in. Sent so a viewer renders the operator's
   * intent rather than its own: `new Date(runAt).toLocaleString()` in a browser
   * shows the VIEWER's zone, so the same 2pm job reads as 2pm in California and
   * 5pm in New York, and neither reader can tell which one was meant.
   */
  readonly timeZone: string;
  /**
   * Why a `failed` job failed, verbatim. Surfaced in the list because the
   * three new refusal reasons -- too late, outside calling hours, claim
   * stranded -- are invisible otherwise: the row would just say FAILED and the
   * operator would have to read Worker logs to learn their call never went out.
   */
  readonly failedDetail: string | null;
}

export interface ScheduleStore {
  get(id: string): Promise<ScheduleJob | null>;
  put(job: ScheduleJob): Promise<void>;
  list(): Promise<ScheduleJob[]>;
  /**
   * Atomically move pending → claimed. Returns the claimed job, or null if
   * another tick already claimed it (or it was cancelled / not yet due).
   */
  claim(id: string, now: number): Promise<ScheduleJob | null>;
  /** Remove a job entirely. Used only by the terminal-retention sweep. */
  delete(id: string): Promise<void>;
}

export interface DialResult {
  readonly ok: boolean;
  readonly callId?: string;
  readonly detail?: string;
}

/**
 * What the fire path hands the dialer.
 *
 * `availabilityUnknown` is a SERVER-ONLY signal and is why this is a payload
 * rather than a bare CallRequest: it must not be settable over the wire, and it
 * cannot be expressed as data inside `busy`/`slots` because its whole meaning
 * is "those are empty and that emptiness is ignorance, not a free calendar".
 */
export interface DialPayload {
  readonly request: CallRequest;
  /**
   * True when this call was set up WITH availability data that was then
   * discarded as untrustworthy. The agent is told it does not have the
   * calendar; see AVAILABILITY_UNKNOWN in src/availability.ts.
   */
  readonly availabilityUnknown: boolean;
}

export type DialFn = (payload: DialPayload) => Promise<DialResult>;

export type AcceptKind = 'immediate' | 'scheduled' | 'error';

export type AcceptResult =
  | { readonly kind: 'immediate'; readonly result: DialResult }
  | { readonly kind: 'scheduled'; readonly job: ScheduleJob }
  | { readonly kind: 'error'; readonly error: string; readonly status: 400 | 409 | 503 };

export function scheduleKey(id: string): string {
  if (!validScheduleId(id)) throw new Error('invalid schedule id');
  return `${SCHEDULE_PREFIX}${id}${SCHEDULE_SUFFIX}`;
}

export function validScheduleId(id: string): boolean {
  return /^sch_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

export function newScheduleId(): string {
  return `sch_${crypto.randomUUID()}`;
}

export function taskSummary(task: string): string {
  const trimmed = task.trim().replace(/\s+/g, ' ');
  return trimmed.length <= 120 ? trimmed : `${trimmed.slice(0, 117)}...`;
}

export function toSummary(job: ScheduleJob): ScheduleSummary {
  return {
    id: job.id,
    to: job.to,
    runAt: job.runAt,
    status: job.status,
    subject: job.subject,
    task: taskSummary(job.task),
    createdAt: job.createdAt,
    firedCallId: job.firedCallId,
    timeZone: job.timeZone,
    failedDetail: job.failedDetail,
  };
}

/**
 * The stored job as a call request, with its availability EXACTLY AS FROZEN.
 *
 * Not the fire path. Kept because the non-availability half of the mapping has
 * one correct answer and should have one writer; `resolveDialPayload` builds on
 * it and is what `fireDue` actually calls.
 */
export function jobToCallRequest(job: ScheduleJob): CallRequest {
  return {
    to: job.to,
    task: job.task,
    ...(job.subject ? { subject: job.subject } : {}),
    ...(job.voice ? { voice: job.voice } : {}),
    ...(job.amd ? { amd: job.amd as CallRequest['amd'] } : {}),
    ...(job.calcomEventTypeSlug ? { calcomEventTypeSlug: job.calcomEventTypeSlug } : {}),
    busy: [...job.busy],
    windowDays: job.windowDays,
    slots: [...job.slots],
    slotMinutes: job.slotMinutes,
    participants: [...job.participants],
    timeZone: job.timeZone,
  };
}

/** Re-fetch bookable start times. Injected so the fire path stays testable. */
export type SlotFetcher = (input: FetchSlotsInput) => Promise<number[]>;

/** Everything the fire path needs to re-resolve availability, or null to skip. */
export interface SlotResolver {
  readonly fetchSlots: SlotFetcher;
  /** cal.com username, taken from server config -- never from the caller. */
  readonly username: string;
}

/**
 * Did this job ever carry availability data?
 *
 * The distinction the AVAILABILITY_UNKNOWN text depends on. A plain call that
 * never had a calendar should stay silent about availability; a call the
 * operator ATTACHED a calendar to and which then lost it must say so.
 */
function carriedAvailability(job: ScheduleJob): boolean {
  return job.busy.length > 0 || job.slots.length > 0 || job.calcomEventTypeSlug !== null;
}

/**
 * How old a stored snapshot may be for THIS job.
 *
 * The policy constant, floored by the derived ceiling: past `windowDays` the
 * snapshot's window and the call's window are disjoint, so it carries literally
 * no information about the call. A short window therefore expires sooner than
 * the policy would, never later.
 */
export function busyMaxAgeMs(job: ScheduleJob): number {
  return Math.min(MAX_BUSY_STALENESS_MS, job.windowDays * DAY_MS);
}

/** Outcome of re-resolving a job's availability, for logs and tests. */
export type SlotSource = 'refetched' | 'frozen' | 'dropped' | 'none';

export interface ResolvedAvailability {
  readonly busy: readonly BusyInput[];
  readonly slots: readonly number[];
  readonly availabilityUnknown: boolean;
  readonly ageMs: number;
  readonly slotSource: SlotSource;
  /** Set when a re-fetch was attempted and threw. Logged, never spoken. */
  readonly fetchError: string | null;
}

/**
 * Decide what availability a job may actually assert at dial time.
 *
 * THE DEFECT THIS EXISTS FOR: `createJob` snapshots `busy` and `slots` into the
 * job, and the horizon is 180 days. Replaying that snapshot has the agent
 * offering appointment times that filled weeks ago -- and worse, a busy array
 * whose window has entirely elapsed intersects nothing, so `freeSlots` renders
 * every working hour as free. `src/calcom.ts` already refuses to collapse "no
 * availability" into "unknown"; freezing re-introduced that collapse through
 * the side door.
 *
 * The two halves are treated differently because they CAN be:
 *   * cal.com slots are re-fetchable here. The endpoint is unauthenticated
 *     public data (verified live 2026-09-01: 200 with the `cal-api-version`
 *     header, 404 without it), so the Worker needs no credential to ask again.
 *   * Google busy geometry is NOT re-fetchable here, deliberately and
 *     permanently: the only token that could read that calendar carries ~45
 *     scopes including full Drive and gmail.modify, so a Worker holding it
 *     would turn a Worker compromise into a full Google-account compromise.
 *     That was considered and rejected when this feature shipped. So busy is
 *     BOUNDED instead of refreshed -- past `busyMaxAgeMs` it is discarded.
 *
 * A failed re-fetch yields NO slots and `availabilityUnknown`, never a silent
 * fall-through to the frozen list: an unreachable cal.com is unknown, and
 * unknown must not be dressed up as an offer.
 */
export async function resolveAvailability(
  job: ScheduleJob,
  now: number,
  resolver: SlotResolver | null,
): Promise<ResolvedAvailability> {
  const ageMs = Math.max(0, now - job.createdAt);
  const busyFresh = ageMs <= busyMaxAgeMs(job);
  const busy: readonly BusyInput[] = busyFresh ? job.busy : [];

  if (job.calcomEventTypeSlug !== null && resolver !== null) {
    const windowMs = job.windowDays * DAY_MS;
    try {
      const fetched = await resolver.fetchSlots({
        username: resolver.username,
        eventTypeSlug: job.calcomEventTypeSlug,
        startIso: new Date(now).toISOString(),
        endIso: new Date(now + windowMs).toISOString(),
        timeZone: job.timeZone,
      });
      // Filter on the parsed EPOCH MS, never on cal.com's day keys: a response
      // to start=2026-09-03 opens with the key "2026-09-02" holding a slot at
      // 2026-09-03T00:00:00Z (measured 2026-09-01). The key is a LOCAL-DATE
      // label and can name a date outside the window whose instant is inside
      // it. `parseSlots` already ignores the keys; so does this.
      const inWindow = fetched.filter((t) => t >= now && t <= now + windowMs);
      // Travel filtering needs in-person geometry, which is exactly what went
      // stale. Without it the offer degrades to what cal.com itself shows a
      // human on the booking page -- correct, just not travel-aware.
      const slots = busyFresh
        ? filterSlotsByTravel(inWindow, busy, job.slotMinutes, DEFAULT_AVAILABILITY)
        : inWindow;
      return {
        busy,
        slots,
        availabilityUnknown: false,
        ageMs,
        slotSource: 'refetched',
        fetchError: null,
      };
    } catch (err) {
      return {
        busy,
        slots: [],
        availabilityUnknown: !busyFresh || busy.length === 0,
        ageMs,
        slotSource: 'dropped',
        fetchError: errText(err),
      };
    }
  }

  if (busyFresh) {
    return {
      busy,
      slots: [...job.slots],
      availabilityUnknown: false,
      ageMs,
      slotSource: job.slots.length > 0 ? 'frozen' : 'none',
      fetchError: null,
    };
  }
  return {
    busy: [],
    slots: [],
    availabilityUnknown: carriedAvailability(job),
    ageMs,
    slotSource: carriedAvailability(job) ? 'dropped' : 'none',
    fetchError: null,
  };
}

/** The job as a dial payload, with availability re-resolved for `now`. */
export async function resolveDialPayload(
  job: ScheduleJob,
  now: number,
  resolver: SlotResolver | null,
): Promise<DialPayload> {
  const resolved = await resolveAvailability(job, now, resolver);
  log('info', 'schedule.availability_resolved', {
    id: job.id,
    slotSource: resolved.slotSource,
    // The attribute that would have named the frozen-availability bug in 30
    // seconds: how old the snapshot this call is about to speak from actually
    // is, next to the bound it was judged against.
    busyAgeMs: resolved.ageMs,
    busyMaxAgeMs: busyMaxAgeMs(job),
    busyIntervals: resolved.busy.length,
    slots: resolved.slots.length,
    availabilityUnknown: resolved.availabilityUnknown,
    fetchError: resolved.fetchError,
  });
  return {
    request: {
      ...jobToCallRequest(job),
      busy: [...resolved.busy],
      slots: [...resolved.slots],
    },
    availabilityUnknown: resolved.availabilityUnknown,
  };
}

/**
 * Pure claim. A tick that skips `status === 'pending'` will double-dial.
 * The overlapping-tick test is armed by this predicate.
 */
export function tryClaim(job: ScheduleJob, now: number): ScheduleJob | null {
  if (job.status !== 'pending') return null;
  if (job.runAt > now) return null;
  return { ...job, status: 'claimed', claimedAt: now };
}

export function createJob(
  req: CallRequest,
  now: number,
  id: string = newScheduleId(),
): ScheduleJob {
  const runAt = req.runAt;
  if (runAt === undefined) throw new Error('createJob requires runAt');
  return {
    id,
    to: req.to,
    task: req.task,
    subject: req.subject ?? null,
    voice: req.voice ?? null,
    amd: req.amd ?? null,
    busy: req.busy ?? [],
    windowDays: req.windowDays ?? 7,
    slots: req.slots ?? [],
    slotMinutes: req.slotMinutes ?? 30,
    participants: req.participants ?? [],
    calcomEventTypeSlug: req.calcomEventTypeSlug ?? null,
    timeZone: normalizeTimeZone(req.timeZone),
    runAt,
    status: 'pending',
    createdAt: now,
    claimedAt: null,
    firedAt: null,
    firedCallId: null,
    failedDetail: null,
  };
}

export function cancelJob(job: ScheduleJob, now: number): ScheduleJob | null {
  if (job.status !== 'pending') return null;
  return {
    ...job,
    status: 'cancelled',
    claimedAt: job.claimedAt,
    firedAt: now,
  };
}

/**
 * The zone a job is judged in, defaulted and validated.
 *
 * An unresolvable zone would make `Intl` throw inside the once-a-minute cron
 * tick and take every other due job down with it, so a bad value degrades to
 * the operator's own zone here rather than at the point of use.
 */
/** Does a stored value still match the slug shape the wire schema admits? */
function validCalcomSlug(value: unknown): value is string {
  return typeof value === 'string' && new RegExp(CALCOM_SLUG_PATTERN).test(value);
}

export function normalizeTimeZone(timeZone: string | undefined | null): string {
  if (typeof timeZone === 'string' && timeZone.length > 0 && isValidTimeZone(timeZone)) {
    return timeZone;
  }
  return DEFAULT_AVAILABILITY.timeZone;
}

/**
 * Local hours during which this Worker is willing to dial a stranger.
 *
 * REUSED from the availability options rather than defined a second time. Those
 * hours already decide which times the agent may OFFER; before this they never
 * decided when the bridge itself may RING, so the same system could offer a
 * 9-to-6 appointment and place the call at 03:00.
 */
export function callingHours(timeZone: string): typeof DEFAULT_AVAILABILITY {
  return { ...DEFAULT_AVAILABILITY, timeZone: normalizeTimeZone(timeZone) };
}

/** Human-readable window, for the 400 body and the failure detail. */
function callingHoursLabel(timeZone: string): string {
  const opt = callingHours(timeZone);
  return `${String(opt.dayStartHour).padStart(2, '0')}:00-${String(opt.dayEndHour).padStart(2, '0')}:00 ${opt.timeZone}`;
}

export async function acceptCallRequest(
  req: CallRequest,
  deps: { readonly store: ScheduleStore; readonly dial: DialFn; readonly now: number },
): Promise<AcceptResult> {
  if (req.runAt === undefined) {
    // An immediate call carries whatever availability the caller just gathered,
    // so there is nothing stale to discard and nothing unknown to declare.
    const result = await deps.dial({ request: req, availabilityUnknown: false });
    return { kind: 'immediate', result };
  }
  if (!Number.isInteger(req.runAt) || !Number.isFinite(req.runAt)) {
    return { kind: 'error', error: 'runAt must be an integer epoch ms', status: 400 };
  }
  if (req.runAt <= deps.now) {
    return { kind: 'error', error: 'runAt must be in the future', status: 400 };
  }
  if (req.runAt - deps.now > MAX_HORIZON_MS) {
    return { kind: 'error', error: 'runAt exceeds 180-day horizon', status: 400 };
  }
  // REFUSE, not defer. Deferring would silently move a real phone call to a
  // time the operator did not choose -- the same class of wrong as dialing
  // late, just quieter, and the operator would find out only from the call log.
  // Here they are still at the keyboard and get a 400 naming the window, which
  // is correctable in one edit. The same condition is re-checked at dial time,
  // where nobody is available to ask and the job is failed instead.
  const zone = normalizeTimeZone(req.timeZone);
  if (!withinCallingHours(req.runAt, callingHours(zone))) {
    return {
      kind: 'error',
      error: `runAt is outside calling hours (${callingHoursLabel(zone)})`,
      status: 400,
    };
  }
  const existing = await deps.store.list();
  if (existing.filter((j) => j.status === 'pending').length >= MAX_SCHEDULES) {
    return { kind: 'error', error: 'schedule queue is full', status: 409 };
  }
  const job = createJob(req, deps.now);
  await deps.store.put(job);
  log('info', 'schedule.created', { id: job.id, to: job.to, runAt: job.runAt });
  return { kind: 'scheduled', job };
}

export async function cancelScheduled(
  store: ScheduleStore,
  id: string,
  now: number,
): Promise<
  { readonly ok: true; readonly job: ScheduleJob } | { readonly ok: false; readonly error: string }
> {
  const job = await store.get(id);
  if (!job) return { ok: false, error: 'not found' };
  const cancelled = cancelJob(job, now);
  if (!cancelled) return { ok: false, error: 'not pending' };
  await store.put(cancelled);
  log('info', 'schedule.cancelled', { id: cancelled.id, to: cancelled.to });
  return { ok: true, job: cancelled };
}

/** Terminal statuses: nothing further will ever happen to a job in one. */
const TERMINAL: ReadonlySet<ScheduleStatus> = new Set(['fired', 'cancelled', 'failed']);

/** When a job reached its terminal status, for the retention sweep. */
function terminalAt(job: ScheduleJob): number {
  return job.firedAt ?? job.claimedAt ?? job.createdAt;
}

export interface FireOptions {
  /** Re-resolve cal.com slots at dial time. Null/absent: no re-fetch. */
  readonly resolver?: SlotResolver | null;
}

export interface FireOutcome {
  readonly dialed: number;
  readonly skipped: number;
  readonly failed: number;
  /** Due jobs refused because they were past MAX_LATENESS_MS. */
  readonly late: number;
  /** Due jobs refused because dial time fell outside calling hours. */
  readonly quiet: number;
  /** Jobs found stranded in `claimed` and written off. */
  readonly stranded: number;
  /** Terminal jobs deleted past TERMINAL_RETENTION_MS. */
  readonly pruned: number;
}

/** Write a refusal terminally, so no later tick can pick the job up again. */
async function refuse(
  store: ScheduleStore,
  claimed: ScheduleJob,
  now: number,
  event: string,
  detail: string,
  extra: Record<string, string | number | boolean | null> = {},
): Promise<void> {
  const marked: ScheduleJob = { ...claimed, status: 'failed', firedAt: now, failedDetail: detail };
  await store.put(marked);
  log('error', event, { id: marked.id, to: marked.to, detail, ...extra });
}

/**
 * Write off jobs stranded in `claimed`.
 *
 * `claimed` is unreachable: `tryClaim` refuses it forever, so without this a
 * job that got there -- the tick died between the claim write and the status
 * write -- is neither dialed nor reported, in the one state that means "we were
 * about to place a real call". Failed rather than re-dialed: the claim proves
 * only that we were ABOUT to dial, so a retry could ring the same person twice.
 */
async function sweepStrandedClaims(
  store: ScheduleStore,
  jobs: readonly ScheduleJob[],
  now: number,
): Promise<number> {
  let stranded = 0;
  for (const job of jobs) {
    if (job.status !== 'claimed') continue;
    const heldMs = now - (job.claimedAt ?? job.createdAt);
    if (heldMs <= CLAIM_TIMEOUT_MS) continue;
    await refuse(
      store,
      job,
      now,
      'schedule.claim_stranded',
      `not dialed: claimed ${Math.round(heldMs / 1000)}s ago and never completed`,
      { heldMs, claimTimeoutMs: CLAIM_TIMEOUT_MS },
    );
    stranded += 1;
  }
  return stranded;
}

/**
 * Bound the store.
 *
 * MAX_SCHEDULES caps PENDING jobs only, and `list()` costs one R2 get per
 * stored object on every one-minute tick, so unpruned terminal jobs make the
 * cron monotonically more expensive forever and it never comes back down.
 */
async function pruneTerminal(
  store: ScheduleStore,
  jobs: readonly ScheduleJob[],
  now: number,
): Promise<number> {
  let pruned = 0;
  for (const job of jobs) {
    if (!TERMINAL.has(job.status)) continue;
    const ageMs = now - terminalAt(job);
    if (ageMs <= TERMINAL_RETENTION_MS) continue;
    await store.delete(job.id);
    pruned += 1;
    log('info', 'schedule.pruned', { id: job.id, status: job.status, ageMs });
  }
  return pruned;
}

/**
 * Claim every due pending job and dial each winner once.
 * Two overlapping ticks share the store's claim(); only the winner dials.
 *
 * A due job is dialed only if it is BOTH fresh enough (MAX_LATENESS_MS) and
 * lands inside calling hours. Failing either, it is claimed and written off
 * rather than left pending: leaving it pending is what turns one missed tick
 * into a 3am phone call on the next successful one.
 */
export async function fireDue(
  store: ScheduleStore,
  now: number,
  dial: DialFn,
  opts: FireOptions = {},
): Promise<FireOutcome> {
  const jobs = await store.list();
  let dialed = 0;
  let skipped = 0;
  let failed = 0;
  let late = 0;
  let quiet = 0;
  const resolver = opts.resolver ?? null;

  const due = jobs.filter((j) => j.status === 'pending' && j.runAt <= now);
  for (const job of due) {
    // Claim BEFORE deciding, including before a refusal: the claim is the
    // mutual exclusion. Deciding first would let one tick refuse a job while
    // an overlapping tick dials the very same one.
    const claimed = await store.claim(job.id, now);
    if (!claimed) {
      skipped += 1;
      continue;
    }

    const latenessMs = now - claimed.runAt;
    if (latenessMs > MAX_LATENESS_MS) {
      await refuse(
        store,
        claimed,
        now,
        'schedule.too_late',
        `not dialed: ${Math.round(latenessMs / 1000)}s late, past the ${Math.round(MAX_LATENESS_MS / 1000)}s grace window`,
        // The attribute that names this bug in 30 seconds rather than from a
        // call recording: how late the tick actually was.
        { latenessMs, maxLatenessMs: MAX_LATENESS_MS, runAt: claimed.runAt },
      );
      late += 1;
      continue;
    }

    const hours = callingHours(claimed.timeZone);
    if (!withinCallingHours(now, hours)) {
      await refuse(
        store,
        claimed,
        now,
        'schedule.outside_calling_hours',
        `not dialed: ${callingHoursLabel(claimed.timeZone)} only`,
        {
          localHour: isValidTimeZone(hours.timeZone) ? localHourOf(now, hours.timeZone) : null,
          timeZone: hours.timeZone,
          runAt: claimed.runAt,
        },
      );
      quiet += 1;
      continue;
    }

    const payload = await resolveDialPayload(claimed, now, resolver);
    const result = await dial(payload);
    if (result.ok && result.callId) {
      const fired: ScheduleJob = {
        ...claimed,
        status: 'fired',
        firedAt: now,
        firedCallId: result.callId,
      };
      await store.put(fired);
      dialed += 1;
      log('info', 'schedule.fired', {
        id: fired.id,
        to: fired.to,
        callId: result.callId,
        latenessMs,
        availabilityUnknown: payload.availabilityUnknown,
      });
    } else {
      const marked: ScheduleJob = {
        ...claimed,
        status: 'failed',
        firedAt: now,
        failedDetail: result.detail ?? 'dial failed',
      };
      await store.put(marked);
      failed += 1;
      log('error', 'schedule.fire_failed', {
        id: marked.id,
        to: marked.to,
        detail: marked.failedDetail,
      });
    }
  }

  const stranded = await sweepStrandedClaims(store, jobs, now);
  const pruned = await pruneTerminal(store, jobs, now);

  return { dialed, skipped, failed, late, quiet, stranded, pruned };
}

export function memoryStore(
  opts: { readonly yieldBeforeClaim?: () => Promise<void> } = {},
): ScheduleStore {
  const jobs = new Map<string, ScheduleJob>();
  return {
    async get(id) {
      return jobs.get(id) ?? null;
    },
    async put(job) {
      jobs.set(job.id, job);
    },
    async list() {
      return [...jobs.values()].sort((a, b) => a.runAt - b.runAt || a.createdAt - b.createdAt);
    },
    async delete(id) {
      jobs.delete(id);
    },
    async claim(id, now) {
      if (opts.yieldBeforeClaim) await opts.yieldBeforeClaim();
      const current = jobs.get(id);
      if (!current) return null;
      const claimed = tryClaim(current, now);
      if (!claimed) return null;
      jobs.set(id, claimed);
      return claimed;
    },
  };
}

export function jobPutOptions(job: ScheduleJob, etag?: string): R2PutOptions {
  return {
    ...(etag === undefined ? {} : { onlyIf: { etagMatches: etag } }),
    httpMetadata: { contentType: 'application/json' },
    customMetadata: {
      to: job.to,
      runAt: String(job.runAt),
      status: job.status,
    },
  };
}

/**
 * Compare-and-swap write. Returns the stored object, or null when the
 * etag no longer matches (HTTP 412). Callers MUST treat null as "lost".
 */
export async function putIfMatch(
  bucket: R2Bucket,
  key: string,
  job: ScheduleJob,
  etag: string,
): Promise<R2Object | null> {
  if (etag.length === 0) return null;
  return bucket.put(key, JSON.stringify(job), jobPutOptions(job, etag));
}

export function r2ScheduleStore(
  bucket: R2Bucket,
  opts: { readonly yieldBeforePut?: () => Promise<void> } = {},
): ScheduleStore {
  return {
    async get(id) {
      const obj = await bucket.get(scheduleKey(id));
      if (!obj) return null;
      return parseJob(await obj.text());
    },
    async put(job) {
      await bucket.put(scheduleKey(job.id), JSON.stringify(job), jobPutOptions(job));
    },
    async delete(id) {
      await bucket.delete(scheduleKey(id));
    },
    async list() {
      const listed = await bucket.list({ prefix: SCHEDULE_PREFIX });
      const out: ScheduleJob[] = [];
      for (const obj of listed.objects) {
        const got = await bucket.get(obj.key);
        if (!got) continue;
        const job = parseJob(await got.text());
        if (job) out.push(job);
      }
      return out.sort((a, b) => a.runAt - b.runAt || a.createdAt - b.createdAt);
    },
    async claim(id, now) {
      const key = scheduleKey(id);
      const obj = await bucket.get(key);
      if (!obj) return null;
      const current = parseJob(await obj.text());
      if (!current) return null;
      const claimed = tryClaim(current, now);
      if (!claimed) return null;
      // Fail closed: a missing etag cannot be compared, so do not put.
      if (obj.etag.length === 0) {
        log('error', 'schedule.claim_missing_etag', { id });
        return null;
      }
      if (opts.yieldBeforePut) await opts.yieldBeforePut();
      const written = await putIfMatch(bucket, key, claimed, obj.etag);
      if (written === null) {
        log('info', 'schedule.claim_lost', { id, to: claimed.to });
        return null;
      }
      return claimed;
    },
  };
}

function parseJob(text: string): ScheduleJob | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    log('error', 'schedule.parse_failed', { error: errText(err) });
    return null;
  }
  if (raw === null || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec['id'] !== 'string' || !validScheduleId(rec['id'])) return null;
  if (typeof rec['to'] !== 'string' || typeof rec['task'] !== 'string') return null;
  if (typeof rec['runAt'] !== 'number' || typeof rec['createdAt'] !== 'number') return null;
  const status = rec['status'];
  if (
    status !== 'pending' &&
    status !== 'claimed' &&
    status !== 'fired' &&
    status !== 'cancelled' &&
    status !== 'failed'
  ) {
    return null;
  }
  return {
    id: rec['id'],
    to: rec['to'],
    task: rec['task'],
    subject: typeof rec['subject'] === 'string' ? rec['subject'] : null,
    voice: typeof rec['voice'] === 'string' ? rec['voice'] : null,
    amd: typeof rec['amd'] === 'string' ? rec['amd'] : null,
    busy: Array.isArray(rec['busy']) ? (rec['busy'] as ScheduleJob['busy']) : [],
    windowDays: typeof rec['windowDays'] === 'number' ? rec['windowDays'] : 7,
    slots: Array.isArray(rec['slots']) ? (rec['slots'] as number[]) : [],
    slotMinutes: typeof rec['slotMinutes'] === 'number' ? rec['slotMinutes'] : 30,
    // [] for a job written before this field existed. That is the FACT about
    // such a job -- it was created when the form could not take participants --
    // not a placeholder standing in for something that was lost.
    participants: Array.isArray(rec['participants'])
      ? rec['participants'].filter((value): value is string => typeof value === 'string')
      : [],
    // Null for a job written before slot re-resolution existed. That is the
    // FACT about such a job -- it was created when nothing could re-ask cal.com
    // -- so its frozen slots fall to the staleness bound instead, which is the
    // safe reading rather than a placeholder standing in for something lost.
    // Re-validated against the SAME pattern the wire schema admits, not merely
    // typeof-checked. The only writer of these objects is this Worker with an
    // already-validated value, so this is defence in depth rather than a fix --
    // but it costs one regex and it means a hand-edited R2 record cannot put a
    // shape past the reader that the schema would have refused, exactly as
    // normalizeTimeZone does for the zone on the line below.
    calcomEventTypeSlug: validCalcomSlug(rec['calcomEventTypeSlug'])
      ? rec['calcomEventTypeSlug']
      : null,
    // A job written before the zone was stored WAS scheduled in the operator's
    // own zone -- this Worker has one operator and DEFAULT_AVAILABILITY.timeZone
    // is theirs -- so the default states that fact rather than guessing. An
    // unresolvable stored value degrades the same way instead of throwing
    // inside the cron tick.
    timeZone: normalizeTimeZone(typeof rec['timeZone'] === 'string' ? rec['timeZone'] : null),
    runAt: rec['runAt'],
    status,
    createdAt: rec['createdAt'],
    claimedAt: typeof rec['claimedAt'] === 'number' ? rec['claimedAt'] : null,
    firedAt: typeof rec['firedAt'] === 'number' ? rec['firedAt'] : null,
    firedCallId: typeof rec['firedCallId'] === 'string' ? rec['firedCallId'] : null,
    failedDetail: typeof rec['failedDetail'] === 'string' ? rec['failedDetail'] : null,
  };
}
