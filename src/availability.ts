// Calendar -> free/busy availability, with NOTHING about what the meetings are.
//
// PRIVACY INVARIANT (the reason this file exists):
// The agent talks to third parties. It must be able to say "Tuesday 10-12 works"
// without ever being able to say WHY the other hours are taken. Event summary,
// description, attendees, and location are read here to decide *whether* and
// *how long* a block is, and are NEVER carried into the returned text.
// `src/availability.test.ts` enforces that structurally with sentinel strings.
//
// Field names below were read off a live `gog calendar events --json` response
// on 2026-08-26 rather than assumed; five of them change the answer:
//   transparency==='transparent'  -> does NOT block time (a "free" event)
//   status==='cancelled'          -> still returned by the API; must be dropped
//   attendee.self.responseStatus  -> an event YOU declined must not block you
//   eventType==='workingLocation' -> a location marker, not a meeting
//   hangoutLink / conferenceData  -> the remote detector; no travel time needed

/** The subset of a Google Calendar event this module reads. */
export interface CalendarEvent {
  readonly status?: string;
  readonly transparency?: string;
  readonly eventType?: string;
  /** Read to detect a video call. Never emitted. */
  readonly hangoutLink?: string;
  /** Read to detect a video call. Never emitted. */
  readonly conferenceData?: unknown;
  /** Read to decide travel padding. Never emitted. */
  readonly location?: string;
  /** Never read for output. Present so callers can pass events through unchanged. */
  readonly summary?: string;
  readonly description?: string;
  readonly attendees?: readonly CalendarAttendee[];
  readonly start?: CalendarTime;
  readonly end?: CalendarTime;
}

export interface CalendarAttendee {
  readonly self?: boolean;
  readonly responseStatus?: string;
}

export interface CalendarTime {
  /** Timed events. */
  readonly dateTime?: string;
  /** All-day events use `date` instead. */
  readonly date?: string;
}

export interface AvailabilityOptions {
  /** Minutes of padding on both sides of every commitment. */
  readonly bufferMinutes: number;
  /** Extra minutes before AND after an IN-PERSON commitment, for travel. */
  readonly travelMinutes: number;
  /** Earliest hour of day to offer, local 0-23. */
  readonly dayStartHour: number;
  /** Latest hour of day to offer, local 0-23. */
  readonly dayEndHour: number;
  /** Do not offer a gap shorter than this. */
  readonly minSlotMinutes: number;
  /** IANA zone used to render local wall-clock times. */
  readonly timeZone: string;
}

export const DEFAULT_AVAILABILITY: AvailabilityOptions = {
  bufferMinutes: 15,
  travelMinutes: 30,
  dayStartHour: 9,
  dayEndHour: 18,
  minSlotMinutes: 30,
  timeZone: 'America/Los_Angeles',
};

/** A half-open interval [startMs, endMs). */
export interface Interval {
  readonly startMs: number;
  readonly endMs: number;
}

const MIN = 60_000;

/**
 * Does this event actually consume the user's time?
 *
 * Every branch here was chosen from a real API response, not from the field
 * name. Getting any one of them wrong silently *hides* real availability, which
 * is the failure the caller can never see — the agent just offers fewer slots.
 */
export function blocksTime(ev: CalendarEvent): boolean {
  if (ev.status === 'cancelled') return false;
  // 'transparent' is Google's word for "show me as free during this".
  if (ev.transparency === 'transparent') return false;
  // A working-location marker spans the whole day but commits no time.
  if (ev.eventType === 'workingLocation') return false;
  const me = (ev.attendees ?? []).find((a) => a.self === true);
  if (me?.responseStatus === 'declined') return false;
  return true;
}

/** A video call costs no travel time. Absence of a location also implies remote. */
export function isRemote(ev: CalendarEvent): boolean {
  if (typeof ev.hangoutLink === 'string' && ev.hangoutLink.length > 0) return true;
  if (ev.conferenceData !== undefined && ev.conferenceData !== null) return true;
  const loc = (ev.location ?? '').trim();
  if (loc.length === 0) return true;
  return /^https?:\/\/|zoom\.us|meet\.google|teams\.microsoft|webex/i.test(loc);
}

/**
 * Convert an event to the interval it *effectively* consumes, including buffer
 * and — only when it is in person — travel time on both sides.
 *
 * Returns null for events that consume no time, and for all-day events other
 * than out-of-office (an all-day birthday should not erase a working day).
 */
