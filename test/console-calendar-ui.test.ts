// Console UI calendar attachment: form fields, script preview wiring, and
// POST /api/console/calls body construction for cal.com event-type slug,
// windowDays, and slotMinutes.
//
// Verifies the complete UI flow: HTML fields exist, JavaScript reads them,
// script preview includes calendar data, and the place-call request carries
// all calendar fields to the Worker.

import { describe, expect, it } from 'vitest';
import { renderConsolePage } from '../src/console-ui';

function consoleScript(html: string): string {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1])
    .filter((script): script is string => Boolean(script?.trim()));
  const script = scripts[0];
  if (scripts.length !== 1 || script === undefined) {
    throw new Error(`expected exactly one inline script, found ${scripts.length}`);
  }
  return script;
}

const PAGE = renderConsolePage('test-nonce', 'authorized', { name: 'Operator', image: null });
const SCRIPT = consoleScript(PAGE);

describe('calendar form fields', () => {
  it('offers a cal.com event-type slug field', () => {
    expect(PAGE).toContain('id="call-calcom-slug"');
    expect(PAGE).toContain('maxlength="128"');
    expect(PAGE).toContain('placeholder="your-username/30min"');
  });

  it('offers windowDays and slotMinutes fields as a row', () => {
    expect(PAGE).toContain('id="call-window-days"');
    expect(PAGE).toContain('id="call-slot-minutes"');
    expect(PAGE).toContain('type="number"');
    expect(PAGE).toContain('min="1"');
    expect(PAGE).toContain('max="30"');
    expect(PAGE).toContain('min="5"');
    expect(PAGE).toContain('max="480"');
  });

  it('marks all calendar fields as optional in the UI', () => {
    expect(PAGE).toContain('Cal.com event type (optional)');
  });
});

describe('script preview with calendar data', () => {
  it('reads calcomEventTypeSlug from the form', () => {
    expect(SCRIPT).toContain("byId('call-calcom-slug')");
    expect(SCRIPT).toContain('.value.trim()');
  });

  it('reads windowDays and slotMinutes as integers', () => {
    expect(SCRIPT).toContain("byId('call-window-days').value");
    expect(SCRIPT).toContain("byId('call-slot-minutes').value");
    expect(SCRIPT).toContain('parseInt(');
  });

  it('includes calendar fields in the script-preview request body', () => {
    expect(SCRIPT).toContain('/api/console/script-preview');
    expect(SCRIPT).toContain('calcomEventTypeSlug');
    expect(SCRIPT).toContain('windowDays');
    expect(SCRIPT).toContain('slotMinutes');
  });

  it('omits calendar fields when empty rather than sending null or empty string', () => {
    // The schema treats absent calendar fields as "no availability"; sending
    // null or empty string would fail validation.
    expect(SCRIPT).toContain('calcomEventTypeSlug: calcomSlug || undefined');
    expect(SCRIPT).toContain('Number.isFinite(windowDays) ? windowDays : undefined');
    expect(SCRIPT).toContain('Number.isFinite(slotMinutes) ? slotMinutes : undefined');
  });

  it('refreshes the script preview when calendar fields change', () => {
    expect(SCRIPT).toContain("byId('call-calcom-slug').addEventListener('input', refreshScript)");
    expect(SCRIPT).toContain("byId('call-window-days').addEventListener('input', refreshScript)");
    expect(SCRIPT).toContain("byId('call-slot-minutes').addEventListener('input', refreshScript)");
  });
});

describe('place-call request with calendar data', () => {
  it('includes calcomEventTypeSlug in the POST /api/console/calls body', () => {
    expect(SCRIPT).toContain('/api/console/calls');
    expect(SCRIPT).toContain('calcomEventTypeSlug: calcomSlug || undefined');
  });

  it('includes windowDays in the request body when set', () => {
    expect(SCRIPT).toContain('windowDays: Number.isFinite(windowDays) ? windowDays : undefined');
  });

  it('includes slotMinutes in the request body when set', () => {
    expect(SCRIPT).toContain('slotMinutes: Number.isFinite(slotMinutes) ? slotMinutes : undefined');
  });

  it('reads calendar fields before constructing the request body', () => {
    // Verifies the JavaScript evaluates calendar fields in the startButton handler
    // and includes them in the same request body as other fields.
    const startHandlerMatch = SCRIPT.indexOf("startButton.addEventListener('click'");
    const calcomSlugMatch = SCRIPT.indexOf(
      "byId('call-calcom-slug').value.trim()",
      startHandlerMatch,
    );
    const windowDaysMatch = SCRIPT.indexOf("byId('call-window-days').value", startHandlerMatch);
    const slotMinutesMatch = SCRIPT.indexOf("byId('call-slot-minutes').value", startHandlerMatch);

    expect(startHandlerMatch).toBeGreaterThan(-1);
    expect(calcomSlugMatch).toBeGreaterThan(startHandlerMatch);
    expect(windowDaysMatch).toBeGreaterThan(startHandlerMatch);
    expect(slotMinutesMatch).toBeGreaterThan(startHandlerMatch);
  });
});

describe('security constraints', () => {
  it('carries no calendar titles or event names into the prompt', () => {
    // Security: only numeric slots/busy data goes to the prompt, never calendar
    // titles or event type names. The console sends the slug and the Worker
    // resolves it server-side.
    expect(SCRIPT).not.toContain('event.title');
    expect(SCRIPT).not.toContain('event.name');
    expect(SCRIPT).not.toContain('calendar title');
  });

  it('never exposes busy intervals to the browser', () => {
    // The busy/slots data comes from the Worker's server-side resolution, not
    // from the console form. Operators provide a slug, not raw calendar data.
    expect(SCRIPT).not.toContain('busy:');
    expect(SCRIPT).not.toContain('busyIntervals');
  });
});
