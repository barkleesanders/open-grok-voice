import { describe, expect, it } from 'vitest';
import { DEFAULT_AVAILABILITY, withinCallingHours } from '../src/availability';
import worker, { app } from '../src/index';
import { createFakeR2 } from './fake-r2';
import { testEnv } from './test-env';

/**
 * A run-at that is in the future AND inside calling hours.
 *
 * `Date.now() + 1h` is no longer a valid schedule: dialing is gated on local
 * calling hours, so that constant made this suite pass or fail depending on
 * what time of day it was run. Walk forward in hours until one lands inside
 * the window instead -- deterministic behaviour at every wall clock.
 */
function nextCallingHour(): number {
  const hour = 60 * 60 * 1000;
  for (let t = Date.now() + hour; ; t += hour) {
    if (withinCallingHours(t, DEFAULT_AVAILABILITY)) return t;
  }
}
const FUTURE = nextCallingHour();
const TASK = 'Ask if a printed business check is accepted and if results return without a SASE.';

function envWithLogs() {
  const r2 = createFakeR2();
  return { r2, env: testEnv({ CALL_LOGS: r2.bucket }) };
}

async function call(path: string, init: RequestInit, env = testEnv()): Promise<Response> {
  return app.fetch(new Request(`https://bridge.example.test${path}`, init), env);
}

describe('Worker scheduled export', () => {
  it('exposes a short claim-then-dial tick, not a live CallSession', () => {
    expect(typeof worker.scheduled).toBe('function');
    expect(typeof worker.fetch).toBe('function');
  });
});

describe('API-key schedule routes', () => {
  it('rejects a missing or wrong key', async () => {
    const missing = await call('/call/schedules', { method: 'GET' });
    expect(missing.status).toBe(401);
    const wrong = await call('/call/schedules', {
      method: 'GET',
      headers: { 'x-api-key': 'nope' },
    });
    expect(wrong.status).toBe(401);
    const del = await call('/call/schedules/sch_11111111-1111-4111-8111-111111111111', {
      method: 'DELETE',
      headers: { 'x-api-key': 'nope' },
    });
    expect(del.status).toBe(401);
  });

  it('creates a deferred job without dialing, lists it, then cancels', async () => {
    const { r2, env } = envWithLogs();
    const created = await call(
      '/call',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'test-app-key' },
        body: JSON.stringify({
          to: '+15555550101',
          task: TASK,
          subject: 'Records office search fee',
          runAt: FUTURE,
        }),
      },
      env,
    );
    expect(created.status).toBe(202);
    const body = (await created.json()) as {
      scheduleId: string;
      status: string;
      runAt: number;
      to: string;
      callId?: string;
    };
    expect(body.status).toBe('scheduled');
    expect(body.to).toBe('+15555550101');
    expect(body.runAt).toBe(FUTURE);
    expect(body.callId).toBeUndefined();
    expect(body.scheduleId.startsWith('sch_')).toBe(true);
    expect(r2.keys().some((k) => k.startsWith('schedules/'))).toBe(true);

    const listed = await call('/call/schedules', { headers: { 'x-api-key': 'test-app-key' } }, env);
    expect(listed.status).toBe(200);
    const page = (await listed.json()) as { schedules: Array<Record<string, unknown>> };
    expect(page.schedules).toHaveLength(1);
    expect(page.schedules[0]).toMatchObject({
      id: body.scheduleId,
      to: '+15555550101',
      status: 'pending',
      runAt: FUTURE,
      subject: 'Records office search fee',
    });

    const cancelled = await call(
      `/call/schedules/${body.scheduleId}`,
      { method: 'DELETE', headers: { 'x-api-key': 'test-app-key' } },
      env,
    );
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual({
      scheduleId: body.scheduleId,
      status: 'cancelled',
    });
  });
});
