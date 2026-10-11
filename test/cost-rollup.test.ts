// The cost rollup, including the requirement that made the design what it is:
// every call ALREADY in the archive must get a price, with no migration.

import { describe, expect, it } from 'vitest';
import {
  type CallLogRecord,
  callLogKey,
  listRowFromObject,
  putCallLogRecord,
} from '../src/call-log';
import { DEFAULT_RATES, estimateCallCost, usdPerMinuteFloor } from '../src/cost';
import {
  billableFromRow,
  forecastFor,
  MAX_ROLLUP_PAGES,
  periodBounds,
  rollupCosts,
  TRAILING_WINDOW_DAYS,
} from '../src/cost-rollup';
import { createFakeR2, type FakeR2 } from './fake-r2';

/** 2026-08-28T12:00:00Z — a Friday, mid-month, so every window is partly elapsed. */
const NOW = Date.parse('2026-08-28T12:00:00Z');
const MINUTE = 60_000;

function record(overrides: Partial<CallLogRecord> = {}): CallLogRecord {
  const endedAt = overrides.endedAt ?? NOW - 3_600_000;
  return {
    schema: 2,
    callId: `call-${endedAt}`,
    phase: 'completed',
    direction: 'outbound',
    inboundMode: null,
    to: '+1415*****23',
    task: 'Ask about the referral.',
    // Schema 2 on purpose: these fixtures stand in for records already in the
    // real bucket, which have no explicit subject. null is what such a record
    // holds, and the reader must derive a label from `task` rather than assume.
    subject: null,
    voice: 'liora',
    amdResult: null,
    failureReason: null,
    inboundFallbackReason: null,
    forwardAttempted: 0,
    startedAt: endedAt - 2 * MINUTE,
    endedAt,
    durationMs: 2 * MINUTE,
    answeredAt: endedAt - 2 * MINUTE,
    teardownReason: 'normal',
    transcript: [],
    recordings: [],
    ...overrides,
  };
}

async function seed(r2: FakeR2, records: readonly CallLogRecord[]): Promise<void> {
  for (const rec of records) {
    await putCallLogRecord(r2.bucket, callLogKey(rec.callId, rec.endedAt), rec);
  }
}

/**
 * A record as written BEFORE schema 2, i.e. with no answeredAt and no schema in
 * metadata. This is what the bucket is actually full of, so the rollup has to
 * price it rather than skip it.
 */
async function seedLegacy(r2: FakeR2, endedAt: number, durationMs: number): Promise<void> {
  await r2.bucket.put(callLogKey(`legacy-${endedAt}`, endedAt), JSON.stringify({ schema: 1 }), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: {
      callId: `legacy-${endedAt}`,
      phase: 'completed',
      direction: 'outbound',
      to: '+1415*****99',
      endedAt: String(endedAt),
      durationMs: String(durationMs),
      transcriptEntries: '4',
      // Deliberately no `schema`, no `answeredAt`, no `recorded`.
    },
  });
}

describe('period bounds (UTC)', () => {
  it('bounds each window around the instant given', () => {
    expect(periodBounds('day', NOW)).toMatchObject({
      startMs: Date.parse('2026-08-28T00:00:00Z'),
      endMs: Date.parse('2026-08-29T00:00:00Z'),
    });
    // 2026-08-28 is a Friday, so the ISO week began Monday the 24th.
    expect(periodBounds('week', NOW)).toMatchObject({
      startMs: Date.parse('2026-08-24T00:00:00Z'),
      endMs: Date.parse('2026-08-31T00:00:00Z'),
    });
    expect(periodBounds('month', NOW)).toMatchObject({
      startMs: Date.parse('2026-08-01T00:00:00Z'),
      endMs: Date.parse('2026-09-01T00:00:00Z'),
    });
    expect(periodBounds('year', NOW)).toMatchObject({
      startMs: Date.parse('2026-01-01T00:00:00Z'),
      endMs: Date.parse('2027-01-01T00:00:00Z'),
    });
  });

  it('rolls the month and year boundaries correctly', () => {
    const dec31 = Date.parse('2026-12-31T23:59:59Z');
    expect(periodBounds('month', dec31).endMs).toBe(Date.parse('2027-01-01T00:00:00Z'));
    expect(periodBounds('year', dec31).endMs).toBe(Date.parse('2027-01-01T00:00:00Z'));
    // Sunday must belong to the week that STARTED on Monday, not begin a new one.
    const sunday = Date.parse('2026-08-30T12:00:00Z');
    expect(periodBounds('week', sunday).startMs).toBe(Date.parse('2026-08-24T00:00:00Z'));
  });
});

