// Deferred-call schedule: create does not dial, omit run-at dials now,
// cancel never dials, overlapping fire ticks dial exactly once.

import { describe, expect, it } from 'vitest';
import {
  acceptCallRequest,
  cancelScheduled,
  createJob,
  type DialFn,
  fireDue,
  memoryStore,
  putIfMatch,
  r2ScheduleStore,
  type ScheduleJob,
  type ScheduleStore,
  scheduleKey,
  tryClaim,
} from '../src/schedule';
import type { CallRequest } from '../src/types';
import { createFakeR2 } from './fake-r2';

// Wednesday 2026-04-22, 11:00 AM America/Los_Angeles -- and the zone matters
// now that dialing is gated on calling hours. The previous constant was
// 8:06 PM PT, which every one of these cases would refuse.
const NOW = Date.parse('2026-04-22T18:00:00Z');
const FUTURE = NOW + 60 * 60 * 1000;

function req(over: Partial<CallRequest> = {}): CallRequest {
  return {
    to: '+15555550101',
    task: 'Ask two questions about a mailed court-records search.',
    ...over,
  };
}

function recordingDial(): { dial: DialFn; calls: CallRequest[] } {
  const calls: CallRequest[] = [];
  return {
    calls,
    dial: async (payload) => {
      calls.push(payload.request);
      return { ok: true, callId: `call-${calls.length}` };
    },
  };
}

describe('tryClaim — the predicate overlapping ticks share', () => {
  it('claims a due pending job and refuses every other status', () => {
    const pending = createJob(
      req({ runAt: NOW - 1 }),
      NOW - 10,
      'sch_11111111-1111-4111-8111-111111111111',
    );
    expect(tryClaim(pending, NOW)?.status).toBe('claimed');
    expect(tryClaim({ ...pending, status: 'claimed' }, NOW)).toBeNull();
    expect(tryClaim({ ...pending, status: 'cancelled' }, NOW)).toBeNull();
    expect(tryClaim({ ...pending, status: 'fired' }, NOW)).toBeNull();
  });

  it('refuses a pending job whose runAt is still in the future', () => {
    const job = createJob(req({ runAt: FUTURE }), NOW, 'sch_22222222-2222-4222-8222-222222222222');
    expect(tryClaim(job, NOW)).toBeNull();
  });
});

describe('acceptCallRequest', () => {
  it('stores a future run-at and does not invoke the dial stub', async () => {
    const store = memoryStore();
    const { dial, calls } = recordingDial();
    const accepted = await acceptCallRequest(req({ runAt: FUTURE }), { store, dial, now: NOW });
    expect(accepted.kind).toBe('scheduled');
    if (accepted.kind !== 'scheduled') throw new Error('expected scheduled');
    expect(accepted.job.status).toBe('pending');
    expect(accepted.job.to).toBe('+15555550101');
    expect(accepted.job.runAt).toBe(FUTURE);
    expect(calls).toEqual([]);
    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(accepted.job.id);
  });

  it('dials immediately when run-at is omitted', async () => {
    const store = memoryStore();
    const { dial, calls } = recordingDial();
    const accepted = await acceptCallRequest(req(), { store, dial, now: NOW });
    expect(accepted.kind).toBe('immediate');
    if (accepted.kind !== 'immediate') throw new Error('expected immediate');
    expect(accepted.result.ok).toBe(true);
    expect(accepted.result.callId).toBe('call-1');
    expect(calls).toHaveLength(1);
    expect(await store.list()).toEqual([]);
  });

  it('rejects a run-at that is not in the future', async () => {
    const store = memoryStore();
    const { dial, calls } = recordingDial();
    const accepted = await acceptCallRequest(req({ runAt: NOW }), { store, dial, now: NOW });
    expect(accepted).toEqual({
      kind: 'error',
      error: 'runAt must be in the future',
      status: 400,
    });
    expect(calls).toEqual([]);
  });
});