export function toBusyInterval(ev: CalendarEvent, opt: AvailabilityOptions): Interval | null {
  if (!blocksTime(ev)) return null;

  const startIso = ev.start?.dateTime;
  const endIso = ev.end?.dateTime;

  if (startIso === undefined || endIso === undefined) {
    // All-day. Only an out-of-office day genuinely blocks.
    if (ev.eventType !== 'outOfOffice') return null;
    const d = ev.start?.date;
    if (d === undefined) return null;
    const dayStart = Date.parse(`${d}T00:00:00Z`);
    if (Number.isNaN(dayStart)) return null;
    return { startMs: dayStart, endMs: dayStart + 24 * 60 * MIN };
  }

  const s = Date.parse(startIso);
  const e = Date.parse(endIso);
  if (Number.isNaN(s) || Number.isNaN(e) || e <= s) return null;

  const travel = isRemote(ev) ? 0 : opt.travelMinutes;
  const pad = (opt.bufferMinutes + travel) * MIN;
  return { startMs: s - pad, endMs: e + pad };
}

/** Merge overlapping/touching intervals into a minimal sorted set. */
export function mergeIntervals(input: readonly Interval[]): Interval[] {
  const sorted = [...input].sort((a, b) => a.startMs - b.startMs);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && iv.startMs <= last.endMs) {
      out[out.length - 1] = { startMs: last.startMs, endMs: Math.max(last.endMs, iv.endMs) };
    } else {
      out.push(iv);
    }
  }
  return out;
}

/** Local wall-clock parts for an instant, in the configured zone. */
function localParts(
  ms: number,
  timeZone: string,
): { y: number; m: number; d: number; h: number; min: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const map = new Map<string, string>(
    fmt.formatToParts(new Date(ms)).map((p) => [p.type as string, p.value]),
  );
  const num = (k: string): number => Number.parseInt(map.get(k) ?? '0', 10);
  // Intl renders midnight as hour 24 in some locales; normalise.
  const h = num('hour') % 24;
  return { y: num('year'), m: num('month'), d: num('day'), h, min: num('minute') };
}

/**
 * Local wall-clock hour (0-23) for an instant, in the given zone.
 *
 * A thin named read of `localParts` so callers outside this module -- the
 * scheduler's calling-hours gate is the first -- get the SAME zone arithmetic
 * the availability renderer uses. A second `Intl` implementation written next
 * to this one is exactly how the offered slots and the dial time drift apart
 * across a DST boundary.
 */
export function localHourOf(ms: number, timeZone: string): number {
  return localParts(ms, timeZone).h;
}

/**
 * Is this an IANA zone `Intl` can actually resolve?
 *
 * Load-bearing rather than defensive: `new Intl.DateTimeFormat(_, {timeZone})`
 * THROWS a RangeError on an unknown zone, and the first caller of the hour
 * helpers is the once-a-minute cron tick. One job carrying a bad zone would
 * abort the whole tick and every other due job with it, so every zone that
 * reaches this module is checked at its boundary and defaulted on failure.
 */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Is `ms` inside the local hours this operator is willing to have a phone
 * ring, i.e. [dayStartHour, dayEndHour) local?
 *
 * Half-open on purpose and for the same reason `freeSlots` is: dayEndHour is
 * when the day CLOSES, so 18:00 with dayEndHour 18 is already outside it.
 *
 * Returns false for an unresolvable zone rather than throwing. Three outcomes
 * collapse to two here deliberately: "cannot tell what hour it is locally" is
 * not a reason to dial a stranger, so it is treated as outside the window.
 */
export function withinCallingHours(ms: number, opt: AvailabilityOptions): boolean {
  if (!isValidTimeZone(opt.timeZone)) return false;
  const h = localHourOf(ms, opt.timeZone);
  return h >= opt.dayStartHour && h < opt.dayEndHour;
}

/**
 * What the agent is told when the call was set up WITH calendar data and that
 * data could not be trusted at dial time.
 *
 * This exists because silence is not safe here. Omitting the availability
 * section entirely is correct for a call that never had a calendar -- most
 * calls -- but for one the operator attached a calendar to, silence next to a
 * task that says "offer him a time" is precisely where the agent invents one.
 * Saying "you do not have it" is the only honest reading of a dropped snapshot,
 * and it is the same distinction `src/calcom.ts` draws between an empty array
 * and a failed fetch.
 */
