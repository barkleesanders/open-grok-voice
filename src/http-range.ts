// HTTP Range parsing, per RFC 9110 section 14.
//
// WHY THIS IS ITS OWN MODULE: the console's audio scrub bar is inert unless the
// server answers ranged requests. `HTMLMediaElement.seekable` stays EMPTY when a
// response carries no `Accept-Ranges` and no length, so the browser has nothing
// to seek within and the slider does nothing — which is exactly what this Worker
// shipped: `grep -rn "Accept-Ranges\|Content-Range\|206" src/` returned zero
// matches before this file existed.
//
// The parsing is separated from the two call sites (R2 archive, provider proxy)
// so the edge cases below are unit-testable without a bucket, a Durable Object,
// or a network.

/**
 * What a client's `Range` header asks for, resolved against a KNOWN object size.
 *
 * A discriminated union rather than `number | null` pairs, because the three
 * outcomes have genuinely different responses (200 / 206 / 416) and collapsing
 * "no range" into "range starting at 0" would answer 206 to a request that never
 * asked for one.
 */
export type RangeRequest =
  /** Serve the whole representation with 200. Also the answer for a header we deliberately ignore. */
  | { readonly kind: 'none' }
  /** Serve bytes [offset, offset+length-1] with 206. Always satisfiable and already clamped. */
  | { readonly kind: 'range'; readonly offset: number; readonly length: number }
  /** Nothing in the header can be served: answer 416 with `Content-Range: bytes * /size`. */
  | { readonly kind: 'unsatisfiable' };

/**
 * Digits only, and few enough that `Number()` cannot lose precision. A 16-digit
 * cap keeps every accepted value inside Number.MAX_SAFE_INTEGER, so an absurd
 * `bytes=99999999999999999999-` is rejected as malformed rather than silently
 * becoming a rounded float that then compares wrong against `size`.
 */
const POSITION = /^[0-9]{1,16}$/;

/**
 * Resolve a `Range` header against an object of `size` bytes.
 *
 * Deliberate choices, each of which RFC 9110 permits:
 *   - A syntactically INVALID Range MUST be ignored (section 14.2: "An origin
 *     server MUST ignore a Range header field that contains a range unit it does
 *     not understand"), so those return `none` and the caller answers 200.
 *   - A MULTI-range request is ignored rather than answered with
 *     multipart/byteranges. Section 14.2 allows a server to ignore Range
 *     entirely, and no audio element sends one; building a multipart body to
 *     serve a case that never arrives is untested weight.
 *   - An unsatisfiable range gets 416 rather than a silent 200, because a media
 *     element that seeks past the end needs to learn the real length.
 */
export function parseRangeHeader(header: string | null | undefined, size: number): RangeRequest {
  if (!Number.isSafeInteger(size) || size < 0) return { kind: 'none' };
  if (header === null || header === undefined) return { kind: 'none' };
  const raw = header.trim();
  if (raw.length === 0) return { kind: 'none' };

  // Range units are case-insensitive; anything but `bytes` is a unit we do not
  // understand and therefore must ignore.
  const eq = raw.indexOf('=');
  if (eq < 0) return { kind: 'none' };
  if (raw.slice(0, eq).trim().toLowerCase() !== 'bytes') return { kind: 'none' };

  const spec = raw.slice(eq + 1).trim();
  // Multi-range: ignored on purpose (see the doc comment).
  if (spec.includes(',')) return { kind: 'none' };

  const dash = spec.indexOf('-');
  if (dash < 0) return { kind: 'none' };
  const firstRaw = spec.slice(0, dash).trim();
  const lastRaw = spec.slice(dash + 1).trim();

  // Suffix form: `bytes=-N` means "the last N bytes".
  if (firstRaw.length === 0) {
    if (!POSITION.test(lastRaw)) return { kind: 'none' };
    const suffix = Number(lastRaw);
    // A zero-length suffix, and any suffix against an empty object, can never be
    // satisfied. RFC 9110 section 14.1.2 treats a suffix-length of 0 as
    // unsatisfiable rather than as an empty success.
    if (suffix === 0 || size === 0) return { kind: 'unsatisfiable' };
    // "If the selected representation is shorter than the specified
    // suffix-length, the entire representation is used." (section 14.1.2)
    const length = Math.min(suffix, size);
    return { kind: 'range', offset: size - length, length };
  }

  if (!POSITION.test(firstRaw)) return { kind: 'none' };
  const first = Number(firstRaw);
  // A start at or past the end is unsatisfiable — including every range against
  // a zero-byte object, since `first >= 0 === size` there.
  if (first >= size) return { kind: 'unsatisfiable' };

  // Open-ended form: `bytes=N-` means "N through the end".
  if (lastRaw.length === 0) return { kind: 'range', offset: first, length: size - first };

  if (!POSITION.test(lastRaw)) return { kind: 'none' };
  const last = Number(lastRaw);
  // "If the last-pos value is less than the first-pos value, the byte-range-spec
  // is invalid" (section 14.1.1) — invalid, so ignored, not 416.
  if (last < first) return { kind: 'none' };
  // A last-pos past the end is clamped, not rejected.
  const end = Math.min(last, size - 1);
  return { kind: 'range', offset: first, length: end - first + 1 };
}

/** The `Content-Range` value for a served range: `bytes <start>-<end>/<size>`. */
export function contentRangeValue(offset: number, length: number, size: number): string {
  return `bytes ${offset}-${offset + length - 1}/${size}`;
}

/** The `Content-Range` value for a 416: `bytes * /<size>`, which reports the real length. */
export function unsatisfiedContentRangeValue(size: number): string {
  return `bytes */${size}`;
}
