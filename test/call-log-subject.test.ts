// What a call was ABOUT, from the write that stores it to the row that renders it.
//
// The bug these cover is not "a field was missing". It is that FOUR separate
// projections each described a call and each independently dropped the one
// field that tells two calls apart, so the console's log rendered rows that
// differed only by a number and a timestamp.
//
// The measurement that shaped the design, and that a future reader should not
// have to re-derive: the campaign behind the calls now in the real bucket
// queued 41 calls from 4 task files, and those files' first 120 characters
// collapse to 2 distinct strings (groups of 32 and 9), because the operator's
// per-target name never entered the task. A label derived from the task alone
// would therefore have rendered 32 rows identically and looked like a fix.
// That is why `subject` is an explicit input and not a derivation.

import { describe, expect, it } from 'vitest';
import {
  archivedStatusView,
  buildCallLogRecord,
  type CallLogRecord,
  callLogKey,
  deriveCallSubject,
  listCallLog,
  listRowFromObject,
  MAX_SUBJECT_CHARS,
  putCallLogRecord,
  recordingObjectKey,
  resolveCallSubject,
} from '../src/call-log';
import type { RecordingAsset } from '../src/recordings';
import { type CallState, initialState } from '../src/state';
import { createFakeR2 } from './fake-r2';

const T0 = 1_756_000_000_000;

function state(overrides: Partial<CallState> = {}): CallState {
  return {
    ...initialState({
      callId: 'aaaaaaaa-1111-4111-8111-111111111111',
      to: '+14155550123',
      task: 'Ask the clinic about the referral.',
      voice: 'liora',
      amd: null,
      now: T0,
    }),
    phase: 'completed',
    updatedAt: T0 + 42_000,
    ...overrides,
  };
}

const WAV: RecordingAsset = {
  id: 'rec-1',
  format: 'wav',
  channels: 'dual',
  url: 'https://storage.telnyx.com/rec-1.wav',
  startedAt: null,
  endedAt: null,
};

/**
 * A record with every metadata field at a NON-DEFAULT value.
 *
 * That is a requirement, not decoration: the structural test below removes each
 * stored key in turn and demands the projected row change. A fixture with
 * `answeredAt: null` and no recordings writes '' and '0', which read back
 * identically to absent -- so those keys would look inert and the test would
 * report a false positive about the reader.
 */
function record(overrides: Partial<CallState> = {}): CallLogRecord {
  const built = state({ answeredAt: T0 + 5_000, recordings: [WAV], ...overrides });
  return buildCallLogRecord({
    state: built,
    teardownReason: 'leg_A_hangup:normal',
    to: '+14155550123',
    endedAt: built.updatedAt,
    archivedKeys: [recordingObjectKey(built.callId, WAV)],
  });
}

describe('deriveCallSubject', () => {
  it('takes the first sentence when there is one short enough to be a label', () => {
    expect(deriveCallSubject('Ask the clinic about the referral. Then confirm the fax.')).toBe(
      'Ask the clinic about the referral.',
    );
  });

  it('collapses the newlines a multi-line script is written with', () => {
    expect(deriveCallSubject('Call the\n  admissions desk\n\nand ask about a bed.')).toBe(
      'Call the admissions desk and ask about a bed.',
    );
  });

  it('never exceeds what R2 custom metadata will carry', () => {
    const long = `${'x'.repeat(500)}. tail`;
    const out = deriveCallSubject(long);
    expect(out).not.toBeNull();
    expect((out as string).length).toBeLessThanOrEqual(MAX_SUBJECT_CHARS);
  });

  it('is null for a task that is only whitespace, rather than an empty label', () => {
    // The renderer needs "I have nothing" to be distinguishable from "I have an
    // empty string", or it draws a blank line where a label should be.
    expect(deriveCallSubject('   \n\t  ')).toBeNull();
    expect(deriveCallSubject('')).toBeNull();
  });

  it('passes a phone number in the task through unchanged', () => {
    // THE INVERSION THIS PINS. This previously asserted the number was masked,
    // which is what kept maskEmbeddedDigitRuns alive. `to` is now a full E.164
    // on the same row, so masking the operator's own text hid it from the
    // person who typed it and protected nothing.
    const out = deriveCallSubject('Call Bob at 315-426-3600 about the transfer.');
    expect(out).toContain('315-426-3600');
    expect(out).not.toContain('*');
    expect(out).toContain('Bob');
  });

  it('leaves a date alone, as it always did', () => {
    expect(deriveCallSubject('Follow up on the 2026-08-29 referral.')).toContain('2026-08-29');
  });
});

