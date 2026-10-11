// What one call cost, estimated from published list rates.
//
// *** THIS IS AN ESTIMATE, NOT AN INVOICE. *** Every number here is derived from
// the providers' public price pages at the dates recorded below. It does not
// know about volume discounts, contract rates, minimum billing increments,
// per-destination surcharges, taxes, or anything Telnyx and xAI settle on their
// own ledgers. Treat it as an order-of-magnitude check on spend, never as a bill.
// Every surface that renders it says so.
//
// DESIGN: cost is DERIVED AT READ TIME from the stored duration and never
// written into the R2 archive. Two reasons, and the second is the important one:
//   1. Rates change. A number frozen into a record at write time goes quietly
//      wrong and nothing ever revisits it.
//   2. Deriving means every call ALREADY archived gets a cost with no migration
//      and no backfill, which is what makes the rollup cover the whole history
//      rather than only calls placed after this shipped.
//
// Pure functions only. No I/O, no clock reads except the one passed in.

import { log } from './log';

/** Where a rate's number came from, and how much to trust it today. */
export type RateConfidence =
  /** Read from the provider's own page within RATE_FRESH_DAYS. */
  | 'verified'
  /** Read from the provider's page, but long enough ago that it may have moved. */
  | 'stale'
  /** Supplied by the operator through wrangler [vars] — provenance is their invoice. */
  | 'override';

/**
 * How long a published rate is treated as current.
 *
 * This is the Decay Rule in code: a rate that lives on someone else's pricing
 * page can go wrong with no commit of ours, so freshness is COMPUTED from
 * `verifiedAt` on every read rather than hardcoded as a label someone has to
 * remember to update. Nobody has to notice the rates aged; they age themselves.
 */
export const RATE_FRESH_DAYS = 30;

/** A published price, carried with its provenance. */
export interface Rate {
  /** Dollars per `unit`. */
  readonly usd: number;
  readonly unit: 'minute' | 'call';
  /** URL of the page this was read from. */
  readonly source: string;
  /** ISO date (YYYY-MM-DD) the number was last read from `source`. */
  readonly verifiedAt: string;
  /** Anything that makes the number less than a flat fact. */
  readonly note?: string;
}

export interface RateTable {
  /** xAI Speech-to-Speech audio, the model this bridge actually uses. */
  readonly xaiAudio: Rate;
  /** Telnyx Call Control, charged per leg. This architecture runs TWO legs. */
  readonly telnyxLeg: Rate;
  /** Telnyx SIP trunking termination, on the PSTN leg only. */
  readonly telnyxSipTrunk: Rate;
  readonly telnyxRecording: Rate;
  readonly telnyxMediaStreaming: Rate;
  readonly telnyxAmd: Rate;
}

const TELNYX_CALL_CONTROL = 'https://telnyx.com/pricing/call-control';
const TELNYX_ELASTIC_SIP = 'https://telnyx.com/pricing/elastic-sip';
const XAI_MODELS = 'https://docs.x.ai/docs/models';

/**
 * Published list rates.
 *
 * Each figure below was read from the provider's own page on `verifiedAt` --
 * from the raw bytes, not from a rendered summary. Telnyx serves its price
 * tables inside a Next.js flight payload, so the numbers were decoded out of
 * `self.__next_f` rather than scraped from visible HTML; xAI's came from
 * docs.x.ai/llms.txt, which is the docs site's own plain-text export.
 */
