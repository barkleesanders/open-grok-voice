// GET /api/console/costs, through the real app.

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

import { type CallLogRecord, callLogKey, putCallLogRecord } from '../src/call-log';
import type { Env } from '../src/env';
import { app } from '../src/index';
import { createFakeR2 } from './fake-r2';
import { testEnv } from './test-env';

const MINUTE = 60_000;

function finishedCall(endedAt: number): CallLogRecord {
  return {
    schema: 2,
    callId: `call-${endedAt}`,
    phase: 'completed',
    direction: 'outbound',
    inboundMode: null,
    to: '+1415*****23',
    task: 'Ask about the referral.',
    // Schema 2 on purpose: these fixtures stand in for records already in the
    // real bucket, which have no explicit subject. null is what such a record
    // holds, and the reader must derive a label from `task` rather than assume.
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

async function envWithCalls(count: number, overrides: Partial<Env> = {}): Promise<Env> {
  const r2 = createFakeR2();
  const now = Date.now();
  for (let i = 0; i < count; i += 1) {
    // Spread within the current hour so every window contains them.
    const record = finishedCall(now - (i + 1) * 60_000);
    await putCallLogRecord(r2.bucket, callLogKey(record.callId, record.endedAt), record);
  }
  return testEnv({ CALL_LOGS: r2.bucket, ...overrides });
}

async function costs(env: Env, query = ''): Promise<Response> {
  return await app.fetch(new Request(`https://bridge.example.test/api/console/costs${query}`), env);
}

describe('GET /api/console/costs', () => {
  it('returns a priced rollup for the requested window', async () => {
    const env = await envWithCalls(3);
    for (const window of ['day', 'week', 'month', 'year']) {
      const res = await costs(env, `?window=${window}`);
      expect(res.status, window).toBe(200);
      const body = await res.json();
      expect(body, window).toMatchObject({ window, calls: 3, estimate: true });
      expect((body as { totalUsd: number }).totalUsd, window).toBeGreaterThan(0);
    }
  });

  it('carries the breakdown, series, forecast and disclaimer the panel renders', async () => {
    const res = await costs(await envWithCalls(2), '?window=day');
    const body = await res.json();
    expect(body).toMatchObject({
      byProvider: expect.objectContaining({ xai: expect.any(Number), telnyx: expect.any(Number) }),
      forecast: expect.objectContaining({ method: 'daily-mean-over-elapsed-days' }),
      truncated: false,
    });
    const typed = body as { series: unknown[]; disclaimer: string };
    expect(typed.series).toHaveLength(24);
    // The payload itself must say it is not a bill; a consumer should not have
    // to know that from documentation.
    expect(typed.disclaimer).toContain('not a bill');
  });

  it('carries a trailing-window total for every window, so the panel is never bare', async () => {
    // The calendar month is correct at $0 on its first days and reads as broken.
    // The endpoint therefore has to hand the panel something to show alongside
    // it -- for EVERY window, not only the ones that happen to look empty.
    for (const window of ['day', 'week', 'month', 'year']) {
      const res = await costs(await envWithCalls(2), `?window=${window}`);
      expect(res.status, window).toBe(200);
      const body = (await res.json()) as {
        trailing30: { days: number; usd: number; calls: number; truncated: boolean };
      };
      expect(body.trailing30, window).toMatchObject({ days: 30, calls: 2, truncated: false });
      expect(body.trailing30.usd, window).toBeGreaterThan(0);
    }
  });

  it('defaults to the month for a missing or bogus window rather than erroring', async () => {
    const env = await envWithCalls(1);
    for (const query of ['', '?window=', '?window=decade', '?window=../etc']) {
      const res = await costs(env, query);
      expect(res.status, query).toBe(200);
      expect(await res.json(), query).toMatchObject({ window: 'month' });
    }
  });

  it('fails closed with 503 when the archive bucket is not provisioned', async () => {
    const res = await costs(testEnv());
    expect(res.status).toBe(503);
  });

  it('rejects an unauthenticated caller', async () => {
    // The mock authorizes every session, so prove the gate is actually wired by
    // unmocking it for this one assertion.
    vi.doUnmock('../src/auth');
    vi.resetModules();
    const fresh = await import('../src/index');
    const res = await fresh.app.fetch(
      new Request('https://bridge.example.test/api/console/costs'),
      await envWithCalls(1),
    );
    expect(res.status).toBe(401);
  });
});

describe('the detail route and the list route must agree', () => {
  // A schema-1 record -- which is what the production bucket is ENTIRELY made of
  // -- reaches the detail route through archivedStatusView, which always emits
  // an `answeredAt` key. Deciding "does this record know about answers?" from
  // key presence therefore reads a legacy null as "never answered" and prices
  // the call at zero, while the list route (which reads the schema tag) prices
  // the same call correctly. Two different numbers for one call.
  it('prices a legacy schema-1 call the same on both routes', async () => {
    const r2 = createFakeR2();
    const endedAt = Date.now() - 60_000;
    const callId = '55555555-5555-4555-8555-555555555555';
    const legacy = { ...finishedCall(endedAt), callId, schema: 1 as const };
    // Strip answeredAt the way a pre-schema-2 deploy wrote it: absent entirely.
    const { answeredAt: _dropped, ...withoutAnswer } = legacy;
    await r2.bucket.put(callLogKey(callId, endedAt), JSON.stringify(withoutAnswer), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: {
        callId,
        phase: 'completed',
        direction: 'outbound',
        to: '+1415*****23',
        endedAt: String(endedAt),
        durationMs: String(2 * MINUTE),
        transcriptEntries: '3',
      },
    });
    const env = testEnv({ CALL_LOGS: r2.bucket });

    const listRes = await app.fetch(
      new Request('https://bridge.example.test/api/console/calls'),
      env,
    );
    const listBody = (await listRes.json()) as { calls: { cost?: { total: number } }[] };
    const listTotal = listBody.calls[0]?.cost?.total;

    // The DO has no state for this call, so the detail route falls through to
    // the R2 archive -- the path a finished call is actually read on.
    const detailRes = await app.fetch(
      new Request(`https://bridge.example.test/api/console/calls/${callId}`),
      testEnv({
        CALL_LOGS: r2.bucket,
        CALL_SESSION: Object.assign({} as DurableObjectNamespace, {
          idFromName: (name: string) =>
            Object.assign({} as DurableObjectId, { toString: () => name }),
          get: () =>
            Object.assign({} as DurableObjectStub, {
              fetch: async (): Promise<Response> =>
                new Response(JSON.stringify({ error: 'unknown call' }), { status: 404 }),
            }),
        }),
      }),
    );
    const detailBody = (await detailRes.json()) as { cost?: { total: number } };

    expect(listTotal).toBeGreaterThan(0);
    expect(detailBody.cost?.total).toBe(listTotal);
  });

  // The test ABOVE writes `schema: 1`, so `typeof schema === 'number'` holds and
  // the tag decides. Production's records do not have the field AT ALL, which
  // takes the other branch entirely -- so that test passed while production was
  // broken. Measured live 2026-08-28 on the deployed Worker, call 8e386c3f:
  // detail $0.00 with durationSource "unanswered", list $0.202813. Every one of
  // the ten archived calls read $0.00 in the detail panel.
  //
  // The fixture here is therefore the SHAPE PRODUCTION ACTUALLY HAS: no schema
  // key, no answeredAt key, and archived: true supplied by archivedStatusView.
  it('prices a pre-tag record whose schema field is ABSENT, not merely 1', async () => {
    const r2 = createFakeR2();
    const endedAt = Date.now() - 60_000;
    const callId = '66666666-6666-4666-8666-666666666666';
    const base = finishedCall(endedAt);
    // Drop BOTH fields, the way a deploy that predates either one wrote them.
    const { answeredAt: _a, schema: _s, ...preTag } = { ...base, callId };
    await r2.bucket.put(callLogKey(callId, endedAt), JSON.stringify(preTag), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: {
        callId,
        phase: 'completed',
        direction: 'outbound',
        to: '+1415*****23',
        endedAt: String(endedAt),
        durationMs: String(2 * MINUTE),
        transcriptEntries: '3',
      },
    });
    const detailRes = await app.fetch(
      new Request(`https://bridge.example.test/api/console/calls/${callId}`),
      testEnv({
        CALL_LOGS: r2.bucket,
        CALL_SESSION: Object.assign({} as DurableObjectNamespace, {
          idFromName: (name: string) =>
            Object.assign({} as DurableObjectId, { toString: () => name }),
          get: () =>
            Object.assign({} as DurableObjectStub, {
              fetch: async (): Promise<Response> =>
                new Response(JSON.stringify({ error: 'unknown call' }), { status: 404 }),
            }),
        }),
      }),
    );
    const detail = (await detailRes.json()) as {
      cost?: { total: number; durationSource: string };
    };
    // The specific wrong answer, named so a regression cannot hide behind a
    // vague "greater than zero": treating an absent tag as "knows about
    // answers" yields exactly durationSource 'unanswered' and a $0.00 total.
    expect(detail.cost?.durationSource).not.toBe('unanswered');
    expect(detail.cost?.durationSource).toBe('total');
    expect(detail.cost?.total).toBeGreaterThan(0);
  });
});
