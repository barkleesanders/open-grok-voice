// Aggregate estimated spend over a time window, straight out of the R2 archive.
//
// WHY THERE IS NO BACKFILL: cost is derived from stored duration at READ time
// (see src/cost.ts), so every call already in the bucket is priced the moment
// this ships. Nothing is migrated and nothing is rewritten.
//
// WHY IT READS list() METADATA AND NOT THE RECORDS: R2 `list()` returns custom
// metadata inline when asked, and src/call-log.ts puts everything a price needs
// there (endedAt, durationMs, answeredAt, recorded, phase). Pricing a month from
// list pages is a handful of requests; a GET per call would be an O(calls)
// fan-out on a request path, which is how a cheap panel becomes an outage.

import {
  CALL_LOG_PREFIX,
  type CallLogListRow,
  endedAtFromKey,
  listRowFromObject,
} from './call-log';
import {
  type BillableCall,
  type CallCost,
  estimateCallCost,
  type RateConfidence,
  type RateTable,
  tableConfidence,
  usdPerMinuteFloor,
} from './cost';
import { log } from './log';

export type CostWindow = 'day' | 'week' | 'month' | 'year';

export function isCostWindow(value: string | undefined): value is CostWindow {
  return value === 'day' || value === 'week' || value === 'month' || value === 'year';
}

/**
 * Pages of 1,000 scanned before the rollup gives up and says so.
 *
 * A bound, not a guess: at 1,000 objects a page this covers 20,000 calls. The
 * point is that an unbounded scan on an authenticated request path is how a
 * dashboard takes the Worker down, and that a partial total reported as complete
 * is worse than one labelled `truncated`.
 */
export const MAX_ROLLUP_PAGES = 20;

/**
 * Length of the trailing window reported alongside the calendar period.
 *
 * NOT a scan cap and NOT a guess at corpus size -- the only bound on the scan is
 * still MAX_ROLLUP_PAGES. This is a reporting horizon, chosen to be the same
 * order as the calendar month it sits next to so the two numbers are directly
 * comparable ("this month" vs "the last month's worth of days").
 *
 * It exists because a CALENDAR month is correct and useless on its first days:
 * measured against the live archive on 2026-09-02, window=month read
 * $0.00 / 0 calls while window=week read $2.057742 / 11 calls, every one of
 * those calls having landed on 2026-08-31 -- one day the wrong side of the
 * boundary. A correct $0.00 is indistinguishable from a broken panel.
 */
export const TRAILING_WINDOW_DAYS = 30;

/** All times are UTC. A Worker has no user timezone, and inventing one would silently shift day boundaries. */
export interface CostPeriod {
  readonly window: CostWindow;
  readonly startMs: number;
  readonly endMs: number;
}

/** Inclusive-start, exclusive-end bounds of the period `now` falls in. */
export function periodBounds(window: CostWindow, now: number): CostPeriod {
  const d = new Date(now);
  if (window === 'day') {
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return { window, startMs: start, endMs: start + 86_400_000 };
  }
  if (window === 'week') {
    // ISO-ish: weeks start Monday. getUTCDay() is 0 for Sunday.
    const dayOfWeek = (d.getUTCDay() + 6) % 7;
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dayOfWeek);
    return { window, startMs: start, endMs: start + 7 * 86_400_000 };
  }
  if (window === 'month') {
    return {
      window,
      startMs: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1),
      endMs: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1),
    };
  }
  return {
    window,
    startMs: Date.UTC(d.getUTCFullYear(), 0, 1),
    endMs: Date.UTC(d.getUTCFullYear() + 1, 0, 1),
  };
}

/** Bucket width for the panel's series: 24 hours for a day, days for a week/month, months for a year. */
function bucketStarts(period: CostPeriod): number[] {
  const starts: number[] = [];
  if (period.window === 'day') {
    for (let t = period.startMs; t < period.endMs; t += 3_600_000) starts.push(t);
    return starts;
  }
  if (period.window === 'year') {
    const year = new Date(period.startMs).getUTCFullYear();
    for (let month = 0; month < 12; month += 1) starts.push(Date.UTC(year, month, 1));
    return starts;
  }
  for (let t = period.startMs; t < period.endMs; t += 86_400_000) starts.push(t);
  return starts;
}

/**
 * Which bucket an instant falls in. Derived arithmetically from the period, so
 * it does NOT need the `starts` array — the caller bounds the result against
 * `starts.length` before indexing, which is where that check belongs.
 */
function bucketIndexFor(period: CostPeriod, at: number): number {
  if (period.window === 'day') return Math.floor((at - period.startMs) / 3_600_000);
  if (period.window === 'year') return new Date(at).getUTCMonth();
  return Math.floor((at - period.startMs) / 86_400_000);
}

