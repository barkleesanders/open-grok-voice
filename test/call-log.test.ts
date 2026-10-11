// The durable call archive: key scheme, metadata shape, and the R2 round trip.
//
// The key scheme is the load-bearing part. R2 list() is lexicographic ASCENDING
// with no reverse option, so "newest first" is a property of the KEY, not of the
// query — and the only way to prove it is to write calls out of order and read
// the order back. test/fake-r2.ts mirrors semantics measured against the real
// bucket, so these assertions mean what they say.

import { describe, expect, it } from 'vitest';
import {
  archivedStatusView,
  archiveRecording,
  asciiMetadataValue,
  buildCallLogRecord,
  CALL_LOG_PREFIX,
  type CallLogRecord,
  callLogKey,
  findArchiveKey,
  listCallLog,
  listRowFromObject,
  MAX_ARCHIVED_RECORDING_BYTES,
  putCallLogRecord,
  readCallLogRecord,
  recordingObjectKey,
} from '../src/call-log';
import type { RecordingAsset } from '../src/recordings';
import { type CallState, initialState } from '../src/state';
import { createFakeR2 } from './fake-r2';
import { readUtf8 } from './read-utf8';
import { testEnv } from './test-env';

const T0 = 1_756_000_000_000;

function finished(overrides: Partial<CallState> = {}): CallState {
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
    transcript: [{ role: 'assistant', text: 'Hello there.', at: T0 + 1_000 }],
    ...overrides,
  };
}

function record(state: CallState = finished(), reason = 'leg_A_hangup:normal'): CallLogRecord {
  return buildCallLogRecord({
    state,
    teardownReason: reason,
    to: '+14155550123',
    endedAt: state.updatedAt,
  });
}

const wavAsset: RecordingAsset = {
  id: 'rec-abc',
  format: 'wav',
  channels: 'dual',
  url: 'https://s3.amazonaws.com/bucket/rec-abc.wav',
  startedAt: null,
  endedAt: null,
};

describe('call-log key scheme', () => {
  it('SORTS NEWEST FIRST under a lexicographic ascending list', () => {
    // R2 offers no reverse, so if this inverts the archive reads oldest-first
    // and the console's first page is the least useful one.
    const older = callLogKey('call-old', T0);
    const newer = callLogKey('call-new', T0 + 60_000);
    expect([older, newer].sort()).toEqual([newer, older]);
  });

  it('keeps a fixed-width sort field so lexicographic order equals numeric order', () => {
    const sortFields = [T0, T0 + 1, T0 + 10 ** 9, 0, 1].map((at) => {
      const key = callLogKey('c', at);
      return key.slice(CALL_LOG_PREFIX.length).split('-')[0] ?? '';
    });
    for (const field of sortFields) expect(field).toHaveLength(13);
    // A shorter field would sort '999' after '1000'; equal width rules it out.
    expect(new Set(sortFields.map((f) => f.length)).size).toBe(1);
  });

  it('clamps a nonsense end time instead of emitting a negative or NaN key', () => {
    expect(callLogKey('c', Number.NaN)).toMatch(/^calls\/\d{13}-c\.json$/);
    expect(callLogKey('c', -1)).toMatch(/^calls\/\d{13}-c\.json$/);
    expect(callLogKey('c', Number.MAX_SAFE_INTEGER)).toMatch(/^calls\/0{13}-c\.json$/);
  });
});

describe('recording object keys', () => {
  it('flattens the fallback id so a URL cannot fabricate directory levels', () => {
    // recordingAssetFromWebhook falls back to `${format}:${url}` when Telnyx
    // omits recording_id; that string carries ':' and '/'.
    const fallback: RecordingAsset = {
      ...wavAsset,
      id: 'wav:https://s3.amazonaws.com/bucket/deep/path/rec-9.wav',
    };
    const key = recordingObjectKey('call-1', fallback);
    expect(key.startsWith('recordings/call-1/')).toBe(true);
    expect(key.slice('recordings/call-1/'.length)).not.toContain('/');
    expect(key.endsWith('.wav')).toBe(true);
  });

  it('bounds key length and never emits an empty name segment', () => {
    const long = recordingObjectKey('call-1', { ...wavAsset, id: 'x'.repeat(500) });
    expect(long.length).toBeLessThan(200);
    const empty = recordingObjectKey('call-1', { ...wavAsset, id: '///:::' });
    expect(empty).toBe('recordings/call-1/recording.wav');
  });
});

