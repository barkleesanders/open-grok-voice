/**
 * Tests for concurrent multi-call support: registry tracking, cap enforcement,
 * and live call listing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperatorSession } from '../src/auth';

// Mock the auth module to always return an authorized session
vi.mock('../src/auth', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../src/auth');
  const authorized: OperatorSession = {
    kind: 'authorized',
    user: { name: 'Test Operator', image: null },
  };
  return { ...actual, getOperatorSession: async (): Promise<OperatorSession> => authorized };
});

import { MAX_CONCURRENT_OUTBOUND, REGISTRY_NAME } from '../src/call-session';
import { app } from '../src/index';
import { testEnv } from './test-env';

/** Stub Telnyx and xAI provider APIs to return success responses */
function stubProviderApis(): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    // Telnyx API endpoints - return proper call_control_id
    if (url.includes('telnyx.com')) {
      return new Response(
        JSON.stringify({
          data: {
            call_control_id: 'v3:test-call-control-id',
            call_leg_id: 'test-leg-id',
            call_session_id: 'test-session-id',
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
    // xAI or other endpoints
    return new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

describe('Concurrent multi-call', () => {
  let env: ReturnType<typeof testEnv>;

  beforeEach(() => {
    env = testEnv();
    stubProviderApis();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('Registry live tracking', () => {
    it('adds call to live registry on successful start', async () => {
      const req = new Request('https://test/call', {
        method: 'POST',
        headers: { 'x-api-key': env.APP_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ to: '+14155550123', task: 'test task' }),
      });
      const res = await app.fetch(req, env);
      expect(res.status).toBe(202);
      const body = (await res.json()) as { callId: string };

      // Check live registry
      const registry = env.CALL_SESSION.get(env.CALL_SESSION.idFromName(REGISTRY_NAME));
      const liveRes = await registry.fetch('https://do/registry/list-live');
      expect(liveRes.status).toBe(200);
      const liveData = (await liveRes.json()) as { calls: Array<{ callId: string }> };
      expect(liveData.calls).toHaveLength(1);
      const live = liveData.calls[0];
      expect(live).toBeDefined();
      if (!live) throw new Error('expected one live call');
      expect(live.callId).toBe(body.callId);
    });

    it('removes call from live registry on teardown', async () => {
      const req = new Request('https://test/call', {
        method: 'POST',
        headers: { 'x-api-key': env.APP_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ to: '+14155550123', task: 'test task' }),
      });
      const placeRes = await app.fetch(req, env);
      const body = (await placeRes.json()) as { callId: string };

      // Simulate hangup to trigger teardown
      const stub = env.CALL_SESSION.get(env.CALL_SESSION.idFromName(body.callId));
      await stub.fetch('https://do/event', {
        method: 'POST',
        body: JSON.stringify({ type: 'hangup', leg: 'A', cause: 'test', at: Date.now() }),
      });

      // Check live registry is empty
      const registry = env.CALL_SESSION.get(env.CALL_SESSION.idFromName(REGISTRY_NAME));
      const liveRes = await registry.fetch('https://do/registry/list-live');
      const liveData = (await liveRes.json()) as { calls: unknown[] };
      expect(liveData.calls).toHaveLength(0);
    });
  });

  describe('Concurrent cap enforcement', () => {
    it('enforces MAX_CONCURRENT_OUTBOUND limit', async () => {
      // Unique destinations so dial_locked does not fire before the concurrent cap.
      const callIds: string[] = [];
      for (let i = 0; i < MAX_CONCURRENT_OUTBOUND; i++) {
        const req = new Request('https://test/call', {
          method: 'POST',
          headers: { 'x-api-key': env.APP_API_KEY, 'content-type': 'application/json' },
          body: JSON.stringify({
            to: `+1415555${String(2000 + i).padStart(4, '0')}`,
            task: `call ${i}`,
          }),
        });
        const res = await app.fetch(req, env);
        expect(res.status).toBe(202);
        const body = (await res.json()) as { callId: string };
        callIds.push(body.callId);
      }

      // Next call should be rejected with 409
      const req = new Request('https://test/call', {
        method: 'POST',
        headers: { 'x-api-key': env.APP_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ to: '+14155559999', task: 'blocked call' }),
      });
      const res = await app.fetch(req, env);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('concurrent call limit');
    });

    it('allows new calls after one terminates', async () => {
      // Fill to cap
      const callIds: string[] = [];
      for (let i = 0; i < MAX_CONCURRENT_OUTBOUND; i++) {
        const req = new Request('https://test/call', {
          method: 'POST',
          headers: { 'x-api-key': env.APP_API_KEY, 'content-type': 'application/json' },
          body: JSON.stringify({
            to: `+1415555${String(2000 + i).padStart(4, '0')}`,
            task: `call ${i}`,
          }),
        });
        const res = await app.fetch(req, env);
        const body = (await res.json()) as { callId: string };
        callIds.push(body.callId);
      }

      // Hang up first call
      const firstId = callIds[0];
      expect(firstId).toBeDefined();
      if (!firstId) throw new Error('expected a placed call id');
      const stub = env.CALL_SESSION.get(env.CALL_SESSION.idFromName(firstId));
      await stub.fetch('https://do/event', {
        method: 'POST',
        body: JSON.stringify({ type: 'hangup', leg: 'A', cause: 'test', at: Date.now() }),
      });

      // Now new call should succeed
      const req = new Request('https://test/call', {
        method: 'POST',
        headers: { 'x-api-key': env.APP_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ to: '+14155559998', task: 'new call' }),
      });
      const res = await app.fetch(req, env);
      expect(res.status).toBe(202);
    });
  });

  describe('Live calls API', () => {
    it('returns empty list when no calls active', async () => {
      const req = new Request('https://test/api/console/calls/live');
      const res = await app.fetch(req, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { calls: unknown[] };
      expect(body.calls).toEqual([]);
    });

    it('lists all active calls', async () => {
      // Place two calls
      for (let i = 0; i < 2; i++) {
        const req = new Request('https://test/call', {
          method: 'POST',
          headers: { 'x-api-key': env.APP_API_KEY, 'content-type': 'application/json' },
          body: JSON.stringify({ to: `+1415555012${i}`, task: `call ${i}`, subject: `Test ${i}` }),
        });
        await app.fetch(req, env);
      }

      // List live calls
      const req = new Request('https://test/api/console/calls/live');
      const res = await app.fetch(req, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        calls: Array<{ callId: string; to: string; subject: string | null }>;
      };
      expect(body.calls).toHaveLength(2);
      const first = body.calls[0];
      const second = body.calls[1];
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (!first || !second) throw new Error('expected two live calls');
      expect(first.subject).toBe('Test 0');
      expect(second.subject).toBe('Test 1');
    });
  });

  describe('Console parallel placement', () => {
    it('places multiple console calls in parallel', async () => {
      const calls = [];
      for (let i = 0; i < 3; i++) {
        const req = new Request('https://test/api/console/calls', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            to: `+1415555012${i}`,
            task: `parallel call ${i}`,
            recordingNoticeAcknowledged: true,
          }),
        });
        const res = await app.fetch(req, env);
        expect(res.status).toBe(202);
        const body = (await res.json()) as { callId: string };
        calls.push(body.callId);
      }

      // All three should be live
      const req = new Request('https://test/api/console/calls/live');
      const res = await app.fetch(req, env);
      const body = (await res.json()) as { calls: unknown[] };
      expect(body.calls).toHaveLength(3);
    });
  });

  describe('Same-number dial lock', () => {
    it('returns 409 dial_locked when a live call already exists to the same to', async () => {
      const first = await app.fetch(
        new Request('https://test/call', {
          method: 'POST',
          headers: { 'x-api-key': env.APP_API_KEY, 'content-type': 'application/json' },
          body: JSON.stringify({ to: '+14155550999', task: 'first dial' }),
        }),
        env,
      );
      expect(first.status).toBe(202);
      const firstBody = (await first.json()) as { callId: string };

      const second = await app.fetch(
        new Request('https://test/call', {
          method: 'POST',
          headers: { 'x-api-key': env.APP_API_KEY, 'content-type': 'application/json' },
          body: JSON.stringify({ to: '+14155550999', task: 'duplicate dial' }),
        }),
        env,
      );
      expect(second.status).toBe(409);
      const body = (await second.json()) as {
        error: string;
        callId?: string;
        detail?: string;
      };
      expect(body.error).toBe('dial_locked');
      expect(body.callId).toBe(firstBody.callId);
    });

    it('allows a second dial to the same to when force=true', async () => {
      const first = await app.fetch(
        new Request('https://test/call', {
          method: 'POST',
          headers: { 'x-api-key': env.APP_API_KEY, 'content-type': 'application/json' },
          body: JSON.stringify({ to: '+14155550888', task: 'first dial' }),
        }),
        env,
      );
      expect(first.status).toBe(202);

      const second = await app.fetch(
        new Request('https://test/call', {
          method: 'POST',
          headers: { 'x-api-key': env.APP_API_KEY, 'content-type': 'application/json' },
          body: JSON.stringify({ to: '+14155550888', task: 'forced dial', force: true }),
        }),
        env,
      );
      expect(second.status).toBe(202);
      const body = (await second.json()) as { callId: string };
      expect(body.callId).toBeTruthy();
    });

    it('still allows a different to while another number is live', async () => {
      await app.fetch(
        new Request('https://test/call', {
          method: 'POST',
          headers: { 'x-api-key': env.APP_API_KEY, 'content-type': 'application/json' },
          body: JSON.stringify({ to: '+14155550777', task: 'live one' }),
        }),
        env,
      );
      const other = await app.fetch(
        new Request('https://test/call', {
          method: 'POST',
          headers: { 'x-api-key': env.APP_API_KEY, 'content-type': 'application/json' },
          body: JSON.stringify({ to: '+14155550778', task: 'other number' }),
        }),
        env,
      );
      expect(other.status).toBe(202);
    });
  });
});
