// The archive as the Durable Object actually writes it.
//
// test/call-log.test.ts proves the helpers can write a record. This file proves
// the DO CALLS them, at the terminal transition, exactly once per call — which
// is the part that breaks when someone moves the teardown effect or adds a
// second terminal event. The real CallSession class runs here against a fake
// DurableObjectState and a fake R2; only the provider fetch is stubbed.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CALL_LOG_PREFIX,
  type CallLogRecord,
  callLogKey,
  listCallLog,
  readCallLogRecord,
} from '../src/call-log';
import { CallSession } from '../src/call-session';
import type { Env } from '../src/env';
import type { RecordingAsset } from '../src/recordings';
import { type CallEvent, type CallState, initialState } from '../src/state';
import { createFakeDurableObjectState, type FakeDurableObjectState } from './fake-do';
import { createFakeR2, type FakeR2 } from './fake-r2';
import { testEnv } from './test-env';

const CALL_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const T0 = 1_756_000_000_000;

const wavAsset: RecordingAsset = {
  id: 'rec-abc',
  format: 'wav',
  channels: 'dual',
  url: 'https://s3.amazonaws.com/bucket/rec-abc.wav',
  startedAt: null,
  endedAt: null,
};

/** Telnyx command endpoints answer 200; recording downloads answer audio. */
function stubProviderFetch(audio = 'RIFFfake'): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('https://s3.amazonaws.com/')) {
      return new Response(audio, { headers: { 'Content-Length': String(audio.length) } });
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
}

interface Harness {
  readonly session: CallSession;
  readonly r2: FakeR2;
  readonly doState: FakeDurableObjectState;
  send(event: CallEvent): Promise<Response>;
}