describe('custom metadata sanitation', () => {
  it('strips control bytes and non-ASCII while keeping ordinary text', () => {
    expect(asciiMetadataValue('+14155550123')).toBe('+14155550123');
    // Written as escapes on purpose: literal control bytes in a source file
    // make git treat it as binary, and an unreviewable test is not a test.
    expect(asciiMetadataValue('caf\u00e9 \u2014 Ren\u00e9e \u{1F4DE}')).toBe('caf  Rene ');
    expect(asciiMetadataValue('a\u0000b\u001Fc')).toBe('abc');
  });

  it('bounds length so one carrier-supplied field cannot fill the metadata budget', () => {
    expect(asciiMetadataValue('z'.repeat(10_000))).toHaveLength(120);
  });
});

describe('archive round trip through R2', () => {
  it('writes a listable row and reads the record back', async () => {
    const fake = createFakeR2();
    const rec = record();
    const key = callLogKey(rec.callId, rec.endedAt);
    await expect(putCallLogRecord(fake.bucket, key, rec)).resolves.toBe(true);

    const page = await listCallLog(fake.bucket, { limit: 25 });
    expect(page.calls).toHaveLength(1);
    expect(page.calls[0]).toMatchObject({
      callId: rec.callId,
      phase: 'completed',
      direction: 'outbound',
      to: '+14155550123',
      endedAt: rec.endedAt,
      durationMs: 42_000,
      transcriptEntries: 1,
    });
    expect(page.cursor).toBeNull();

    const back = await readCallLogRecord(fake.bucket, key);
    expect(back?.transcript).toEqual(rec.transcript);
    expect(back?.task).toBe('Ask the clinic about the referral.');
  });

  it('archives the FULL phone number, in the body and in the list metadata', async () => {
    // THE INVERSION THIS PINS. Until 2026-08-29 this test asserted the exact
    // opposite -- that a full E.164 never reached the archive -- and it was
    // the guard holding masking in place. The operator asked for masking to be
    // removed everywhere, logs included, having been shown the trade-off.
    // Kept as an assertion rather than deleted, because a silently-restored
    // mask would otherwise look identical to a passing suite.
    const fake = createFakeR2();
    const rec = record();
    await putCallLogRecord(fake.bucket, callLogKey(rec.callId, rec.endedAt), rec);
    const body = fake.text(callLogKey(rec.callId, rec.endedAt)) ?? '';
    expect(body).toContain('+14155550123');
    expect(body).not.toContain('*');
    const meta = fake.raw(callLogKey(rec.callId, rec.endedAt))?.customMetadata ?? {};
    expect(meta['to']).toBe('+14155550123');
  });

  it('lists newest first across pages and resumes on the cursor', async () => {
    const fake = createFakeR2();
    // Written OLDEST FIRST so insertion order cannot be mistaken for sort order.
    for (let i = 0; i < 5; i += 1) {
      const state = finished({
        callId: `call-${i}`,
        updatedAt: T0 + i * 60_000,
      });
      const rec = record(state);
      await putCallLogRecord(fake.bucket, callLogKey(rec.callId, rec.endedAt), rec);
    }
    const first = await listCallLog(fake.bucket, { limit: 2 });
    expect(first.calls.map((c) => c.callId)).toEqual(['call-4', 'call-3']);
    expect(first.cursor).not.toBeNull();

    const second = await listCallLog(fake.bucket, {
      limit: 2,
      cursor: first.cursor ?? undefined,
    });
    expect(second.calls.map((c) => c.callId)).toEqual(['call-2', 'call-1']);
  });

  it('IS IDEMPOTENT: rewriting the same key updates the row instead of adding one', async () => {
    const fake = createFakeR2();
    const rec = record();
    const key = callLogKey(rec.callId, rec.endedAt);
    await putCallLogRecord(fake.bucket, key, rec);
    await putCallLogRecord(fake.bucket, key, {
      ...rec,
      recordings: [{ format: 'wav', channels: 'dual', archivedKey: 'recordings/x/y.wav' }],
    });
    expect(fake.putCount()).toBe(2);
    const page = await listCallLog(fake.bucket, { limit: 25 });
    expect(page.calls).toHaveLength(1);
    expect((await readCallLogRecord(fake.bucket, key))?.recordings).toHaveLength(1);
  });

  it('reports a failed write instead of throwing into the teardown path', async () => {
    const fake = createFakeR2();
    fake.failNext('put', 1);
    const rec = record();
    await expect(
      putCallLogRecord(fake.bucket, callLogKey(rec.callId, rec.endedAt), rec),
    ).resolves.toBe(false);
  });

  it('degrades a row whose metadata predates a newer reader', () => {
    const row = listRowFromObject({
      key: 'calls/2346444800000-aaaaaaaa-1111-4111-8111-111111111111.json',
    });
    expect(row.callId).toBe('aaaaaaaa-1111-4111-8111-111111111111');
    expect(row.phase).toBe('unknown');
    expect(row.direction).toBe('unknown');
    expect(row.endedAt).toBeNull();
  });

  it('rejects a bogus phase or direction rather than echoing it to the console', () => {
    const row = listRowFromObject({
      key: 'calls/2346444800000-c.json',
      customMetadata: { callId: 'c', phase: 'not-a-phase', direction: 'sideways' },
    });
    expect(row.phase).toBe('unknown');
    expect(row.direction).toBe('unknown');
  });
});

