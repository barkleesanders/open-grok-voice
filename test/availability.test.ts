import { describe, expect, it } from 'vitest';
import {
  type AvailabilityOptions,
  availabilityFromBusy,
  availabilityFromEvents,
  blocksTime,
  busyFromEvents,
  type CalendarEvent,
  DEFAULT_AVAILABILITY,
  freeSlots,
  isRemote,
  mergeIntervals,
  padBusy,
  toBusyInterval,
} from '../src/availability';
import {
  HYDRATED_DEFAULTS,
  hydrateState,
  initialState,
  type PersistedCallState,
} from '../src/state';
import { CallRequestSchema } from '../src/types';

const OPT: AvailabilityOptions = { ...DEFAULT_AVAILABILITY, timeZone: 'America/Los_Angeles' };
const MIN = 60_000;

// A Tuesday in PDT. 10:00-11:00 local == 17:00-18:00Z.
const T10 = '2026-09-01T17:00:00Z';
const T11 = '2026-09-01T18:00:00Z';
const WINDOW_FROM = Date.parse('2026-09-01T00:00:00Z');
const WINDOW_TO = Date.parse('2026-09-03T00:00:00Z');

function ev(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return { start: { dateTime: T10 }, end: { dateTime: T11 }, ...over };
}

describe('privacy invariant — event contents never reach the prompt', () => {
  // Every sensitive field carries a unique sentinel. If ANY of them can leak,
  // this fails and names the field. This is structural: a future field that
  // gets rendered will trip it as long as the sentinel is added here.
  const SENTINELS = {
    summary: 'ZZSUMMARYZZ',
    description: 'ZZDESCRIPTIONZZ',
    location: 'ZZLOCATIONZZ',
    attendeeEmail: 'ZZATTENDEEZZ@example.com',
    hangoutLink: 'https://meet.google.com/ZZHANGOUTZZ',
  } as const;

  const loaded: CalendarEvent = ev({
    summary: SENTINELS.summary,
    description: SENTINELS.description,
    location: SENTINELS.location,
    hangoutLink: SENTINELS.hangoutLink,
    attendees: [{ self: true, responseStatus: 'accepted' }, { self: false }],
  });

  it('emits no sensitive field value', () => {
    const out = availabilityFromEvents([loaded], WINDOW_FROM, WINDOW_TO, OPT);
    for (const [field, sentinel] of Object.entries(SENTINELS)) {
      expect(out, `leaked ${field}`).not.toContain(sentinel);
    }
  });

  it('positive control — the event really was processed', () => {
    // Proves the assertion above is not vacuous: this event DOES shape output.
    // With it, the 10-11 hour is unavailable; without it, that hour is free.
    const withEvent = availabilityFromEvents([loaded], WINDOW_FROM, WINDOW_TO, OPT);
    const withoutEvent = availabilityFromEvents([], WINDOW_FROM, WINDOW_TO, OPT);
    expect(withEvent).not.toEqual(withoutEvent);
    expect(withEvent).toContain('AVAILABILITY');
  });
});

describe('blocksTime — the five rules read off a live response', () => {
  it('counts an ordinary accepted event', () => {
    expect(blocksTime(ev())).toBe(true);
  });
  it('ignores cancelled events (the API still returns them)', () => {
    expect(blocksTime(ev({ status: 'cancelled' }))).toBe(false);
  });
  it('ignores transparent events (shown as free)', () => {
    expect(blocksTime(ev({ transparency: 'transparent' }))).toBe(false);
  });
  it('ignores an event the user declined', () => {
    expect(blocksTime(ev({ attendees: [{ self: true, responseStatus: 'declined' }] }))).toBe(false);
  });
  it('ignores workingLocation markers', () => {
    expect(blocksTime(ev({ eventType: 'workingLocation' }))).toBe(false);
  });
  it('still counts an event someone ELSE declined', () => {
    expect(blocksTime(ev({ attendees: [{ self: false, responseStatus: 'declined' }] }))).toBe(true);
  });
});

