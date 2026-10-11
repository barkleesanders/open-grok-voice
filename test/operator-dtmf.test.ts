/**
 * Operator / API-key DTMF path: POST /operator/dtmf on the DO (and mirrored
 * Worker routes) must send tones on leg A with the same validator + budget as
 * the agent send_dtmf tool.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallSession } from '../src/call-session';
import { type CallState, initialState } from '../src/state';
import { createFakeDurableObjectState } from './fake-do';
import { testEnv } from './test-env';

const CALL_ID = 'cccccccc-3333-4333-8333-333333333333';
const LEG_A = 'legA-operator-dtmf';
const T0 = 1_756_100_000_000;

async function seededSession(overrides: Partial<CallState> = {}) {
  const doState = createFakeDurableObjectState();
  const telnyx: Request[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('telnyx.com')) {
      telnyx.push(new Request(input, init));
      return new Response('{"data":{"result":"ok"}}', { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
  const session = new CallSession(doState.ctx, testEnv());
  const seeded: CallState = {
    ...initialState({
      callId: CALL_ID,
      to: '+13154263600',
      task: 'Press 1 for billing.',
      voice: 'eve',
      amd: null,
      now: T0,
    }),
    phase: 'connecting',
    legA: LEG_A,
    ...overrides,
  };
  await doState.ctx.storage.put('state', seeded);
  return { session, doState, telnyx };
}

describe('operator DTMF', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends validated digits to leg A', async () => {
    const { session, telnyx } = await seededSession();
    const res = await session.fetch(
      new Request('https://do/operator/dtmf', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ digits: '1w2#' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; digits: string };
    expect(body).toEqual({ ok: true, digits: '1w2#', pressesUsed: 1 });
    expect(telnyx).toHaveLength(1);
    const req = telnyx[0];
    expect(req).toBeDefined();
    if (!req) throw new Error('expected telnyx send_dtmf request');
    expect(req.url).toContain(`/calls/${LEG_A}/actions/send_dtmf`);
    const payload = (await req.json()) as { digits: string };
    expect(payload.digits).toBe('1w2#');
  });

  it('rejects invalid digits with 400', async () => {
    const { session, telnyx } = await seededSession();
    const res = await session.fetch(
      new Request('https://do/operator/dtmf', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ digits: 'press 1' }),
      }),
    );
    expect(res.status).toBe(400);
    expect(telnyx).toHaveLength(0);
  });

  it('returns 409 when leg A is missing', async () => {
    const { session } = await seededSession({ legA: null });
    const res = await session.fetch(
      new Request('https://do/operator/dtmf', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ digits: '1' }),
      }),
    );
    expect(res.status).toBe(409);
  });
});
