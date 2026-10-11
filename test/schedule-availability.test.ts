// The four correctness defects of the deferred-call scheduler, each pinned by
// the behaviour a real phone call would have shown:
//   1. frozen availability   -- a stale snapshot renders as a FREE calendar
//   2. no max-lateness guard -- a missed tick dials at the wrong hour
//   3. no quiet-hours gate   -- nothing stopped a 3am dial
//   4. no timezone on the job -- runAt is epoch ms with no zone to read it in

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AVAILABILITY_UNKNOWN,
  availabilityFromBusy,
  DEFAULT_AVAILABILITY,
  withinCallingHours,
} from '../src/availability';
import { availabilityText } from '../src/call-session';
import { composeInstructions } from '../src/instructions';
import {
  acceptCallRequest,
  busyMaxAgeMs,
  CLAIM_TIMEOUT_MS,
  createJob,
  type DialFn,
  fireDue,
  MAX_LATENESS_MS,
  memoryStore,
  r2ScheduleStore,
  resolveAvailability,
  type ScheduleJob,
  type SlotResolver,
  scheduleKey,
  TERMINAL_RETENTION_MS,
  toSummary,
} from '../src/schedule';
import { type CallState, initialState } from '../src/state';
import type { CallRequest } from '../src/types';
import { createFakeR2 } from './fake-r2';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Wednesday 2026-04-22, 11:00 AM America/Los_Angeles. Inside calling hours. */
const NOW = Date.parse('2026-04-22T18:00:00Z');
/** The same Wednesday at 03:00 America/Los_Angeles. */
const THREE_AM = Date.parse('2026-04-22T10:00:00Z');
const ID = 'sch_33333333-3333-4333-8333-333333333333';

function req(over: Partial<CallRequest> = {}): CallRequest {
  return { to: '+15555550101', task: 'Ask whether the records request was received.', ...over };
}

/** A job created `ageMs` ago, carrying a busy snapshot from that same moment. */
function jobWithBusy(ageMs: number, over: Partial<ScheduleJob> = {}): ScheduleJob {
  const createdAt = NOW - ageMs;
  return {
    ...createJob(req({ runAt: NOW, busy: [], windowDays: 7 }), createdAt, ID),
    // One in-person commitment on the morning the snapshot was taken.
    busy: [{ startMs: createdAt + HOUR, endMs: createdAt + 3 * HOUR, remote: false }],
    ...over,
  };
}

function recordingDial(): { dial: DialFn; calls: CallRequest[]; unknown: boolean[] } {
  const calls: CallRequest[] = [];
  const unknown: boolean[] = [];
  return {
    calls,
    unknown,
    dial: async (payload) => {
      calls.push(payload.request);
      unknown.push(payload.availabilityUnknown);
      return { ok: true, callId: `call-${calls.length}` };
    },
  };
}

// ---------------------------------------------------------------------------
// 1. FROZEN AVAILABILITY
// ---------------------------------------------------------------------------