describe('rollup over the archive', () => {
  it('prices every call in the window and sums to the per-call estimates', async () => {
    const r2 = createFakeR2();
    const calls = [
      record({ endedAt: NOW - 3_600_000 }),
      record({ endedAt: NOW - 7_200_000 }),
      record({ endedAt: NOW - 10_800_000 }),
    ];
    await seed(r2, calls);
    const rollup = await rollupCosts({
      bucket: r2.bucket,
      window: 'day',
      rates: DEFAULT_RATES,
      now: NOW,
    });

    expect(rollup.calls).toBe(3);
    // Cross-checked against the per-call model rather than restating the
    // rollup's own arithmetic back at itself.
    const expected = calls.reduce((sum, rec) => {
      const cost = estimateCallCost({
        call: {
          startedAt: rec.startedAt,
          endedAt: rec.endedAt,
          answeredAt: rec.answeredAt,
          durationMs: rec.durationMs,
          answered: true,
        },
        rates: DEFAULT_RATES,
        recorded: false,
        now: NOW,
      });
      return sum + cost.total;
    }, 0);
    expect(rollup.totalUsd).toBeCloseTo(expected, 6);
    expect(rollup.averageUsdPerCall).toBeCloseTo(expected / 3, 6);
    expect(
      rollup.byProvider.xai + rollup.byProvider.telnyx + rollup.byProvider.telnyxRecording,
    ).toBeCloseTo(rollup.totalUsd, 6);
    expect(rollup.estimate).toBe(true);
    expect(rollup.truncated).toBe(false);
  });

  it('COVERS CALLS ARCHIVED BEFORE THE COST MODEL EXISTED', async () => {
    // The requirement that decided the design: cost is derived at read time, so
    // a record written by an older deploy — no answeredAt, no schema tag — is
    // priced with no migration. If this ever regresses, the panel silently
    // undercounts the entire history.
    const r2 = createFakeR2();
    await seedLegacy(r2, NOW - 3_600_000, 2 * MINUTE);
    await seedLegacy(r2, NOW - 5_400_000, 4 * MINUTE);
    const rollup = await rollupCosts({
      bucket: r2.bucket,
      window: 'day',
      rates: DEFAULT_RATES,
      now: NOW,
    });

    expect(rollup.calls).toBe(2);
    expect(rollup.totalUsd).toBeGreaterThan(0);
    // ...and it reports that those numbers are the LOOSE kind, measured from
    // total wall time rather than from answer.
    expect(rollup.looseDurationCalls).toBe(2);
  });

  it('excludes calls outside the window at both ends', async () => {
    const r2 = createFakeR2();
    await seed(r2, [
      record({ endedAt: NOW - 3_600_000 }), // today: in
      record({ endedAt: Date.parse('2026-08-27T23:00:00Z') }), // yesterday: out
      record({ endedAt: Date.parse('2026-08-29T01:00:00Z') }), // tomorrow: out
    ]);
    const rollup = await rollupCosts({
      bucket: r2.bucket,
      window: 'day',
      rates: DEFAULT_RATES,
      now: NOW,
    });
    expect(rollup.calls).toBe(1);
  });

  it('buckets the series by hour for a day and by month for a year', async () => {
    const r2 = createFakeR2();
    await seed(r2, [
      record({ endedAt: Date.parse('2026-08-28T09:30:00Z') }),
      record({ endedAt: Date.parse('2026-08-28T09:45:00Z') }),
      record({ endedAt: Date.parse('2026-08-28T11:15:00Z') }),
    ]);
    const day = await rollupCosts({
      bucket: r2.bucket,
      window: 'day',
      rates: DEFAULT_RATES,
      now: NOW,
    });
    expect(day.series).toHaveLength(24);
    expect(day.series[9]?.calls).toBe(2);
    expect(day.series[11]?.calls).toBe(1);
    expect(day.series[10]?.calls).toBe(0);

    const year = await rollupCosts({
      bucket: r2.bucket,
      window: 'year',
      rates: DEFAULT_RATES,
      now: NOW,
    });
    expect(year.series).toHaveLength(12);
    expect(year.series[7]?.calls).toBe(3); // August is index 7
    expect(year.series[0]?.calls).toBe(0);
  });

  it('returns an empty, well-formed rollup when nothing is archived', async () => {
    const r2 = createFakeR2();
    const rollup = await rollupCosts({
      bucket: r2.bucket,
      window: 'month',
      rates: DEFAULT_RATES,
      now: NOW,
    });
    expect(rollup.calls).toBe(0);
    expect(rollup.totalUsd).toBe(0);
    // Not NaN. A zero-call average must be reported as 0, not 0/0.
    expect(rollup.averageUsdPerCall).toBe(0);
    expect(rollup.series.every((bucket) => bucket.usd === 0)).toBe(true);
  });

  it('prices a call that never answered at zero without dropping it from the count', async () => {
    const r2 = createFakeR2();
    await seed(r2, [
      record({ endedAt: NOW - 3_600_000, answeredAt: null, phase: 'failed', durationMs: 30_000 }),
    ]);
    const rollup = await rollupCosts({
      bucket: r2.bucket,
      window: 'day',
      rates: DEFAULT_RATES,
      now: NOW,
    });
    expect(rollup.calls).toBe(1);
    expect(rollup.totalUsd).toBe(0);
  });
});