describe('resolveCallSubject', () => {
  it('prefers what the operator actually named the call, and says a human named it', () => {
    expect(
      resolveCallSubject({
        subject: 'ACME Medical Center',
        task: 'You are an assistant...',
      }),
    ).toEqual({ text: 'ACME Medical Center', source: 'operator' });
  });

  it('falls back to the task, and says the fallback is what happened', () => {
    // The SOURCE is the whole point. Version 3a7d4f0c returned this same text
    // with no way to know a machine wrote it, so the console promoted it to the
    // row headline as though the operator had typed it.
    expect(resolveCallSubject({ subject: null, task: 'Ask about the bed.' })).toEqual({
      text: 'Ask about the bed.',
      source: 'derived',
    });
  });

  it('treats a blank subject as absent rather than as an empty operator label', () => {
    expect(resolveCallSubject({ subject: '   ', task: 'Ask about the bed.' })).toEqual({
      text: 'Ask about the bed.',
      source: 'derived',
    });
  });

  it('is null on BOTH halves when there is genuinely nothing to say', () => {
    // A source without a text would be a label with no label; a text without a
    // source is the regression. Neither is representable.
    expect(resolveCallSubject({ subject: null, task: '' })).toEqual({ text: null, source: null });
  });

  it('never reports a source without a text, for any input', () => {
    const inputs = [
      { subject: 'Named', task: 'anything' },
      { subject: null, task: 'Ask about the bed.' },
      { subject: '  ', task: '   ' },
      { subject: null, task: '' },
    ];
    for (const input of inputs) {
      const out = resolveCallSubject(input);
      expect(out.source === null).toBe(out.text === null);
    }
  });
});

describe('the subject survives the R2 round trip', () => {
  it('reaches a list row through custom metadata, with no GET of the body', async () => {
    // The whole point of carrying it in metadata: listCallLog issues one list()
    // and never fetches a record. If the subject only lived in the body, a page
    // of rows would cost a GET per call.
    const fake = createFakeR2();
    const rec = record({ subject: 'ACME Medical Center' });
    await putCallLogRecord(fake.bucket, callLogKey(rec.callId, rec.endedAt), rec);

    const page = await listCallLog(fake.bucket, { limit: 10 });
    expect(page.calls).toHaveLength(1);
    expect(page.calls[0]?.subject).toBe('ACME Medical Center');
    expect(page.calls[0]?.subjectSource).toBe('operator');
  });

  it('gives a subject-less call a derived one, so no row renders unlabelled', async () => {
    const fake = createFakeR2();
    const rec = record({ subject: null, task: 'Ask the clinic about the referral.' });
    await putCallLogRecord(fake.bucket, callLogKey(rec.callId, rec.endedAt), rec);

    const page = await listCallLog(fake.bucket, { limit: 10 });
    expect(page.calls[0]?.subject).toBe('Ask the clinic about the referral.');
    // Tagged, so the renderer can decline to promote it to the headline.
    expect(page.calls[0]?.subjectSource).toBe('derived');
  });

  it('reads an object written before schema 3 as null, not as an empty label', () => {
    // Every object in the real bucket today is in this shape.
    const row = listRowFromObject({
      key: 'calls/2345678901234-abc.json',
      // `to` stays MASKED here on purpose: it is literally what the objects in
      // the real bucket hold. Records written before 2026-08-29 were masked at
      // write time, and removing the mask cannot recover their digits.
      customMetadata: { callId: 'abc', phase: 'completed', to: '+1********23', schema: '2' },
    });
    expect(row.subject).toBeNull();
    expect(row.subjectSource).toBeNull();
  });

  it('reads an EMPTY metadata subject as null too', () => {
    // R2 custom metadata holds strings only, so an absent value arrives as ''.
    // The same trap positiveIntOrNull exists for, one type over.
    const row = listRowFromObject({
      key: 'calls/2345678901234-abc.json',
      customMetadata: { callId: 'abc', subject: '   ' },
    });
    expect(row.subject).toBeNull();
  });

  it('refuses a subject whose author was never recorded', () => {
    // THE EXACT SHAPE OF THE 10 OBJECTS IN THE PRODUCTION BUCKET after version
    // 3a7d4f0c's backfill ran: a derived label sitting in the plain `subject`
    // key with nothing saying a machine wrote it. Handing that to the renderer
    // as a bare string is what buried the number under boilerplate. It reads as
    // "I have nothing" until the backfill restores its provenance.
    const row = listRowFromObject({
      key: 'calls/2345678901234-abc.json',
      customMetadata: {
        callId: 'abc',
        subject: 'You are an assistant placing a call on behalf of the operator.',
        schema: '2',
      },
    });
    expect(row.subject).toBeNull();
    expect(row.subjectSource).toBeNull();
  });

  it('reads an UNRECOGNIZED provenance token as unrecorded, not as a source', () => {
    const row = listRowFromObject({
      key: 'calls/2345678901234-abc.json',
      customMetadata: { callId: 'abc', subject: 'Something', subjectSource: 'wishful' },
    });
    expect(row.subject).toBeNull();
    expect(row.subjectSource).toBeNull();
  });

  it('records provenance even for a call with no subject at all', () => {
    // Otherwise the backfill can never recognize such an object as done and
    // rewrites it on every run while reporting the pass as work.
    const fake = createFakeR2();
    const rec = record({ subject: null, task: '' });
    const key = callLogKey(rec.callId, rec.endedAt);
    return putCallLogRecord(fake.bucket, key, rec).then(() => {
      expect(fake.raw(key)?.customMetadata['subjectSource']).toBe('none');
      const row = listRowFromObject({ key, customMetadata: fake.raw(key)?.customMetadata });
      expect(row.subject).toBeNull();
      expect(row.subjectSource).toBeNull();
    });
  });
});