/**
 * Turn one archived list row into something priceable.
 *
 * The `answered` decision is the subtle one and is made from what the record
 * actually knows, never guessed:
 *   - schema 2 with an answer instant -> answered, metered from that instant.
 *   - schema 2 WITHOUT one -> the call genuinely never answered. Schema 2 always
 *     writes the field, so its absence there is information, not a gap.
 *   - schema 1 (or unknown) -> the field did not exist yet. Treated as answered
 *     and metered over total wall time, which OVERSTATES a call that rang out.
 *     Named, surfaced as `durationSource: 'total'`, and reported in the payload
 *     so the operator can see which part of a total is the loose part.
 */
export function billableFromRow(row: CallLogListRow, endedAt: number): BillableCall {
  const durationMs = row.durationMs ?? 0;
  const knowsAnswer = row.schema !== null && row.schema >= 2;
  return {
    startedAt: endedAt - durationMs,
    endedAt,
    answeredAt: row.answeredAt,
    durationMs,
    answered: knowsAnswer ? row.answeredAt !== null : true,
    // Straight from R2 custom metadata -- the rollup never opens a record body,
    // so a conference call's extra legs have to arrive here as one number or
    // they do not arrive at all. null means the object predates conferences and
    // genuinely had none, which prices to zero correctly.
    participantBillableMs: row.participantBillableMs ?? 0,
  };
}

export interface CostBucket {
  readonly startMs: number;
  readonly usd: number;
  readonly calls: number;
}

export interface CostByProvider {
  readonly xai: number;
  readonly telnyx: number;
  /** Broken out of Telnyx because it is the line an operator can switch off. */
  readonly telnyxRecording: number;
}

export type ForecastMethod = 'daily-mean-over-elapsed-days';

export interface CostForecast {
  readonly method: ForecastMethod;
  /** Projected spend for the WHOLE period, or null when there is not enough data to project. */
  readonly usd: number | null;
  /** Whole days of the period already elapsed -- the sample the mean is taken over. */
  readonly sampleDays: number;
  /** Why `usd` is null, when it is. */
  readonly reason: string | null;
  readonly note: string;
}

/**
 * Spend over the trailing window, so the panel is never bare on a young period.
 *
 * Deliberately small: no `series` and no `byProvider`. Those exist to break the
 * SELECTED period down, and duplicating them here would double the payload to
 * say something the selected period already says better.
 */
export interface TrailingTotal {
  readonly days: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly usd: number;
  readonly calls: number;
  /** True when the scan stopped before reaching startMs, so this is a FLOOR. */
  readonly truncated: boolean;
}

export interface CostRollup {
  readonly window: CostWindow;
  readonly startMs: number;
  readonly endMs: number;
  readonly totalUsd: number;
  readonly calls: number;
  readonly averageUsdPerCall: number;
  /**
   * Billable call milliseconds this period, summed from the SAME `billableMs`
   * each call was priced on. Surfaced rather than kept private so a reader can
   * divide it themselves and get exactly `usdPerMinute` back.
   */
  readonly billableMs: number;
  /**
   * Blended USD per billable call-minute, or NULL when there are no billable
   * minutes to divide by.
   *
   * NULL, never 0, and that is the whole point: a window whose calls all rang
   * out has real calls, $0 of cost and 0 minutes, and rendering "$0.0000/min"
   * there asserts a measured rate of zero -- a claim, not an absence. The
   * sibling `averageUsdPerCall` returns 0 for its empty case; that is existing
   * behaviour, not a precedent to copy into a rate.
   *
   * DENOMINATOR IS CALL WALL TIME, not summed leg time. A conference call
   * bills participant legs on top of the same call-minute, so it prices ABOVE
   * the two-party floor -- correctly, because that minute genuinely cost more.
   * Dividing by leg-minutes instead would flatten exactly the difference an
   * operator is looking for.
   */
  readonly usdPerMinute: number | null;
  /**
   * The plain two-party per-minute floor from the SAME rate table, so the
   * figure above has something to be compared against. See usdPerMinuteFloor.
   */
  readonly usdPerMinuteFloor: number;
  /**
   * The xAI slice of that floor, in dollars. Carried so a consumer never has to
   * re-derive it from a rate table it does not have -- and so nothing renders a
   * share computed from a field that is not in the payload.
   *
   * It is the structural fact about this bridge: at default rates $0.08 of the
   * $0.0925 floor is the model, so infrastructure tuning cannot move the number
   * much. Worth stating next to any cost figure that invites optimisation.
   */
  readonly usdPerMinuteFloorXai: number;
  /**
   * Same rates, same archive, same estimate semantics as `totalUsd` -- it is a
   * DIFFERENT WINDOW over identical data, not a second, better-sourced figure.
   */
  readonly trailing30: TrailingTotal;
  readonly byProvider: CostByProvider;
  readonly series: readonly CostBucket[];
  readonly forecast: CostForecast;
  /** How many priced calls fell back to total wall time instead of answered time. */
  readonly looseDurationCalls: number;
  readonly rateConfidence: RateConfidence;
  /** True when the page cap was hit, so this total is a FLOOR, not the answer. */
  readonly truncated: boolean;
  readonly estimate: true;
}

