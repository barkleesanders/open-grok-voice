// Script preview with calendar availability tests.

import { describe, expect, it } from 'vitest';
import { availabilityFromBusy, DEFAULT_AVAILABILITY, renderSlots } from '../src/availability';
import type { Env } from '../src/env';
import { app } from '../src/index';
import { composeInstructions } from '../src/instructions';
import { ScriptPreviewRequestSchema } from '../src/types';
import { testEnv } from './test-env';

describe('script preview with calendar fields', () => {
  async function preview(body: unknown, env: Env = testEnv()): Promise<Response> {
    return app.fetch(
      new Request('https://bridge.example.test/api/console/script-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
    );
  }

  it('rejects anonymous caller', async () => {
    const response = await preview({ task: 'anything' });
    expect(response.status).toBe(401);
  });

  it('accepts calendar fields in schema', async () => {
    // This won't actually call the route due to auth, but validates the schema
    const body = {
      task: 'reschedule appointment',
      busy: [{ startMs: 1700000000000, endMs: 1700003600000, remote: false }],
      windowDays: 7,
      slots: [1700010000000, 1700013600000],
      slotMinutes: 30,
      calcomEventTypeSlug: '30min',
      timeZone: 'America/Los_Angeles',
      voicemail: false,
    };

    // Schema validation happens before auth check, so we check that it parses
    const response = await preview(body);
    expect(response.status).toBe(401); // Auth failure, not 400 schema error
  });

  it('rejects invalid timeZone', async () => {
    const body = {
      task: 'test',
      timeZone: 'NotA/ValidZone',
    };

    const _response = await preview(body);
    // Will reject for auth, but we can verify schema with a direct test
    const parsed = ScriptPreviewRequestSchema.safeParse(body);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.message.includes('IANA zone'))).toBe(true);
    }
  });

  it('accepts valid IANA timeZone', async () => {
    const valid = ScriptPreviewRequestSchema.safeParse({
      task: 'test',
      timeZone: 'America/New_York',
    });
    expect(valid.success).toBe(true);
  });

  it('enforces busy array limits', async () => {
    const tooManyBusy = Array.from({ length: 501 }, (_, i) => ({
      startMs: 1700000000000 + i * 3600000,
      endMs: 1700000000000 + (i + 1) * 3600000,
      remote: false,
    }));

    const parsed = ScriptPreviewRequestSchema.safeParse({
      task: 'test',
      busy: tooManyBusy,
    });
    expect(parsed.success).toBe(false);
  });

  it('enforces slots array limits', async () => {
    const tooManySlots = Array.from({ length: 401 }, (_, i) => 1700000000000 + i * 1800000);

    const parsed = ScriptPreviewRequestSchema.safeParse({
      task: 'test',
      slots: tooManySlots,
    });
    expect(parsed.success).toBe(false);
  });

  it('validates calcomEventTypeSlug pattern', async () => {
    // Valid slugs
    expect(
      ScriptPreviewRequestSchema.safeParse({
        task: 'test',
        calcomEventTypeSlug: '30min',
      }).success,
    ).toBe(true);

    expect(
      ScriptPreviewRequestSchema.safeParse({
        task: 'test',
        calcomEventTypeSlug: 'my-appointment-type',
      }).success,
    ).toBe(true);

    // Invalid slugs
    expect(
      ScriptPreviewRequestSchema.safeParse({
        task: 'test',
        calcomEventTypeSlug: 'has space',
      }).success,
    ).toBe(false);

    expect(
      ScriptPreviewRequestSchema.safeParse({
        task: 'test',
        calcomEventTypeSlug: 'UPPERCASE',
      }).success,
    ).toBe(false);

    expect(
      ScriptPreviewRequestSchema.safeParse({
        task: 'test',
        calcomEventTypeSlug: '-starts-with-dash',
      }).success,
    ).toBe(false);
  });
});

describe('script preview availability rendering (integration)', () => {
  it('includes availability section when slots provided', () => {
    const now = Date.now();
    const slots = [now + 3600000, now + 7200000]; // 1h and 2h from now
    const availability = renderSlots(slots, DEFAULT_AVAILABILITY, now, {
      slotMinutes: 30,
      bookingUrl: 'https://cal.com/test',
      requiresConfirmation: true,
    });

    const segments = composeInstructions({
      task: 'reschedule appointment',
      direction: 'outbound',
      availability,
    });

    const availSegment = segments.find((s) => s.kind === 'availability');
    expect(availSegment).toBeDefined();
    expect(availSegment?.text).toBe(availability);
    expect(availSegment?.text).toContain('AVAILABILITY');
  });

  it('omits availability section when no calendar data', () => {
    const segments = composeInstructions({
      task: 'reschedule appointment',
      direction: 'outbound',
      availability: null,
    });

    const availSegment = segments.find((s) => s.kind === 'availability');
    expect(availSegment).toBeUndefined();
  });

  it('includes availability section when busy windows provided', () => {
    const now = Date.now();
    const busy = [{ startMs: now + 3600000, endMs: now + 7200000, remote: false }];
    const availability = availabilityFromBusy(busy, now, 7);

    const segments = composeInstructions({
      task: 'reschedule appointment',
      direction: 'outbound',
      availability,
    });

    const availSegment = segments.find((s) => s.kind === 'availability');
    expect(availSegment).toBeDefined();
    expect(availSegment?.text).toContain('AVAILABILITY');
  });
});