export const DEFAULT_RATES: RateTable = {
  xaiAudio: {
    // "| Speech to Speech (grok-voice-think-fast-2.0) | $0.08 / min ($4.80 / hr)
    //  audio<br />$0.004 / text input |"
    usd: 0.08,
    unit: 'minute',
    source: XAI_MODELS,
    verifiedAt: '2026-08-28',
    // The $0.004 text-input charge is modelled as ZERO. This bridge sends one
    // session.update plus occasional instruction refreshes -- a handful of text
    // events per call against a per-minute audio charge twenty times larger.
    // Including it would add noise, not accuracy.
    note: 'Audio only; the $0.004 text-input component is treated as negligible for a voice call.',
  },
  telnyxLeg: {
    // "Make outbound calls" -> "$0.002 per minute + the SIP Trunking fee for
    // outbound calls"; inbound local and toll-free are the same $0.002.
    usd: 0.002,
    unit: 'minute',
    source: TELNYX_CALL_CONTROL,
    verifiedAt: '2026-08-28',
  },
  telnyxSipTrunk: {
    // "Make outbound calls / Local calls / Starting at $0.005 per minute"
    usd: 0.005,
    unit: 'minute',
    source: TELNYX_ELASTIC_SIP,
    verifiedAt: '2026-08-28',
    // "Starting at" is a FLOOR, not a fixed price: the real rate depends on the
    // destination. This makes the estimate a lower bound for any call that is
    // not a cheap domestic local one.
    note: 'Published as "Starting at" -- a destination-dependent floor, so a real invoice can be higher.',
  },
  telnyxRecording: {
    // "Call recording" -> "$0.002 per minute"; "Call recording storage" -> "$0 per minute".
    usd: 0.002,
    unit: 'minute',
    source: TELNYX_CALL_CONTROL,
    verifiedAt: '2026-08-28',
    note: 'Recording storage is separately published at $0 per minute, so it adds nothing.',
  },
  telnyxMediaStreaming: {
    // "Media Streaming over WebSockets" -> "$0.0035 per minute".
    // This is NOT optional for this Worker: the reducer fires START_MEDIA_EFFECTS
    // on leg_a_answered (src/state.ts), so every answered call streams media.
    usd: 0.0035,
    unit: 'minute',
    source: TELNYX_CALL_CONTROL,
    verifiedAt: '2026-08-28',
    note: 'Published without a "per leg" qualifier (unlike noise suppression), so billed once per call here.',
  },
  telnyxAmd: {
    // "Standard answering machine detection" -> "$0.002 per call". Per CALL, not
    // per minute -- src/telnyx.ts sets answering_machine_detection on the dial.
    usd: 0.002,
    unit: 'call',
    source: TELNYX_CALL_CONTROL,
    verifiedAt: '2026-08-28',
    note: 'Standard AMD. Premium AMD is $0.0065 per call; this Worker does not request it.',
  },
};

/** The wrangler [vars] name that overrides each rate. */
const OVERRIDE_VARS = {
  xaiAudio: 'RATE_XAI_PER_MIN',
  telnyxLeg: 'RATE_TELNYX_LEG_PER_MIN',
  telnyxSipTrunk: 'RATE_TELNYX_SIP_PER_MIN',
  telnyxRecording: 'RATE_TELNYX_RECORDING_PER_MIN',
  telnyxMediaStreaming: 'RATE_TELNYX_MEDIA_STREAM_PER_MIN',
  telnyxAmd: 'RATE_TELNYX_AMD_PER_CALL',
} as const satisfies Record<keyof RateTable, string>;

/** Reject anything that would poison the arithmetic with NaN or a negative price. */
function parseRateOverride(raw: string | undefined, varName: string): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    // Loud but not fatal: a typo in a var must not take the console down, and it
    // must not silently become NaN and render every cost as "$NaN".
    log('warn', 'cost.rate.override_invalid', { var: varName, value: trimmed });
    return null;
  }
  return parsed;
}

/** Only the vars this module reads, so callers need not pass a whole Env. */
export type RateOverrides = Partial<
  Record<(typeof OVERRIDE_VARS)[keyof typeof OVERRIDE_VARS], string>
>;

/** Sentinel `verifiedAt` marking a rate that came from an operator var. */
export const OVERRIDE_DATE = 'override';

/**
 * The rate table in force, with operator overrides applied.
 *
 * The overrides exist so the numbers can be corrected against a REAL Telnyx
 * invoice without a code change and without a deploy of this module's defaults.
 *
 * Every field is listed explicitly rather than looped over, so adding a rate to
 * RateTable without wiring its override is a COMPILE error instead of a rate
 * that silently ignores its var.
 */
export function ratesFrom(overrides: RateOverrides, base: RateTable = DEFAULT_RATES): RateTable {
  const resolve = (key: keyof RateTable): Rate => {
    const varName = OVERRIDE_VARS[key];
    const value = parseRateOverride(overrides[varName], varName);
    if (value === null) return base[key];
    return {
      ...base[key],
      usd: value,
      source: `wrangler var ${varName}`,
      // An override's provenance is the operator's own invoice, which this
      // module cannot date. Stamping today's date would be a lie, so the
      // sentinel makes `rateConfidence` report 'override' instead.
      verifiedAt: OVERRIDE_DATE,
      note: 'Operator override from wrangler [vars]; not a published list rate.',
    };
  };
  return {
    xaiAudio: resolve('xaiAudio'),
    telnyxLeg: resolve('telnyxLeg'),
    telnyxSipTrunk: resolve('telnyxSipTrunk'),
    telnyxRecording: resolve('telnyxRecording'),
    telnyxMediaStreaming: resolve('telnyxMediaStreaming'),
    telnyxAmd: resolve('telnyxAmd'),
  };
}