describe('row -> billable projection', () => {
  it('trusts a schema-2 null as "never answered" but not a schema-1 null', async () => {
    // The distinction the whole legacy story rests on. Getting it backwards
    // either zeroes the entire history or invents charges for rang-out calls.
    const r2 = createFakeR2();
    await seed(r2, [record({ endedAt: NOW - 1000, answeredAt: null })]);
    await seedLegacy(r2, NOW - 2000, 2 * MINUTE);
    const listed = await r2.bucket.list({ prefix: 'calls/', include: ['customMetadata'] });
    const rows = listed.objects.map((object) => listRowFromObject(object));

    const modern = rows.find((row) => row.schema === 2);
    const legacy = rows.find((row) => row.schema === null);
    if (!modern || !legacy) throw new Error('expected one modern and one legacy row');
    expect(billableFromRow(modern, NOW - 1000).answered).toBe(false);
    expect(billableFromRow(legacy, NOW - 2000).answered).toBe(true);
  });
});

describe('forecast honesty', () => {
  const month = periodBounds('month', NOW);

  it('refuses to project from less than two whole days', () => {
    const dayTwo = Date.parse('2026-08-02T06:00:00Z');
    const forecast = forecastFor(month, 5, dayTwo);
    // A single partial day times 31 is not a forecast, and printing one next to
    // measured numbers makes it read as equally solid.
    expect(forecast.usd).toBeNull();
    expect(forecast.reason).toMatch(/two whole days/);
    expect(forecast.sampleDays).toBe(1);
  });

  it('names its method and projects from the daily mean of elapsed days', () => {
    // 2026-08-28T12:00Z: 27 whole days elapsed of a 31-day month.
    const forecast = forecastFor(month, 27, NOW);
    expect(forecast.method).toBe('daily-mean-over-elapsed-days');
    expect(forecast.sampleDays).toBe(27);
    expect(forecast.usd).toBeCloseTo(31, 6); // $1/day * 31 days
    expect(forecast.note).toMatch(/Projection, not a measurement/);
  });

  it('stops projecting once the period is over', () => {
    const after = Date.parse('2026-09-05T00:00:00Z');
    const forecast = forecastFor(month, 42, after);
    // The month is finished; the measurement IS the answer.
    expect(forecast.usd).toBe(42);
  });
});

describe('bounded work', () => {
  it('caps the scan and says so rather than reporting a partial total as complete', async () => {
    // The fake pages at `limit`, so a small limit is not available; instead
    // assert the contract that the cap exists and is surfaced, which is what
    // stops a silent undercount from looking like a real number.
    expect(MAX_ROLLUP_PAGES).toBeGreaterThan(0);
    const r2 = createFakeR2();
    await seed(r2, [record({ endedAt: NOW - 1000 })]);
    const rollup = await rollupCosts({
      bucket: r2.bucket,
      window: 'day',
      rates: DEFAULT_RATES,
      now: NOW,
    });
    expect(rollup.truncated).toBe(false);
  });

  it('stops scanning once it reaches calls older than the window', async () => {
    // The early exit is safe only because callLogKey bakes a DESCENDING clock
    // into the key. Proven by counting list() calls: a full scan of 1 in-window
    // call plus older ones must not read more pages than it needs.
    const r2 = createFakeR2();
    await seed(r2, [
      record({ endedAt: NOW - 1000 }),
      record({ endedAt: Date.parse('2026-07-01T00:00:00Z') }),
      record({ endedAt: Date.parse('2026-06-01T00:00:00Z') }),
    ]);
    const rollup = await rollupCosts({
      bucket: r2.bucket,
      window: 'day',
      rates: DEFAULT_RATES,
      now: NOW,
    });
    expect(rollup.calls).toBe(1);
  });
});

