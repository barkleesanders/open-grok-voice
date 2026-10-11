import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_AVAILABILITY, withinCallingHours } from '../src/availability';
import { app } from '../src/index';
import { createFakeR2 } from './fake-r2';
import { testEnv } from './test-env';

/**
 * RELATIVE, not a fixed instant.
 *
 * This was `1_788_179_700_000` (2026-08-31 08:35 America/New_York), chosen when
 * the job was staged. `POST /call` rejects a runAt that is not in the future
 * (`runAt must be in the future`, schedule.ts:196), so the test passed until
 * that moment arrived and then failed for every run afterwards -- a red suite
 * with no code change behind it, which is exactly the kind of false signal that
 * trains people to ignore the gate. What is under test is the route contract
 * (schedule, do not dial), not one calendar instant, so the horizon is computed.
 */
const RUN_AT = nextCallingHour();

/**
 * ...and inside CALLING HOURS, for the same reason it is relative.
 *
 * `now + 1h` was a valid schedule until dialing was gated on local calling
 * hours; after that it made this suite pass or fail depending on the time of
 * day it ran, which is the same false-signal failure the comment above was
 * written about. Walk forward until an hour lands inside the window.
 */
function nextCallingHour(): number {
  const hour = 60 * 60 * 1000;
  for (let t = Date.now() + hour; ; t += hour) {
    if (withinCallingHours(t, DEFAULT_AVAILABILITY)) return t;
  }
}
const TASK = [
  "Hi, I'm calling on behalf of the operator — I'm their assistant.",
  'I just have a couple of quick questions about mailing a records request to the records office — is this the right desk, or should I call someone else?',
  'If yes, ask exactly two questions, then stop:',
  '1. Will you accept a printed business check, mailed with the request?',
  '2. If the envelope already has a return address, will you mail the results back without a separate stamped envelope?',
  'If they want a callback, take a name and say the operator will call back. Do not agree to any fee or mailing on their behalf.',
  'If this is voicemail, hang up without leaving a message.',
  'If asked whether you are a real person, say you are an AI assistant the operator uses to place calls.',
  'Do not mention any alleged crimes. Do not read a home street address.',
].join(' ');

describe('Records office deferred job', () => {
  it('creates via POST /call without dialing', async () => {
    const r2 = createFakeR2();
    const env = testEnv({ CALL_LOGS: r2.bucket });
    const res = await app.fetch(
      new Request('https://bridge.example.test/call', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'test-app-key' },
        body: JSON.stringify({
          to: '+15555550101',
          subject: 'Records office search fee',
          task: TASK,
          runAt: RUN_AT,
        }),
      }),
      env,
    );
    expect(res.status).toBe(202);
    const created = (await res.json()) as Record<string, unknown>;
    expect(created.status).toBe('scheduled');
    expect(created.to).toBe('+15555550101');
    expect(created.runAt).toBe(RUN_AT);
    expect(created.callId).toBeUndefined();

    const listed = await app.fetch(
      new Request('https://bridge.example.test/call/schedules', {
        headers: { 'x-api-key': 'test-app-key' },
      }),
      env,
    );
    expect(listed.status).toBe(200);
    const page = (await listed.json()) as { schedules: Array<Record<string, unknown>> };
    expect(page.schedules).toHaveLength(1);
    expect(page.schedules[0]?.status).toBe('pending');

    const out = process.env.CLERK_JOB_OUT;
    if (out) {
      writeFileSync(
        out,
        `${JSON.stringify(
          {
            created,
            list: page.schedules[0],
            r2Keys: r2.keys(),
            note: 'Created through shipped POST /call. Production fire requires /ship of this Worker; Carmack does not deploy.',
          },
          null,
          2,
        )}\n`,
      );
    }
  });
});