describe('cancel then fire', () => {
  it('a cancelled job never dials', async () => {
    const store = memoryStore();
    const { dial, calls } = recordingDial();
    const accepted = await acceptCallRequest(req({ runAt: FUTURE }), { store, dial, now: NOW });
    if (accepted.kind !== 'scheduled') throw new Error('expected scheduled');
    const cancelled = await cancelScheduled(store, accepted.job.id, NOW + 1);
    expect(cancelled.ok).toBe(true);
    const fired = await fireDue(store, FUTURE + 1, dial);
    expect(fired).toMatchObject({ dialed: 0, skipped: 0, failed: 0, late: 0, quiet: 0 });
    expect(calls).toEqual([]);
    expect((await store.get(accepted.job.id))?.status).toBe('cancelled');
  });
});

describe('exactly-once fire under overlapping ticks', () => {
  it('two concurrent fireDue calls produce one dial', async () => {
    let arrived = 0;
    const store = memoryStore({
      yieldBeforeClaim: async () => {
        arrived += 1;
        while (arrived < 2) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      },
    });
    const { dial, calls } = recordingDial();
    const accepted = await acceptCallRequest(req({ runAt: NOW - 1 }), {
      store,
      dial,
      now: NOW - 10_000,
    });
    if (accepted.kind !== 'scheduled') throw new Error('expected scheduled');
    const [a, b] = await Promise.all([fireDue(store, NOW, dial), fireDue(store, NOW, dial)]);
    const dialed = a.dialed + b.dialed;
    const skipped = a.skipped + b.skipped;
    expect(dialed).toBe(1);
    expect(skipped).toBe(1);
    expect(calls).toHaveLength(1);
    expect((await store.get(accepted.job.id))?.status).toBe('fired');
    expect((await store.get(accepted.job.id))?.firedCallId).toBe('call-1');
  });

  it('NEGATIVE CONTROL: skipping the pending-status check double-dials', async () => {
    // Proves the overlapping-tick test above is armed by tryClaim's
    // status === 'pending' guard: drop it, and both ticks dial.
    const jobs = new Map<string, ScheduleJob>();
    const broken: ScheduleStore = {
      async get(id) {
        return jobs.get(id) ?? null;
      },
      async put(job) {
        jobs.set(job.id, job);
      },
      async delete(id) {
        jobs.delete(id);
      },
      async list() {
        return [...jobs.values()];
      },
      async claim(id, now) {
        const current = jobs.get(id);
        if (!current) return null;
        if (current.runAt > now) return null;
        // Deliberately omits `status === 'pending'`.
        const claimed = { ...current, status: 'claimed' as const, claimedAt: now };
        jobs.set(id, claimed);
        return claimed;
      },
    };
    let arrived = 0;
    const yielding: ScheduleStore = {
      get: broken.get.bind(broken),
      put: broken.put.bind(broken),
      delete: broken.delete.bind(broken),
      list: broken.list.bind(broken),
      claim: async (id, now) => {
        arrived += 1;
        while (arrived < 2) await new Promise((resolve) => setTimeout(resolve, 0));
        return broken.claim(id, now);
      },
    };
    const { dial, calls } = recordingDial();
    const accepted = await acceptCallRequest(req({ runAt: NOW - 1 }), {
      store: yielding,
      dial,
      now: NOW - 10_000,
    });
    if (accepted.kind !== 'scheduled') throw new Error('expected scheduled');
    await Promise.all([fireDue(yielding, NOW, dial), fireDue(yielding, NOW, dial)]);
    expect(calls.length).toBeGreaterThan(1);
  });
});