describe('defect 1 — a frozen busy snapshot renders as a FREE calendar', () => {
  it('THE FAILURE ITSELF: a 3-week-old snapshot reports every working hour open', () => {
    // This is not a degraded answer, it is a fabricated one, and it is why the
    // busy half is bounded rather than merely flagged. `freeSlots` intersects
    // stored intervals with [now, now+window); a snapshot whose own window has
    // entirely elapsed intersects nothing, so nothing is subtracted.
    const stale = jobWithBusy(21 * DAY);
    const replayed = availabilityFromBusy(stale.busy, NOW, stale.windowDays);
    expect(replayed).toContain('AVAILABILITY');
    // Every remaining hour of the 7-day window comes back open: today from the
    // current instant to close, and all six following days 9 to 6. Nothing was
    // subtracted, because nothing in the snapshot reaches this window.
    expect(replayed).toContain('11 AM to 6 PM');
    expect(replayed.match(/9 AM to 6 PM/g)?.length).toBe(6);
    expect(replayed).not.toContain('no open slots');
  });

  it('drops the stale snapshot and reports availability as UNKNOWN', async () => {
    const resolved = await resolveAvailability(jobWithBusy(21 * DAY), NOW, null);
    expect(resolved.busy).toEqual([]);
    expect(resolved.slots).toEqual([]);
    expect(resolved.availabilityUnknown).toBe(true);
    expect(resolved.slotSource).toBe('dropped');
  });

  it('keeps a snapshot that is still inside the bound', async () => {
    const fresh = jobWithBusy(HOUR);
    const resolved = await resolveAvailability(fresh, NOW, null);
    expect(resolved.busy).toHaveLength(1);
    expect(resolved.availabilityUnknown).toBe(false);
  });

  it('is bounded by BOTH the policy constant and the derived window ceiling', () => {
    // Stated honestly: for every LEGAL windowDays (the schema allows 1-30, so
    // >= 24h) the 4-hour policy constant is the binding term and the derived
    // ceiling never fires. The derived term is there to bound a FUTURE edit --
    // raise the policy constant past a day and a short-window job is still
    // clamped to the point where its snapshot and the call window go disjoint.
    // The fractional value below is not a legal input; it exercises that arm.
    expect(busyMaxAgeMs(jobWithBusy(0, { windowDays: 30 }))).toBe(4 * HOUR);
    expect(busyMaxAgeMs(jobWithBusy(0, { windowDays: 1 }))).toBe(4 * HOUR);
    expect(busyMaxAgeMs({ ...jobWithBusy(0), windowDays: 1 / 12 })).toBe(2 * HOUR);
  });

  it('a call that NEVER had a calendar stays silent rather than declaring ignorance', async () => {
    const plain = createJob(req({ runAt: NOW }), NOW - 40 * DAY, ID);
    const resolved = await resolveAvailability(plain, NOW, null);
    expect(resolved.availabilityUnknown).toBe(false);
    expect(resolved.slotSource).toBe('none');
  });

  it('tells the agent it does not have the calendar, through composeInstructions', () => {
    const segments = composeInstructions({
      task: 'Offer him a time to meet.',
      availability: AVAILABILITY_UNKNOWN,
    });
    const availability = segments.filter((s) => s.kind === 'availability');
    expect(availability).toHaveLength(1);
    expect(availability[0]?.text).toContain('you do NOT have the calendar');
    // The load-bearing half: it must forbid asserting a free slot, not merely
    // omit one. Silence next to "offer him a time" is where one gets invented.
    expect(availability[0]?.text).toContain('never say a time is open');
    // Order is a security property: the fixed block still precedes the task.
    const kinds = segments.map((s) => s.kind);
    expect(kinds.indexOf('availability')).toBeLessThan(kinds.indexOf('operator'));
  });
});

describe('defect 1 — cal.com slots are RE-RESOLVED, not replayed', () => {
  const resolver = (fetched: number[]): SlotResolver => ({
    username: 'testuser',
    fetchSlots: async () => fetched,
  });

  it('re-fetches at fire time and discards the frozen list', async () => {
    const frozen = NOW + 2 * DAY;
    const fresh = NOW + 3 * DAY;
    const job: ScheduleJob = {
      ...jobWithBusy(HOUR),
      slots: [frozen],
      calcomEventTypeSlug: '30mins',
    };
    const resolved = await resolveAvailability(job, NOW, resolver([fresh]));
    expect(resolved.slotSource).toBe('refetched');
    expect(resolved.slots).toEqual([fresh]);
    expect(resolved.slots).not.toContain(frozen);
  });

  it('filters the re-fetched slots on EPOCH MS, never on cal.com day keys', async () => {
    // Measured against the live API 2026-09-01: a request for start=2026-09-03
    // comes back with a first key of "2026-09-02" holding a slot at
    // 2026-09-03T00:00:00Z. The key is a LOCAL-DATE label and can name a date
    // outside the requested window while its instant is inside it. So the
    // boundary slot at exactly `now` must survive, and only instants genuinely
    // outside [now, now+window] may be dropped.
    // No busy geometry, so the ONLY filter under test is the epoch-ms window;
    // travel filtering has its own boundary behaviour and would confound this.
    const job: ScheduleJob = { ...jobWithBusy(HOUR), busy: [], calcomEventTypeSlug: '30mins' };
    const before = NOW - 1;
    const boundary = NOW;
    const inside = NOW + 2 * DAY;
    const after = NOW + 8 * DAY;
    const resolved = await resolveAvailability(
      job,
      NOW,
      resolver([before, boundary, inside, after]),
    );
    expect(resolved.slots).toEqual([boundary, inside]);
  });

  it('a FAILED re-fetch is unknown, never a silent fall-through to the frozen list', async () => {
    const job: ScheduleJob = {
      ...jobWithBusy(21 * DAY),
      slots: [NOW + 2 * DAY],
      calcomEventTypeSlug: '30mins',
    };
    const resolved = await resolveAvailability(job, NOW, {
      username: 'testuser',
      fetchSlots: async () => {
        throw new Error('cal.com 500');
      },
    });
    expect(resolved.slots).toEqual([]);
    expect(resolved.availabilityUnknown).toBe(true);
    expect(resolved.fetchError).toContain('cal.com 500');
  });
});

