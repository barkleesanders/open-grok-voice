import { describe, expect, it } from 'vitest';
import { issueMediaToken, parseMediaEvent, verifyMediaToken } from '../src/media';

const CALL_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_CALL_ID = '22222222-2222-4222-8222-222222222222';
const SECRET = 'media-test-secret-that-is-long-enough';
const NOW = 1_700_000_000_000;

describe('per-call media tokens', () => {
  it('accepts a token only for its call and intended ingress kind', async () => {
    const browser = await issueMediaToken(SECRET, CALL_ID, 'browser', NOW);
    const ingress = await issueMediaToken(SECRET, CALL_ID, 'ingress', NOW);

    await expect(verifyMediaToken(SECRET, browser, CALL_ID, 'browser', NOW)).resolves.toBe(true);
    await expect(verifyMediaToken(SECRET, ingress, CALL_ID, 'ingress', NOW)).resolves.toBe(true);
    await expect(verifyMediaToken(SECRET, browser, OTHER_CALL_ID, 'browser', NOW)).resolves.toBe(
      false,
    );
    await expect(verifyMediaToken(SECRET, browser, CALL_ID, 'ingress', NOW)).resolves.toBe(false);
  });

  it('rejects missing, tampered, expired, and malformed tokens', async () => {
    const token = await issueMediaToken(SECRET, CALL_ID, 'browser', NOW);
    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;

    await expect(verifyMediaToken(SECRET, undefined, CALL_ID, 'browser', NOW)).resolves.toBe(false);
    await expect(verifyMediaToken(SECRET, tampered, CALL_ID, 'browser', NOW)).resolves.toBe(false);
    await expect(verifyMediaToken(SECRET, token, CALL_ID, 'browser', NOW + 91_000)).resolves.toBe(
      false,
    );
    await expect(
      verifyMediaToken(SECRET, 'm1.not-a-payload.not-a-signature', CALL_ID, 'browser', NOW),
    ).resolves.toBe(false);
  });
});

describe('Telnyx media event parser', () => {
  it('normalizes control events and both track names', () => {
    expect(parseMediaEvent(JSON.stringify({ event: 'connected' }))).toEqual({ kind: 'connected' });
    expect(
      parseMediaEvent(
        JSON.stringify({
          event: 'start',
          start: { media_format: { encoding: 'PCMU', sample_rate: '8000', channels: '1' } },
        }),
      ),
    ).toEqual({ kind: 'start', codec: 'PCMU', sampleRate: 8000, channels: 1 });
    expect(
      parseMediaEvent(
        JSON.stringify({
          event: 'media',
          sequence_number: '9',
          media: { track: 'inbound_track', chunk: '0', timestamp: '20', payload: 'AQID' },
        }),
      ),
    ).toEqual({
      kind: 'media',
      track: 'inbound',
      chunk: 0,
      sequence: 9,
      timestamp: 20,
      payload: 'AQID',
    });
    expect(
      parseMediaEvent(
        JSON.stringify({
          event: 'media',
          media: { track: 'outbound', chunk: 1, payload: 'AQID' },
        }),
      ),
    ).toEqual({
      kind: 'media',
      track: 'outbound',
      chunk: 1,
      sequence: null,
      timestamp: null,
      payload: 'AQID',
    });
    expect(parseMediaEvent(JSON.stringify({ event: 'stop' }))).toEqual({ kind: 'stop' });
  });

  it('rejects unknown tracks, invalid payloads, and incomplete start metadata', () => {
    expect(
      parseMediaEvent(
        JSON.stringify({ event: 'media', media: { track: 'sideband', chunk: 0, payload: 'AQID' } }),
      ),
    ).toBeNull();
    expect(
      parseMediaEvent(
        JSON.stringify({
          event: 'media',
          media: { track: 'inbound', chunk: 0, payload: 'not base64!' },
        }),
      ),
    ).toBeNull();
    expect(
      parseMediaEvent(
        JSON.stringify({ event: 'start', start: { media_format: { encoding: 'PCMU' } } }),
      ),
    ).toBeNull();
    expect(parseMediaEvent('{"event":"media"}')).toBeNull();
    expect(parseMediaEvent('not json')).toBeNull();
  });
});