/** How much to trust one rate right now. */
export function rateConfidence(rate: Rate, now: number): RateConfidence {
  if (rate.verifiedAt === OVERRIDE_DATE) return 'override';
  const verified = Date.parse(`${rate.verifiedAt}T00:00:00Z`);
  if (!Number.isFinite(verified)) return 'stale';
  const ageDays = (now - verified) / 86_400_000;
  return ageDays <= RATE_FRESH_DAYS ? 'verified' : 'stale';
}

/** The weakest confidence across the table -- what the UI should report overall. */
export function tableConfidence(rates: RateTable, now: number): RateConfidence {
  const all = Object.values(rates).map((rate) => rateConfidence(rate, now));
  if (all.includes('stale')) return 'stale';
  if (all.includes('override')) return 'override';
  return 'verified';
}

/** Which timestamp the billable duration came from. */
export type DurationSource =
  /** endedAt - answeredAt: what a carrier actually meters. */
  | 'answered'
  /** endedAt - startedAt, because no answer time was recorded. Includes ring time. */
  | 'total'
  /** The call was never answered, so there are no billable minutes at all. */
  | 'unanswered';

/** The stored facts a cost can be derived from. Deliberately not CallLogRecord: */
/** the rollup builds these out of R2 list metadata, which has no transcript.    */
export interface BillableCall {
  readonly startedAt: number;
  readonly endedAt: number;
  /** Epoch ms the human leg was answered, or null when unknown or never answered. */
  readonly answeredAt: number | null;
  /** Total wall time, used only when `answeredAt` is unknown. */
  readonly durationMs: number;
  /** A call that reached a terminal FAILED phase without ever connecting. */
  readonly answered: boolean;
  /**
   * Summed answered-to-departure milliseconds across EVERY escalation
   * participant on this call. Zero for a plain two-leg call.
   *
   * ONE NUMBER, not a roster, and that is deliberate. The console's list route
   * prices a page of calls from R2 custom metadata alone -- strings, no record
   * bodies -- so anything the list cannot carry, the list would silently price
   * differently from the detail panel. That exact divergence shipped once
   * before (two different costs for one call). A single scalar is computable
   * from the roster AND storable in one metadata key, so both surfaces are
   * reading the same input rather than agreeing by luck.
   *
   * Absent on every record written before conference support, where 0 is the
   * FACT rather than a fallback: those calls had no participants because the
   * feature did not exist.
   */
  readonly participantBillableMs?: number;
}

/** The per-participant timestamps the billable sum is computed from. */
export interface BillableParticipant {
  /** When their LEG answered. Null means they never answered: zero minutes. */
  readonly answeredAt: number | null;
  /** When they left. Null means they were still on when the call ended. */
  readonly leftAt: number | null;
}

/**
 * Total billable milliseconds across participants.
 *
 * THE ONE DEFINITION, so the live status route, the archived detail view and
 * the R2 metadata writer cannot drift.
 *
 * Metered from ANSWER, exactly like leg A -- a carrier bills a leg from the
 * moment it is picked up, not from the moment it is joined to a conference.
 * A participant still on the line when the call ended is metered to `endedAt`;
 * one who never answered contributes nothing.
 *
 * WHAT THIS IS NOT: an invoice line. Telnyx bills each leg on its own clock and
 * this reconstructs those clocks from webhook arrival times, so a slow webhook
 * shifts a boundary by however long it was slow. The error is on the order of
 * the webhook latency, which is small against a per-minute rate -- but it is an
 * estimate of a duration we did not measure directly, and the model says so
 * rather than presenting it as metered fact.
 */
export function participantBillableMs(
  participants: readonly BillableParticipant[],
  endedAt: number,
): number {
  let total = 0;
  for (const participant of participants) {
    if (participant.answeredAt === null) continue;
    const left = participant.leftAt ?? endedAt;
    if (left <= participant.answeredAt) continue;
    total += left - participant.answeredAt;
  }
  return total;
}

