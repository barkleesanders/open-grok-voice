import { describe, expect, it } from 'vitest';
import {
  type BillableCall,
  billableDuration,
  COST_DISCLAIMER,
  DEFAULT_RATES,
  estimateCallCost,
  OVERRIDE_DATE,
  RATE_FRESH_DAYS,
  type RateTable,
  rateConfidence,
  ratesFrom,
  tableConfidence,
} from '../src/cost';

const T0 = 1_756_000_000_000;
/** A moment when the shipped rates are still inside their freshness window. */
const FRESH_NOW = Date.parse('2026-09-01T00:00:00Z');

function call(overrides: Partial<BillableCall> = {}): BillableCall {
  return {
    startedAt: T0,
    answeredAt: T0 + 20_000,
    endedAt: T0 + 140_000,
    durationMs: 140_000,
    answered: true,
    ...overrides,
  };
}

describe('billable duration', () => {
  it('meters from ANSWER, not from dial', () => {
    // The whole point: 140s of wall time but only 120s of connected call. A
    // carrier bills the 120. Using wall time here would overstate by 17%.
    expect(billableDuration(call())).toEqual({
      billableMs: 120_000,
      durationSource: 'answered',
    });
  });

  it('falls back to total wall time when no answer instant was recorded', () => {
    // Every call archived before answeredAt existed looks like this. The
    // fallback is honest but LOOSE, so it reports a different source rather
    // than pretending it measured the same thing.
    expect(billableDuration(call({ answeredAt: null }))).toEqual({
      billableMs: 140_000,
      durationSource: 'total',
    });
  });

  it('charges nothing for a call that was never answered', () => {
    // A call that rang out and connected to nobody. Costing it as if it had
    // talked for two minutes is the most damaging error available here, because
    // it is confidently wrong in the expensive direction.
    expect(billableDuration(call({ answered: false }))).toEqual({
      billableMs: 0,
      durationSource: 'unanswered',
    });
  });

  it('ignores an answer instant that is not before the end', () => {
    // Clock skew between provider webhooks must not produce a negative duration.
    expect(billableDuration(call({ answeredAt: T0 + 200_000 })).billableMs).toBe(140_000);
    expect(billableDuration(call({ answeredAt: T0 + 140_000 })).durationSource).toBe('total');
  });

  it('never returns a negative duration', () => {
    expect(billableDuration(call({ answeredAt: null, durationMs: -5 })).billableMs).toBe(0);
  });
});

describe('per-call cost', () => {
  it('itemises a two-minute answered call, and the parts sum to the total', () => {
    const cost = estimateCallCost({
      call: call(),
      rates: DEFAULT_RATES,
      recorded: true,
      now: FRESH_NOW,
    });
    // 120_000 ms = exactly 2.0 billable minutes. Worked by hand:
    //   xAI              2 x $0.08    = $0.16
    //   Telnyx leg A     2 x $0.002   = $0.004
    //   Telnyx leg B     2 x $0.002   = $0.004   <- the SECOND leg, easy to forget
    //   SIP trunking     2 x $0.005   = $0.01
    //   recording        2 x $0.002   = $0.004
    //   media streaming  2 x $0.0035  = $0.007
    //   AMD              1 x $0.002   = $0.002   <- per CALL, not per minute
    //                                   -------
    //                                    $0.191
    expect(cost.billableMs).toBe(120_000);
    expect(cost.xai).toBeCloseTo(0.16, 10);
    expect(cost.telnyxLegA).toBeCloseTo(0.004, 10);
    expect(cost.telnyxLegB).toBeCloseTo(0.004, 10);
    expect(cost.telnyxSip).toBeCloseTo(0.01, 10);
    expect(cost.telnyxRecording).toBeCloseTo(0.004, 10);
    expect(cost.telnyxMediaStreaming).toBeCloseTo(0.007, 10);
    expect(cost.telnyxAmd).toBeCloseTo(0.002, 10);
    expect(cost.total).toBeCloseTo(0.191, 10);

    // The total must BE the sum of the parts, not a separately computed number
    // that could drift from the breakdown shown next to it.
    const parts =
      cost.xai +
      cost.telnyxLegA +
      cost.telnyxLegB +
      cost.telnyxSip +
      cost.telnyxRecording +
      cost.telnyxMediaStreaming +
      cost.telnyxAmd;
    expect(cost.total).toBeCloseTo(parts, 10);
  });

  it('bills BOTH Telnyx legs, because this architecture runs two', () => {
    // Leg A is the PSTN call to the human; leg B is the SIP call into xAI. Both
    // are up for the bridged duration. A one-leg model understates Telnyx.
    const cost = estimateCallCost({
      call: call(),
      rates: DEFAULT_RATES,
      recorded: false,
      now: FRESH_NOW,
    });
    expect(cost.telnyxLegB).toBe(cost.telnyxLegA);
    expect(cost.telnyxLegA).toBeGreaterThan(0);
  });

  it('charges nothing at all for a call that never connected', () => {
    const cost = estimateCallCost({
      call: call({ answered: false }),
      rates: DEFAULT_RATES,
      recorded: false,
      now: FRESH_NOW,
    });
    expect(cost.total).toBe(0);
    expect(cost.xai).toBe(0);
    expect(cost.telnyxAmd).toBe(0);
    expect(cost.durationSource).toBe('unanswered');
  });

  it('is exactly zero for a zero-length answered call', () => {
    const zero = call({ answeredAt: T0, endedAt: T0, durationMs: 0 });
    const cost = estimateCallCost({
      call: zero,
      rates: DEFAULT_RATES,
      recorded: true,
      now: FRESH_NOW,
    });
    // Zero minutes of everything metered, but AMD is per call and the call did
    // answer, so the one per-call charge remains.
    expect(cost.xai).toBe(0);
    expect(cost.telnyxRecording).toBe(0);
    expect(cost.total).toBeCloseTo(DEFAULT_RATES.telnyxAmd.usd, 10);
  });

  it('drops the recording line when there is no recording', () => {
    const withRec = estimateCallCost({
      call: call(),
      rates: DEFAULT_RATES,
      recorded: true,
      now: FRESH_NOW,
    });
    const without = estimateCallCost({
      call: call(),
      rates: DEFAULT_RATES,
      recorded: false,
      now: FRESH_NOW,
    });
    expect(without.telnyxRecording).toBe(0);
    expect(withRec.total - without.total).toBeCloseTo(withRec.telnyxRecording, 10);
  });

  it('always marks itself an estimate', () => {
    const cost = estimateCallCost({
      call: call(),
      rates: DEFAULT_RATES,
      recorded: true,
      now: FRESH_NOW,
    });
    expect(cost.estimate).toBe(true);
    expect(COST_DISCLAIMER).toContain('not a bill');
  });
});

