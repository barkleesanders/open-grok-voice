// Operator speech-to-text, run on Cloudflare Workers AI.
//
// The console records a short clip in the browser and posts the raw bytes
// here; the transcript goes into the operator's task box. Audio is never
// stored — it exists only for the life of this request.

import { errText, log } from './log';

/**
 * Model. Chosen over `@cf/openai/whisper` because that model's input type is
 * `{ audio: number[] }` — a JSON array with one element per BYTE, which for a
 * 20 KB clip is a ~100 KB array to serialise on the hot path. This model takes
 * a base64 string. `whisper-tiny-en` is smaller but English-only and less
 * accurate; the Deepgram models are built for streaming, which this is not.
 */
export const TRANSCRIBE_MODEL = '@cf/openai/whisper-large-v3-turbo';

/**
 * Byte ceiling on an upload, enforced before the model is called.
 *
 * This is also the DURATION guard that can be applied up front: duration is
 * not knowable without decoding, so bytes stand in for it here and the real
 * duration is checked against MAX_AUDIO_SECONDS once the model reports it.
 * 8 MiB is roughly two orders of magnitude above a two-minute Opus clip, so
 * it bounds abuse without rejecting a legitimate recording from a browser
 * that picked a fat codec.
 */
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

/** Ceiling on decoded audio length. The console stops recording at this too. */
export const MAX_AUDIO_SECONDS = 120;

/**
 * Container types accepted from the browser.
 *
 * Chrome's MediaRecorder emits `audio/webm;codecs=opus` and Safari's emits
 * `audio/mp4`; both were confirmed to decode correctly (2026-08-28) by sending
 * real recordings of each to this model. The rest are here because the same
 * decoder handles them and a browser may legitimately choose one.
 */
const ALLOWED_AUDIO_TYPES: ReadonlySet<string> = new Set([
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/flac',
]);

/** Strip codec parameters: `audio/webm;codecs=opus` -> `audio/webm`. */
export function audioTypeAccepted(contentType: string | null): boolean {
  if (!contentType) return false;
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return ALLOWED_AUDIO_TYPES.has(base);
}

export type TranscribeResult =
  | { readonly ok: true; readonly text: string; readonly durationSeconds: number }
  /** Decoded fine, but contained no speech. Distinct from a failure. */
  | { readonly ok: false; readonly reason: 'no_speech' }
  /** Decoded fine and ran too long. */
  | { readonly ok: false; readonly reason: 'too_long'; readonly durationSeconds: number }
  /** The model rejected or could not decode the bytes. */
  | { readonly ok: false; readonly reason: 'model_error' };

/** Base64-encode without building a megabyte-long argument list. */
function base64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Transcribe one recording.
 *
 * `vad_filter: true` is NOT tuning — it is required for correctness. Measured
 * against the live model on 2026-08-28: with the filter off, two seconds of
 * pure silence transcribes as "Thank you." and a 0.15s blip as "You", both
 * with a success response. Whisper hallucinates confidently on silence, and
 * this transcript is pasted into the box that dials a real phone number, so a
 * plausible invention is far worse here than an empty result. With the filter
 * on, both cases return an empty string and `duration_after_vad: 0`, which is
 * what makes `no_speech` detectable at all.
 */
/**
 * The one method of the `Ai` binding this module uses.
 *
 * Narrower than `Ai` on purpose: a test can implement this exactly, with a
 * real function and the real input/output types, instead of casting a
 * part-built double at the full binding and losing type checking on the very
 * call shape the test exists to pin.
 */
export interface TranscriptionRunner {
  run(
    model: typeof TRANSCRIBE_MODEL,
    inputs: Ai_Cf_Openai_Whisper_Large_V3_Turbo_Input,
  ): Promise<Ai_Cf_Openai_Whisper_Large_V3_Turbo_Output>;
}

export async function transcribeAudio(
  ai: TranscriptionRunner,
  audio: Uint8Array,
): Promise<TranscribeResult> {
  let output: Ai_Cf_Openai_Whisper_Large_V3_Turbo_Output;
  try {
    output = await ai.run(TRANSCRIBE_MODEL, {
      audio: base64(audio),
      vad_filter: true,
      task: 'transcribe',
    });
  } catch (err) {
    // Undecodable bytes land here: the model answers "Failed to decode audio
    // file" (code 3030) rather than returning an empty transcription.
    log('error', 'transcribe.model.failed', { bytes: audio.length, error: errText(err) });
    return { ok: false, reason: 'model_error' };
  }

  const durationSeconds = output.transcription_info?.duration ?? 0;
  if (durationSeconds > MAX_AUDIO_SECONDS) {
    log('warn', 'transcribe.too_long', { durationSeconds });
    return { ok: false, reason: 'too_long', durationSeconds };
  }

  const text = (output.text ?? '').trim();
  if (text.length === 0) {
    log('info', 'transcribe.no_speech', { durationSeconds });
    return { ok: false, reason: 'no_speech' };
  }
  log('info', 'transcribe.ok', { durationSeconds, chars: text.length });
  return { ok: true, text, durationSeconds };
}
