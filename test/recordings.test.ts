import { describe, expect, it } from 'vitest';
import {
  isRecordingUrlAllowed,
  type RecordingWebhookPayload,
  recordingAssetFromWebhook,
} from '../src/recordings';
import { testEnv } from './test-env';

const EMPTY_ENV = testEnv();

describe('recording URL policy', () => {
  it('allows HTTPS Telnyx storage URLs and rejects SSRF-shaped URLs', () => {
    expect(isRecordingUrlAllowed('https://s3.amazonaws.com/bucket/call.wav', EMPTY_ENV)).toBe(true);
    expect(isRecordingUrlAllowed('https://cdn.telnyx.com/recordings/call.wav', EMPTY_ENV)).toBe(
      true,
    );
    expect(isRecordingUrlAllowed('http://s3.amazonaws.com/bucket/call.wav', EMPTY_ENV)).toBe(false);
    expect(isRecordingUrlAllowed('https://evil.example/call.wav', EMPTY_ENV)).toBe(false);
    expect(isRecordingUrlAllowed('https://127.0.0.1/call.wav', EMPTY_ENV)).toBe(false);
    expect(isRecordingUrlAllowed('https://notamazonaws.com/call.wav', EMPTY_ENV)).toBe(false);
    expect(isRecordingUrlAllowed('https://s3.amazonaws.com@evil.example/call.wav', EMPTY_ENV)).toBe(
      false,
    );
  });

  it('uses an explicit host allowlist with a hostname boundary', () => {
    const env = testEnv({ RECORDING_HOST_ALLOWLIST: 'media.example.com' });
    expect(isRecordingUrlAllowed('https://media.example.com/audio.wav', env)).toBe(true);
    expect(isRecordingUrlAllowed('https://edge.media.example.com/audio.wav', env)).toBe(true);
    expect(isRecordingUrlAllowed('https://media.example.com.evil/audio.wav', env)).toBe(false);
  });
});

describe('recording callback parser', () => {
  it('retains only typed metadata and an allowlisted provider URL', () => {
    const payload: RecordingWebhookPayload = {
      recording_id: 'recording-1',
      format: 'wav',
      channels: 'dual',
      recording_started_at: '2026-08-27T12:00:00.000Z',
      recording_ended_at: '2026-08-27T12:01:00.000Z',
      recording_urls: { wav: 'https://s3.amazonaws.com/bucket/recording-1.wav' },
    };
    expect(recordingAssetFromWebhook(payload, EMPTY_ENV)).toEqual({
      id: 'recording-1',
      format: 'wav',
      channels: 'dual',
      url: 'https://s3.amazonaws.com/bucket/recording-1.wav',
      startedAt: '2026-08-27T12:00:00.000Z',
      endedAt: '2026-08-27T12:01:00.000Z',
    });
  });

  it('falls back to public URLs and rejects incomplete or untrusted callbacks', () => {
    expect(
      recordingAssetFromWebhook(
        {
          format: 'mp3',
          channels: 'single',
          public_recording_urls: { mp3: 'https://s3.amazonaws.com/a.mp3' },
        },
        EMPTY_ENV,
      ),
    ).toMatchObject({ format: 'mp3', channels: 'single', url: 'https://s3.amazonaws.com/a.mp3' });
    expect(
      recordingAssetFromWebhook(
        { format: 'wav', channels: 'dual', recording_urls: { wav: 'https://evil.example/a.wav' } },
        EMPTY_ENV,
      ),
    ).toBeNull();
    expect(
      recordingAssetFromWebhook(
        {
          format: 'ogg',
          channels: 'dual',
          recording_urls: { wav: 'https://s3.amazonaws.com/a.ogg' },
        },
        EMPTY_ENV,
      ),
    ).toBeNull();
    expect(
      recordingAssetFromWebhook(
        {
          format: 'wav',
          channels: 'dual',
          recording_urls: { wav: 'https://s3.amazonaws.com/a.wav' },
          recording_started_at: 'never',
        },
        EMPTY_ENV,
      ),
    ).toMatchObject({ startedAt: null });
  });
});
