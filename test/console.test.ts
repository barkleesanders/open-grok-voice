import { describe, expect, it } from 'vitest';
import { renderConsolePage } from '../src/console-ui';
import type { Env } from '../src/env';
import { app } from '../src/index';
import { issueMediaToken } from '../src/media';
import { encodeClientState } from '../src/types';
import { testEnv } from './test-env';

const CALL_ID = '33333333-3333-4333-8333-333333333333';

function unprovisionedEnv(): Env {
  return testEnv();
}

async function request(
  path: string,
  init: RequestInit = {},
  env: Env = unprovisionedEnv(),
): Promise<Response> {
  return app.fetch(new Request(`https://bridge.example.test${path}`, init), env);
}

describe('operator console route boundaries', () => {
  it('mounts both Better Auth verbs and fails closed before D1 is provisioned', async () => {
    await expect(request('/api/auth/get-session')).resolves.toMatchObject({ status: 503 });
    await expect(
      request('/api/auth/sign-in/social', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'google' }),
      }),
    ).resolves.toMatchObject({ status: 503 });
  });

  it('serves a fail-closed config screen without embedding secrets', async () => {
    const response = await request('/console');
    const html = await response.text();
    expect(response.status).toBe(503);
    expect(response.headers.get('Content-Security-Policy')).toMatch(/script-src 'nonce-/);
    expect(response.headers.get('Content-Security-Policy')).toContain("connect-src 'self'");
    expect(response.headers.get('Content-Security-Policy')).not.toContain('ws: wss:');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toContain('Cookie');
    expect(html).toContain('Console auth is not configured');
    expect(html).toContain('rel="icon"');
    expect(html).not.toContain('APP_API_KEY');
    expect(html).not.toContain('XAI_API_KEY');
    expect(html).not.toContain('TELNYX_API_KEY');

    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
      .map((match) => match[1])
      .filter((script): script is string => Boolean(script?.trim()));
    expect(scripts).toHaveLength(1);
    const script = scripts[0];
    if (!script) throw new Error('expected one inline console script');
    expect(() => new Function(script)).not.toThrow();
    expect(() => new Function(`${script} }`)).toThrow(SyntaxError);
  });

  it('rejects anonymous session and console call API requests', async () => {
    const me = await request('/api/me');
    expect(me.status).toBe(401);
    expect(me.headers.get('Cache-Control')).toBe('private, no-store');
    expect(me.headers.get('Vary')).toContain('Cookie');

    const calls = await request('/api/console/calls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: '+14155550123',
        task: 'should not reach the call DO',
        recordingNoticeAcknowledged: true,
      }),
    });
    expect(calls.status).toBe(401);
    expect(calls.headers.get('Cache-Control')).toBe('private, no-store');
    expect(calls.headers.get('Vary')).toContain('Cookie');

    // The backfill route REWRITES every object in the call archive. Its own
    // test file mocks the session as always-authorized, which proves the
    // behaviour but says nothing about the gate -- so the gate is asserted
    // here, where the session is genuinely anonymous.
    const backfill = await request('/api/console/calls/backfill-subjects', { method: 'POST' });
    expect(backfill.status).toBe(401);
    expect(backfill.headers.get('Cache-Control')).toBe('private, no-store');

    const schedules = await request('/api/console/schedules');
    expect(schedules.status).toBe(401);
    expect(schedules.headers.get('Cache-Control')).toBe('private, no-store');

    const cancel = await request(
      '/api/console/schedules/sch_11111111-1111-4111-8111-111111111111',
      {
        method: 'DELETE',
      },
    );
    expect(cancel.status).toBe(401);
    expect(cancel.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('adds baseline security headers to public responses', async () => {
    const response = await request('/health');
    expect(response.status).toBe(200);
    expect(response.headers.get('Strict-Transport-Security')).toBe(
      'max-age=31536000; includeSubDomains',
    );
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
  });

  it('rejects a browser WebSocket before any call-control access without a session', async () => {
    const token = await issueMediaToken('browser-secret', CALL_ID, 'browser');
    const response = await request(
      `/api/console/calls/${CALL_ID}/monitor?token=${encodeURIComponent(token)}`,
      { headers: { Upgrade: 'websocket' } },
      testEnv({ BETTER_AUTH_SECRET: 'browser-secret' }),
    );
    expect(response.status).toBe(401);
  });
});