describe('isRemote — travel time only applies in person', () => {
  it('hangoutLink means remote', () => {
    expect(
      isRemote(ev({ hangoutLink: 'https://meet.google.com/abc', location: '1 Main St' })),
    ).toBe(true);
  });
  it('conferenceData means remote', () => {
    expect(isRemote(ev({ conferenceData: { entryPoints: [] }, location: '1 Main St' }))).toBe(true);
  });
  it('a physical address is not remote', () => {
    expect(isRemote(ev({ location: '1 Main St, San Francisco' }))).toBe(false);
  });
  it('a zoom URL in location is remote', () => {
    expect(isRemote(ev({ location: 'https://zoom.us/j/123' }))).toBe(true);
  });
  it('no location at all is treated as remote', () => {
    expect(isRemote(ev())).toBe(true);
  });
});

describe('travel + buffer padding', () => {
  it('in-person pads buffer AND travel on both sides', () => {
    const iv = toBusyInterval(ev({ location: '1 Main St' }), OPT);
    expect(iv).not.toBeNull();
    const pad = (OPT.bufferMinutes + OPT.travelMinutes) * MIN;
    expect(iv?.startMs).toBe(Date.parse(T10) - pad);
    expect(iv?.endMs).toBe(Date.parse(T11) + pad);
  });

  it('remote pads buffer ONLY — no travel', () => {
    const iv = toBusyInterval(ev({ hangoutLink: 'https://meet.google.com/x' }), OPT);
    const pad = OPT.bufferMinutes * MIN;
    expect(iv?.startMs).toBe(Date.parse(T10) - pad);
    expect(iv?.endMs).toBe(Date.parse(T11) + pad);
  });

  it('an in-person block is strictly larger than the same block remote', () => {
    const inPerson = toBusyInterval(ev({ location: '1 Main St' }), OPT);
    const remote = toBusyInterval(ev({ hangoutLink: 'https://meet.google.com/x' }), OPT);
    const span = (i: { startMs: number; endMs: number } | null): number =>
      i === null ? 0 : i.endMs - i.startMs;
    expect(span(inPerson)).toBeGreaterThan(span(remote));
  });

  it('all-day events do not erase the day, but all-day OOO does', () => {
    const birthday: CalendarEvent = { start: { date: '2026-09-01' }, end: { date: '2026-09-02' } };
    expect(toBusyInterval(birthday, OPT)).toBeNull();
    const ooo: CalendarEvent = {
      eventType: 'outOfOffice',
      start: { date: '2026-09-01' },
      end: { date: '2026-09-02' },
    };
    expect(toBusyInterval(ooo, OPT)).not.toBeNull();
  });

  it('drops a zero-length or inverted event', () => {
    expect(toBusyInterval(ev({ end: { dateTime: T10 } }), OPT)).toBeNull();
  });
});

describe('mergeIntervals', () => {
  it('merges overlapping and touching, preserves disjoint', () => {
    const merged = mergeIntervals([
      { startMs: 300, endMs: 400 },
      { startMs: 0, endMs: 100 },
      { startMs: 90, endMs: 200 },
    ]);
    expect(merged).toEqual([
      { startMs: 0, endMs: 200 },
      { startMs: 300, endMs: 400 },
    ]);
  });
  it('returns empty for empty', () => {
    expect(mergeIntervals([])).toEqual([]);
  });
});

describe('freeSlots', () => {
  it('never returns a slot shorter than minSlotMinutes', () => {
    const busy = [
      { startMs: Date.parse('2026-09-01T16:00:00Z'), endMs: Date.parse('2026-09-01T16:50:00Z') },
      { startMs: Date.parse('2026-09-01T17:10:00Z'), endMs: Date.parse('2026-09-01T23:00:00Z') },
    ];
    const slots = freeSlots(busy, WINDOW_FROM, WINDOW_TO, OPT);
    for (const s of slots) {
      expect(s.endMs - s.startMs).toBeGreaterThanOrEqual(OPT.minSlotMinutes * MIN);
    }
  });

  it('terminates and stays inside the window', () => {
    const slots = freeSlots([], WINDOW_FROM, WINDOW_TO, OPT);
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      expect(s.startMs).toBeGreaterThanOrEqual(WINDOW_FROM);
      expect(s.endMs).toBeLessThanOrEqual(WINDOW_TO);
      expect(s.endMs).toBeGreaterThan(s.startMs);
    }
  });

  it('a fully-booked window yields the explicit no-slots instruction', () => {
    const wall = [{ startMs: WINDOW_FROM, endMs: WINDOW_TO }];
    const text = (() => {
      const slots = freeSlots(wall, WINDOW_FROM, WINDOW_TO, OPT);
      expect(slots).toEqual([]);
      return availabilityFromEvents(
        [
          ev({
            location: '1 Main St',
            start: { dateTime: '2026-09-01T00:00:00Z' },
            end: { dateTime: '2026-09-03T00:00:00Z' },
          }),
        ],
        WINDOW_FROM,
        WINDOW_TO,
        OPT,
      );
    })();
    expect(text).toContain('no open slots');
    expect(text).not.toContain('- ');
  });
});