async function harness(overrides: Partial<CallState> = {}, env?: Partial<Env>): Promise<Harness> {
  const r2 = createFakeR2();
  const doState = createFakeDurableObjectState();
  const session = new CallSession(doState.ctx, testEnv({ CALL_LOGS: r2.bucket, ...env }));
  const seeded: CallState = {
    ...initialState({
      callId: CALL_ID,
      to: '+14155550123',
      task: 'Ask the clinic about the referral.',
      voice: 'liora',
      amd: null,
      now: T0,
    }),
    phase: 'bridged',
    legA: 'legA-cc',
    legB: 'legB-cc',
    legBAnswered: true,
    xaiSessionReady: true,
    bridgeRequested: true,
    transcript: [{ role: 'assistant', text: 'Hello there.', at: T0 + 1_000 }],
    ...overrides,
  };
  await doState.ctx.storage.put('state', seeded);
  return {
    session,
    r2,
    doState,
    send: (event) =>
      session.fetch(
        new Request('https://do/event', { method: 'POST', body: JSON.stringify(event) }),
      ),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the Durable Object archives a call when it ends', () => {
  it('writes exactly one listable record on the terminal transition', async () => {
    stubProviderFetch();
    const h = await harness();
    expect(h.r2.keys()).toEqual([]);

    await h.send({ type: 'hangup', leg: 'A', cause: 'normal_clearing', at: T0 + 42_000 });
    await h.doState.drain();

    const keys = h.r2.keys().filter((k) => k.startsWith(CALL_LOG_PREFIX));
    expect(keys).toEqual([callLogKey(CALL_ID, T0 + 42_000)]);

    const page = await listCallLog(h.r2.bucket, { limit: 25 });
    expect(page.calls).toHaveLength(1);
    expect(page.calls[0]).toMatchObject({
      callId: CALL_ID,
      phase: 'completed',
      direction: 'outbound',
      durationMs: 42_000,
      transcriptEntries: 1,
    });

    const stored = await readCallLogRecord(h.r2.bucket, keys[0] ?? '');
    expect(stored?.teardownReason).toBe('leg_A_hangup:normal_clearing');
    expect(stored?.transcript).toHaveLength(1);
  });

  it('archives a FAILED call too — the one you most want a log of', async () => {
    stubProviderFetch();
    const h = await harness();
    await h.send({ type: 'failed', reason: 'xai_ws: Error: refused', at: T0 + 9_000 });
    await h.doState.drain();

    const key = callLogKey(CALL_ID, T0 + 9_000);
    const stored = await readCallLogRecord(h.r2.bucket, key);
    expect(stored?.phase).toBe('failed');
    expect(stored?.failureReason).toBe('xai_ws: Error: refused');
  });

  it('IS IDEMPOTENT under a redelivered hangup: one row, one key', async () => {
    stubProviderFetch();
    const h = await harness();
    const event: CallEvent = { type: 'hangup', leg: 'A', cause: 'normal', at: T0 + 42_000 };
    await h.send(event);
    await h.send(event);
    await h.send({ type: 'hangup', leg: 'B', cause: 'normal', at: T0 + 43_000 });
    await h.doState.drain();

    expect(h.r2.keys().filter((k) => k.startsWith(CALL_LOG_PREFIX))).toHaveLength(1);
    const page = await listCallLog(h.r2.bucket, { limit: 25 });
    expect(page.calls).toHaveLength(1);
  });

  it('adds a late recording to the SAME record instead of a second row', async () => {
    // Telnyx saves recordings AFTER the call ends, so the record written at
    // teardown lists none. The rewrite has to reuse the anchored key.
    stubProviderFetch();
    const h = await harness();
    await h.send({ type: 'hangup', leg: 'A', cause: 'normal', at: T0 + 42_000 });
    await h.doState.drain();

    const key = callLogKey(CALL_ID, T0 + 42_000);
    expect((await readCallLogRecord(h.r2.bucket, key))?.recordings).toEqual([]);

    await h.send({ type: 'recording_saved', asset: wavAsset, at: T0 + 55_000 });
    await h.doState.drain();

    expect(h.r2.keys().filter((k) => k.startsWith(CALL_LOG_PREFIX))).toEqual([key]);
    const updated = await readCallLogRecord(h.r2.bucket, key);
    expect(updated?.recordings).toEqual([
      { format: 'wav', channels: 'dual', archivedKey: `recordings/${CALL_ID}/rec-abc.wav` },
    ]);
    // The key stayed pinned to the ORIGINAL end time, not the recording's.
    expect(updated?.endedAt).toBe(T0 + 42_000);
    expect(h.r2.text(`recordings/${CALL_ID}/rec-abc.wav`)).toBe('RIFFfake');
  });

  it('archives recording bytes so playback survives the provider URL expiring', async () => {
    stubProviderFetch('RIFFthe-audio');
    const h = await harness();
    await h.send({ type: 'hangup', leg: 'A', cause: 'normal', at: T0 + 1_000 });
    await h.send({ type: 'recording_saved', asset: wavAsset, at: T0 + 2_000 });
    await h.doState.drain();

    // Now make the provider URL dead, exactly as an expired signature would.
    vi.stubGlobal('fetch', async () => new Response('expired', { status: 403 }));
    const played = await h.session.fetch(new Request('https://do/recording?format=wav'));
    expect(played.status).toBe(200);
    expect(played.headers.get('Content-Type')).toBe('audio/wav');
    expect(await played.text()).toBe('RIFFthe-audio');
  });

  it('still ends the call cleanly when the archive write fails', async () => {
    stubProviderFetch();
    const h = await harness();
    h.r2.failNext('put', 5);
    const response = await h.send({ type: 'hangup', leg: 'A', cause: 'normal', at: T0 + 1_000 });
    await h.doState.drain();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ phase: 'completed' });
  });

  it('is a no-op with no bucket bound, so an unprovisioned environment still calls', async () => {
    stubProviderFetch();
    const r2 = createFakeR2();
    const doState = createFakeDurableObjectState();
    const session = new CallSession(doState.ctx, testEnv());
    await doState.ctx.storage.put('state', {
      ...initialState({
        callId: CALL_ID,
        to: '+14155550123',
        task: 't',
        voice: 'liora',
        amd: null,
        now: T0,
      }),
      phase: 'bridged',
      legA: 'legA-cc',
    });
    const response = await session.fetch(
      new Request('https://do/event', {
        method: 'POST',
        body: JSON.stringify({ type: 'hangup', leg: 'A', cause: 'normal', at: T0 + 1 }),
      }),
    );
    await doState.drain();
    expect(response.status).toBe(200);
    expect(r2.keys()).toEqual([]);
  });

  it('pins the archive key in DO storage before the first write', async () => {
    stubProviderFetch();
    const h = await harness();
    await h.send({ type: 'hangup', leg: 'A', cause: 'normal', at: T0 + 7_000 });
    await h.doState.drain();
    expect(h.doState.peek<{ key: string }>('callLogAnchor')).toMatchObject({
      key: callLogKey(CALL_ID, T0 + 7_000),
      endedAt: T0 + 7_000,
    });
  });

  it('archives an inbound call with the caller in full E.164', async () => {
    stubProviderFetch();
    const h = await harness({
      direction: 'inbound',
      inboundMode: 'follow_me',
      to: '+16075550100',
      forwardAttempted: 2,
      inboundFallbackReason: 'targets_exhausted',
    });
    await h.send({ type: 'hangup', leg: 'A', cause: 'normal', at: T0 + 3_000 });
    await h.doState.drain();

    const key = callLogKey(CALL_ID, T0 + 3_000);
    const stored = (await readCallLogRecord(h.r2.bucket, key)) as CallLogRecord;
    expect(stored.direction).toBe('inbound');
    expect(stored.inboundFallbackReason).toBe('targets_exhausted');
    // Runs the REAL DO teardown path end to end, so it is what proves an
    // unmasked number survives from CallState into the archived record.
    expect(stored.to).toBe('+16075550100');
    expect(h.r2.text(key)).toContain('+16075550100');
  });
});