export interface BillableDuration {
  readonly billableMs: number;
  readonly durationSource: DurationSource;
}

/**
 * How many milliseconds this call should be charged for.
 *
 * The three cases are genuinely different and collapsing them is the bug this
 * function exists to prevent:
 *   - answered, with a recorded answer instant: meter from ANSWER, like a carrier.
 *   - answered, but archived before answeredAt existed: fall back to total wall
 *     time and SAY SO, because it silently includes ring time and so runs high.
 *   - never answered: no billable minutes. Costing a rang-out call as though it
 *     had connected is the worst of the three, because it is confidently wrong.
 */
export function billableDuration(call: BillableCall): BillableDuration {
  if (!call.answered) return { billableMs: 0, durationSource: 'unanswered' };
  if (call.answeredAt !== null && call.endedAt > call.answeredAt) {
    return { billableMs: call.endedAt - call.answeredAt, durationSource: 'answered' };
  }
  return { billableMs: Math.max(0, call.durationMs), durationSource: 'total' };
}

/** One call's cost, itemised. Every field is USD. */
export interface CallCost {
  /** xAI Speech-to-Speech audio. */
  readonly xai: number;
  /** Telnyx Call Control on leg A, the PSTN leg to the human. */
  readonly telnyxLegA: number;
  /** Telnyx Call Control on leg B, the SIP leg into xAI. */
  readonly telnyxLegB: number;
  /** Telnyx SIP trunking termination. PSTN leg only -- see the note in the code. */
  readonly telnyxSip: number;
  /**
   * Call Control + SIP trunking across every escalation participant leg.
   *
   * Kept as its OWN line rather than folded into telnyxLegA/telnyxSip: a
   * conference call and a two-party call would otherwise be indistinguishable
   * in the breakdown, and "why did this call cost three times the last one" is
   * exactly the question the panel exists to answer.
   */
  readonly telnyxParticipants: number;
  /** Billable participant milliseconds this line was computed from. */
  readonly participantBillableMs: number;
  readonly telnyxRecording: number;
  readonly telnyxMediaStreaming: number;
  readonly telnyxAmd: number;
  readonly total: number;
  readonly billableMs: number;
  readonly durationSource: DurationSource;
  readonly rateConfidence: RateConfidence;
  /** Always true. Present in the payload so no consumer can forget what this is. */
  readonly estimate: true;
}

/** Round to cents-with-headroom: sub-cent line items are real at this scale. */
function usd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export interface CostInput {
  readonly call: BillableCall;
  readonly rates: RateTable;
  /** Whether this call had a recording. No recording, no recording charge. */
  readonly recorded: boolean;
  /** Now, for rate-freshness only. Never used in the arithmetic. */
  readonly now: number;
}

/**
 * Estimate one call's cost from list rates.
 *
 * THE TWO-LEG POINT: this architecture has Telnyx originate BOTH legs and bridge
 * them carrier-side -- leg A is the PSTN call to the human, leg B is the SIP call
 * into sip.voice.x.ai (see the module header of src/call-session.ts). Both are up
 * for the bridged duration, so Call Control is charged TWICE. Modelling one leg
 * would understate every call by a third of its Telnyx line.
 *
 * *** AND IT IS NO LONGER ONLY TWO LEGS. *** Conference support (2026-08-30)
 * lets an operator add escalation participants mid-call, and each one is a
 * THIRD, FOURTH, ... real outbound PSTN leg on this account. Those legs are
 * priced from `participantBillableMs` on their own clocks rather than at the
 * call's duration, because they join late and may leave early -- charging them
 * for the whole call would overstate a one-minute escalation on a ten-minute
 * call by an order of magnitude, in the wrong direction.
 *
 * WHAT IS ASSUMED, stated rather than buried:
 *   - SIP TRUNKING IS CHARGED ON LEG A ONLY. Telnyx publishes trunking as a
 *     per-destination PSTN termination rate; leg B terminates at a SIP URI, not
 *     on the PSTN. Whether Telnyx applies a trunking fee to a SIP-URI
 *     destination is NOT stated on either pricing page and was not verified, so
 *     it is modelled as not applying. If an invoice says otherwise, raise
 *     RATE_TELNYX_SIP_PER_MIN to cover both legs rather than editing this file.
 *   - xAI IS METERED OVER THE WHOLE BILLABLE WINDOW. The realtime session
 *     actually starts a few seconds later, when leg B answers, which this does
 *     not track. So the xAI line runs slightly HIGH -- named direction, not a
 *     silent one.
 *   - NO MINIMUM BILLING INCREMENT. Neither page publishes one. Real carriers
 *     commonly round up per 6 or per 60 seconds, which would make actual spend
 *     higher. This estimate is therefore a floor on the per-minute components.
 */
