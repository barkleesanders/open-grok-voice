# Ranged playback, measured against a real runtime

`./node_modules/.bin/wrangler dev --local -c tools/repro/recording-range/wrangler.toml --port 8799`
then `curl http://127.0.0.1:8799/seed`. Run 2026-08-28.

This harness imports the SHIPPED parser from `src/http-range.ts`, so it exercises
production code rather than a re-implementation that could agree with a bug. It
covers the R2 hop only; `test/recording-range.test.ts` covers the HTTP route and
the Durable Object.

## The question the docs do not answer

`developers.cloudflare.com/r2/api/workers/workers-api-reference/` defines
`R2Object.size` only as "Size of the object in bytes" and never says whether that
is the full object or the served slice when `get()` carried a range. That matters
because `size` is the natural denominator for `Content-Range`, and picking wrong
tells a media element the file is only as long as its first chunk — which looks
exactly like the bug this work fixes.

`GET /probe` (`get(KEY, { range: { offset: 10, length: 20 } })` on a 1,000-byte object):

```json
{"requested":{"offset":10,"length":20},"objectSize":1000,
 "objectRange":{"offset":10,"length":20},"bodyLength":20,"bodyMatchesSlice":true}
```

**Measured: `size` is the FULL object size (1000), not the served length (20).**
`range` reports what was served, and the bytes are the correct slice.

Scope of that measurement: this is workerd/miniflare via `--local`, NOT the
production R2 service. It is one implementation agreeing with the more common
reading, not a guarantee from Cloudflare. `src/call-session.ts` therefore still
takes the denominator from `head()`, which is never ranged and so is unambiguous
under either reading. Do not "simplify" that head() away on the strength of this
file: it would make correctness depend on an undocumented behaviour measured in a
different implementation from the one production runs.

## Observed responses

| Request | Status | Content-Range | Content-Length | Body bytes |
|---|---|---|---|---|
| `Range: bytes=0-99` | `206 Partial Content` | `bytes 0-99/1000` | 100 | 100 |
| (no Range) | `200 OK` | — | 1000 | 1000 |
| `Range: bytes=-50` | `206 Partial Content` | `bytes 950-999/1000` | 50 | 50 |
| `Range: bytes=99999-` | `416 Range Not Satisfiable` | `bytes */1000` | — | 0 |
| `Range: bytes=abc` | `200 OK` | — | 1000 | 1000 |

`Accept-Ranges: bytes` is present on the 200, which is what makes the browser
offer seeking at all. `Cache-Control: private, no-store` and
`X-Content-Type-Options: nosniff` survive every branch.
