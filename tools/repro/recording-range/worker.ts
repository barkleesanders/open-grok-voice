// Range playback against a REAL workerd runtime and a REAL R2 binding.
//
// The vitest suite proves the logic against a hand-written R2 fake. This proves
// the two things a fake cannot:
//   1. workerd's R2 binding really honours `get(key, { range: { offset, length } })`.
//   2. What `R2Object.size` reports on a RANGED get — which the Workers docs do
//      not state (developers.cloudflare.com/r2/api/workers/workers-api-reference/
//      defines it only as "Size of the object in bytes"). src/call-session.ts is
//      deliberately written not to depend on the answer; this measures it anyway
//      so the ambiguity is recorded rather than assumed.
//
// It imports the SAME parser the Worker ships (../../../src/http-range) so this
// is a test of production code, not a re-implementation that could agree with a
// bug. It does NOT exercise operatorGate or the CallSession DO; the vitest file
// test/recording-range.test.ts covers that hop.
//
// Run:  ./node_modules/.bin/wrangler dev --local -c tools/repro/recording-range/wrangler.toml

import {
  contentRangeValue,
  parseRangeHeader,
  unsatisfiedContentRangeValue,
} from '../../../src/http-range';

interface HarnessEnv {
  readonly BUCKET: R2Bucket;
}

const KEY = 'recordings/fixture/rec.wav';
/** 1,000 distinguishable bytes: a wrong offset shows up in the body, not just the headers. */
const AUDIO = Array.from({ length: 1000 }, (_, i) => String.fromCharCode(33 + (i % 90))).join('');

export default {
  async fetch(request: Request, env: HarnessEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/seed') {
      await env.BUCKET.put(KEY, AUDIO, { httpMetadata: { contentType: 'audio/wav' } });
      return Response.json({ seeded: KEY, bytes: AUDIO.length });
    }

    // Reports what R2 itself says on a ranged get, so the `size` question is
    // answered by measurement rather than by reading the docs harder.
    if (url.pathname === '/probe') {
      const object = await env.BUCKET.get(KEY, { range: { offset: 10, length: 20 } });
      if (!object) return Response.json({ error: 'not seeded' }, { status: 404 });
      const body = await object.text();
      return Response.json({
        requested: { offset: 10, length: 20 },
        objectSize: object.size,
        objectRange: object.range ?? null,
        bodyLength: body.length,
        bodyMatchesSlice: body === AUDIO.slice(10, 30),
      });
    }

    if (url.pathname !== '/recording') return new Response('not found', { status: 404 });

    const head = await env.BUCKET.head(KEY);
    if (!head) return Response.json({ error: 'not seeded' }, { status: 404 });
    const size = head.size;
    const requested = parseRangeHeader(request.headers.get('Range'), size);

    const base: Record<string, string> = {
      'Content-Type': 'audio/wav',
      'Cache-Control': 'private, no-store',
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'bytes',
    };

    if (requested.kind === 'unsatisfiable') {
      return new Response(null, {
        status: 416,
        headers: { ...base, 'Content-Range': unsatisfiedContentRangeValue(size) },
      });
    }
    if (requested.kind === 'none') {
      const object = await env.BUCKET.get(KEY);
      if (!object) return Response.json({ error: 'vanished' }, { status: 404 });
      return new Response(object.body, {
        status: 200,
        headers: { ...base, 'Content-Length': String(size), ETag: head.httpEtag },
      });
    }
    const object = await env.BUCKET.get(KEY, {
      range: { offset: requested.offset, length: requested.length },
    });
    if (!object) return Response.json({ error: 'vanished' }, { status: 404 });
    return new Response(object.body, {
      status: 206,
      headers: {
        ...base,
        'Content-Length': String(requested.length),
        'Content-Range': contentRangeValue(requested.offset, requested.length, size),
        ETag: head.httpEtag,
      },
    });
  },
};
