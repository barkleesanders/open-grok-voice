// POST /api/console/calls/backfill-subjects, through the real app.
//
// WHY THIS ROUTE HAS TESTS AT ALL: the subject is read from R2 CUSTOM METADATA
// so a page of rows costs one list(). Every object written before schema 3 has
// its task in the BODY and nothing in its metadata, so shipping the renderer
// alone would leave the console looking exactly as it did -- the fix would
// appear not to work on precisely the calls the operator already has.

import { describe, expect, it, vi } from 'vitest';
import type { OperatorSession } from '../src/auth';

vi.mock('../src/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/auth')>();
  const authorized: OperatorSession = {
    kind: 'authorized',
    user: { name: 'Operator', image: null },
  };
  return { ...actual, getOperatorSession: async (): Promise<OperatorSession> => authorized };
});

import { type CallLogRecord, callLogKey, listCallLog } from '../src/call-log';
import type { Env } from '../src/env';
import { app } from '../src/index';
import { createFakeR2, type FakeR2 } from './fake-r2';
import { testEnv } from './test-env';

const T0 = 1_756_000_000_000;
const MINUTE = 60_000;

/** A record exactly as a pre-schema-3 deploy wrote it: no subject anywhere. */
function legacyRecord(index: number): CallLogRecord {
  const endedAt = T0 + index * MINUTE;
  return {
    schema: 2,
    callId: `call-${index}`,
    phase: 'completed',
    direction: 'outbound',
    inboundMode: null,
    // Masked, because a pre-schema-3 deploy masked it at write time.
    to: '+1********23',
    task: `Ask facility ${index} about a bed. Then confirm the fax number.`,
    subject: null,
    voice: 'liora',
    amdResult: null,
    failureReason: null,
    inboundFallbackReason: null,
    forwardAttempted: 0,
    startedAt: endedAt - 2 * MINUTE,
    endedAt,
    durationMs: 2 * MINUTE,
    answeredAt: endedAt - 2 * MINUTE,
    teardownReason: 'normal',
    transcript: [],
    recordings: [],
  };
}

/**
 * Seed the bucket the way an OLD writer did: body written, metadata written by
 * a writer that had never heard of `subject`. Using putCallLogRecord here would
 * defeat the test -- it would store the pair and leave nothing to backfill.
 *
 * `staleSubject` reproduces the SECOND legacy shape, and the one that actually
 * exists in the production bucket right now: version 3a7d4f0c's backfill ran
 * and wrote a DERIVED label into the plain `subject` key, with nothing
 * recording that a machine wrote it. That object both HAS a subject and NEEDS
 * rewriting, which is exactly the case the old skip condition ("already has a
 * subject") would refuse to touch.
 */
async function seedLegacy(
  r2: FakeR2,
  count: number,
  options: { readonly staleSubject?: boolean; readonly operatorSubject?: string } = {},
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const base = legacyRecord(i);
    const rec: CallLogRecord =
      options.operatorSubject === undefined ? base : { ...base, subject: options.operatorSubject };
    await r2.bucket.put(callLogKey(rec.callId, rec.endedAt), JSON.stringify(rec), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: {
        callId: rec.callId,
        phase: rec.phase,
        direction: rec.direction,
        to: rec.to,
        endedAt: String(rec.endedAt),
        durationMs: String(rec.durationMs),
        transcriptEntries: '0',
        schema: String(rec.schema),
        answeredAt: String(rec.answeredAt),
        recorded: '0',
        // No subjectSource in either shape: that key is what this change adds.
        ...(options.staleSubject === true ? { subject: `Ask facility ${i} about a bed.` } : {}),
      },
    });
  }
}

function envWith(r2: FakeR2): Env {
  return { ...testEnv(), CALL_LOGS: r2.bucket };
}