describe('busy wire contract — no caller string can reach the prompt', () => {
  it('the schema rejects any extra key alongside the numbers', () => {
    const smuggled = {
      to: '+14155550123',
      task: 'call the dentist',
      busy: [{ startMs: 1, endMs: 2, remote: true, summary: 'ZZLEAKZZ' }],
    };
    const r = CallRequestSchema.safeParse(smuggled);
    expect(r.success).toBe(false);
  });

  it('positive control — the same payload WITHOUT the extra key is accepted', () => {
    // Proves the rejection above is caused by the smuggled key, not by some
    // unrelated invalidity in the fixture.
    const clean = {
      to: '+14155550123',
      task: 'call the dentist',
      busy: [{ startMs: 1, endMs: 2, remote: true }],
    };
    expect(CallRequestSchema.safeParse(clean).success).toBe(true);
  });

  it('rejects non-finite and non-integer times', () => {
    const bad = (busy: unknown) =>
      CallRequestSchema.safeParse({ to: '+14155550123', task: 't', busy }).success;
    expect(bad([{ startMs: Number.NaN, endMs: 2, remote: true }])).toBe(false);
    expect(bad([{ startMs: 1.5, endMs: 2, remote: true }])).toBe(false);
    expect(bad([{ startMs: 1, endMs: 2, remote: 'yes' }])).toBe(false);
  });
});

describe('availabilityFromBusy — the window starts NOW', () => {
  const NOW = Date.parse('2026-09-01T19:00:00Z'); // Tuesday, 12:00 PDT

  it('never offers a slot that already elapsed', () => {
    const text = availabilityFromBusy(
      [{ startMs: NOW, endMs: NOW + 3_600_000, remote: true }],
      NOW,
      2,
      OPT,
    );
    // Tuesday morning is in the past relative to NOW, so it must not appear.
    const tuesdayLines = text.split('\n').filter((l) => l.startsWith('- Tuesday'));
    for (const line of tuesdayLines) {
      expect(line).not.toMatch(/\b(9|10|11) AM\b/);
    }
  });

  it('padBusy keeps the in-person block strictly larger than the remote one', () => {
    const [remote] = padBusy([{ startMs: NOW, endMs: NOW + 3_600_000, remote: true }], OPT);
    const [inPerson] = padBusy([{ startMs: NOW, endMs: NOW + 3_600_000, remote: false }], OPT);
    expect(inPerson).toBeDefined();
    expect(remote).toBeDefined();
    const span = (i?: { startMs: number; endMs: number }): number => (i ? i.endMs - i.startMs : 0);
    expect(span(inPerson) - span(remote)).toBe(2 * OPT.travelMinutes * MIN);
  });

  it('drops inverted / non-finite intervals instead of corrupting the day', () => {
    expect(padBusy([{ startMs: 100, endMs: 100, remote: true }], OPT)).toEqual([]);
    expect(padBusy([{ startMs: Number.NaN, endMs: 5, remote: true }], OPT)).toEqual([]);
  });
});