describe('resolving a callId back to its archive', () => {
  it('finds the key without knowing the end time', async () => {
    const fake = createFakeR2();
    const rec = record();
    const key = callLogKey(rec.callId, rec.endedAt);
    await putCallLogRecord(fake.bucket, key, rec);
    await expect(findArchiveKey(fake.bucket, rec.callId)).resolves.toBe(key);
    await expect(findArchiveKey(fake.bucket, 'never-called')).resolves.toBeNull();
  });

  it('projects the archive into the shape the live status endpoint returns', () => {
    const view = archivedStatusView({
      ...record(),
      recordings: [{ format: 'wav', channels: 'dual', archivedKey: 'recordings/a/b.wav' }],
    });
    expect(view['phase']).toBe('completed');
    expect(view['archived']).toBe(true);
    expect(view['monitoring']).toMatchObject({ available: false });
    expect(view['recordings']).toEqual([{ format: 'wav', channels: 'dual', available: true }]);
  });
});

describe('recording archival', () => {
  const env = testEnv();

  it('copies provider bytes into R2 under a per-call key', async () => {
    const fake = createFakeR2();
    const audio = 'RIFFfake-wav-bytes';
    const fetchImpl = async (): Promise<Response> =>
      new Response(audio, { headers: { 'Content-Length': String(audio.length) } });
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl as typeof fetch;
    try {
      const key = await archiveRecording(fake.bucket, wavAsset, 'call-1', () => true);
      expect(key).toBe('recordings/call-1/rec-abc.wav');
      expect(fake.text(key ?? '')).toBe(audio);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('refuses a URL outside the recording host allowlist', async () => {
    const fake = createFakeR2();
    const evil: RecordingAsset = { ...wavAsset, url: 'https://evil.example/a.wav' };
    let fetched = false;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response('nope');
    }) as typeof fetch;
    try {
      const guard = (url: string): boolean => url.startsWith('https://s3.amazonaws.com/');
      await expect(archiveRecording(fake.bucket, evil, 'call-1', guard)).resolves.toBeNull();
      expect(fetched).toBe(false);
      expect(fake.keys()).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
    // The real guard must reach the same verdict from the real env.
    expect(env.RECORDING_HOST_ALLOWLIST).toBeUndefined();
  });

  it('skips an oversized or length-less body rather than buffering it', async () => {
    const fake = createFakeR2();
    const original = globalThis.fetch;

    globalThis.fetch = (async () =>
      new Response('x', {
        headers: { 'Content-Length': String(MAX_ARCHIVED_RECORDING_BYTES + 1) },
      })) as typeof fetch;
    await expect(archiveRecording(fake.bucket, wavAsset, 'call-1', () => true)).resolves.toBeNull();

    globalThis.fetch = (async () => new Response(new ReadableStream())) as typeof fetch;
    await expect(archiveRecording(fake.bucket, wavAsset, 'call-1', () => true)).resolves.toBeNull();

    globalThis.fetch = original;
    expect(fake.keys()).toEqual([]);
  });

  it('does not re-download audio it has already archived', async () => {
    const fake = createFakeR2();
    let calls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response('bytes', { headers: { 'Content-Length': '5' } });
    }) as typeof fetch;
    try {
      await archiveRecording(fake.bucket, wavAsset, 'call-1', () => true);
      await archiveRecording(fake.bucket, wavAsset, 'call-1', () => true);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('workerd fetch constraints (found by probing the real bucket)', () => {
  // redirect:'error' is NOT implemented in workerd — it throws a TypeError at
  // the call, so both the archive and the playback proxy were silent no-ops
  // until 2026-08-28. Node's fetch DOES implement it, which is precisely why no
  // unit test caught it. This structural check is the guard against a rewrite
  // reintroducing it, because a behavioural test here would pass either way.
  it('never asks for redirect:"error" anywhere in the Worker source', () => {
    const sources = ['../src/call-log.ts', '../src/call-session.ts', '../src/index.ts'];
    for (const rel of sources) {
      // Strip comments first: the explanation of this very trap names the
      // forbidden option, and a check that its own documentation trips is a
      // check nobody keeps.
      const code = readUtf8(import.meta.url, rel)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(code, `${rel} passes redirect:'error', which throws on workerd`).not.toMatch(
        /redirect:\s*['"]error['"]/,
      );
    }
  });

  it('refuses a redirected provider response instead of following it off-host', async () => {
    const fake = createFakeR2();
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 302,
        headers: { Location: 'https://evil.example/a.wav', 'Content-Length': '10' },
      })) as typeof fetch;
    try {
      await expect(
        archiveRecording(fake.bucket, wavAsset, 'call-1', () => true),
      ).resolves.toBeNull();
      expect(fake.keys()).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('a recording is reported available only if its bytes are really stored', () => {
  // The first version of this derived archivedKey from recordingObjectKey()
  // alone, which always returns a string — so `available` was unconditionally
  // true even when archiveRecording() had returned null and nothing was in R2.
  // A play button that lies about a recording it cannot fetch is worse than one
  // that admits the gap, because the gap is recoverable and the lie is not.
  const withRecording = finished({
    recordings: [wavAsset],
  });
  const expectedKey = recordingObjectKey(withRecording.callId, wavAsset);

  it('reports null when the archive attempt did not land', () => {
    const rec = buildCallLogRecord({
      state: withRecording,
      teardownReason: 'x',
      to: '+14155550123',
      endedAt: withRecording.updatedAt,
      archivedKeys: [],
    });
    expect(rec.recordings).toEqual([{ format: 'wav', channels: 'dual', archivedKey: null }]);
    expect(archivedStatusView(rec)['recordings']).toEqual([
      { format: 'wav', channels: 'dual', available: false },
    ]);
  });

  it('reports the key once the bytes are confirmed stored', () => {
    const rec = buildCallLogRecord({
      state: withRecording,
      teardownReason: 'x',
      to: '+14155550123',
      endedAt: withRecording.updatedAt,
      archivedKeys: [expectedKey],
    });
    expect(rec.recordings).toEqual([{ format: 'wav', channels: 'dual', archivedKey: expectedKey }]);
    expect(archivedStatusView(rec)['recordings']).toEqual([
      { format: 'wav', channels: 'dual', available: true },
    ]);
  });
});

// Schema 5: the archive records the recording DECISION, not only the outcome.
//
// `recorded` has always answered "was audio kept". It cannot answer "was anyone
// told" or "did the operator choose this", and those are the questions an audit
// actually asks. The failure this block guards is not a dropped field -- it is a
// CONFIDENT DEFAULT standing in for a value nobody wrote down.
describe('the archive records the recording decision, not just the outcome', () => {
  it('carries the operator choice onto the record', () => {
    const rec = record(finished({ recordingMode: 'off', noticeEnabled: false }));
    expect(rec.schema).toBe(5);
    expect(rec.recordingMode).toBe('off');
    expect(rec.noticeEnabled).toBe(false);
  });

  it('round-trips a notice that was switched OFF as FALSE, not as unknown', async () => {
    // The one that bites. R2 metadata is strings, so the obvious `x ? '1':'0'`
    // and the obvious `meta[x] === '1'` both turn "off" and "never written" into
    // the same value -- and the record then asserts the notice was off about
    // every call archived before this field existed.
    const fake = createFakeR2();
    const rec = record(finished({ recordingMode: 'on_demand', noticeEnabled: false }));
    const key = callLogKey(rec.callId, rec.endedAt);
    await putCallLogRecord(fake.bucket, key, rec);
    const page = await listCallLog(fake.bucket, { limit: 10 });
    expect(page.calls).toHaveLength(1);
    expect(page.calls[0]?.noticeEnabled).toBe(false);
    expect(page.calls[0]?.recordingMode).toBe('on_demand');
  });

  it('round-trips a notice that was ON as TRUE', async () => {
    const fake = createFakeR2();
    const rec = record(finished({ recordingMode: 'auto', noticeEnabled: true }));
    await putCallLogRecord(fake.bucket, callLogKey(rec.callId, rec.endedAt), rec);
    const page = await listCallLog(fake.bucket, { limit: 10 });
    expect(page.calls[0]?.noticeEnabled).toBe(true);
    expect(page.calls[0]?.recordingMode).toBe('auto');
  });

  it('reads a PRE-SCHEMA-5 object as unknown — never as a default', () => {
    // 14 records were in the real bucket when this shipped, all of them written
    // by code where recording was unconditional. 'auto' would even have been
    // TRUE for all 14. It is still not what this must return: a call completing
    // between that measurement and the deploy would be a schema-4 record whose
    // real mode was on_demand, and nothing in the object could tell them apart.
    const row = listRowFromObject({
      key: 'calls/0000000000000-aaaaaaaa-1111-4111-8111-111111111111.json',
      customMetadata: { callId: 'c1', phase: 'completed', schema: '4', recorded: '1' },
    });
    expect(row.recordingMode).toBeNull();
    expect(row.noticeEnabled).toBeNull();
    // Stated as its own assertion because null-vs-default is the whole point.
    expect(row.recordingMode).not.toBe('auto');
    expect(row.noticeEnabled).not.toBe(true);
    expect(row.noticeEnabled).not.toBe(false);
    // The OUTCOME is still known for an old record. Only the decision is not.
    expect(row.recorded).toBe(true);
  });

  it('does not stamp a decision onto a legacy record it rewrites', async () => {
    // THE BACKFILL PATH, and the reason the writer spells out `=== undefined`
    // instead of `? '1' : '0'`. The subject backfill rewrites an old object's
    // metadata FROM ITS BODY. A schema-4 body has no noticeEnabled, so the
    // naive encoding would write '0' and the archive would then assert, in
    // durable storage, that a call whose notice setting was never recorded had
    // the notice OFF. That is manufacturing evidence, not defaulting.
    const legacy: CallLogRecord = {
      ...record(),
      schema: 4,
      recordingMode: undefined,
      noticeEnabled: undefined,
    };
    const fake = createFakeR2();
    await putCallLogRecord(fake.bucket, callLogKey(legacy.callId, legacy.endedAt), legacy);
    const page = await listCallLog(fake.bucket, { limit: 10 });
    expect(page.calls[0]?.noticeEnabled).toBeNull();
    expect(page.calls[0]?.recordingMode).toBeNull();
  });

  it('refuses a recording mode it does not recognise', () => {
    // Metadata is a string map other writers touch. An unrecognised value is
    // unknown, never a mode the rest of the code will branch on.
    const row = listRowFromObject({
      key: 'calls/0000000000000-bbbbbbbb-2222-4222-8222-222222222222.json',
      customMetadata: { recordingMode: 'always', noticeEnabled: 'yes' },
    });
    expect(row.recordingMode).toBeNull();
    expect(row.noticeEnabled).toBeNull();
  });
});