async function backfill(env: Env): Promise<Record<string, unknown>> {
  const res = await app.request(
    'https://worker.test/api/console/calls/backfill-subjects',
    { method: 'POST' },
    env,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe('backfilling subjects onto already-archived calls', () => {
  it('leaves legacy rows unlabelled until it runs, then labels them', async () => {
    const r2 = createFakeR2();
    await seedLegacy(r2, 3);
    const env = envWith(r2);

    // The state the console is in today.
    const before = await listCallLog(r2.bucket, { limit: 10 });
    expect(before.calls.map((row) => row.subject)).toEqual([null, null, null]);

    const result = await backfill(env);
    expect(result).toMatchObject({ scanned: 3, updated: 3, skipped: 0, failed: 0, complete: true });

    const after = await listCallLog(r2.bucket, { limit: 10 });
    expect(after.calls.map((row) => row.subject)).toEqual([
      'Ask facility 2 about a bed.',
      'Ask facility 1 about a bed.',
      'Ask facility 0 about a bed.',
    ]);
    // And every one of them is stamped as MACHINE-written, which is what stops
    // the console promoting it over the number.
    expect(after.calls.map((row) => row.subjectSource)).toEqual(['derived', 'derived', 'derived']);
  });

  it('MIGRATES the mis-keyed objects the previous backfill already wrote', async () => {
    // THE STATE OF PRODUCTION RIGHT NOW. Version 3a7d4f0c's backfill ran over
    // the 10 archived calls and put a derived label in `subject` with no
    // provenance beside it, so the renderer promoted all of them. Its skip
    // condition was "this object already has a subject", which describes every
    // one of these -- so re-running it unchanged would skip precisely the
    // objects that need fixing and report the pass as complete.
    const r2 = createFakeR2();
    await seedLegacy(r2, 3, { staleSubject: true });
    const env = envWith(r2);

    const before = await listCallLog(r2.bucket, { limit: 10 });
    // The reader already refuses an unattributed label, so the console is not
    // broken while the backfill is pending -- it is merely unlabelled again.
    expect(before.calls.map((row) => row.subjectSource)).toEqual([null, null, null]);

    const result = await backfill(env);
    expect(result).toMatchObject({ scanned: 3, updated: 3, skipped: 0, failed: 0 });

    const after = await listCallLog(r2.bucket, { limit: 10 });
    expect(after.calls.map((row) => row.subjectSource)).toEqual(['derived', 'derived', 'derived']);
    expect(after.calls[0]?.subject).toBe('Ask facility 2 about a bed.');
  });

  it('restores an OPERATOR label from the body, rather than calling it derived', async () => {
    // The body is the authority on provenance: record.subject is what a human
    // supplied. A blanket "everything backfilled is derived" would demote a
    // genuinely named call and destroy the feature for the campaign that
    // actually sends subjects.
    const r2 = createFakeR2();
    await seedLegacy(r2, 1, {
      staleSubject: true,
      operatorSubject: 'ACME Medical Center',
    });

    await backfill(envWith(r2));

    const after = await listCallLog(r2.bucket, { limit: 10 });
    expect(after.calls[0]?.subject).toBe('ACME Medical Center');
    expect(after.calls[0]?.subjectSource).toBe('operator');
  });

  it('is idempotent over the MIGRATED shape too, not just the unlabelled one', async () => {
    const r2 = createFakeR2();
    await seedLegacy(r2, 2, { staleSubject: true });
    const env = envWith(r2);

    await backfill(env);
    const putsAfterFirst = r2.putCount();

    const second = await backfill(env);
    expect(second).toMatchObject({ scanned: 2, updated: 0, skipped: 2, failed: 0 });
    expect(r2.putCount()).toBe(putsAfterFirst);
  });

  it('does not touch the record body, and above all not its schema tag', async () => {
    // Bumping schema to 3 would tell the cost model a schema-2 record knows its
    // own answer time. It does not, so the model would read null as "never
    // answered" and price a real call at $0.00 -- the bug that reached
    // production on 2026-08-28.
    const r2 = createFakeR2();
    await seedLegacy(r2, 1);
    const key = callLogKey('call-0', T0);
    const bodyBefore = r2.text(key);

    await backfill(envWith(r2));

    expect(r2.text(key)).toBe(bodyBefore);
    expect(r2.raw(key)?.customMetadata['schema']).toBe('2');
    expect(JSON.parse(r2.text(key) as string).schema).toBe(2);
  });

  it('leaves the schema tag alone on the MIGRATION path as well', async () => {
    // The migration rewrites metadata that already held a value, which is a
    // different code path from filling an empty one. The $0.00 bug is one
    // careless `schema: 3` away on either.
    const r2 = createFakeR2();
    await seedLegacy(r2, 1, { staleSubject: true });
    const key = callLogKey('call-0', T0);
    const bodyBefore = r2.text(key);

    await backfill(envWith(r2));

    expect(r2.text(key)).toBe(bodyBefore);
    expect(r2.raw(key)?.customMetadata['schema']).toBe('2');
    expect(JSON.parse(r2.text(key) as string).schema).toBe(2);
  });

  it('is idempotent: a second run rewrites nothing', async () => {
    const r2 = createFakeR2();
    await seedLegacy(r2, 2);
    const env = envWith(r2);

    await backfill(env);
    const putsAfterFirst = r2.putCount();

    const second = await backfill(env);
    expect(second).toMatchObject({ scanned: 2, updated: 0, skipped: 2, failed: 0 });
    expect(r2.putCount()).toBe(putsAfterFirst);
  });

  it('reports a record it could not read instead of counting it as fixed', async () => {
    const r2 = createFakeR2();
    await seedLegacy(r2, 1);
    r2.failNext('get', 1);

    const result = await backfill(envWith(r2));
    expect(result).toMatchObject({ scanned: 1, updated: 0, failed: 1 });
  });

  it('says so when the call log is not configured, rather than reporting success', async () => {
    const env: Env = { ...testEnv(), CALL_LOGS: undefined };
    const res = await app.request(
      'https://worker.test/api/console/calls/backfill-subjects',
      { method: 'POST' },
      env,
    );
    expect(res.status).toBe(503);
  });
});