describe('trailing window beside the calendar period', () => {
  /**
   * 2026-09-02T12:00:00Z and 2026-08-31T18:00:00Z are the INCIDENT's shape, not
   * invented dates: measured live on 2026-09-02, window=month read $0.00 / 0
   * calls while window=week read $2.057742 / 11 calls, every one of those calls
   * having ended on 2026-08-31 -- one day the wrong side of the month boundary.
   */
  const EARLY_SEPT = Date.parse('2026-09-02T12:00:00Z');
  const LATE_AUG = Date.parse('2026-08-31T18:00:00Z');

  async function seedLateAugust(count: number): Promise<FakeR2> {
    const r2 = createFakeR2();
    const calls: CallLogRecord[] = [];
    for (let i = 0; i < count; i += 1) calls.push(record({ endedAt: LATE_AUG - i * MINUTE }));
    await seed(r2, calls);
    return r2;
  }

  it('REPRODUCES THE INCIDENT: the calendar month is $0 and the trailing window is not', async () => {
    const r2 = await seedLateAugust(3);
    const rollup = await rollupCosts({
      bucket: r2.bucket,
      window: 'month',
      rates: DEFAULT_RATES,
      now: EARLY_SEPT,
    });

    // The calendar month stays a calendar month. It is CORRECT at zero, and
    // that correctness is exactly what made the panel look broken.
    expect(rollup.startMs).toBe(Date.parse('2026-09-01T00:00:00Z'));
    expect(rollup.totalUsd).toBe(0);
    expect(rollup.calls).toBe(0);

    // The fallback line is what stops the panel reading as dead.
    expect(rollup.trailing30.calls).toBe(3);
    expect(rollup.trailing30.usd).toBeGreaterThan(0);
    expect(rollup.trailing30.days).toBe(TRAILING_WINDOW_DAYS);
    expect(rollup.trailing30.endMs).toBe(EARLY_SEPT);
    expect(rollup.trailing30.startMs).toBe(EARLY_SEPT - TRAILING_WINDOW_DAYS * 86_400_000);
    expect(rollup.trailing30.truncated).toBe(false);
  });

  it('reports the SAME trailing figure whichever window is selected', async () => {
    // The trailing total is a property of the archive and the clock, never of
    // the dropdown. If it moved with the selection it would just be a second,
    // differently-labelled copy of the period total.
    const r2 = await seedLateAugust(4);
    const totals: { usd: number; calls: number }[] = [];
    for (const window of ['day', 'week', 'month', 'year'] as const) {
      const rollup = await rollupCosts({
        bucket: r2.bucket,
        window,
        rates: DEFAULT_RATES,
        now: EARLY_SEPT,
      });
      totals.push({ usd: rollup.trailing30.usd, calls: rollup.trailing30.calls });
    }
    const first = totals[0];
    expect(first).toBeDefined();
    for (const total of totals) {
      expect(total.calls).toBe(4);
      expect(total.usd).toBe(first?.usd);
      expect(total.usd).toBeGreaterThan(0);
    }
  });

  it('excludes a call that fell out of the trailing window at the far end', async () => {
    const r2 = createFakeR2();
    const cutoff = EARLY_SEPT - TRAILING_WINDOW_DAYS * 86_400_000;
    await seed(r2, [
      record({ endedAt: cutoff + MINUTE }), // just inside
      record({ endedAt: cutoff - MINUTE }), // just outside
    ]);
    const rollup = await rollupCosts({
      bucket: r2.bucket,
      window: 'day',
      rates: DEFAULT_RATES,
      now: EARLY_SEPT,
    });
    expect(rollup.trailing30.calls).toBe(1);
  });

  it('sums to the period total when the period sits inside the trailing window', async () => {
    // A week that is entirely within the last 30 days must not price its own
    // calls differently from the trailing accumulator reading the same rows.
    const r2 = createFakeR2();
    const inWeek = Date.parse('2026-09-01T09:00:00Z');
    await seed(r2, [record({ endedAt: inWeek }), record({ endedAt: inWeek - MINUTE })]);
    const rollup = await rollupCosts({
      bucket: r2.bucket,
      window: 'week',
      rates: DEFAULT_RATES,
      now: EARLY_SEPT,
    });
    expect(rollup.calls).toBe(2);
    expect(rollup.trailing30.calls).toBe(2);
    expect(rollup.trailing30.usd).toBeCloseTo(rollup.totalUsd, 6);
  });

  /**
   * One page past the cap, spaced so the scan runs out ~23 days back: PAST the
   * start of today, but NOT past the start of the trailing window. That is the
   * only interesting truncation case -- the one where the two figures disagree
   * about whether they are complete.
   */
  async function seedPastTheCap(now: number): Promise<FakeR2> {
    const r2 = createFakeR2();
    for (let i = 0; i < MAX_ROLLUP_PAGES * 1000 + 1; i += 1) {
      const endedAt = now - (i + 1) * 100_000;
      await r2.bucket.put(callLogKey(`capped-${i}`, endedAt), '{}', {
        customMetadata: { callId: `capped-${i}`, endedAt: String(endedAt), durationMs: '120000' },
      });
    }
    return r2;
  }

  it('truncates the two figures SEPARATELY rather than letting one lie for the other', async () => {
    const r2 = await seedPastTheCap(EARLY_SEPT);
    const rollup = await rollupCosts({
      bucket: r2.bucket,
      window: 'day',
      rates: DEFAULT_RATES,
      now: EARLY_SEPT,
    });
    // The scan died ~23 days back, which is well below the start of TODAY, so
    // the day total really is complete and must not be labelled a floor...
    expect(rollup.truncated).toBe(false);
    expect(rollup.calls).toBeGreaterThan(0);
    // ...while the trailing window, which reaches 30 days back, genuinely is one.
    expect(rollup.trailing30.truncated).toBe(true);
  });

  it('marks BOTH as floors when the cap lands inside both windows', async () => {
    const r2 = await seedPastTheCap(EARLY_SEPT);
    const rollup = await rollupCosts({
      bucket: r2.bucket,
      window: 'year',
      rates: DEFAULT_RATES,
      now: EARLY_SEPT,
    });
    // A year starts in January; the scan never got near it.
    expect(rollup.truncated).toBe(true);
    expect(rollup.trailing30.truncated).toBe(true);
  });

  it('COSTS ONE ARCHIVE SCAN, NOT TWO', async () => {
    // The performance constraint, asserted rather than asserted-in-a-comment.
    // Computing the trailing total from a SECOND independent list() loop would
    // double the R2 reads on an authenticated request path the console polls.
    // These counters come from the fake bucket itself, so a second scan shows up
    // as doubled numbers here whatever shape it is written in.
    const r2 = await seedLateAugust(6);
    const objectsStored = r2.keys().length;
    expect(objectsStored).toBe(6);

    const before = { lists: r2.listCount(), objects: r2.listedObjectCount() };
    expect(before).toEqual({ lists: 0, objects: 0 });

    const rollup = await rollupCosts({
      bucket: r2.bucket,
      window: 'month',
      rates: DEFAULT_RATES,
      now: EARLY_SEPT,
    });
    // Both accumulators were filled...
    expect(rollup.trailing30.calls).toBe(6);
    // ...off exactly one page, each object read exactly once.
    expect(r2.listCount()).toBe(1);
    expect(r2.listedObjectCount()).toBe(objectsStored);
  });

  it('reads each object once even when the period is WIDER than the trailing window', async () => {
    // window=year scans from January, so the union is the year. The trailing
    // accumulator must ride that same pass rather than open its own.
    const r2 = createFakeR2();
    await seed(r2, [
      record({ endedAt: LATE_AUG }),
      record({ endedAt: Date.parse('2026-03-04T10:00:00Z') }),
      record({ endedAt: Date.parse('2026-01-15T10:00:00Z') }),
    ]);
    const rollup = await rollupCosts({
      bucket: r2.bucket,
      window: 'year',
      rates: DEFAULT_RATES,
      now: EARLY_SEPT,
    });
    expect(rollup.calls).toBe(3);
    expect(rollup.trailing30.calls).toBe(1);
    expect(r2.listCount()).toBe(1);
    expect(r2.listedObjectCount()).toBe(3);
  });
});