describe('every projection of a call agrees about what it is called', () => {
  // THE REGRESSION THIS EXISTS FOR: the list route and the detail route once
  // reported two different COSTS for the same call, in production, because each
  // derived its own answer. Four projections describe a call here. If any one of
  // them is added, changed, or replaced and does not carry the subject, this
  // fails rather than shipping a console where a row and its detail panel
  // disagree about which call the operator is looking at.
  const cases: readonly { readonly name: string; readonly state: Partial<CallState> }[] = [
    { name: 'explicit subject', state: { subject: 'ECMC Admissions' } },
    { name: 'derived from task', state: { subject: null } },
  ];

  for (const testCase of cases) {
    it(`list metadata and the archived detail view match (${testCase.name})`, async () => {
      const fake = createFakeR2();
      const rec = record(testCase.state);
      const key = callLogKey(rec.callId, rec.endedAt);
      await putCallLogRecord(fake.bucket, key, rec);

      const listed = (await listCallLog(fake.bucket, { limit: 10 })).calls[0];
      const detail = archivedStatusView(rec);
      const expected = resolveCallSubject(rec);

      expect(expected.text).not.toBeNull();
      expect(listed?.subject).toBe(expected.text);
      expect(detail['subject']).toBe(expected.text);
      // The PAIR has to agree, not just the text. A view that carries the label
      // but drops its author is exactly the state version 3a7d4f0c shipped.
      expect(listed?.subjectSource).toBe(expected.source);
      expect(detail['subjectSource']).toBe(expected.source);
    });
  }

  it('every metadata key the writer stores is actually read by the projection', async () => {
    // Structural, not behavioural: it does not name the fields. Dropping any
    // single key from the stored metadata must change the projected row, which
    // is only true while the write set and the read set correspond. A field
    // added to one side and forgotten on the other fails here, including a
    // field that does not exist yet.
    const fake = createFakeR2();
    const rec = record({ subject: 'ECMC Admissions' });
    const key = callLogKey(rec.callId, rec.endedAt);
    await putCallLogRecord(fake.bucket, key, rec);

    const stored = fake.raw(key)?.customMetadata;
    expect(stored).toBeDefined();
    const full = listRowFromObject({ key, customMetadata: stored });
    // callId is the one legitimate exemption: keys are `calls/<sort>-<id>.json`,
    // so callIdFromKey recovers it with no metadata at all. That fallback is
    // deliberate -- a row whose metadata was lost must still be clickable -- and
    // it makes the stored copy redundant rather than unread.
    const RECOVERABLE_FROM_KEY = new Set(['callId']);
    const inert: string[] = [];
    for (const metaKey of Object.keys(stored as Record<string, string>)) {
      if (RECOVERABLE_FROM_KEY.has(metaKey)) continue;
      const without = { ...(stored as Record<string, string>) };
      delete without[metaKey];
      if (
        JSON.stringify(listRowFromObject({ key, customMetadata: without })) === JSON.stringify(full)
      ) {
        inert.push(metaKey);
      }
    }
    expect(inert).toEqual([]);
  });
});
