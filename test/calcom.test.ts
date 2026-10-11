import { describe, expect, it } from 'vitest';
import {
  type AvailabilityOptions,
  DEFAULT_AVAILABILITY,
  filterSlotsByTravel,
  renderSlots,
} from '../src/availability';
import { parseSlots } from '../src/calcom';
import { readUtf8 } from './read-utf8';

const OPT: AvailabilityOptions = { ...DEFAULT_AVAILABILITY, timeZone: 'America/Los_Angeles' };
// A REAL captured response, not a hand-written mock — a mock would only prove
// the parser matches my assumption about the shape.
const REAL = JSON.parse(readUtf8(import.meta.url, '../src/__fixtures__/calcom/v2-slots.json'));

describe('parseSlots — against the captured live response', () => {
  it('extracts sorted, de-duplicated epoch times', () => {
    const s = parseSlots(REAL);
    expect(s.length).toBeGreaterThan(0);
    expect([...s]).toEqual([...s].sort((a, b) => a - b));
    expect(new Set(s).size).toBe(s.length);
    for (const t of s) expect(Number.isFinite(t)).toBe(true);
  });

  it('also reads the booking page trpc shape (different wrapper AND field name)', () => {
    const trpc = {
      result: {
        data: { json: { slots: { '2026-08-27': [{ time: '2026-08-27T16:00:00.000Z' }] } } },
      },
    };
    expect(parseSlots(trpc)).toEqual([Date.parse('2026-08-27T16:00:00.000Z')]);
  });

  it('THROWS on an unrecognised body instead of returning []', () => {
    // [] means "no availability"; a failed parse means "unknown". Collapsing
    // them would have the agent assert a free calendar it never read.
    expect(() => parseSlots({ status: 'error' })).toThrow(/unrecognised/i);
    expect(() => parseSlots(null)).toThrow();
  });

  it('skips malformed entries without discarding the good ones', () => {
    const mixed = {
      data: { '2026-08-27': [{ start: 'not-a-date' }, {}, { start: '2026-08-27T16:00:00Z' }] },
    };
    expect(parseSlots(mixed)).toEqual([Date.parse('2026-08-27T16:00:00Z')]);
  });
});

describe('filterSlotsByTravel — the one thing cal.com cannot know', () => {
  const T = (iso: string): number => Date.parse(iso);
  // In-person 10:00-11:00 PT.
  const inPerson = [
    { startMs: T('2026-08-29T17:00:00Z'), endMs: T('2026-08-29T18:00:00Z'), remote: false },
  ];
  const remote = [
    { startMs: T('2026-08-29T17:00:00Z'), endMs: T('2026-08-29T18:00:00Z'), remote: true },
  ];

  it('drops a slot starting immediately after an IN-PERSON commitment', () => {
    const at1100 = T('2026-08-29T18:00:00Z');
    expect(filterSlotsByTravel([at1100], inPerson, 30, OPT)).toEqual([]);
  });

  it('keeps that same slot when the commitment was REMOTE', () => {
    // Positive control: proves the drop above is caused by in-person-ness,
    // not by the slot merely being adjacent.
    const at1100 = T('2026-08-29T18:00:00Z');
    expect(filterSlotsByTravel([at1100], remote, 30, OPT)).toEqual([at1100]);
  });

  it('keeps a slot beyond the travel radius', () => {
    const far = T('2026-08-29T18:35:00Z'); // 11:35, past 11:00 + 30min travel
    expect(filterSlotsByTravel([far], inPerson, 30, OPT)).toEqual([far]);
  });

  it('accounts for the slot DURATION, not just its start', () => {
    // 9:15 + 60min runs into the 10:00 event even though 9:15 itself is clear.
    const at0915 = T('2026-08-29T16:15:00Z');
    expect(filterSlotsByTravel([at0915], inPerson, 60, OPT)).toEqual([]);
    expect(filterSlotsByTravel([at0915], inPerson, 15, OPT)).toEqual([at0915]);
  });

  it('is a no-op with no in-person commitments', () => {
    const s = [T('2026-08-29T18:00:00Z'), T('2026-08-29T19:00:00Z')];
    expect(filterSlotsByTravel(s, [], 30, OPT)).toEqual(s);
  });
});