export const AVAILABILITY_UNKNOWN = [
  'AVAILABILITY: you do NOT have the calendar for this call.',
  'The schedule information this call was set up with was too old to trust and was discarded.',
  'Do not state, imply, or guess when anyone is free or busy, and never say a time is open.',
  'If a time needs to be arranged, say you will check the calendar and follow up.',
].join('\n');

/**
 * The instant of `hour:00` local time on the local day containing `ms`.
 * Derived by measuring the zone's offset at that instant rather than assuming
 * a fixed offset, so DST transitions do not shift the working day.
 */
function localHourInstant(ms: number, hour: number, timeZone: string): number {
  const p = localParts(ms, timeZone);
  const guessUtc = Date.UTC(p.y, p.m - 1, p.d, hour, 0, 0);
  const back = localParts(guessUtc, timeZone);
  const guessLocalMinutes = back.h * 60 + back.min;
  const offsetMinutes = guessLocalMinutes - hour * 60;
  return guessUtc - offsetMinutes * MIN;
}

/** Free windows inside working hours across [fromMs, toMs), minus busy. */
export function freeSlots(
  busy: readonly Interval[],
  fromMs: number,
  toMs: number,
  opt: AvailabilityOptions,
): Interval[] {
  const merged = mergeIntervals(busy);
  const out: Interval[] = [];
  const minLen = opt.minSlotMinutes * MIN;

  for (let cursor = fromMs; cursor < toMs; ) {
    const dayOpen = Math.max(localHourInstant(cursor, opt.dayStartHour, opt.timeZone), fromMs);
    const dayClose = Math.min(localHourInstant(cursor, opt.dayEndHour, opt.timeZone), toMs);
    const nextDay = localHourInstant(cursor + 24 * 60 * MIN, opt.dayStartHour, opt.timeZone);

    let open = Math.max(dayOpen, cursor);
    for (const b of merged) {
      if (b.endMs <= open || b.startMs >= dayClose) continue;
      if (b.startMs - open >= minLen) out.push({ startMs: open, endMs: b.startMs });
      open = Math.max(open, b.endMs);
    }
    if (dayClose - open >= minLen) out.push({ startMs: open, endMs: dayClose });

    // Guard against a non-advancing cursor on a pathological zone/DST result.
    cursor = nextDay > cursor ? nextDay : cursor + 24 * 60 * MIN;
  }
  return out;
}

function fmtSlot(iv: Interval, timeZone: string): string {
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
  const clock = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const from = clock.format(new Date(iv.startMs)).replace(':00', '');
  const to = clock.format(new Date(iv.endMs)).replace(':00', '');
  return `${day.format(new Date(iv.startMs))}: ${from} to ${to}`;
}

/**
 * Render availability for the system prompt.
 *
 * Emits ONLY day names and clock ranges. No event fields reach this string —
 * that is asserted structurally in the tests, not merely intended here.
 */
