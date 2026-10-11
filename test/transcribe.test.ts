import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { app } from '../src/index';
import {
  audioTypeAccepted,
  MAX_AUDIO_SECONDS,
  TRANSCRIBE_MODEL,
  type TranscriptionRunner,
  transcribeAudio,
} from '../src/transcribe';
import { testEnv } from './test-env';

interface RecordedCall {
  readonly model: string;
  readonly inputs: Ai_Cf_Openai_Whisper_Large_V3_Turbo_Input;
}

/** A runner that records what it was asked and replies with a scripted output. */
function fakeRunner(reply: Ai_Cf_Openai_Whisper_Large_V3_Turbo_Output | Error): {
  runner: TranscriptionRunner;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const runner: TranscriptionRunner = {
    async run(model, inputs) {
      calls.push({ model, inputs });
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return { runner, calls };
}

function output(text: string, duration: number): Ai_Cf_Openai_Whisper_Large_V3_Turbo_Output {
  return { text, word_count: text.split(' ').length, transcription_info: { duration } };
}

describe('audio type allowlist', () => {
  it('accepts what browsers actually record, parameters and all', () => {
    // Chrome MediaRecorder reports audio/webm;codecs=opus and Safari audio/mp4;
    // both were confirmed to decode on the live model (2026-08-28).
    expect(audioTypeAccepted('audio/webm;codecs=opus')).toBe(true);
    expect(audioTypeAccepted('audio/webm')).toBe(true);
    expect(audioTypeAccepted('audio/mp4')).toBe(true);
    expect(audioTypeAccepted('AUDIO/WAV')).toBe(true);
    expect(audioTypeAccepted('audio/ogg; codecs=opus')).toBe(true);
  });

  it('rejects everything else, including a missing type', () => {
    for (const type of [
      null,
      '',
      'application/json',
      'text/html',
      'video/mp4',
      'audio',
      'image/png',
    ]) {
      expect(audioTypeAccepted(type), String(type)).toBe(false);
    }
  });
});

describe('transcribeAudio', () => {
  it('sends base64 audio with vad_filter ON', async () => {
    // vad_filter is a CORRECTNESS requirement, not tuning. Measured against
    // the live model 2026-08-28: with it off, two seconds of pure silence
    // transcribes as "Thank you." and a 0.15s blip as "You", both reported as
    // success. That invented text would be pasted into the box that dials a
    // real number, so the filter must never be dropped.
    const { runner, calls } = fakeRunner(output('hello there', 2));
    await transcribeAudio(runner, new Uint8Array([1, 2, 3, 4]));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe(TRANSCRIBE_MODEL);
    const inputs = calls[0]?.inputs;
    if (typeof inputs !== 'object' || inputs === null) throw new Error('expected object inputs');
    expect(inputs.vad_filter).toBe(true);
    expect(inputs.task).toBe('transcribe');
    expect(inputs.audio).toBe(btoa(String.fromCharCode(1, 2, 3, 4)));
  });

  it('base64-encodes correctly past the chunk boundary', async () => {
    // The encoder walks the buffer in 0x8000 slices to avoid a spread of
    // hundreds of thousands of arguments; an off-by-one there would corrupt
    // every recording longer than about a second.
    const bytes = new Uint8Array(0x8000 * 2 + 7);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 256;
    const { runner, calls } = fakeRunner(output('long', 5));
    await transcribeAudio(runner, bytes);
    const inputs = calls[0]?.inputs;
    if (typeof inputs !== 'object' || inputs === null) throw new Error('expected object inputs');
    expect(inputs.audio).toBe(Buffer.from(bytes).toString('base64'));
  });

  it('returns the trimmed transcript with its duration', async () => {
    const { runner } = fakeRunner(output('  call the dentist  ', 4.6));
    await expect(transcribeAudio(runner, new Uint8Array([1]))).resolves.toEqual({
      ok: true,
      text: 'call the dentist',
      durationSeconds: 4.6,
    });
  });

  it('reports no_speech rather than pasting an empty string', async () => {
    // What the live model returns for silence WITH vad_filter on: empty text.
    const { runner } = fakeRunner(output('', 2));
    await expect(transcribeAudio(runner, new Uint8Array([1]))).resolves.toEqual({
      ok: false,
      reason: 'no_speech',
    });
  });

  it('treats whitespace-only output as no speech too', async () => {
    const { runner } = fakeRunner(output('   ', 2));
    await expect(transcribeAudio(runner, new Uint8Array([1]))).resolves.toEqual({
      ok: false,
      reason: 'no_speech',
    });
  });

  it('rejects a recording longer than the cap', async () => {
    const { runner } = fakeRunner(output('a very long monologue', MAX_AUDIO_SECONDS + 1));
    await expect(transcribeAudio(runner, new Uint8Array([1]))).resolves.toEqual({
      ok: false,
      reason: 'too_long',
      durationSeconds: MAX_AUDIO_SECONDS + 1,
    });
  });

  it('turns a model failure into model_error instead of throwing', async () => {
    // Undecodable bytes surface here: the live model answers "Failed to decode
    // audio file" with code 3030 rather than an empty transcription.
    const { runner } = fakeRunner(new Error('AiError: Failed to decode audio file.'));
    await expect(transcribeAudio(runner, new Uint8Array([1]))).resolves.toEqual({
      ok: false,
      reason: 'model_error',
    });
  });
});

describe('transcribe route', () => {
  async function post(init: RequestInit, env: Env = testEnv()): Promise<Response> {
    return app.fetch(
      new Request('https://bridge.example.test/api/console/transcribe', {
        method: 'POST',
        ...init,
      }),
      env,
    );
  }

  it('rejects an anonymous caller before touching Workers AI', async () => {
    const { runner, calls } = fakeRunner(output('should never run', 1));
    const response = await post(
      { headers: { 'Content-Type': 'audio/webm' }, body: new Uint8Array([1, 2, 3]) },
      testEnv({ AI: runner }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(calls).toHaveLength(0);
  });

  it('never answers 500 when the AI binding is absent', async () => {
    const response = await post({
      headers: { 'Content-Type': 'audio/webm' },
      body: new Uint8Array([1, 2, 3]),
    });
    expect([401, 503]).toContain(response.status);
  });
});