/**
 * Project the period's spend from the days that have actually finished.
 *
 * NOT "spend so far divided by elapsed fraction". On day 1 of a month that
 * method multiplies a single day -- possibly a single call -- by 30, and prints
 * it next to real measured numbers where it reads as equally solid. This takes a
 * mean over WHOLE elapsed days and refuses to answer at all below two of them,
 * because a projection from one partial day is not a projection.
 */
export function forecastFor(
  period: CostPeriod,
  spentUsd: number,
  now: number,
  dayMs = 86_400_000,
): CostForecast {
  const note =
    'Projection, not a measurement: the mean of whole elapsed days in this period, extended to its full length.';
  const method: ForecastMethod = 'daily-mean-over-elapsed-days';
  const elapsedMs = Math.max(0, Math.min(now, period.endMs) - period.startMs);
  const sampleDays = Math.floor(elapsedMs / dayMs);
  const periodDays = (period.endMs - period.startMs) / dayMs;
  if (sampleDays < 2) {
    return {
      method,
      usd: null,
      sampleDays,
      reason: 'fewer than two whole days have elapsed in this period',
      note,
    };
  }
  if (sampleDays >= periodDays) {
    // The period is over; the measurement IS the answer, so do not dress a
    // completed total up as a forecast.
    return { method, usd: spentUsd, sampleDays, reason: null, note };
  }
  return {
    method,
    usd: Math.round((spentUsd / sampleDays) * periodDays * 1e6) / 1e6,
    sampleDays,
    reason: null,
    note,
  };
}

export interface RollupInput {
  readonly bucket: R2Bucket;
  readonly window: CostWindow;
  readonly rates: RateTable;
  readonly now: number;
}

/**
 * Price every archived call whose end time falls inside the window.
 *
 * Scanning stops as soon as a row is older than the window. That is safe ONLY
 * because callLogKey bakes a DESCENDING clock into the key (see its comment), so
 * lexicographic order is newest-first and everything after the first out-of-range
 * row is older still. If that key scheme ever changes, this early exit silently
 * starts returning partial totals.
 */
/**
 * Blended USD per billable call-minute, or null when there is nothing to divide.
 *
 * Its own function so the zero-denominator decision has ONE home and a name.
 * Returning 0 here instead of null is the tempting bug: a window whose calls all
 * rang out has real calls and zero billable minutes, and "$0.0000/min" asserts a
 * measured rate rather than an absent one.
 */
function blendedUsdPerMinute(totalUsd: number, billableMs: number): number | null {
  if (billableMs === 0) return null;
  return Math.round((totalUsd / (billableMs / 60_000)) * 1e6) / 1e6;
}