export function estimateCallCost(input: CostInput): CallCost {
  const { rates, recorded, now } = input;
  const { billableMs, durationSource } = billableDuration(input.call);
  const minutes = billableMs / 60_000;

  const xai = usd(minutes * rates.xaiAudio.usd);
  const telnyxLegA = usd(minutes * rates.telnyxLeg.usd);
  const telnyxLegB = usd(minutes * rates.telnyxLeg.usd);
  const telnyxSip = usd(minutes * rates.telnyxSipTrunk.usd);
  // Participant legs are PSTN calls like leg A, so each carries Call Control
  // AND SIP trunking. They carry neither media streaming (one stream per call,
  // started on leg A) nor AMD (participant dials request no detection).
  const participantMs = Math.max(0, input.call.participantBillableMs ?? 0);
  const participantMinutes = participantMs / 60_000;
  const telnyxParticipants = usd(
    participantMinutes * (rates.telnyxLeg.usd + rates.telnyxSipTrunk.usd),
  );
  const telnyxRecording = recorded ? usd(minutes * rates.telnyxRecording.usd) : 0;
  const telnyxMediaStreaming = usd(minutes * rates.telnyxMediaStreaming.usd);
  // Per CALL, and only for a call that was answered: AMD runs on the answered
  // leg, so a call that never connected is not charged for detecting nothing.
  const telnyxAmd = durationSource === 'unanswered' ? 0 : rates.telnyxAmd.usd;

  return {
    xai,
    telnyxLegA,
    telnyxLegB,
    telnyxSip,
    telnyxParticipants,
    participantBillableMs: participantMs,
    telnyxRecording,
    telnyxMediaStreaming,
    telnyxAmd,
    total: usd(
      xai +
        telnyxLegA +
        telnyxLegB +
        telnyxSip +
        telnyxParticipants +
        telnyxRecording +
        telnyxMediaStreaming +
        telnyxAmd,
    ),
    billableMs,
    durationSource,
    rateConfidence: tableConfidence(rates, now),
    estimate: true,
  };
}

/**
 * Published cost of ONE plain two-party call minute, derived from this table.
 *
 * This is the denominator for "are we running hot?": xAI audio + both Call
 * Control legs + SIP trunking on the PSTN leg + media streaming. With
 * DEFAULT_RATES that is $0.0925/min, of which $0.08 -- 86% -- is the xAI model.
 * A rate figure with nothing to compare it against is a number, not a signal.
 *
 * DERIVED from the same RateTable the estimate uses, never a literal. A
 * hardcoded 0.0925 would keep rendering happily after a rate moved or an
 * operator override landed, and would then be a comparison against a price
 * nobody charges -- the exact decay class the `verifiedAt` stamps exist to
 * catch on the rates themselves.
 *
 * Deliberately EXCLUDES three things, because a rate that includes them is not
 * a floor:
 *   - recording ($0.002/min): per-call optional, not every call records.
 *   - AMD: charged per CALL, so it belongs in no per-minute figure. It is why
 *     a very short answered call always prices above this floor.
 *   - participant legs: they exist only on a conference call.
 * So an observed rate ABOVE this floor is the expected shape for recorded,
 * short, or multi-party calls -- not evidence of a pricing bug.
 */
export function usdPerMinuteFloor(rates: RateTable = DEFAULT_RATES): number {
  return usd(
    rates.xaiAudio.usd +
      rates.telnyxLeg.usd * 2 +
      rates.telnyxSipTrunk.usd +
      rates.telnyxMediaStreaming.usd,
  );
}

/** The disclaimer every surface renders. One string, so it cannot drift. */
export const COST_DISCLAIMER =
  'Estimated from published list rates, not a bill. Excludes contract pricing, minimum billing increments, taxes, and per-destination surcharges.';