// ---------------------------------------------------------------------------
// 2. MAX LATENESS
// ---------------------------------------------------------------------------

describe('defect 2 — a job past the grace window is failed, never dialed late', () => {
  async function fireLate(latenessMs: number) {
    const store = memoryStore();
    const { dial, calls } = recordingDial();
    const runAt = NOW - latenessMs;
    await store.put({ ...createJob(req({ runAt }), runAt - HOUR, ID), runAt });
    const outcome = await fireDue(store, NOW, dial);
    return { outcome, calls, job: await store.get(ID) };
  }

  it('dials a job that is only a tick late', async () => {
    const { outcome, calls, job } = await fireLate(90_000);
    expect(outcome.dialed).toBe(1);
    expect(outcome.late).toBe(0);
    expect(calls).toHaveLength(1);
    expect(job?.status).toBe('fired');
  });

  it('refuses a job past MAX_LATENESS_MS and says how late it was', async () => {
    const { outcome, calls, job } = await fireLate(MAX_LATENESS_MS + 60_000);
    expect(outcome.dialed).toBe(0);
    expect(outcome.late).toBe(1);
    expect(calls).toEqual([]);
    expect(job?.status).toBe('failed');
    expect(job?.failedDetail).toContain('late');
  });

  it('a refused job is TERMINAL, so a later tick cannot pick it up', async () => {
    const store = memoryStore();
    const { dial, calls } = recordingDial();
    const runAt = NOW - (MAX_LATENESS_MS + 60_000);
    await store.put({ ...createJob(req({ runAt }), runAt - HOUR, ID), runAt });
    await fireDue(store, NOW, dial);
    await fireDue(store, NOW + 60_000, dial);
    await fireDue(store, NOW + 2 * HOUR, dial);
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. QUIET HOURS
// ---------------------------------------------------------------------------

describe('defect 3 — calling hours gate both acceptance and dialing', () => {
  it('refuses a 3am run-at at accept time, naming the window', async () => {
    const store = memoryStore();
    const { dial, calls } = recordingDial();
    const accepted = await acceptCallRequest(req({ runAt: THREE_AM + DAY }), {
      store,
      dial,
      now: NOW,
    });
    expect(accepted.kind).toBe('error');
    if (accepted.kind !== 'error') throw new Error('expected error');
    expect(accepted.status).toBe(400);
    expect(accepted.error).toContain('calling hours');
    expect(accepted.error).toContain('America/Los_Angeles');
    expect(calls).toEqual([]);
    expect(await store.list()).toEqual([]);
  });

  it('accepts the SAME instant when the operator scheduled it in a zone where it is 6am... no: 11am', async () => {
    // 2026-04-22T14:00Z is 07:00 in Los Angeles (refused) and 10:00 in New York
    // (accepted). One instant, two answers -- which is precisely why the zone
    // has to live on the job instead of being assumed.
    const instant = Date.parse('2026-04-22T14:00:00Z') + DAY;
    const store = memoryStore();
    const { dial } = recordingDial();
    const pacific = await acceptCallRequest(req({ runAt: instant }), { store, dial, now: NOW });
    expect(pacific.kind).toBe('error');
    const eastern = await acceptCallRequest(req({ runAt: instant, timeZone: 'America/New_York' }), {
      store,
      dial,
      now: NOW,
    });
    expect(eastern.kind).toBe('scheduled');
    if (eastern.kind !== 'scheduled') throw new Error('expected scheduled');
    expect(eastern.job.timeZone).toBe('America/New_York');
  });

  it('refuses to DIAL outside calling hours even for a job that was accepted', async () => {
    // Isolated from the lateness guard on purpose: this tick is only 60s late.
    const store = memoryStore();
    const { dial, calls } = recordingDial();
    await store.put({ ...createJob(req({ runAt: THREE_AM }), THREE_AM - HOUR, ID) });
    const outcome = await fireDue(store, THREE_AM + 60_000, dial);
    expect(outcome.quiet).toBe(1);
    expect(outcome.dialed).toBe(0);
    expect(calls).toEqual([]);
    const job = await store.get(ID);
    expect(job?.status).toBe('failed');
    expect(job?.failedDetail).toContain('09:00-18:00');
  });

  it('the same job dials when the tick lands inside the window', async () => {
    const store = memoryStore();
    const { dial, calls } = recordingDial();
    await store.put({ ...createJob(req({ runAt: NOW }), NOW - HOUR, ID) });
    const outcome = await fireDue(store, NOW + 60_000, dial);
    expect(outcome.dialed).toBe(1);
    expect(outcome.quiet).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('withinCallingHours is half-open at the closing hour', () => {
    const opt = DEFAULT_AVAILABILITY;
    expect(withinCallingHours(Date.parse('2026-04-22T16:00:00Z'), opt)).toBe(true); // 09:00
    expect(withinCallingHours(Date.parse('2026-04-22T15:59:00Z'), opt)).toBe(false); // 08:59
    expect(withinCallingHours(Date.parse('2026-04-23T00:59:00Z'), opt)).toBe(true); // 17:59
    expect(withinCallingHours(Date.parse('2026-04-23T01:00:00Z'), opt)).toBe(false); // 18:00
  });

  it('an unresolvable zone is treated as OUTSIDE the window, never as inside', () => {
    // Three outcomes collapsed to two deliberately: "cannot tell what hour it
    // is there" is not a reason to ring a stranger.
    expect(withinCallingHours(NOW, { ...DEFAULT_AVAILABILITY, timeZone: 'Mars/Olympus' })).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. TIMEZONE ON THE JOB
// ---------------------------------------------------------------------------

describe('defect 4 — the job carries the zone its runAt was chosen in', () => {
  it('stores, summarises, and defaults the zone', () => {
    const job = createJob(req({ runAt: NOW, timeZone: 'America/New_York' }), NOW - HOUR, ID);
    expect(job.timeZone).toBe('America/New_York');
    expect(toSummary(job).timeZone).toBe('America/New_York');
    expect(createJob(req({ runAt: NOW }), NOW - HOUR, ID).timeZone).toBe('America/Los_Angeles');
  });

  it('degrades an unusable zone instead of throwing inside the cron tick', () => {
    // A RangeError here would abort the whole tick and every OTHER due job.
    const job = createJob(req({ runAt: NOW }), NOW - HOUR, ID);
    expect(() =>
      withinCallingHours(NOW, { ...DEFAULT_AVAILABILITY, timeZone: job.timeZone }),
    ).not.toThrow();
  });

  it('BACK-COMPAT: a job stored before any of these fields existed still reads', async () => {
    const r2 = createFakeR2();
    const store = r2ScheduleStore(r2.bucket);
    // Byte-for-byte the shape written by the previous version: no timeZone, no
    // calcomEventTypeSlug, no participants.
    await r2.bucket.put(
      scheduleKey(ID),
      JSON.stringify({
        id: ID,
        to: '+15555550101',
        task: 'legacy job',
        subject: null,
        voice: null,
        amd: null,
        busy: [],
        windowDays: 7,
        slots: [],
        slotMinutes: 30,
        runAt: NOW,
        status: 'pending',
        createdAt: NOW - HOUR,
        claimedAt: null,
        firedAt: null,
        firedCallId: null,
        failedDetail: null,
      }),
    );
    const job = await store.get(ID);
    expect(job).not.toBeNull();
    expect(job?.timeZone).toBe('America/Los_Angeles');
    expect(job?.calcomEventTypeSlug).toBeNull();
    expect(job?.participants).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Signal-logic audit findings fixed in the same pass
// ---------------------------------------------------------------------------

describe('bounded state — terminal jobs do not accumulate forever', () => {
  it('prunes a terminal job past retention and keeps a recent one', async () => {
    const store = memoryStore();
    const { dial } = recordingDial();
    const old = {
      ...createJob(req({ runAt: NOW }), NOW, 'sch_44444444-4444-4444-8444-444444444444'),
      status: 'fired' as const,
      firedAt: NOW - (TERMINAL_RETENTION_MS + DAY),
    };
    const recent = {
      ...createJob(req({ runAt: NOW }), NOW, 'sch_55555555-5555-4555-8555-555555555555'),
      status: 'cancelled' as const,
      firedAt: NOW - DAY,
    };
    await store.put(old);
    await store.put(recent);
    const outcome = await fireDue(store, NOW, dial);
    expect(outcome.pruned).toBe(1);
    expect(await store.get(old.id)).toBeNull();
    expect(await store.get(recent.id)).not.toBeNull();
  });

  it('never prunes a PENDING job, however far out its runAt is', async () => {
    const store = memoryStore();
    const { dial } = recordingDial();
    await store.put(createJob(req({ runAt: NOW + 170 * DAY }), NOW - 170 * DAY, ID));
    const outcome = await fireDue(store, NOW, dial);
    expect(outcome.pruned).toBe(0);
    expect(await store.get(ID)).not.toBeNull();
  });
});

describe('a job stranded in `claimed` is written off, not left unreachable', () => {
  it('fails it after the claim timeout and never re-dials it', async () => {
    const store = memoryStore();
    const { dial, calls } = recordingDial();
    await store.put({
      ...createJob(req({ runAt: NOW - HOUR }), NOW - 2 * HOUR, ID),
      status: 'claimed',
      claimedAt: NOW - (CLAIM_TIMEOUT_MS + 60_000),
    });
    const outcome = await fireDue(store, NOW, dial);
    expect(outcome.stranded).toBe(1);
    // Failed rather than re-dialed: the claim proves we were ABOUT to place a
    // real call, so a retry could ring the same person a second time.
    expect(calls).toEqual([]);
    expect((await store.get(ID))?.status).toBe('failed');
  });

  it('leaves a freshly claimed job alone', async () => {
    const store = memoryStore();
    const { dial } = recordingDial();
    await store.put({
      ...createJob(req({ runAt: NOW - HOUR }), NOW - 2 * HOUR, ID),
      status: 'claimed',
      claimedAt: NOW - 5_000,
    });
    const outcome = await fireDue(store, NOW, dial);
    expect(outcome.stranded).toBe(0);
    expect((await store.get(ID))?.status).toBe('claimed');
  });
});

// ---------------------------------------------------------------------------
// Found while fixing defect 1: the Worker has been SENDING cal.com slots and
// the Durable Object has never read them.
// ---------------------------------------------------------------------------

describe('every field the Worker sends on /start is read by the Durable Object', () => {
  /**
   * A CLASS-level guard, not a case-level one.
   *
   * `startCall` has sent `slots` and `slotMinutes` since cal.com support
   * shipped; `StartArgs` never declared them and the `/start` handler never
   * passed them to `initialState`, so `state.slots` was ALWAYS empty and the
   * cal.com branch of `availabilityText` was unreachable on every real call.
   * Nothing failed -- the agent quietly fell back to computed busy windows,
   * which is the exact rendering cal.com was adopted to replace.
   *
   * A field-by-field assertion would not have caught it (the missing field has
   * no assertion), so this compares the two literals directly: every key the
   * Worker puts in the /start body must be READ by name in the handler.
   */
  it('names every key of the /start body in the handler', () => {
    const worker = readFileSync(join('src', 'index.ts'), 'utf8');
    const session = readFileSync(join('src', 'call-session.ts'), 'utf8');

    const bodyStart = worker.indexOf("await callStub(env, callId).fetch('https://do/start'");
    expect(bodyStart).toBeGreaterThan(-1);
    const body = worker.slice(bodyStart, worker.indexOf('});', bodyStart));
    const sent = [...body.matchAll(/^\s{8}([a-zA-Z]+):/gm)].map((m) => m[1]);
    // Positive control: the extraction found a realistic body, not zero keys.
    expect(sent.length).toBeGreaterThan(10);
    expect(sent).toContain('slots');

    const unread = sent.filter((key) => key !== 'callId' && !session.includes(`args.${key}`));
    expect(unread).toEqual([]);
  });
});

describe('availabilityText — what the live call is actually told', () => {
  /**
   * Only the availability inputs are overridable. Deliberately NOT
   * Partial<CallState>: CallState.participants is a row type while
   * initialState takes labels, so spreading the whole state type here would
   * need a cast to compile -- and a cast is the thing that hides the next
   * shape change.
   */
  interface AvailabilityOverrides {
    readonly availabilityUnknown?: boolean;
    readonly busy?: readonly { startMs: number; endMs: number; remote: boolean }[];
    readonly slots?: readonly number[];
    readonly slotMinutes?: number;
  }

  function state(over: AvailabilityOverrides = {}): CallState {
    return initialState({
      callId: 'c1',
      to: '+15555550101',
      task: 'Ask about the appointment.',
      voice: 'liora',
      amd: null,
      now: NOW,
      ...over,
    });
  }

  it('declares ignorance when the snapshot was dropped, instead of staying silent', () => {
    const text = availabilityText(state({ availabilityUnknown: true }), 'https://cal.com/x');
    expect(text).toBe(AVAILABILITY_UNKNOWN);
  });

  it('outranks leftover geometry: unknown means unknown', () => {
    // Belt and braces. If a future change leaves busy populated alongside the
    // flag, the honest answer still has to win over the computed windows.
    const text = availabilityText(
      state({
        availabilityUnknown: true,
        busy: [{ startMs: NOW, endMs: NOW + HOUR, remote: true }],
      }),
      'https://cal.com/x',
    );
    expect(text).toBe(AVAILABILITY_UNKNOWN);
  });

  it('stays silent for a call that simply never had a calendar', () => {
    expect(availabilityText(state(), 'https://cal.com/x')).toBeNull();
  });

  it('reaches the cal.com branch once slots are actually carried', () => {
    // Unreachable before this change: state.slots was always [].
    // availabilityText reads the wall clock (renderSlots drops elapsed times),
    // so the slot has to be in the REAL future, not the fixture's.
    const text = availabilityText(
      state({ slots: [Date.now() + 2 * HOUR], slotMinutes: 30 }),
      'https://cal.com/testuser',
    );
    expect(text).toContain('bookable 30-minute start times');
  });
});

describe('a stored job cannot carry a slug shape the wire schema would refuse', () => {
  it('nulls a hand-edited slug that fails the ingress pattern', async () => {
    const r2 = createFakeR2();
    const store = r2ScheduleStore(r2.bucket);
    const base = {
      id: ID,
      to: '+15555550101',
      task: 'legacy job',
      runAt: NOW,
      status: 'pending',
      createdAt: NOW - HOUR,
    };
    await r2.bucket.put(
      scheduleKey(ID),
      JSON.stringify({ ...base, calcomEventTypeSlug: '../../evil?x=1' }),
    );
    expect((await store.get(ID))?.calcomEventTypeSlug).toBeNull();
    // Positive control: the reader is not simply nulling everything.
    await r2.bucket.put(
      scheduleKey(ID),
      JSON.stringify({ ...base, calcomEventTypeSlug: '30mins' }),
    );
    expect((await store.get(ID))?.calcomEventTypeSlug).toBe('30mins');
  });
});
