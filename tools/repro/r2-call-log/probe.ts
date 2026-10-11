// End-to-end proof that the SHIPPED src/call-log.ts writes to a REAL R2 bucket.
//
// The unit tests run against an in-memory fake. This runs the exact same
// functions on workerd against open-grok-voice-call-logs, so "the code
// compiles" and "the object lands" are two different claims and this settles
// the second one.
//
//   ./node_modules/.bin/wrangler dev --remote -c tools/repro/r2-call-log/wrangler.toml --port 8799
//   curl -s localhost:8799/ | python3 -m json.tool
//
// NEVER `wrangler deploy` this.
//
// IT WRITES INTO THE PRODUCTION PREFIXES. That is deliberate and unavoidable:
// the whole point is to exercise the SHIPPED callLogKey() and
// recordingObjectKey(), and those return `calls/...` and `recordings/...` by
// definition. Giving the probe its own prefixes would mean testing a
// different function than the one that runs in production.
//
// So it cleans up after itself instead: every key it writes is tracked and
// deleted before it returns, and the response reports `leftBehind` so a
// non-empty array is visible rather than silent. Run it against a bucket you
// are willing to see three transient `probe-*` rows in.

import {
  archiveRecording,
  buildCallLogRecord,
  callLogKey,
  findArchiveKey,
  listCallLog,
  putCallLogRecord,
  readCallLogRecord,
  recordingObjectKey,
} from '../../../src/call-log';
import type { RecordingAsset } from '../../../src/recordings';
import { type CallState, initialState } from '../../../src/state';

interface Env {
  readonly CALL_LOGS: R2Bucket;
}

const T0 = 1_756_000_000_000;

/** A real, length-declaring HTTPS body standing in for a Telnyx signed URL. */
const AUDIO_URL = 'https://speed.cloudflare.com/__down?bytes=2048';

function finished(callId: string, endedAt: number, phase: CallState['phase']): CallState {
  return {
    ...initialState({
      callId,
      to: '+14155550123',
      task: 'Probe: ask the clinic about the referral.',
      voice: 'liora',
      amd: null,
      now: T0,
    }),
    phase,
    updatedAt: endedAt,
    transcript: [{ role: 'assistant', text: 'Probe transcript line.', at: T0 + 1_000 }],
  };
}

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const out: Record<string, unknown> = {};
    const ids = ['probe-oldest', 'probe-middle', 'probe-newest'];
    const ends = [T0 + 10_000, T0 + 70_000, T0 + 130_000];

    // Write OLDEST FIRST, so read order cannot be insertion order.
    const keys: string[] = [];
    for (let i = 0; i < ids.length; i += 1) {
      const state = finished(ids[i] as string, ends[i] as number, i === 1 ? 'failed' : 'completed');
      const record = buildCallLogRecord({
        state,
        teardownReason: 'probe',
        to: '+14155550123',
        endedAt: state.updatedAt,
      });
      const key = callLogKey(record.callId, record.endedAt);
      keys.push(key);
      out[`put:${ids[i]}`] = await putCallLogRecord(env.CALL_LOGS, key, record);
    }
    out['keysWritten'] = keys;

    // The headline: does the console's list read back newest first?
    const page = await listCallLog(env.CALL_LOGS, { limit: 100 });
    const probeRows = page.calls.filter((c) => c.callId.startsWith('probe-'));
    out['listOrder'] = probeRows.map((c) => c.callId);
    out['listRow'] = probeRows[0] ?? null;

    // Resolve a callId with no end time in hand.
    out['findArchiveKey'] = await findArchiveKey(env.CALL_LOGS, 'probe-newest');

    // Full record round trip, including the transcript.
    const back = await readCallLogRecord(env.CALL_LOGS, keys[2] as string);
    out['readBack'] = back
      ? { callId: back.callId, phase: back.phase, to: back.to, transcript: back.transcript }
      : null;
    out['noRawPhoneNumber'] = JSON.stringify(back ?? {}).includes('+14155550123') === false;

    // Recording archival over a real fetch -> real R2 stream.
    const asset: RecordingAsset = {
      id: 'probe-rec-1',
      format: 'wav',
      channels: 'dual',
      url: AUDIO_URL,
      startedAt: null,
      endedAt: null,
    };
    const archivedKey = await archiveRecording(env.CALL_LOGS, asset, 'probe-newest', () => true);
    out['archivedKey'] = archivedKey;
    out['expectedRecordingKey'] = recordingObjectKey('probe-newest', asset);
    const audio = archivedKey ? await env.CALL_LOGS.get(archivedKey) : null;
    out['archivedBytes'] = audio ? (await audio.arrayBuffer()).byteLength : null;

    // Clean up. These keys sit in the same namespace the operator console
    // lists, so leaving them behind would put fake calls in a real call log.
    const written = [...keys, ...(archivedKey ? [archivedKey] : [])];
    await env.CALL_LOGS.delete(written);
    const survivors: string[] = [];
    for (const key of written) {
      if (await env.CALL_LOGS.head(key)) survivors.push(key);
    }
    // Reported, not just logged: a silent cleanup failure is how a probe
    // quietly becomes a data-integrity problem.
    out['deleted'] = written.length - survivors.length;
    out['leftBehind'] = survivors;

    return Response.json(out, { headers: { 'Cache-Control': 'no-store' } });
  },
};
