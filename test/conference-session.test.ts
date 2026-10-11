// The join notice as the Durable Object actually performs it.
//
// test/conference.test.ts proves the reducer emits the effect and the client
// builds the right body. This proves the DO CALLS them: that the notice goes out
// in the CALL'S OWN agent voice, and that what was heard on the call ends up in
// the record. The real CallSession runs here against a fake DurableObjectState;
// only the provider fetch is stubbed.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallSession } from '../src/call-session';
import { participantJoinNotice } from '../src/instructions';
import { type CallEvent, type CallState, initialState, type Participant } from '../src/state';
import { FALLBACK_NOTICE_VOICE } from '../src/telnyx';
import { createFakeDurableObjectState, type FakeDurableObjectState } from './fake-do';
import { testEnv } from './test-env';

const CALL_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const T0 = 1_756_000_000_000;

interface Sent {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

/**
 * Stub every provider call, recording each one.
 *
 * `ttsFails` and `speakFails` exist to test the path that MATTERS most for
 * honesty: when the announcement does not go out, the transcript must not claim
 * it did. They are separate because the two paths fail independently -- the
 * render path failing is survivable, both failing is not.
 */
function stubProviderFetch(
  sent: Sent[],
  opts: { speakFails?: boolean; ttsFails?: boolean } = {},
): void {
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      const raw = init?.body;
      // The media upload is multipart, not JSON, so a string-only reader would
      // record it as {} and every assertion about media_name would pass
      // vacuously.
      let body: Record<string, unknown> = {};
      if (typeof raw === 'string') {
        body = JSON.parse(raw) as Record<string, unknown>;
      } else if (raw instanceof FormData) {
        for (const [k, v] of raw.entries()) {
          body[k] = typeof v === 'string' ? v : `<blob:${(v as Blob).size}>`;
        }
      }
      sent.push({ url, body });
      if (url.endsWith('/text-to-speech/speech')) {
        if (opts.ttsFails) {
          return new Response(JSON.stringify({ errors: [{ detail: 'voice not found' }] }), {
            status: 400,
          });
        }
        // Real bytes, not '{}': synthesizeSpeech rejects a 0-byte 200, and a
        // JSON stub would let a broken audio path look healthy.
        return new Response(new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]), {
          status: 200,
          headers: { 'Content-Type': 'audio/mpeg' },
        });
      }
      if (opts.speakFails && url.endsWith('/actions/speak')) {
        return new Response(JSON.stringify({ errors: [{ detail: 'voice not found' }] }), {
          status: 422,
        });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  );
}

function joinedParticipant(): Participant {
  return {
    pid: 'p0',
    to: '+14155550199',
    label: 'Supervisor',
    legId: 'legP0-cc',
    // 'dialing', not 'joined': the participant_joined event below is what must
    // do the promoting. Seeding it as already joined would make the reducer's
    // duplicate guard swallow the event and the test would assert nothing.
    status: 'dialing',
    answeredAt: T0 + 10,
    joinedAt: null,
    leftAt: null,
    muted: false,
    held: false,
    supervisorRole: 'barge',
  };
}

interface Harness {
  readonly doState: FakeDurableObjectState;
  send(event: CallEvent): Promise<Response>;
}

