// LOCAL HARNESS ONLY -- NEVER DEPLOYED. Nothing in src/ imports this file.
//
// It serves the REAL console page and wires the three new features to the REAL
// production modules, with the operator auth gate REMOVED, so the whole flow
// can be driven in a real browser without provisioning Better Auth, D1 and a
// Google OAuth client. Removing the gate is the entire reason this file is
// separate from the Worker and carries a different name in its own config.
//
//   ./node_modules/.bin/wrangler dev -c tools/repro/console-probe/wrangler.toml --port 8799
//
// What it exists to prove, which a unit test cannot:
//   1. `Permissions-Policy: microphone=(self)` actually PERMITS getUserMedia in
//      a real browser. The unit test can only compare a header string.
//   2. The inline console script parses and runs under the real nonce CSP.
//   3. The `AI` binding accepts the exact input `transcribeAudio` builds.
import { renderConsolePage } from '../../../src/console-ui';
import { composeInstructions } from '../../../src/instructions';
import {
  deletePreset,
  listPresets,
  readPreset,
  validPresetName,
  writePreset,
} from '../../../src/presets';
import {
  audioTypeAccepted,
  type TranscriptionRunner,
  transcribeAudio,
} from '../../../src/transcribe';

interface ProbeEnv {
  readonly AI: TranscriptionRunner;
  readonly CALL_LOGS: R2Bucket;
}

/** Byte-identical to the policies the real Worker sends. */
const CONSOLE_PERMISSIONS_POLICY = 'camera=(), geolocation=(), microphone=(self)';

function nonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/[^A-Za-z0-9_-]/g, '');
}

function priv(body: BodyInit, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

/**
 * Hostnames this harness will answer on.
 *
 * It serves an UNAUTHENTICATED console bound to the real R2 bucket and the
 * real Workers AI account. That is fine on a developer's loopback interface
 * and unacceptable anywhere else, and "we would never deploy it" is not a
 * control — one `wrangler deploy -c tools/repro/console-probe/wrangler.toml`
 * is all it would take. This refuses to serve rather than relying on nobody
 * making that mistake.
 */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    const url = new URL(request.url);
    if (!LOCAL_HOSTS.has(url.hostname)) {
      return new Response('this harness only runs on localhost\n', { status: 403 });
    }
    const path = url.pathname;

    if (path === '/' || path === '/console') {
      const pageNonce = nonce();
      return new Response(
        renderConsolePage(pageNonce, 'authorized', { name: 'Probe', image: null }),
        {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${pageNonce}'; style-src 'nonce-${pageNonce}'; img-src 'self' data:; connect-src 'self'; media-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'`,
            'Permissions-Policy': CONSOLE_PERMISSIONS_POLICY,
            'Cache-Control': 'private, no-store',
          },
        },
      );
    }

    if (path === '/api/me') return priv(JSON.stringify({ authenticated: true }));
    if (path === '/api/console/calls' && request.method === 'GET') {
      return priv(JSON.stringify({ calls: [], cursor: null }));
    }

    if (path === '/api/console/script-preview' && request.method === 'POST') {
      const body = (await request.json()) as { task?: string; voicemail?: boolean };
      const segments = composeInstructions({
        task: typeof body.task === 'string' ? body.task : '',
        direction: 'outbound',
        amdResult: body.voicemail === true ? 'machine' : null,
      });
      return priv(JSON.stringify({ segments, text: segments.map((s) => s.text).join('\n') }));
    }

    if (path === '/api/console/presets' && request.method === 'GET') {
      return priv(JSON.stringify({ presets: await listPresets(env.CALL_LOGS) }));
    }
    if (path.startsWith('/api/console/presets/')) {
      const name = decodeURIComponent(path.slice('/api/console/presets/'.length));
      if (!validPresetName(name))
        return priv(JSON.stringify({ error: 'invalid preset name' }), 400);
      if (request.method === 'GET') {
        const record = await readPreset(env.CALL_LOGS, name);
        return record
          ? priv(JSON.stringify(record))
          : priv(JSON.stringify({ error: 'unknown preset' }), 404);
      }
      if (request.method === 'PUT') {
        const body = (await request.json()) as { task?: string };
        const result = await writePreset(env.CALL_LOGS, name, String(body.task ?? ''));
        return result.ok
          ? priv(JSON.stringify(result.record))
          : priv(JSON.stringify({ error: result.reason }), 409);
      }
      if (request.method === 'DELETE') {
        await deletePreset(env.CALL_LOGS, name);
        return priv(JSON.stringify({ deleted: true }));
      }
    }

    if (path === '/api/console/transcribe' && request.method === 'POST') {
      if (!audioTypeAccepted(request.headers.get('Content-Type'))) {
        return priv(JSON.stringify({ error: 'unsupported audio type' }), 415);
      }
      const audio = new Uint8Array(await request.arrayBuffer());
      const result = await transcribeAudio(env.AI, audio);
      if (result.ok) {
        return priv(JSON.stringify({ text: result.text, durationSeconds: result.durationSeconds }));
      }
      if (result.reason === 'no_speech')
        return priv(JSON.stringify({ error: 'no speech detected' }), 422);
      if (result.reason === 'too_long')
        return priv(JSON.stringify({ error: 'recording is too long' }), 413);
      return priv(JSON.stringify({ error: 'transcription failed' }), 502);
    }

    return new Response('not found\n', { status: 404 });
  },
};
