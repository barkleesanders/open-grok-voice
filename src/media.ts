// Server-authenticated media tokens and the narrow Telnyx media-stream parser.
//
// Telnyx sends JSON control envelopes and base64 RTP payloads over the stream.
// The browser never receives the Telnyx call-control id, xAI call id, or an API
// key. It receives only the normalized event types below after this parser has
// validated the provider shape.

import { z } from 'zod';
import { timingSafeEqual } from './signatures';

export type MediaTokenKind = 'browser' | 'ingress';

interface MediaTokenPayload {
  readonly version: 1;
  readonly callId: string;
  readonly kind: MediaTokenKind;
  readonly expiresAt: number;
  readonly nonce: string;
}

const MediaTokenPayloadSchema = z
  .object({
    version: z.literal(1),
    callId: z.string().uuid(),
    kind: z.enum(['browser', 'ingress']),
    expiresAt: z.number().int().positive(),
    nonce: z.string().min(16).max(128),
  })
  .strict();

const TOKEN_PREFIX = 'm1';
const BROWSER_TOKEN_TTL_SECONDS = 90;
const INGRESS_TOKEN_TTL_SECONDS = 15 * 60;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function textToBase64Url(text: string): string {
  return bytesToBase64Url(new TextEncoder().encode(text));
}

function base64UrlToText(encoded: string): string | null {
  try {
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    const binary = atob(`${normalized}${padding}`);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

async function sign(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)),
  );
  return bytesToBase64Url(signature);
}

function tokenTtl(kind: MediaTokenKind): number {
  return kind === 'browser' ? BROWSER_TOKEN_TTL_SECONDS : INGRESS_TOKEN_TTL_SECONDS;
}

/** Mint a short-lived token scoped to one opaque application call id. */
export async function issueMediaToken(
  secret: string | undefined,
  callId: string,
  kind: MediaTokenKind,
  nowMs: number = Date.now(),
): Promise<string> {
  if (!secret) throw new Error('media token secret is not configured');
  const nonceBytes = new Uint8Array(18);
  crypto.getRandomValues(nonceBytes);
  const payload: MediaTokenPayload = {
    version: 1,
    callId,
    kind,
    expiresAt: Math.floor(nowMs / 1000) + tokenTtl(kind),
    nonce: bytesToBase64Url(nonceBytes),
  };
  const encoded = textToBase64Url(JSON.stringify(payload));
  const unsigned = `${TOKEN_PREFIX}.${encoded}`;
  const signature = await sign(secret, unsigned);
  return `${unsigned}.${signature}`;
}

/** Validate a token without revealing whether its signature or payload failed. */
export async function verifyMediaToken(
  secret: string | undefined,
  token: string | null | undefined,
  callId: string,
  kind: MediaTokenKind,
  nowMs: number = Date.now(),
): Promise<boolean> {
  // Reject oversized bearer/query values before doing any cryptographic work.
  if (!secret || !token || token.length > 4096) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return false;
  const encoded = parts[1];
  const providedSignature = parts[2];
  if (!encoded || !providedSignature) return false;
  const unsigned = `${TOKEN_PREFIX}.${encoded}`;
  try {
    const expectedSignature = await sign(secret, unsigned);
    if (!timingSafeEqual(providedSignature, expectedSignature)) return false;
  } catch {
    return false;
  }
  const decoded = base64UrlToText(encoded);
  if (!decoded) return false;
  let value: unknown;
  try {
    value = JSON.parse(decoded);
  } catch {
    return false;
  }
  const parsed = MediaTokenPayloadSchema.safeParse(value);
  if (!parsed.success) return false;
  const payload = parsed.data;
  const nowSeconds = Math.floor(nowMs / 1000);
  const maxLifetime = tokenTtl(kind) + 30;
  return (
    payload.callId === callId &&
    payload.kind === kind &&
    payload.expiresAt > nowSeconds &&
    payload.expiresAt <= nowSeconds + maxLifetime
  );
}

export type MediaTrack = 'inbound' | 'outbound';

export type ParsedMediaEvent =
  | { readonly kind: 'connected' }
  | {
      readonly kind: 'start';
      readonly codec: string;
      readonly sampleRate: number;
      readonly channels: number;
    }
  | {
      readonly kind: 'media';
      readonly track: MediaTrack;
      readonly chunk: number;
      readonly sequence: number | null;
      readonly timestamp: number | null;
      readonly payload: string;
    }
  | { readonly kind: 'stop' };

const NumberLikeSchema = z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]);

function isBase64Payload(value: string): boolean {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return false;
  const paddingAt = value.indexOf('=');
  if (paddingAt >= 0 && value.length % 4 !== 0) return false;
  return value.replace(/=+$/g, '').length % 4 !== 1;
}

const MediaEnvelopeSchema = z
  .object({
    event: z.enum(['connected', 'start', 'media', 'stop']),
    sequence_number: NumberLikeSchema.optional(),
    start: z
      .object({
        media_format: z
          .object({
            encoding: z.string().min(1).max(32),
            sample_rate: NumberLikeSchema,
            channels: NumberLikeSchema,
          })
          .loose(),
      })
      .loose()
      .optional(),
    media: z
      .object({
        track: z.string().min(1).max(32),
        chunk: NumberLikeSchema,
        timestamp: NumberLikeSchema.optional(),
        payload: z.string().min(1).max(2_000_000).refine(isBase64Payload),
      })
      .loose()
      .optional(),
    stop: z.object({}).loose().optional(),
  })
  .loose();

function numberValue(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeTrack(track: string): MediaTrack | null {
  if (track === 'inbound' || track === 'inbound_track') return 'inbound';
  if (track === 'outbound' || track === 'outbound_track') return 'outbound';
  return null;
}

/** Parse one Telnyx WebSocket message into a browser-safe event. */
export function parseMediaEvent(raw: string): ParsedMediaEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = MediaEnvelopeSchema.safeParse(value);
  if (!parsed.success) return null;
  const envelope = parsed.data;
  switch (envelope.event) {
    case 'connected':
      return { kind: 'connected' };
    case 'start': {
      const format = envelope.start?.media_format;
      if (!format) return null;
      const sampleRate = numberValue(format.sample_rate);
      const channels = numberValue(format.channels);
      if (sampleRate === null || channels === null || sampleRate === 0 || channels === 0)
        return null;
      return {
        kind: 'start',
        codec: format.encoding,
        sampleRate,
        channels,
      };
    }
    case 'media': {
      const media = envelope.media;
      if (!media) return null;
      const track = normalizeTrack(media.track);
      const chunk = numberValue(media.chunk);
      if (!track || chunk === null) return null;
      return {
        kind: 'media',
        track,
        chunk,
        sequence: numberValue(envelope.sequence_number),
        timestamp: numberValue(media.timestamp),
        payload: media.payload,
      };
    }
    case 'stop':
      return { kind: 'stop' };
    default: {
      const _never: never = envelope.event;
      return _never;
    }
  }
}
