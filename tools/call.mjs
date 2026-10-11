#!/usr/bin/env node
// Place an outbound call with LIVE calendar availability attached.
//
// Why the calendar is fetched HERE and not in the Worker: the only Google
// refresh token on this machine carries ~45 scopes (full Drive, gmail.modify,
// Contacts, Ads...). Putting it in a Worker secret would make a Worker
// compromise a full Google-account compromise. Instead this process — which
// already holds those creds — reads the calendar, classifies it locally with
// the SAME module the Worker uses, and sends only busy GEOMETRY over the wire:
// {startMs, endMs, remote}. No string leaves this machine, so nothing about
// any meeting can reach the phone call, and nothing a caller sends can be
// injected into the system prompt.
//
//   node tools/call.mjs --to +15555550123 --task "Ask if my order shipped."
//   node tools/call.mjs --to ... --task ... --dry-run     # print, do not dial
//   node tools/call.mjs --to ... --task ... --no-calendar # omit availability

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import {
  availabilityFromBusy,
  busyFromEvents,
  DEFAULT_AVAILABILITY,
  filterSlotsByTravel,
  renderSlots,
} from '../src/availability.ts';
import { fetchCalcomSlots } from '../src/calcom.ts';

const run = promisify(execFile);

const ACCOUNT = process.env.GOG_ACCOUNT ?? 'operator@example.com';
const BASE = process.env.BRIDGE_BASE ?? 'https://open-grok-voice.example.com';
// gog's --max defaults to 10. A silent truncation here would UNDER-report busy
// time, and the agent would then confidently offer a slot that is booked, so
// this is raised well past any real week and the count is checked below.
const MAX_EVENTS = 500;
const CALCOM_USER = process.env.CALCOM_USER ?? 'your-username';
const CALCOM_BOOKING_URL = `https://cal.com/${CALCOM_USER}`;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}
const has = (name) => process.argv.includes(`--${name}`);

const to = arg('to');
const task = arg('task');
// Short label for the console call log. Optional: the Worker derives a fallback
// from the task when it is absent. Pass it whenever several calls share one task
// script — the derived fallback separates SCRIPTS, not targets, so a campaign
// dialling 41 orgs from 4 task files renders 2 distinct labels without this.
// Trimmed to the API's 120-char cap here so an over-long value cannot 400 the call.
const subjectRaw = arg('subject');
const subject = subjectRaw === null ? undefined : subjectRaw.trim().slice(0, 120) || undefined;
const windowDays = Number.parseInt(arg('window-days', '7'), 10);
// cal.com event slug decides the appointment length. 15min | 30mins | 50mins |
// remote-it-consulting — see cal.com/your-username.
const eventSlug = arg('event', '30mins');
const SLUG_MINUTES = { '15min': 15, '30mins': 30, '50mins': 50, 'remote-it-consulting': 60 };
const slotMinutes = Number.parseInt(arg('minutes', String(SLUG_MINUTES[eventSlug] ?? 30)), 10);
if (!to || !task) {
  console.error(
    'usage: call.mjs --to +1XXXXXXXXXX --task "..." [--subject "Acme Corp"] [--window-days 7] [--dry-run] [--no-calendar]',
  );
  process.exit(2);
}

async function fetchBusy() {
  const from = new Date().toISOString();
  const { stdout } = await run(
    'gog',
    [
      '-a',
      ACCOUNT,
      'calendar',
      'events',
      '--json',
      '--from',
      from,
      '--days',
      String(windowDays),
      '--max',
      String(MAX_EVENTS),
    ],
    { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout);
  const events = Array.isArray(parsed) ? parsed : (parsed.events ?? parsed.items ?? []);
  if (events.length >= MAX_EVENTS) {
    // Three outcomes, not two: a capped read is UNMEASURED, not "clear".
    throw new Error(
      `calendar read hit the ${MAX_EVENTS}-event cap — availability would be under-reported; raise MAX_EVENTS`,
    );
  }
  return { busy: busyFromEvents(events), eventCount: events.length };
}

let busy = [];
let slots = [];
const notes = [];

// Google Calendar is read ONLY to learn which commitments are in person, so
// travel time can be subtracted from cal.com's slots. cal.com already knows
// the events themselves; what it cannot know is that you have to physically
// get somewhere. Nothing from these events is ever sent or spoken.
if (!has('no-calendar')) {
  try {
    const r = await fetchBusy();
    busy = r.busy;
    const inPerson = busy.filter((b) => !b.remote).length;
    notes.push(`calendar: ${r.eventCount} events, ${busy.length} blocking, ${inPerson} in person`);
  } catch (err) {
    notes.push(`calendar UNAVAILABLE (${err.message}) — no travel filtering applied`);
    busy = [];
  }
}

if (!has('no-calcom')) {
  const start = new Date().toISOString();
  const end = new Date(Date.now() + windowDays * 86_400_000).toISOString();
  try {
    const raw = await fetchCalcomSlots({
      username: CALCOM_USER,
      eventTypeSlug: eventSlug,
      startIso: start,
      endIso: end,
      timeZone: DEFAULT_AVAILABILITY.timeZone,
    });
    slots = filterSlotsByTravel(raw, busy, slotMinutes, DEFAULT_AVAILABILITY);
    const dropped = raw.length - slots.length;
    notes.push(
      `cal.com/${CALCOM_USER} ${eventSlug}: ${raw.length} slots, ${dropped} dropped as unreachable, ${slots.length} offered`,
    );
  } catch (err) {
    // A failed fetch is UNKNOWN, not "no availability". Fall through to the
    // busy-window path rather than telling the agent the calendar is clear.
    notes.push(`cal.com UNAVAILABLE (${err.message}) — falling back to computed windows`);
    slots = [];
  }
}

for (const n of notes) console.error(`[${n.split(':')[0]}] ${n}`);
const preview =
  slots.length > 0
    ? renderSlots(slots, DEFAULT_AVAILABILITY, Date.now(), {
        slotMinutes,
        bookingUrl: CALCOM_BOOKING_URL,
        requiresConfirmation: true,
      })
    : busy.length > 0
      ? availabilityFromBusy(busy, Date.now(), windowDays, DEFAULT_AVAILABILITY)
      : null;
if (preview !== null) {
  console.error('\n--- availability the agent will be given ---');
  console.error(preview);
  console.error('-------------------------------------------\n');
}

const payload = { to, task, busy, windowDays, slots, slotMinutes };
// Omitted entirely when not supplied, so the Worker's derived fallback still applies.
if (subject !== undefined) payload.subject = subject;
if (has('dry-run')) {
  console.log(
    JSON.stringify(
      { ...payload, busy: `${busy.length} intervals`, slots: `${slots.length} slots` },
      null,
      2,
    ),
  );
  process.exit(0);
}

const key = (
  process.env.APP_API_KEY ?? readFileSync(new URL('../.app_api_key.txt', import.meta.url), 'utf8')
).trim();
const res = await fetch(`${BASE}/call`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': key },
  body: JSON.stringify(payload),
});
const text = await res.text();
console.log(res.status, text);
process.exit(res.ok ? 0 : 1);