describe('busyFromEvents — classification matches toBusyInterval', () => {
  it('drops exactly the events blocksTime drops', () => {
    const events: CalendarEvent[] = [
      ev(),
      ev({ status: 'cancelled' }),
      ev({ transparency: 'transparent' }),
      ev({ eventType: 'workingLocation' }),
      ev({ attendees: [{ self: true, responseStatus: 'declined' }] }),
    ];
    expect(busyFromEvents(events)).toHaveLength(1);
  });

  it('marks a physical address as not-remote and a hangout as remote', () => {
    expect(busyFromEvents([ev({ location: '1 Main St' })])[0]?.remote).toBe(false);
    expect(busyFromEvents([ev({ hangoutLink: 'https://meet.google.com/x' })])[0]?.remote).toBe(
      true,
    );
  });

  it('emits ONLY numeric/boolean fields — no strings survive classification', () => {
    const out = busyFromEvents([ev({ summary: 'ZZSUMMARYZZ', location: 'ZZLOCATIONZZ' })]);
    expect(JSON.stringify(out)).not.toContain('ZZ');
    for (const b of out) {
      expect(Object.keys(b).sort()).toEqual(['endMs', 'remote', 'startMs']);
    }
  });
});

describe('deploy safety — state written by an OLDER version must not crash a live call', () => {
  // storage.get<CallState>() is a cast, not validation. A record written before
  // `busy`/`windowDays` existed comes back with them undefined while TS still
  // believes they are present. This is the shape a call in flight across the
  // 2026-08-26 deploy would have hit.
  const preDeploy = {
    callId: 'c1',
    phase: 'answered',
    to: '+14155550123',
    task: 'call the dentist',
    voice: 'eve',
    amd: null,
  } as unknown as PersistedCallState;

  it('reproduces the crash when the raw record is used unhydrated', () => {
    const raw = preDeploy as unknown as { busy: unknown[] };
    expect(() => raw.busy.length).toThrow(TypeError);
  });

  it('hydrateState fills the missing fields', () => {
    const s = hydrateState(preDeploy);
    expect(s.busy).toEqual([]);
    expect(s.windowDays).toBe(7);
    expect(() => s.busy.length).not.toThrow();
  });

  it('preserves every field the old record DID carry', () => {
    const s = hydrateState(preDeploy);
    expect(s.task).toBe('call the dentist');
    expect(s.to).toBe('+14155550123');
    expect(s.callId).toBe('c1');
  });

  it('does not clobber values a NEWER record already has', () => {
    const withBusy = {
      ...preDeploy,
      busy: [{ startMs: 1, endMs: 2, remote: true }],
      windowDays: 14,
    } as unknown as PersistedCallState;
    const s = hydrateState(withBusy);
    expect(s.busy).toHaveLength(1);
    expect(s.windowDays).toBe(14);
  });
});

describe('date anchor — regression from live call 66e70e19 (2026-08-26)', () => {
  // On that call the agent said "I don't have any times listed for today" and
  // then quoted a slot dated that same day. It could see day NAMES but had no
  // way to know which one was today.
  const NOW = Date.parse('2026-08-26T22:18:00Z'); // Wednesday 3:18 PM PDT

  it('states the current date and time so "today" is resolvable', () => {
    const out = availabilityFromBusy([], NOW, 3, OPT);
    expect(out).toContain('RIGHT NOW it is Wednesday, August 26, 2026');
    expect(out).toContain('America/Los_Angeles');
    expect(out).toMatch(/resolve "today", "tonight", "tomorrow"/);
  });

  it('the anchor names the SAME weekday the slots use, so they can be matched', () => {
    const out = availabilityFromBusy([], NOW, 3, OPT);
    const anchorDay = out.match(/RIGHT NOW it is (\w+), (\w+ \d+)/);
    expect(anchorDay).not.toBeNull();
    const [, weekday, monthDay] = anchorDay ?? [];
    // A slot for today must be findable by the exact string the anchor uses.
    expect(out).toContain(`- ${weekday}, ${monthDay}:`);
  });

  it('still emits the anchor when there are NO slots', () => {
    const wall = [{ startMs: NOW - 1, endMs: NOW + 10 * 24 * 3_600_000, remote: true }];
    const out = availabilityFromBusy(wall, NOW, 3, OPT);
    expect(out).toContain('RIGHT NOW it is Wednesday');
    expect(out).toContain('no open slots');
  });

  it('tells the agent a window is not an appointment length', () => {
    // It offered "Thursday 9 AM to 6 PM" as a time for a 30-minute meeting.
    const out = availabilityFromBusy([], NOW, 3, OPT);
    expect(out).toContain('OPEN WINDOWS, not appointment lengths');
    expect(out).toContain('Propose a specific START time');
  });

  it('the anchor leaks nothing — privacy invariant survives the new header', () => {
    const loaded = ev({
      summary: 'ZZSUMMARYZZ',
      location: 'ZZLOCATIONZZ',
      start: { dateTime: '2026-08-27T17:00:00Z' },
      end: { dateTime: '2026-08-27T18:00:00Z' },
    });
    const out = availabilityFromBusy(busyFromEvents([loaded]), NOW, 3, OPT);
    expect(out).not.toContain('ZZ');
  });
});