describe('renderSlots — what the agent is told', () => {
  const NOW = Date.parse('2026-08-26T22:00:00Z');
  const slots = [
    Date.parse('2026-08-27T16:00:00Z'),
    Date.parse('2026-08-27T16:30:00Z'),
    Date.parse('2026-08-28T17:00:00Z'),
  ];
  const R = {
    slotMinutes: 30,
    bookingUrl: 'https://cal.com/your-username',
    requiresConfirmation: true,
  };

  it('emits discrete start times grouped by day, and the date anchor', () => {
    const out = renderSlots(slots, OPT, NOW, R);
    expect(out).toContain('RIGHT NOW it is Wednesday, August 26, 2026');
    expect(out).toContain('bookable 30-minute start times');
    expect(out).toContain('- Thursday, August 27: 9:00 AM, 9:30 AM');
    expect(out).toContain('Never invent a time that is not listed');
  });

  it('gives the booking link SPOKEN, not raw, and forbids claiming a booking', () => {
    const out = renderSlots(slots, OPT, NOW, R);
    // Raw URL must NOT appear: TTS reads it letter by letter (seen on a live
    // call), and xAI's `replace` map cannot fix it because its keys may not
    // contain punctuation.
    expect(out).toContain('cal dot com slash your dash username');
    expect(out).not.toContain('https://cal.com/your-username');
    expect(out).toContain('REQUIRE the operator to confirm');
    expect(out).toContain('Never tell anyone a time is confirmed or booked');
  });

  it('drops slots already in the past', () => {
    const past = Date.parse('2026-08-26T18:00:00Z'); // before NOW
    const out = renderSlots([past, ...slots], OPT, NOW, R);
    expect(out).not.toContain('11:00 AM');
  });

  it('still offers the booking page when there is nothing to offer', () => {
    const out = renderSlots([], OPT, NOW, R);
    expect(out).toContain('no open times');
    expect(out).toContain('cal dot com slash your dash username');
    expect(out).not.toContain('bookable 30-minute start times');
  });

  it('NO rendered path leaks a raw URL for TTS to spell out', () => {
    for (const out of [renderSlots(slots, OPT, NOW, R), renderSlots([], OPT, NOW, R)]) {
      expect(out).not.toMatch(/https?:\/\//);
      expect(out).not.toMatch(/cal\.com/);
    }
  });

  it('leaks nothing — only weekday, date, clock time and the public link', () => {
    const out = renderSlots(slots, OPT, NOW, R);
    expect(out).not.toMatch(/@/); // no attendee emails
    expect(out.toLowerCase()).not.toContain('meeting with');
  });
});

// ---------------------------------------------------------------------------
// The cal.com fetch runs inside the CRON dial path (scheduled ->
// runDueSchedules -> resolveAvailability), and fireDue walks due jobs
// SEQUENTIALLY. An unbounded subrequest there stalls every job behind it on
// that tick -- and a stall long enough to cross MAX_LATENESS_MS would make the
// lateness guard refuse the very call it exists to protect.
// ---------------------------------------------------------------------------
describe('cal.com fetch is bounded — it runs in the cron dial path', () => {
  /**
   * Text of the argument list of the `fetch(` starting at `from`, by matching
   * parens. Deliberately NOT a fixed character window: a window silently
   * shrinks when a comment is added and simultaneously matches a neighbouring
   * call. Throws rather than returning "" — an extractor that returns empty on
   * failure turns one broken helper into a suite-wide false negative.
   */
  function fetchArgs(src: string, from: number): string {
    const open = src.indexOf('(', from);
    if (open < 0) throw new Error(`unbalanced fetch( at ${from}`);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')' && --depth === 0) return src.slice(open, i + 1);
    }
    throw new Error(`unbalanced fetch( at ${from}`);
  }

  const SRC = readUtf8(import.meta.url, '../src/calcom.ts');

  it('EVERY fetch in calcom.ts carries an abort signal', () => {
    const offenders: string[] = [];
    let seen = 0;
    for (let i = SRC.indexOf('fetch('); i !== -1; i = SRC.indexOf('fetch(', i + 1)) {
      // skip `fetchCalcomSlots(` / `fetchSlots(` — only the global fetch call
      if (/[A-Za-z0-9_]/.test(SRC[i - 1] ?? '')) continue;
      seen++;
      const args = fetchArgs(SRC, i);
      if (!args.includes('signal:')) offenders.push(args.slice(0, 120));
    }
    // Positive control: if this hits 0 the scan found nothing and proves nothing.
    expect(seen).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it('the signal is a real timeout, not an unarmed placeholder', async () => {
    const { CALCOM_FETCH_TIMEOUT_MS, fetchCalcomSlots } = await import('../src/calcom');
    expect(CALCOM_FETCH_TIMEOUT_MS).toBeGreaterThan(0);
    // far under the 60s cron tick, so a hung upstream cannot span two ticks
    expect(CALCOM_FETCH_TIMEOUT_MS).toBeLessThan(60_000);

    let captured: RequestInit | undefined;
    const real = globalThis.fetch;
    globalThis.fetch = ((_u: unknown, init?: RequestInit) => {
      captured = init;
      return Promise.resolve(new Response(JSON.stringify({ data: {} }), { status: 200 }));
    }) as typeof globalThis.fetch;
    try {
      await fetchCalcomSlots({
        username: 'x',
        eventTypeSlug: '30mins',
        startIso: new Date(0).toISOString(),
        endIso: new Date(1).toISOString(),
        timeZone: 'America/Los_Angeles',
      });
    } finally {
      globalThis.fetch = real;
    }
    expect(captured?.signal).toBeInstanceOf(AbortSignal);
  });
});
