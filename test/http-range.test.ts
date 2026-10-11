import { describe, expect, it } from 'vitest';
import {
  contentRangeValue,
  parseRangeHeader,
  type RangeRequest,
  unsatisfiedContentRangeValue,
} from '../src/http-range';

/** A 1,000-byte object: big enough that clamping and suffixes are distinguishable. */
const SIZE = 1000;

describe('Range header parsing', () => {
  // One table, because the interesting content of this parser IS the edge list.
  // Each row is (header, expected) against SIZE, with the reason it matters.
  const cases: ReadonlyArray<readonly [string | null | undefined, RangeRequest, string]> = [
    // --- the forms a media element actually sends ---
    [
      'bytes=0-99',
      { kind: 'range', offset: 0, length: 100 },
      'closed range is inclusive at both ends',
    ],
    [
      'bytes=100-',
      { kind: 'range', offset: 100, length: 900 },
      'open-ended range runs to the last byte',
    ],
    [
      'bytes=-50',
      { kind: 'range', offset: 950, length: 50 },
      'suffix range counts back from the end',
    ],
    ['bytes=0-0', { kind: 'range', offset: 0, length: 1 }, 'a single byte is a legal range'],
    [
      `bytes=0-${SIZE - 1}`,
      { kind: 'range', offset: 0, length: SIZE },
      'the whole object as an explicit range',
    ],

    // --- absent / ignorable: serve 200, never 206 ---
    [undefined, { kind: 'none' }, 'no header at all'],
    [null, { kind: 'none' }, 'a null header from Headers.get()'],
    ['', { kind: 'none' }, 'an empty header'],
    ['   ', { kind: 'none' }, 'a whitespace-only header'],
    ['bytes=abc', { kind: 'none' }, 'non-numeric positions are malformed and MUST be ignored'],
    ['bytes=0-1,5-6', { kind: 'none' }, 'multi-range is ignored rather than answered multipart'],
    ['bytes=', { kind: 'none' }, 'a unit with no spec'],
    ['bytes=-', { kind: 'none' }, 'a bare dash names neither a start nor a suffix'],
    ['items=0-99', { kind: 'none' }, 'an unknown range unit MUST be ignored'],
    ['0-99', { kind: 'none' }, 'a spec with no unit is malformed'],
    ['bytes=50-10', { kind: 'none' }, 'last-pos below first-pos is invalid, so ignored (not 416)'],
    ['bytes=1e3-', { kind: 'none' }, 'exponent notation is not a digit string'],
    ['bytes=-1.5', { kind: 'none' }, 'a fractional suffix is not a digit string'],
    [
      'bytes=99999999999999999999-',
      { kind: 'none' },
      'a position too long to hold exactly is malformed',
    ],

    // --- unsatisfiable: 416, so the client learns the true length ---
    ['bytes=99999-', { kind: 'unsatisfiable' }, 'a start past the end cannot be served'],
    [
      `bytes=${SIZE}-`,
      { kind: 'unsatisfiable' },
      'a start exactly AT the end is already past the last byte',
    ],
    ['bytes=5000-6000', { kind: 'unsatisfiable' }, 'a closed range wholly past the end'],
    [
      'bytes=-0',
      { kind: 'unsatisfiable' },
      'a zero-length suffix is unsatisfiable, not an empty 206',
    ],

    // --- clamping: a range that overhangs the end is trimmed, not rejected ---
    [
      'bytes=990-99999',
      { kind: 'range', offset: 990, length: 10 },
      'last-pos past the end is clamped',
    ],
    [
      'bytes=-99999',
      { kind: 'range', offset: 0, length: SIZE },
      'an oversized suffix yields the whole object',
    ],

    // --- tolerated whitespace and casing ---
    [
      '  bytes=0-99  ',
      { kind: 'range', offset: 0, length: 100 },
      'surrounding whitespace is trimmed',
    ],
    ['BYTES=0-99', { kind: 'range', offset: 0, length: 100 }, 'the range unit is case-insensitive'],
    [
      'bytes = 0 - 99',
      { kind: 'range', offset: 0, length: 100 },
      'whitespace inside the spec is tolerated',
    ],
  ];

  it.each(cases)('%s -> %o (%s)', (header, expected) => {
    expect(parseRangeHeader(header, SIZE)).toEqual(expected);
  });

  it('treats every range against a zero-byte object as unsatisfiable', () => {
    // Not a hypothetical: archiveRecording refuses a zero Content-Length, but a
    // truncated or hand-placed object can still be empty, and `bytes=0-` on an
    // empty object must not answer "206, 0 bytes" — there is no byte zero.
    expect(parseRangeHeader('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRangeHeader('bytes=-10', 0)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRangeHeader(undefined, 0)).toEqual({ kind: 'none' });
  });

  it('ignores a Range when the size itself is not a usable byte count', () => {
    // Defensive: a caller that hands us a bad size gets a full-body 200 rather
    // than a Content-Range built out of NaN.
    expect(parseRangeHeader('bytes=0-99', Number.NaN)).toEqual({ kind: 'none' });
    expect(parseRangeHeader('bytes=0-99', -1)).toEqual({ kind: 'none' });
  });

  it('never returns a range that runs past the end of the object', () => {
    // A property over the whole table: whatever a client sends, offset+length
    // must land inside the object. This is the invariant that keeps
    // Content-Range honest, so it is asserted directly rather than inferred.
    for (const [header] of cases) {
      const parsed = parseRangeHeader(header, SIZE);
      if (parsed.kind !== 'range') continue;
      expect(parsed.offset).toBeGreaterThanOrEqual(0);
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed.offset + parsed.length).toBeLessThanOrEqual(SIZE);
    }
  });
});

describe('Content-Range formatting', () => {
  it('reports an inclusive end and the FULL object size as the denominator', () => {
    // The denominator is the total length, not the length of this slice. Getting
    // that wrong makes a media element believe the file is only as long as its
    // first chunk, which looks exactly like the bug this work fixes.
    expect(contentRangeValue(0, 100, SIZE)).toBe('bytes 0-99/1000');
    expect(contentRangeValue(950, 50, SIZE)).toBe('bytes 950-999/1000');
    expect(contentRangeValue(0, 1, 1)).toBe('bytes 0-0/1');
  });

  it('reports the real length on an unsatisfiable range', () => {
    expect(unsatisfiedContentRangeValue(SIZE)).toBe('bytes */1000');
    expect(unsatisfiedContentRangeValue(0)).toBe('bytes */0');
  });
});
