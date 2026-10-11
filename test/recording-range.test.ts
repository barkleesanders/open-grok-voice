// Ranged playback, end to end: HTTP route -> Durable Object -> R2.
//
// WHY THIS FILE EXISTS: the console's scrub bar was inert. A recording played
// but could not be seeked, because every layer answered a bare 200 with no
// length and no Accept-Ranges, and `HTMLMediaElement.seekable` is populated
// only from a range-capable response. Before this work
// `grep -rn "Accept-Ranges\|Content-Range\|206" src/` matched NOTHING.
//
// The test drives the REAL Hono app and the REAL CallSession class, so it fails
// if ANY of the three hops drops the Range: the route -> DO subrequest, the DO's
// R2 read, or the response on the way back out. Only two things are faked: the
// R2 bucket, and the auth module (a Better Auth session needs a live D1, and
// this file is not testing sign-in).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperatorSession } from '../src/auth';
import { readUtf8 } from './read-utf8';

// Only the session lookup is replaced. operatorGate, the route body, the DO
// dispatch and every header decision below it still run as shipped.
vi.mock('../src/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/auth')>();
  const authorized: OperatorSession = {
    kind: 'authorized',
    user: { name: 'Operator', image: null },
  };
  return { ...actual, getOperatorSession: async (): Promise<OperatorSession> => authorized };
});

// vi.mock is hoisted above these by vitest, so the app below is built against
// the mocked auth module even though the imports read as ordinary statics.
import { recordingObjectKey } from '../src/call-log';
import { CallSession } from '../src/call-session';
import type { Env } from '../src/env';
import { app } from '../src/index';
import type { RecordingAsset } from '../src/recordings';
import { type CallState, initialState } from '../src/state';
import { createFakeDurableObjectState } from './fake-do';
import { createFakeR2, type FakeR2 } from './fake-r2';
import { testEnv } from './test-env';

const CALL_ID = '44444444-4444-4444-8444-444444444444';
const T0 = 1_756_000_000_000;
/** 1,000 distinguishable bytes, so a wrong offset is visible in the body, not just the headers. */
const AUDIO = Array.from({ length: 1000 }, (_, i) => String.fromCharCode(33 + (i % 90))).join('');

const wavAsset: RecordingAsset = {
  id: 'rec-range',
  format: 'wav',
  channels: 'dual',
  url: 'https://s3.amazonaws.com/bucket/rec-range.wav',
  startedAt: null,
  endedAt: null,
};

interface Fixture {
  readonly env: Env;
  readonly r2: FakeR2;
}

/**
 * A DurableObjectNamespace whose stub delegates to a REAL CallSession.
 *
 * Same runtime-enforced-partial technique as test/fake-do.ts: only the members
 * the Worker actually calls are implemented, so reaching for any other member
 * throws a TypeError naming it rather than silently reading undefined.
 */
function namespaceFor(session: CallSession): DurableObjectNamespace {
  const stub = Object.assign({} as DurableObjectStub, {
    // CallSession.fetch is typed `Response | Promise<Response>`; the stub
    // contract is strictly a Promise, so normalise rather than assert.
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      await session.fetch(new Request(input instanceof Request ? input : String(input), init)),
  });
  return Object.assign({} as DurableObjectNamespace, {
    idFromName: (name: string) => Object.assign({} as DurableObjectId, { toString: () => name }),
    get: () => stub,
  });
}

async function fixture(): Promise<Fixture> {
  const r2 = createFakeR2();
  const doState = createFakeDurableObjectState();
  const env = testEnv({ CALL_LOGS: r2.bucket });
  const session = new CallSession(doState.ctx, env);
  const seeded: CallState = {
    ...initialState({
      callId: CALL_ID,
      to: '+14155550123',
      task: 'Ask about the referral.',
      voice: 'liora',
      amd: null,
      now: T0,
    }),
    phase: 'completed',
    recordings: [wavAsset],
  };
  await doState.ctx.storage.put('state', seeded);
  // The archived bytes the console plays back.
  await r2.bucket.put(recordingObjectKey(CALL_ID, wavAsset), AUDIO, {
    httpMetadata: { contentType: 'audio/wav' },
  });
  return { env: testEnv({ CALL_LOGS: r2.bucket, CALL_SESSION: namespaceFor(session) }), r2 };
}

// Hono's app.fetch is typed `Response | Promise<Response>`; await it rather
// than assert the union away.
async function play(env: Env, range?: string): Promise<Response> {
  return await app.fetch(
    new Request(`https://bridge.example.test/api/console/calls/${CALL_ID}/recording/wav`, {
      headers: range === undefined ? {} : { Range: range },
    }),
    env,
  );
}