describe('the archive never claims a recording it does not hold', () => {
  it('records archivedKey null when the provider download fails', async () => {
    // Telnyx told us a recording exists, but the bytes never arrived. The
    // archive has to say so — the signed URL will expire and then there is
    // nothing to play.
    vi.stubGlobal('fetch', async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('https://s3.amazonaws.com/')) return new Response('gone', { status: 403 });
      return new Response('{}', { status: 200 });
    });
    const h = await harness();
    await h.send({ type: 'hangup', leg: 'A', cause: 'normal', at: T0 + 1_000 });
    await h.send({ type: 'recording_saved', asset: wavAsset, at: T0 + 2_000 });
    await h.doState.drain();

    const stored = await readCallLogRecord(h.r2.bucket, callLogKey(CALL_ID, T0 + 1_000));
    expect(stored?.recordings).toEqual([{ format: 'wav', channels: 'dual', archivedKey: null }]);
    expect(h.r2.keys().some((k) => k.startsWith('recordings/'))).toBe(false);
  });
});

describe('the live status names the call the same way the archive does', () => {
  // THE HANDOVER THIS PROTECTS: the console polls the DO while a call runs and
  // the R2 archive once it ends. Those are two different projections of one
  // call. If only the archive carried the subject, the detail panel would show
  // a name during the call and lose it the instant the call completed -- and if
  // only the live one carried it, the reverse. Both, or the console contradicts
  // itself at the exact moment an operator looks for what just happened.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the operator subject for a call in flight', async () => {
    const h = await harness({ subject: 'ACME Medical Center' });
    const res = await h.session.fetch(new Request('https://do/status'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['subject']).toBe('ACME Medical Center');
    expect(body['subjectSource']).toBe('operator');
    expect(body['task']).toBe('Ask the clinic about the referral.');
  });

  it('derives one when the call was started without a subject, and SAYS it derived it', async () => {
    // The live projection was the fourth to carry the subject and would have
    // been the fourth to drop its provenance. Without the tag the detail panel
    // presents a machine summary of the script under the word an operator's own
    // label uses.
    const h = await harness({ subject: null });
    const res = await h.session.fetch(new Request('https://do/status'));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['subject']).toBe('Ask the clinic about the referral.');
    expect(body['subjectSource']).toBe('derived');
  });

  it('agrees with the archived view of the SAME call, before and after teardown', async () => {
    stubProviderFetch();
    const h = await harness({ subject: 'ECMC Admissions' });

    const live = (await (await h.session.fetch(new Request('https://do/status'))).json()) as Record<
      string,
      unknown
    >;
    await h.send({ type: 'hangup', leg: 'A', cause: 'normal', at: T0 + 30_000 });

    const key = h.r2.keys().find((k) => k.startsWith(CALL_LOG_PREFIX));
    expect(key).toBeDefined();
    const stored = (await readCallLogRecord(h.r2.bucket, key as string)) as CallLogRecord;
    const archived = (await listCallLog(h.r2.bucket, { limit: 5 })).calls[0];

    expect(live['subject']).toBe('ECMC Admissions');
    expect(stored.subject).toBe('ECMC Admissions');
    expect(archived?.subject).toBe(live['subject']);
    // The provenance has to survive the handover too, or the row a call is
    // filed into after teardown loses the headline it had while it ran.
    expect(live['subjectSource']).toBe('operator');
    expect(archived?.subjectSource).toBe(live['subjectSource']);
  });
});