export async function rollupCosts(input: RollupInput): Promise<CostRollup> {
  const { bucket, window, rates, now } = input;
  const period = periodBounds(window, now);
  const trailingStartMs = now - TRAILING_WINDOW_DAYS * 86_400_000;
  // ONE scan, over the UNION of the calendar period and the trailing window.
  //
  // Both totals are accumulated in the same pass on purpose. A second,
  // independent list() loop would DOUBLE the R2 reads on an authenticated
  // request path for a panel the console polls -- the same reasoning that makes
  // this read list() metadata instead of GETting each record. The union only
  // moves the point at which the early exit fires; the page cap above is
  // unchanged, so the worst case is still MAX_ROLLUP_PAGES list() calls, not
  // twice that. test/cost-rollup.test.ts counts list() calls and objects read
  // so a future refactor cannot quietly reintroduce the second scan.
  const scanStartMs = Math.min(period.startMs, trailingStartMs);
  const scanEndMs = Math.max(period.endMs, now);
  const starts = bucketStarts(period);
  const bucketUsd = new Array<number>(starts.length).fill(0);
  const bucketCalls = new Array<number>(starts.length).fill(0);

  let totalUsd = 0;
  let calls = 0;
  let xai = 0;
  let telnyx = 0;
  let telnyxRecording = 0;
  let looseDurationCalls = 0;
  let billableMs = 0;
  let trailingUsd = 0;
  let trailingCalls = 0;
  /**
   * Oldest instant the scan actually reached. Only meaningful when the page cap
   * is hit, where it decides WHICH of the two windows the cap truncated: a cap
   * reached below period.startMs leaves the period total complete even though
   * the wider trailing window is a floor.
   */
  let oldestScannedMs = Number.POSITIVE_INFINITY;
  let cappedOut = false;
  let cursor: string | undefined;
  let reachedOlder = false;

  for (let page = 0; page < MAX_ROLLUP_PAGES && !reachedOlder; page += 1) {
    const listed: R2Objects = await bucket.list({
      prefix: CALL_LOG_PREFIX,
      limit: 1000,
      include: ['customMetadata'],
      ...(cursor ? { cursor } : {}),
    });
    for (const object of listed.objects) {
      const row = listRowFromObject(object);
      // Prefer metadata, but fall back to the key, which encodes the end time
      // and so survives an object whose metadata is missing.
      const endedAt = row.endedAt ?? endedAtFromKey(object.key);
      if (endedAt === null) continue;
      if (endedAt >= scanEndMs) continue; // newer than either window; keep scanning
      if (endedAt < scanStartMs) {
        reachedOlder = true;
        break;
      }
      // Keys sort newest-first, so every row reached here is the oldest so far.
      oldestScannedMs = endedAt;
      const cost: CallCost = estimateCallCost({
        call: billableFromRow(row, endedAt),
        rates,
        recorded: row.recorded,
        now,
      });
      // A row can belong to the trailing window, the calendar period, or both.
      if (endedAt >= trailingStartMs && endedAt <= now) {
        trailingUsd += cost.total;
        trailingCalls += 1;
      }
      // Everything below this line is the SELECTED period only.
      if (endedAt < period.startMs || endedAt >= period.endMs) continue;
      totalUsd += cost.total;
      calls += 1;
      xai += cost.xai;
      telnyx +=
        cost.telnyxLegA +
        cost.telnyxLegB +
        cost.telnyxSip +
        // Participant legs are Telnyx charges like any other leg. Omitting them
        // here would leave byProvider summing to LESS than totalUsd on any
        // conference call -- a breakdown that silently does not add up.
        cost.telnyxParticipants +
        cost.telnyxMediaStreaming +
        cost.telnyxAmd;
      telnyxRecording += cost.telnyxRecording;
      // Same field the call was priced on, so totalUsd/billableMs is exactly
      // the blended rate and not a second, differently-derived number.
      billableMs += cost.billableMs;
      if (cost.durationSource === 'total') looseDurationCalls += 1;
      const index = bucketIndexFor(period, endedAt);
      if (index >= 0 && index < starts.length) {
        bucketUsd[index] = (bucketUsd[index] ?? 0) + cost.total;
        bucketCalls[index] = (bucketCalls[index] ?? 0) + 1;
      }
    }
    if (reachedOlder) break;
    // Trust `truncated`, not the returned count: a page can hold fewer than
    // `limit` objects and still have more to come.
    if (!listed.truncated) break;
    cursor = listed.cursor;
    if (page === MAX_ROLLUP_PAGES - 1) {
      cappedOut = true;
      log('warn', 'cost.rollup.truncated', { window, pages: MAX_ROLLUP_PAGES });
    }
  }

  // The cap truncates a window only if the scan stopped INSIDE it. With no row
  // reached at all, oldestScannedMs is +Infinity and both read truncated, which
  // is the conservative answer rather than a total presented as complete.
  const truncated = cappedOut && oldestScannedMs > period.startMs;
  const trailingTruncated = cappedOut && oldestScannedMs > trailingStartMs;

  const round = (value: number): number => Math.round(value * 1e6) / 1e6;
  return {
    window,
    startMs: period.startMs,
    endMs: period.endMs,
    totalUsd: round(totalUsd),
    calls,
    averageUsdPerCall: calls === 0 ? 0 : round(totalUsd / calls),
    billableMs,
    usdPerMinute: blendedUsdPerMinute(totalUsd, billableMs),
    usdPerMinuteFloor: usdPerMinuteFloor(rates),
    usdPerMinuteFloorXai: round(rates.xaiAudio.usd),
    trailing30: {
      days: TRAILING_WINDOW_DAYS,
      startMs: trailingStartMs,
      endMs: now,
      usd: round(trailingUsd),
      calls: trailingCalls,
      truncated: trailingTruncated,
    },
    byProvider: { xai: round(xai), telnyx: round(telnyx), telnyxRecording: round(telnyxRecording) },
    series: starts.map((startMs, index) => ({
      startMs,
      usd: round(bucketUsd[index] ?? 0),
      calls: bucketCalls[index] ?? 0,
    })),
    forecast: forecastFor(period, round(totalUsd), now),
    looseDurationCalls,
    rateConfidence: tableConfidence(rates, now),
    truncated,
    estimate: true,
  };
}