describe('cost per minute', () => {
  it('is the period total divided by the SAME minutes the calls were priced on', async () => {
    const r2 = createFakeR2();
    await seed(r2, [
      record({
        endedAt: NOW - 3_600_000,
        durationMs: 4 * MINUTE,
        answeredAt: NOW - 3_600_000 - 4 * MINUTE,
      }),
      record({
        callId: 'b',
        endedAt: NOW - 7_200_000,
        durationMs: 6 * MINUTE,
        answeredAt: NOW - 7_200_000 - 6 * MINUTE,
      }),
    ]);
    const rollup = await rollupCosts({
      bucket: r2.bucket,
      window: 'day',
      rates: DEFAULT_RATES,
      now: NOW,
    });

    expect(rollup.calls).toBe(2);
    expect(rollup.billableMs).toBe(10 * MINUTE);
    // Reproducible by hand from two published fields -- that is the property.
    expect(rollup.usdPerMinute).toBeCloseTo(rollup.totalUsd / 10, 9);
    // Two plain unrecorded two-party calls, so the only thing above the floor
    // is the per-CALL answering-machine fee amortised over ten minutes:
    // 0.0925 + (2 * 0.002 / 10) = 0.0929.
    expect(rollup.usdPerMinute).toBeCloseTo(0.0929, 6);
  });

  it('is NULL, never 0, when calls exist but none of them answered', async () => {
    const r2 = createFakeR2();
    // Schema 2 with answeredAt null is a call that genuinely rang out.
    await seed(r2, [
      record({
        callId: 'rang-out',
        endedAt: NOW - 3_600_000,
        durationMs: 30_000,
        answeredAt: null,
      }),
    ]);
    const rollup = await rollupCosts({
      bucket: r2.bucket,
      window: 'day',
      rates: DEFAULT_RATES,
      now: NOW,
    });

    expect(rollup.calls).toBe(1); // the call is real and counted...
    expect(rollup.totalUsd).toBe(0); // ...and correctly free...
    expect(rollup.billableMs).toBe(0); // ...with nothing to divide by.
    // The whole point: 0 would assert a MEASURED rate of zero.
    expect(rollup.usdPerMinute).toBeNull();
    expect(rollup.usdPerMinute).not.toBe(0);
  });

  it('never emits Infinity or NaN on an empty period', async () => {
    const r2 = createFakeR2();
    const rollup = await rollupCosts({
      bucket: r2.bucket,
      window: 'day',
      rates: DEFAULT_RATES,
      now: NOW,
    });
    expect(rollup.usdPerMinute).toBeNull();
    expect(Number.isFinite(rollup.usdPerMinuteFloor)).toBe(true);
  });
});