describe('hydration is COMPLETE — the guard that survives the next field', () => {
  // Adding busy/windowDays broke live calls once (TypeError on state.busy.length),
  // and adding slots/slotMinutes reintroduced the risk because the fix was
  // extended and its test was not.
  //
  // Iterating HYDRATED_DEFAULTS alone is NOT enough, verified by two-arm
  // control: deleting an entry from it merely deletes that entry's test case
  // (47 passed), and adding a field to CallState without a default typechecks
  // clean (tsc rc=0). So the load-bearing check is the key-set canary below:
  // every key of a fresh state must be accounted for in exactly one of
  // HYDRATED_DEFAULTS or NOT_HYDRATED, which fails on both mistakes.
  function fresh() {
    return initialState({
      callId: 'c1',
      to: '+14155550123',
      task: 't',
      voice: 'eve',
      amd: null,
      now: 0,
    });
  }

  // Fields that legitimately come from storage on EVERY record because they
  // predate the storage-shape gap. Anything new belongs in HYDRATED_DEFAULTS.
  const NOT_HYDRATED = [
    'callId',
    'phase',
    'to',
    'task',
    'voice',
    'amd',
    'legA',
    'legB',
    'xaiCallId',
    'legBAnswered',
    'xaiSessionReady',
    'bridgeRequested',
    'amdResult',
    'failureReason',
    'createdAt',
    'updatedAt',
    'transcript',
  ];

  it('KEY-SET CANARY: every CallState field is classified', () => {
    const actual = Object.keys(fresh()).sort();
    const classified = [...NOT_HYDRATED, ...Object.keys(HYDRATED_DEFAULTS)].sort();
    const unclassified = actual.filter((k) => !classified.includes(k));
    const stale = classified.filter((k) => !actual.includes(k));
    expect(
      unclassified,
      `new CallState field(s) with no hydration decision: ${unclassified.join(', ')}`,
    ).toEqual([]);
    expect(stale, `classified but no longer on CallState: ${stale.join(', ')}`).toEqual([]);
  });

  for (const key of Object.keys(HYDRATED_DEFAULTS)) {
    it(`restores "${key}" when an older record lacks it`, () => {
      const old = { ...fresh() } as Record<string, unknown>;
      delete old[key];
      const h = hydrateState(old as unknown as PersistedCallState) as unknown as Record<
        string,
        unknown
      >;
      expect(key in h, `hydrateState() dropped ${key}`).toBe(true);
      expect(h[key]).toBeDefined();
      expect(h[key]).toEqual((HYDRATED_DEFAULTS as Record<string, unknown>)[key]);
    });
  }

  it('a record missing ALL of them still hydrates to a usable state', () => {
    const old = { ...fresh() } as Record<string, unknown>;
    for (const k of Object.keys(HYDRATED_DEFAULTS)) delete old[k];
    const s = hydrateState(old as unknown as PersistedCallState);
    expect(() => s.busy.length + s.slots.length).not.toThrow();
    expect(s.slotMinutes).toBe(30);
    expect(s.windowDays).toBe(7);
  });

  it('does NOT clobber values a newer record already carries', () => {
    const s = hydrateState({
      ...fresh(),
      slots: [1, 2, 3],
      slotMinutes: 50,
    } as unknown as PersistedCallState);
    expect(s.slots).toHaveLength(3);
    expect(s.slotMinutes).toBe(50);
  });

  it('preserves the fields an old record DID carry', () => {
    const s = hydrateState(fresh() as unknown as PersistedCallState);
    expect(s.callId).toBe('c1');
    expect(s.task).toBe('t');
    expect(s.transcript).toBeDefined();
  });
});