describe('public media and webhook negative controls', () => {
  it('rejects an invalid Telnyx ingress token and accepts no unauthenticated stream', async () => {
    const bad = await request(
      `/telnyx-media/${CALL_ID}?token=not-valid`,
      { headers: { Upgrade: 'websocket' } },
      testEnv({ BETTER_AUTH_SECRET: 'ingress-secret' }),
    );
    expect(bad.status).toBe(401);

    const validToken = await issueMediaToken('ingress-secret', CALL_ID, 'ingress');
    const unavailable = await request(
      `/telnyx-media/${CALL_ID}?token=${encodeURIComponent(validToken)}`,
      { headers: { Upgrade: 'websocket' } },
      testEnv({ BETTER_AUTH_SECRET: 'ingress-secret' }),
    );
    expect(unavailable.status).toBe(503);
  });

  it('rejects an unsigned recording callback when signature verification is required', async () => {
    const body = JSON.stringify({
      data: {
        event_type: 'call.recording.saved',
        payload: {
          client_state: encodeClientState({ callId: CALL_ID, leg: 'A' }),
          recording_id: 'recording-1',
          format: 'wav',
          channels: 'dual',
          recording_urls: { wav: 'https://s3.amazonaws.com/call.wav' },
        },
      },
    });
    const response = await request('/telnyx-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    expect(response.status).toBe(401);
  });

  it('acks an unattributed or untrusted recording callback without touching a call DO', async () => {
    const env = testEnv({ ALLOW_UNSIGNED_WEBHOOKS: 'true' });
    const wrongLeg = await request(
      '/telnyx-webhook',
      {
        method: 'POST',
        body: JSON.stringify({
          data: {
            event_type: 'call.recording.saved',
            payload: { client_state: encodeClientState({ callId: CALL_ID, leg: 'B' }) },
          },
        }),
      },
      env,
    );
    expect(wrongLeg.status).toBe(200);

    const untrustedUrl = await request(
      '/telnyx-webhook',
      {
        method: 'POST',
        body: JSON.stringify({
          data: {
            event_type: 'call.recording.saved',
            payload: {
              client_state: encodeClientState({ callId: CALL_ID, leg: 'A' }),
              format: 'wav',
              channels: 'dual',
              recording_urls: { wav: 'https://evil.example/call.wav' },
            },
          },
        }),
      },
      env,
    );
    expect(untrustedUrl.status).toBe(200);
  });
});

describe('call log route boundaries', () => {
  it('refuses to enumerate past calls without an operator session', async () => {
    const response = await request('/api/console/calls');
    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toContain('Cookie');
  });

  it('accepts standing APP_API_KEY (x-api-key) for archive list', async () => {
    // Agents/MCP use the same standing key as POST /call. A wrong key still
    // 401s; a valid key must reach the call-log handler (503 if R2 unbound in
    // this fixture env — never 401).
    const rejected = await request('/api/console/calls?limit=100', {
      headers: { 'x-api-key': 'wrong-key' },
    });
    expect(rejected.status).toBe(401);

    const response = await request('/api/console/calls?limit=100', {
      headers: { 'x-api-key': 'test-app-key' },
    });
    expect(response.status).not.toBe(401);
    expect([200, 503, 502]).toContain(response.status);
  });

  it('accepts standing APP_API_KEY for archived call get', async () => {
    const callId = 'f92e725a-fff4-4c6d-bbd6-0ec5adca3159';
    const rejected = await request(`/api/console/calls/${callId}`, {
      headers: { 'x-api-key': 'wrong-key' },
    });
    expect(rejected.status).toBe(401);

    const response = await request(`/api/console/calls/${callId}`, {
      headers: { 'x-api-key': 'test-app-key' },
    });
    // Unbound DO/R2 in unit env → 404/502/503; auth must not be the failure.
    expect(response.status).not.toBe(401);
  });
});

describe('console page surfaces the call log', () => {
  it('renders the list container and its controls under the nonce CSP', async () => {
    const response = await request('/console');
    const html = await response.text();
    // Unauthenticated render is the login shell, so assert on the authorized
    // markup through the renderer directly rather than faking a session.
    const page = renderConsolePage('test-nonce', 'authorized', {
      id: 'u1',
      name: 'Operator',
      email: 'op@example.test',
    } as never);
    expect(page).toContain('id="calllog"');
    expect(page).toContain('id="calllog-refresh"');
    expect(page).toContain('id="calllog-more"');
    expect(page).toContain('Past calls');
    // CSP forbids inline handlers; every control must bind with addEventListener.
    expect(page).not.toMatch(/<button[^>]*\son(click|load)=/i);
    expect(html).toContain('rel="icon"');
  });
});

describe('console script and markup agree', () => {
  // The page runs under a nonce CSP with no external assets, so a typo in an
  // element id fails at runtime as a TypeError on null and takes the whole
  // panel with it. Nothing else in the suite would notice.
  it('resolves every element the inline script looks up', () => {
    const page = renderConsolePage('test-nonce', 'authorized', {
      id: 'u1',
      name: 'Operator',
      email: 'op@example.test',
    } as never);
    const script = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/.exec(page)?.[1] ?? '';
    expect(script).not.toHaveLength(0);
    const looked = [...script.matchAll(/byId\('([^']+)'\)/g)].map((m) => m[1]);
    expect(looked.length).toBeGreaterThan(10);
    const present = new Set([...page.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    // 'google-login' exists only on the login shell; the script branches on it.
    const missing = looked.filter((id) => id !== 'google-login' && !present.has(id as string));
    expect(missing, `script looks up ids absent from the page: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('microphone policy', () => {
  it('grants the microphone to the console page and nowhere else', async () => {
    // THE REGRESSION THIS PINS: `microphone=()` is an EMPTY allowlist, which
    // disables the feature for every origin INCLUDING same-origin. The console
    // shipped with that header, so getUserMedia would have rejected with
    // NotAllowedError before the browser ever showed a permission prompt and
    // the dictation button could never have worked.
    const consolePage = await request('/console');
    const policy = consolePage.headers.get('Permissions-Policy') ?? '';
    expect(policy).toContain('microphone=(self)');
    expect(policy).toContain('camera=()');
    expect(policy).toContain('geolocation=()');

    const other = await request('/health');
    expect(other.headers.get('Permissions-Policy')).toBe(
      'camera=(), geolocation=(), microphone=()',
    );
  });
});

describe('console workspace controls', () => {
  async function workspaceHtml(): Promise<string> {
    // renderConsolePage is called directly: the route fails closed at 503
    // before auth is provisioned, so the authorized markup is unreachable
    // over HTTP in this environment.
    return renderConsolePage('testnonce', 'authorized', { name: 'Operator', image: null });
  }

  it('renders the script preview, preset controls, and dictation button', async () => {
    const html = await workspaceHtml();
    expect(html).toContain('id="script-preview"');
    expect(html).toContain('id="script-voicemail"');
    expect(html).toContain('id="preset-select"');
    expect(html).toContain('id="preset-name"');
    expect(html).toContain('id="preset-save"');
    expect(html).toContain('id="preset-load"');
    expect(html).toContain('id="preset-delete"');
    expect(html).toContain('id="dictate"');
  });

  it('gives the operator no way to author an instructions blob', async () => {
    const html = await workspaceHtml();
    // The preview is a div, never a form control, and the only free-text
    // fields are the task, the destination, the voice, and the preset name.
    expect(html).not.toMatch(/<textarea[^>]*id="script/);
    expect(html).not.toMatch(/contenteditable/i);
    const editableIds = [...html.matchAll(/<(?:textarea|input)[^>]*id="([^"]+)"/g)].map(
      (match) => match[1],
    );
    // `call-subject` is admitted deliberately, and it is the one addition that
    // needed an argument. It is free text, but it is NOT prompt input: it never
    // enters composeInstructions and never reaches xAI -- it only names the call
    // in the archive and the console's log. The test below is what holds that
    // claim up; this allowlist alone would let a future change quietly route it
    // into the prompt while still passing here.
    //
    // `participant-to` and `participant-label` were added with conference
    // support and are admitted on the same argument as `call-subject`: neither
    // is prompt input the operator authors. The number is dialed, and the label
    // is rendered into FIXED sentences by participantsDirective() after passing
    // through sanitizeParticipantLabel -- it can never become an instruction
    // line of its own. test/conference.test.ts holds that claim up.
    //
    // `call-participants` is the same argument once more, and the narrowest of
    // the three: every token it contains is checked against the ONE exported
    // E.164 pattern before the request leaves the browser and again by the zod
    // schema at the route, so the only strings it can carry are dialable
    // numbers. It is not rendered into the prompt at all -- start-of-call
    // participants reach composeInstructions only as roster rows, by the same
    // path as a mid-call add.
    //
    // `participant-role` is deliberately NOT here: it is a <select>, and this
    // regex matches only <input> and <textarea>. A select can submit nothing
    // but its own fixed options, which is what this test is about -- free text
    // the operator authors. `call-amd` and `preset-select` are absent for the
    // same reason and were before this change.
    expect(editableIds.sort()).toEqual([
      'call-calcom-slug',
      'call-participants',
      'call-run-at',
      'call-slot-minutes',
      'call-subject',
      'call-task',
      'call-to',
      'call-voice',
      'call-window-days',
      'participant-label',
      'participant-to',
      'preset-name',
      'recording-consent',
      'script-voicemail',
    ]);
  });
});