async function harness(overrides: Partial<CallState> = {}): Promise<Harness> {
  const doState = createFakeDurableObjectState();
  const session = new CallSession(doState.ctx, testEnv());
  const seeded: CallState = {
    ...initialState({
      callId: CALL_ID,
      to: '+14155550123',
      task: 'Ask the clinic about the referral.',
      // The agent voice the notice must be spoken in.
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
    conferenceId: 'conf-1',
    participants: [joinedParticipant()],
    ...overrides,
  };
  await doState.ctx.storage.put('state', seeded);
  return {
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

describe('the Durable Object performs the join notice', () => {
  it('renders the notice in the call’s OWN voice and plays it to everyone', async () => {
    const sent: Sent[] = [];
    stubProviderFetch(sent);
    const h = await harness();
    await h.send({ type: 'participant_joined', pid: 'p0', at: T0 + 20 });

    const tts = sent.find((r) => r.url.endsWith('/text-to-speech/speech'));
    expect(tts, 'the DO never rendered the notice').toBeDefined();
    // The call's voice is 'liora'. `speak` cannot say liora (422, measured) --
    // the TTS endpoint can, which is the entire reason for this path.
    expect(tts?.body['voice']).toBe('xAI.liora');
    expect(tts?.body['text']).toBe(participantJoinNotice('Supervisor', false));

    const upload = sent.find((r) => r.url.endsWith('/v2/media'));
    expect(upload, 'the DO never uploaded the rendered audio').toBeDefined();
    expect(String(upload?.body['media'])).toMatch(/^<blob:[1-9]/);

    const play = sent.find((r) => r.url.endsWith('/conferences/conf-1/actions/play'));
    expect(play, 'the DO never played the notice').toBeDefined();
    // The played name must be the UPLOADED name. A mismatch plays nothing at
    // all, and every other assertion here would still pass.
    expect(play?.body['media_name']).toBe(upload?.body['media_name']);
    // Omitted => Telnyx plays it to ALL participants, which is the point of a
    // recording notice.
    expect(play?.body).not.toHaveProperty('call_control_ids');
    // And the broken command is not issued at all when the good path works.
    expect(sent.find((r) => r.url.endsWith('/actions/speak'))).toBeUndefined();
  });

  it('records the notice in the transcript, because nothing else can', async () => {
    const sent: Sent[] = [];
    stubProviderFetch(sent);
    const h = await harness();
    await h.send({ type: 'participant_joined', pid: 'p0', at: T0 + 20 });

    const state = h.doState.peek<CallState>('state');
    const system = state?.transcript.filter((entry) => entry.role === 'system') ?? [];
    // Carrier-side TTS never travels over the xAI socket, so no
    // response.output_audio_transcript.done will ever carry these words. Without
    // this the record would show a participant joining in total silence -- and
    // since the notice is now spoken in the AGENT'S voice, a reader would hear
    // the agent say something the transcript does not contain.
    expect(system).toHaveLength(1);
    expect(system[0]?.text).toBe(participantJoinNotice('Supervisor', false));
    expect(system[0]?.at).toBeGreaterThanOrEqual(T0);
  });

  it('falls back to `speak` when the render path fails', async () => {
    const sent: Sent[] = [];
    stubProviderFetch(sent, { ttsFails: true });
    const h = await harness();
    await h.send({ type: 'participant_joined', pid: 'p0', at: T0 + 20 });

    const speak = sent.find((r) => r.url.endsWith('/conferences/conf-1/actions/speak'));
    expect(speak, 'the DO gave up instead of falling back').toBeDefined();
    // NOT xAI.liora -- that is the 422 this whole change exists to stop. The
    // fallback must send a voice `speak` actually accepts.
    expect(speak?.body['voice']).toBe(FALLBACK_NOTICE_VOICE);
    // A consent notice in a house voice still went out, so the record may
    // claim it.
    const state = h.doState.peek<CallState>('state');
    expect(state?.transcript.filter((e) => e.role === 'system')).toHaveLength(1);
  });

  it('does NOT claim a notice when BOTH paths fail', async () => {
    const sent: Sent[] = [];
    stubProviderFetch(sent, { ttsFails: true, speakFails: true });
    const h = await harness();
    await h.send({ type: 'participant_joined', pid: 'p0', at: T0 + 20 });

    const state = h.doState.peek<CallState>('state');
    // The transcript says what was HEARD. Nothing was.
    expect(state?.transcript.filter((entry) => entry.role === 'system')).toHaveLength(0);
    // But the call survives: a rejected voice costs the notice, never the call.
    expect(state?.phase).toBe('bridged');
    expect(state?.participants[0]?.status).toBe('joined');
  });
});