describe('ranged playback of an archived recording', () => {
  let env: Env;
  beforeEach(async () => {
    ({ env } = await fixture());
  });

  it('answers a ranged request with 206 and an exact Content-Range', async () => {
    const res = await play(env, 'bytes=0-99');
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 0-99/1000');
    expect(res.headers.get('Content-Length')).toBe('100');
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    // The BYTES must match the range, not just the headers. A response that
    // declares 0-99 and returns the whole file is the more dangerous bug,
    // because the headers look right.
    const body = await res.text();
    expect(body).toHaveLength(100);
    expect(body).toBe(AUDIO.slice(0, 100));
  });

  it('answers an unranged request with 200, a full length, and Accept-Ranges', async () => {
    const res = await play(env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Length')).toBe('1000');
    // Without this header the browser never offers seeking, which was the bug.
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(res.headers.get('Content-Range')).toBeNull();
    expect(await res.text()).toBe(AUDIO);
  });

  it('serves the tail for a suffix range', async () => {
    const res = await play(env, 'bytes=-50');
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 950-999/1000');
    expect(await res.text()).toBe(AUDIO.slice(950));
  });

  it('serves to the end for an open-ended range', async () => {
    const res = await play(env, 'bytes=900-');
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 900-999/1000');
    expect(res.headers.get('Content-Length')).toBe('100');
    expect(await res.text()).toBe(AUDIO.slice(900));
  });

  it('clamps a range that overhangs the end instead of failing', async () => {
    const res = await play(env, 'bytes=990-99999');
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 990-999/1000');
    expect(await res.text()).toBe(AUDIO.slice(990));
  });

  it('answers 416 with the true length when the range starts past the end', async () => {
    const res = await play(env, 'bytes=99999-');
    expect(res.status).toBe(416);
    // The denominator is how a seeking player learns it overshot.
    expect(res.headers.get('Content-Range')).toBe('bytes */1000');
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
  });

  it('ignores a malformed or multi-range header and serves the whole file', async () => {
    for (const header of ['bytes=abc', 'bytes=0-1,5-6', 'items=0-99']) {
      const res = await play(env, header);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Length')).toBe('1000');
      expect(await res.text()).toBe(AUDIO);
    }
  });

  it('keeps the PII headers on every range outcome', async () => {
    // These recordings are a real phone call. Range negotiation must not become
    // a way to lose no-store or nosniff on some branch.
    for (const header of [undefined, 'bytes=0-99', 'bytes=99999-']) {
      const res = await play(env, header);
      expect(res.headers.get('Cache-Control')).toBe('private, no-store');
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    }
  });

  it('declares Vary: Range on every outcome, so a cache cannot mix slices', async () => {
    // The body of this route now depends on a REQUEST header. `no-store` is
    // what actually stops caching today, so this is the second guard rather
    // than the live fix -- but the two fail differently. If the Cache-Control
    // is ever loosened, or a CDN/proxy is put in front, a cache without `Vary`
    // may hand one client's 206 slice to the next client's unranged GET. That
    // reads as a corrupt recording, not as a caching bug.
    for (const header of [undefined, 'bytes=0-99', 'bytes=-50', 'bytes=99999-', 'bytes=abc']) {
      const res = await play(env, header);
      const vary = (res.headers.get('Vary') ?? '').split(',').map((part) => part.trim());
      const label = header ?? '(none)';
      expect(vary, `Vary lacks Range for: ${label}`).toContain('Range');
      // Not incidental: the app appends `Vary: Cookie` globally (src/index.ts)
      // because these responses are session-scoped. Asserting membership rather
      // than equality is what lets both invariants coexist -- and asserting
      // Cookie here means a future edit that overWRITES Vary instead of
      // appending shows up as an auth-caching bug rather than passing quietly.
      expect(vary, `Vary lost Cookie for: ${label}`).toContain('Cookie');
    }
  });

  it('sets Vary inside the Durable Object too, where the response is built', async () => {
    // Written because the negative control demanded it. Stripping Vary from
    // call-session.ts's recordingHeaders turned NOTHING red: the route sets the
    // header unconditionally and does not forward the DO's, so the DO-level
    // value is invisible from the outside. An invariant no test can observe is
    // one that rots silently, so assert it at the layer that owns it -- the
    // same belt-and-braces the file already applies to Cache-Control/nosniff.
    const stub = env.CALL_SESSION.get(env.CALL_SESSION.idFromName(CALL_ID));
    for (const range of [undefined, 'bytes=0-99', 'bytes=99999-']) {
      const res = await stub.fetch(
        new Request('https://do/recording?format=wav', {
          headers: range === undefined ? {} : { Range: range },
        }),
      );
      expect(res.headers.get('Vary'), `DO dropped Vary for: ${range ?? '(none)'}`).toBe('Range');
    }
  });

  it('sets Vary at the ROUTE, not only inside the Durable Object', async () => {
    // Structural, and the reason this test exists: index.ts rebuilds the
    // response from a fixed allowlist of DO headers. A `Vary` set only in
    // call-session.ts would be dropped at that hop and never reach the browser
    // -- source that looks correct, behaviour that is not. Assert the header is
    // stated unconditionally in the route itself so a future edit to the
    // allowlist cannot silently remove it.
    const route = readUtf8(import.meta.url, '../src/index.ts');
    const start = route.indexOf("app.get('/api/console/calls/:id/recording/:format'");
    expect(start, 'recording route not found -- this test needs updating').toBeGreaterThan(-1);
    let depth = 0;
    let seen = false;
    let end = -1;
    for (let i = start; i < route.length; i++) {
      if (route[i] === '{') {
        depth++;
        seen = true;
      } else if (route[i] === '}' && seen && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    // Fail loudly rather than slicing to '' -- an empty body would make the
    // assertion below pass while proving nothing.
    expect(end, 'could not brace-match the recording route body').toBeGreaterThan(start);
    expect(route.slice(start, end)).toMatch(/Vary:\s*'Range'/);
  });
});