describe('rate provenance', () => {
  it('carries a source URL and a verification date on every rate', () => {
    // A bare number with no provenance is exactly the thing that goes silently
    // wrong months later, so this is asserted for the whole table rather than
    // spot-checked.
    for (const [name, rate] of Object.entries(DEFAULT_RATES)) {
      expect(rate.source, name).toMatch(/^https:\/\//);
      expect(rate.verifiedAt, name).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(rate.usd, name).toBeGreaterThan(0);
      expect(['minute', 'call'], name).toContain(rate.unit);
    }
  });

  it('ages a rate out on its own, with no code change', () => {
    // The Decay Rule: a rate lives on someone else's pricing page and can go
    // wrong with no commit of ours, so freshness is computed, not labelled.
    const rate = DEFAULT_RATES.xaiAudio;
    const verified = Date.parse(`${rate.verifiedAt}T00:00:00Z`);
    expect(rateConfidence(rate, verified + 1000)).toBe('verified');
    expect(rateConfidence(rate, verified + (RATE_FRESH_DAYS - 1) * 86_400_000)).toBe('verified');
    expect(rateConfidence(rate, verified + (RATE_FRESH_DAYS + 1) * 86_400_000)).toBe('stale');
  });

  it('reports the WEAKEST confidence for the table, not the strongest', () => {
    const stale: RateTable = {
      ...DEFAULT_RATES,
      telnyxSipTrunk: { ...DEFAULT_RATES.telnyxSipTrunk, verifiedAt: '2020-01-01' },
    };
    expect(tableConfidence(stale, FRESH_NOW)).toBe('stale');
    expect(tableConfidence(DEFAULT_RATES, FRESH_NOW)).toBe('verified');
  });

  it('treats an unparseable date as stale rather than as fresh', () => {
    expect(rateConfidence({ ...DEFAULT_RATES.xaiAudio, verifiedAt: 'soon' }, FRESH_NOW)).toBe(
      'stale',
    );
  });
});

describe('operator rate overrides', () => {
  it('applies a valid override and marks its provenance', () => {
    const rates = ratesFrom({ RATE_TELNYX_SIP_PER_MIN: '0.0123' });
    expect(rates.telnyxSipTrunk.usd).toBe(0.0123);
    expect(rates.telnyxSipTrunk.verifiedAt).toBe(OVERRIDE_DATE);
    expect(rateConfidence(rates.telnyxSipTrunk, FRESH_NOW)).toBe('override');
    // Untouched rates keep their published provenance.
    expect(rates.xaiAudio).toEqual(DEFAULT_RATES.xaiAudio);
  });

  it('accepts a zero override, because $0 is a real published price', () => {
    // Telnyx publishes recording STORAGE at $0/min, so zero must survive as a
    // value rather than being swallowed as falsy.
    const rates = ratesFrom({ RATE_TELNYX_RECORDING_PER_MIN: '0' });
    expect(rates.telnyxRecording.usd).toBe(0);
  });

  it('falls back to the published rate on malformed input and never yields NaN', () => {
    // The failure that matters: a typo'd var must not render every cost "$NaN".
    for (const bad of ['abc', '', '   ', '-1', 'NaN', 'Infinity', '1,5']) {
      const rates = ratesFrom({ RATE_XAI_PER_MIN: bad });
      expect(rates.xaiAudio.usd, bad).toBe(DEFAULT_RATES.xaiAudio.usd);
      const cost = estimateCallCost({
        call: call(),
        rates,
        recorded: true,
        now: FRESH_NOW,
      });
      expect(Number.isFinite(cost.total), bad).toBe(true);
    }
  });

  it('leaves the table untouched when no vars are set', () => {
    expect(ratesFrom({})).toEqual(DEFAULT_RATES);
  });
});