export function renderAvailability(
  slots: readonly Interval[],
  opt: AvailabilityOptions,
  nowMs: number,
  limit = 12,
): string {
  // The date anchor is load-bearing, not decoration. Without it the agent sees
  // only day NAMES and cannot resolve "today"/"tonight"/"tomorrow". On a real
  // call (66e70e19, 2026-08-26) it answered "I don't have any times listed for
  // today" and then immediately quoted a slot dated that same day.
  const stamp = new Intl.DateTimeFormat('en-US', {
    timeZone: opt.timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(nowMs));
  const anchor = `RIGHT NOW it is ${stamp} (${opt.timeZone}). Use this to resolve "today", "tonight", "tomorrow" and "this week".`;

  if (slots.length === 0) {
    return [
      anchor,
      'AVAILABILITY: no open slots in the window. Do not propose a specific time; offer to call back with times.',
    ].join('\n');
  }
  const lines = slots.slice(0, limit).map((s) => `- ${fmtSlot(s, opt.timeZone)}`);
  return [
    anchor,
    'AVAILABILITY — these are OPEN WINDOWS, not appointment lengths:',
    ...lines,
    'Propose a specific START time inside one of these windows, sized to the meeting.',
    'Never read a whole window aloud as if it were the appointment.',
    'Only offer times from this list. If none work, say you will check and call back.',
    'Never describe what any other commitment is — you do not know, and must not speculate.',
  ].join('\n');
}

/** End-to-end: events -> prompt-ready availability text. */
export function availabilityFromEvents(
  events: readonly CalendarEvent[],
  fromMs: number,
  toMs: number,
  opt: AvailabilityOptions = DEFAULT_AVAILABILITY,
): string {
  const busy: Interval[] = [];
  for (const ev of events) {
    const iv = toBusyInterval(ev, opt);
    if (iv !== null) busy.push(iv);
  }
  return renderAvailability(freeSlots(busy, fromMs, toMs, opt), opt, fromMs);
}

/**
 * A commitment as it crosses the network: NUMBERS AND A BOOLEAN, NOTHING ELSE.
 *
 * This is the trust boundary. The caller has the calendar and does the
 * classification (`blocksTime` / `isRemote` above) locally, then sends only
 * the resulting geometry. Because no caller-supplied STRING exists in this
 * type, no caller string can reach the system prompt — prompt injection via
 * the availability channel is impossible by construction rather than by
 * escaping. `test/availability.test.ts` pins that.
 */
export interface BusyInput {
  readonly startMs: number;
  readonly endMs: number;
  /** True for video calls. False means travel padding is added on both sides. */
  readonly remote: boolean;
}

/** Apply buffer (+ travel when in person) to raw busy geometry. */
export function padBusy(busy: readonly BusyInput[], opt: AvailabilityOptions): Interval[] {
  const out: Interval[] = [];
  for (const b of busy) {
    if (!Number.isFinite(b.startMs) || !Number.isFinite(b.endMs) || b.endMs <= b.startMs) continue;
    const pad = (opt.bufferMinutes + (b.remote ? 0 : opt.travelMinutes)) * MIN;
    out.push({ startMs: b.startMs - pad, endMs: b.endMs + pad });
  }
  return out;
}

/**
 * Busy geometry -> prompt-ready availability text.
 *
 * `nowMs` is passed in rather than read from the clock so this stays pure and
 * testable. Callers evaluate it at instruction-build time — i.e. when the call
 * is actually answered — so slots that elapsed while the phone was ringing
 * fall out of the window on their own.
 */
export function availabilityFromBusy(
  busy: readonly BusyInput[],
  nowMs: number,
  windowDays: number,
  opt: AvailabilityOptions = DEFAULT_AVAILABILITY,
): string {
  const toMs = nowMs + windowDays * 24 * 60 * MIN;
  return renderAvailability(freeSlots(padBusy(busy, opt), nowMs, toMs, opt), opt, nowMs);
}

/** Classify live Google Calendar events into wire-safe busy geometry. */
export function busyFromEvents(events: readonly CalendarEvent[]): BusyInput[] {
  const out: BusyInput[] = [];
  for (const ev of events) {
    if (!blocksTime(ev)) continue;
    const s = ev.start?.dateTime === undefined ? Number.NaN : Date.parse(ev.start.dateTime);
    const e = ev.end?.dateTime === undefined ? Number.NaN : Date.parse(ev.end.dateTime);
    if (Number.isNaN(s) || Number.isNaN(e) || e <= s) {
      // All-day: only out-of-office genuinely blocks (matches toBusyInterval).
      if (ev.eventType !== 'outOfOffice' || ev.start?.date === undefined) continue;
      const d = Date.parse(`${ev.start.date}T00:00:00Z`);
      if (Number.isNaN(d)) continue;
      out.push({ startMs: d, endMs: d + 24 * 60 * MIN, remote: true });
      continue;
    }
    out.push({ startMs: s, endMs: e, remote: isRemote(ev) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// cal.com slots — the PREFERRED availability source.
//
// Why cal.com beats deriving windows from the raw calendar (measured against
// the same Google Calendar, same instant, 2026-08-26):
//   * It knows the REAL working hours per day. It offered Saturday 6-7:30pm and
//     correctly blocked Saturday noon-6pm; the hardcoded 9-6 here did both
//     wrong. Those hours were invented; cal.com's are configured.
//   * It emits DISCRETE BOOKABLE START TIMES at the event's real duration,
//     which is structurally what stops an agent reading a nine-hour window
//     aloud as if it were the appointment.
//   * Its slots are ALREADY PUBLIC on the booking page, so an agent repeating
//     them discloses strictly nothing new.
// What cal.com does NOT know is TRAVEL. It offered 5:30pm fourteen minutes
// after an in-person appointment ended at 5:16pm. That is what the filter
// below is for, and it is the only reason this module still reads locations.
// ---------------------------------------------------------------------------

/** A bookable start time, epoch ms. Numbers only — same wire guarantee. */
export type SlotMs = number;

/**
 * Drop slots that are physically impossible given IN-PERSON commitments.
 *
 * Pads by travelMinutes ONLY, not buffer: cal.com already accounts for the
 * meeting itself, so re-adding its buffer here would double-count and hide
 * real availability. Remote commitments are skipped entirely — a video call
 * costs no travel.
 */
export function filterSlotsByTravel(
  slots: readonly SlotMs[],
  busy: readonly BusyInput[],
  slotMinutes: number,
  opt: AvailabilityOptions,
): SlotMs[] {
  const travel = opt.travelMinutes * MIN;
  const blocked = busy
    .filter((b) => !b.remote && Number.isFinite(b.startMs) && Number.isFinite(b.endMs))
    .map((b) => ({ startMs: b.startMs - travel, endMs: b.endMs + travel }));
  const len = slotMinutes * MIN;
  return slots.filter((t) => {
    const end = t + len;
    return !blocked.some((b) => t < b.endMs && end > b.startMs);
  });
}

function dayKey(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date(ms));
}

function clockOf(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(ms));
}

/**
 * Turn a URL into something a TTS voice reads correctly.
 *
 * This lives in the PROMPT rather than in xAI's `replace` map because that
 * map's keys may not contain punctuation (verified: a dot or slash returns
 * 400), so a URL can never be matched there.
 */
export function spokenUrl(url: string): string {
  return url
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '')
    .replace(/\./g, ' dot ')
    .replace(/\//g, ' slash ')
    .replace(/-/g, ' dash ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface SlotRenderOptions {
  /** Length of the appointment being offered. */
  readonly slotMinutes: number;
  /** Public booking page, e.g. https://cal.com/your-username. Server config. */
  readonly bookingUrl: string;
  /** True when the event type is "requires confirmation" (all of them are). */
  readonly requiresConfirmation: boolean;
  /** Cap on days rendered, to keep the prompt small. */
  readonly maxDays?: number;
  /** Cap on times shown per day. */
  readonly maxPerDay?: number;
}

/**
 * Render discrete bookable start times, grouped by day.
 *
 * Emits ONLY weekday/date labels and clock times — the same privacy invariant
 * as renderAvailability, enforced by the same sentinel tests.
 */
export function renderSlots(
  slots: readonly SlotMs[],
  opt: AvailabilityOptions,
  nowMs: number,
  ropt: SlotRenderOptions,
): string {
  const stamp = new Intl.DateTimeFormat('en-US', {
    timeZone: opt.timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(nowMs));
  const anchor = `RIGHT NOW it is ${stamp} (${opt.timeZone}). Use this to resolve "today", "tonight", "tomorrow" and "this week".`;
  // Say it, do not spell it. Reading the raw URL aloud produced
  // "c-a-l dot c-o-m slash b-a-r-k-l-e-e" on a real call.
  const link = `If none of these work, give them the booking page. Say it exactly as: "${spokenUrl(ropt.bookingUrl)}". Never spell the address out letter by letter.`;

  const future = [...slots].filter((t) => t > nowMs).sort((a, b) => a - b);
  if (future.length === 0) {
    return [
      anchor,
      'AVAILABILITY: no open times in the window. Do not invent one.',
      `Offer to have the operator follow up, or give the booking page, said exactly as: "${spokenUrl(ropt.bookingUrl)}".`,
    ].join('\n');
  }

  const byDay = new Map<string, SlotMs[]>();
  for (const t of future) {
    const k = dayKey(t, opt.timeZone);
    const arr = byDay.get(k);
    if (arr === undefined) byDay.set(k, [t]);
    else arr.push(t);
  }

  const lines: string[] = [];
  for (const [day, times] of [...byDay].slice(0, ropt.maxDays ?? 5)) {
    const shown = times.slice(0, ropt.maxPerDay ?? 8).map((t) => clockOf(t, opt.timeZone));
    const more = times.length > shown.length ? ` (and ${times.length - shown.length} more)` : '';
    lines.push(`- ${day}: ${shown.join(', ')}${more}`);
  }

  const out = [
    anchor,
    `AVAILABILITY — bookable ${ropt.slotMinutes}-minute start times:`,
    ...lines,
    'Offer one of these exact start times. Never invent a time that is not listed.',
    link,
  ];
  if (ropt.requiresConfirmation) {
    out.push(
      'Bookings REQUIRE the operator to confirm. Say you will REQUEST the time and they will confirm.',
      'Never tell anyone a time is confirmed or booked.',
    );
  }
  out.push(
    'Never describe what any other commitment is — you do not know, and must not speculate.',
  );
  return out.join('\n');
}