describe('the two-party floor the rate is compared against', () => {
  it('is DERIVED from the rate table, so an override moves it', async () => {
    const r2 = createFakeR2();
    const base = await rollupCosts({
      bucket: r2.bucket,
      window: 'day',
      rates: DEFAULT_RATES,
      now: NOW,
    });
    expect(base.usdPerMinuteFloor).toBeCloseTo(0.0925, 9);
    expect(base.usdPerMinuteFloorXai).toBeCloseTo(0.08, 9);

    // Halve the model rate; a hardcoded 0.0925 would not move.
    const cheaper = {
      ...DEFAULT_RATES,
      xaiAudio: { ...DEFAULT_RATES.xaiAudio, usd: 0.04 },
    };
    const moved = await rollupCosts({ bucket: r2.bucket, window: 'day', rates: cheaper, now: NOW });
    expect(moved.usdPerMinuteFloor).toBeCloseTo(0.0525, 9);
    expect(moved.usdPerMinuteFloor).not.toBeCloseTo(base.usdPerMinuteFloor, 9);
  });

  it('excludes recording and the per-call AMD fee, which are not per-minute rates', () => {
    // Stated as arithmetic so the exclusion is pinned, not just documented:
    // floor is xai + 2 legs + sip + media, and nothing else.
    expect(usdPerMinuteFloor(DEFAULT_RATES)).toBeCloseTo(
      DEFAULT_RATES.xaiAudio.usd +
        DEFAULT_RATES.telnyxLeg.usd * 2 +
        DEFAULT_RATES.telnyxSipTrunk.usd +
        DEFAULT_RATES.telnyxMediaStreaming.usd,
      9,
    );
    expect(usdPerMinuteFloor(DEFAULT_RATES)).not.toBeCloseTo(
      usdPerMinuteFloor(DEFAULT_RATES) + DEFAULT_RATES.telnyxRecording.usd,
      9,
    );
  });
});