describe('r2ScheduleStore claim CAS', () => {
  it('fake R2 put onlyIf etagMatches fails closed and does not overwrite', async () => {
    const r2 = createFakeR2();
    const first = await r2.bucket.put('k', 'v1');
    if (first === null) throw new Error('unconditional put returned null');
    expect(first.etag.length).toBeGreaterThan(0);
    const lost = await r2.bucket.put('k', 'v2', { onlyIf: { etagMatches: 'stale' } });
    expect(lost).toBeNull();
    expect(r2.text('k')).toBe('v1');
    const won = await r2.bucket.put('k', 'v2', { onlyIf: { etagMatches: first.etag } });
    expect(won).not.toBeNull();
    expect(r2.text('k')).toBe('v2');
    expect(won?.etag).not.toBe(first.etag);
  });

  it('putIfMatch returns null on a stale etag and leaves the body', async () => {
    const r2 = createFakeR2();
    const store = r2ScheduleStore(r2.bucket);
    const { dial } = recordingDial();
    const accepted = await acceptCallRequest(req({ runAt: NOW - 1 }), {
      store,
      dial,
      now: NOW - 10_000,
    });
    if (accepted.kind !== 'scheduled') throw new Error('expected scheduled');
    const key = scheduleKey(accepted.job.id);
    const lost = await putIfMatch(r2.bucket, key, { ...accepted.job, status: 'claimed' }, 'stale');
    expect(lost).toBeNull();
    expect((await store.get(accepted.job.id))?.status).toBe('pending');
  });

  it('two concurrent fireDue calls on r2ScheduleStore produce one dial', async () => {
    let arrived = 0;
    const r2 = createFakeR2();
    const store = r2ScheduleStore(r2.bucket, {
      yieldBeforePut: async () => {
        arrived += 1;
        while (arrived < 2) await new Promise((resolve) => setTimeout(resolve, 0));
      },
    });
    const { dial, calls } = recordingDial();
    const accepted = await acceptCallRequest(req({ runAt: NOW - 1 }), {
      store,
      dial,
      now: NOW - 10_000,
    });
    if (accepted.kind !== 'scheduled') throw new Error('expected scheduled');
    const [a, b] = await Promise.all([fireDue(store, NOW, dial), fireDue(store, NOW, dial)]);
    expect(a.dialed + b.dialed).toBe(1);
    expect(a.skipped + b.skipped).toBe(1);
    expect(calls).toHaveLength(1);
    expect((await store.get(accepted.job.id))?.status).toBe('fired');
  });

  it('NEGATIVE CONTROL: R2 claim that puts without onlyIf double-dials', async () => {
    const r2 = createFakeR2();
    let arrived = 0;
    const broken: ScheduleStore = {
      async get(id) {
        const obj = await r2.bucket.get(scheduleKey(id));
        if (!obj) return null;
        return JSON.parse(await obj.text()) as ScheduleJob;
      },
      async put(job) {
        await r2.bucket.put(scheduleKey(job.id), JSON.stringify(job));
      },
      async delete(id) {
        await r2.bucket.delete(scheduleKey(id));
      },
      async list() {
        return r2ScheduleStore(r2.bucket).list();
      },
      async claim(id, now) {
        const key = scheduleKey(id);
        const obj = await r2.bucket.get(key);
        if (!obj) return null;
        const current = JSON.parse(await obj.text()) as ScheduleJob;
        const claimed = tryClaim(current, now);
        if (!claimed) return null;
        arrived += 1;
        while (arrived < 2) await new Promise((resolve) => setTimeout(resolve, 0));
        await r2.bucket.put(key, JSON.stringify(claimed));
        return claimed;
      },
    };
    const { dial, calls } = recordingDial();
    const accepted = await acceptCallRequest(req({ runAt: NOW - 1 }), {
      store: broken,
      dial,
      now: NOW - 10_000,
    });
    if (accepted.kind !== 'scheduled') throw new Error('expected scheduled');
    await Promise.all([fireDue(broken, NOW, dial), fireDue(broken, NOW, dial)]);
    expect(calls.length).toBeGreaterThan(1);
  });
});
