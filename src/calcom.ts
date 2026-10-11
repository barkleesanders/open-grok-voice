// cal.com public slots.
//
// Endpoint + required header verified live 2026-08-26 against
// cal.com/your-username. The `cal-api-version` header is NOT optional: without
// it the same URL returns 404, which reads exactly like a wrong route and sent
// an earlier probe down the wrong path.
//
// No API key. These slots are already public on the booking page, so an agent
// repeating them discloses nothing that a web visitor could not already see.

export const CALCOM_API = 'https://api.cal.com/v2/slots';
export const CALCOM_API_VERSION = '2024-09-04';

/**
 * Upper bound on a single cal.com slots fetch.
 *
 * This fetch runs inside the CRON dial path (scheduled -> runDueSchedules ->
 * resolveAvailability), and `fireDue` walks due jobs SEQUENTIALLY -- so one
 * hung upstream connection stalls every job behind it on that tick. Left
 * unbounded it interacts badly with MAX_LATENESS_MS: a stall long enough to
 * push a queued job past the lateness window would make the lateness guard
 * refuse the very call it exists to protect.
 *
 * ceiling: a scheduled Worker has a 15-minute wall time per invocation and this
 * Worker ticks every 60s (developers.cloudflare.com/workers/platform/limits,
 * read 2026-09-01). corpus: UNMEASURED -- one live probe on 2026-09-01 returned
 * 200 in well under a second, which is a single sample, not a latency
 * distribution. 8s is therefore a POLICY CHOICE, not a fitted value: far above
 * the one observation, far below the 60s tick, and even at MAX_SCHEDULES (50)
 * due at once the worst case stays inside the wall time. Erring short is the
 * safe direction -- a timeout degrades to `availabilityUnknown` ("I cannot
 * speak to availability"), while erring long stalls the dial queue.
 */
export const CALCOM_FETCH_TIMEOUT_MS = 8_000;

export interface FetchSlotsInput {
  readonly username: string;
  readonly eventTypeSlug: string;
  readonly startIso: string;
  readonly endIso: string;
  readonly timeZone: string;
}

/**
 * Returns bookable start times as epoch ms, sorted.
 *
 * Throws on a non-200 or an unrecognised body rather than returning []. An
 * empty array and a failed fetch mean very different things: the first says
 * "no availability", the second says "unknown", and collapsing them would have
 * the agent confidently assert a free calendar it never actually read.
 */
export async function fetchCalcomSlots(input: FetchSlotsInput): Promise<number[]> {
  const url = new URL(CALCOM_API);
  url.searchParams.set('username', input.username);
  url.searchParams.set('eventTypeSlug', input.eventTypeSlug);
  url.searchParams.set('start', input.startIso);
  url.searchParams.set('end', input.endIso);
  url.searchParams.set('timeZone', input.timeZone);

  const res = await fetch(url, {
    headers: { 'cal-api-version': CALCOM_API_VERSION },
    signal: AbortSignal.timeout(CALCOM_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`cal.com ${res.status} ${(await res.text()).slice(0, 200)}`);
  return parseSlots(await res.json());
}

/**
 * Pull start times out of a cal.com response.
 *
 * Split from the fetch so it can be tested against a captured body. Both the
 * v2 shape ({data:{"YYYY-MM-DD":[{start}]}}) and the booking page's internal
 * trpc shape ({result:{data:{json:{slots:{...[{time}]}}}}}) are accepted,
 * because the two disagree on both the wrapper and the time field name.
 */
export function parseSlots(body: unknown): number[] {
  const root = body as Record<string, unknown>;
  const v2 = root?.data;
  const trpc = (
    (root?.result as Record<string, unknown> | undefined)?.data as
      | Record<string, unknown>
      | undefined
  )?.json as Record<string, unknown> | undefined;
  const days = (v2 ?? trpc?.slots) as Record<string, unknown> | undefined;
  if (days === undefined || days === null || typeof days !== 'object') {
    throw new Error('cal.com: unrecognised response shape');
  }
  const out: number[] = [];
  for (const list of Object.values(days)) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const e = entry as Record<string, unknown>;
      const iso =
        typeof e?.start === 'string' ? e.start : typeof e?.time === 'string' ? e.time : null;
      if (iso === null) continue;
      const ms = Date.parse(iso);
      if (!Number.isNaN(ms)) out.push(ms);
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}
