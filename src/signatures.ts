// Webhook signature verification for BOTH providers.
//
// These are the only two trust boundaries where an unauthenticated party can
// reach us, so both fail CLOSED: a missing key, a malformed header, an
// unparseable timestamp, or any thrown error all return false.
//
// -- Telnyx (Ed25519) ---------------------------------------------------------
// Verified against developers.telnyx.com/docs/development/api-fundamentals/
// webhooks/receiving-webhooks.md (retrieved 2026-08-26):
//   headers: `telnyx-timestamp`, `telnyx-signature-ed25519`
//   signed payload: `${timestamp}|${rawBody}`
//   key: the account Ed25519 PUBLIC key (base64) from Mission Control.
// The doc is explicit: "Verification requires the exact body bytes received by
// the server. Do not parse and reserialize JSON before verification."
//
// -- xAI (Standard Webhooks v1) -----------------------------------------------
// docs.x.ai names the secret `dispatch_signing_secret` and describes it as a
// "Standard Webhooks v1 HMAC-SHA256 signing secret" returned as "whsec_...".
// Scheme verified against the Standard Webhooks specification (retrieved
// 2026-08-26):
//   headers: `webhook-id`, `webhook-timestamp`, `webhook-signature`
//   signed content: `${msg_id}.${timestamp}.${payload}`
//   secret: base64, prefixed `whsec_`
//   signature header: SPACE-DELIMITED list, each `v1,<base64>` (rotation), so
//     we must accept if ANY v1 entry matches.

/** Default replay window, in seconds, for both providers. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Constant-time byte comparison. Length difference is folded in, not returned early. */
export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Constant-time string comparison (UTF-8 bytes). */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  return timingSafeEqualBytes(enc.encode(a), enc.encode(b));
}

function timestampWithinTolerance(
  timestamp: string,
  toleranceSeconds: number,
  nowMs: number,
): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  return Math.abs(nowMs / 1000 - ts) <= toleranceSeconds;
}

/**
 * Verify a Telnyx webhook (Ed25519).
 *
 * @param rawBody   the EXACT bytes received, as text. Never a re-serialized object.
 * @param publicKeyB64 the account public key. Undefined => cannot verify => false.
 */
export async function verifyTelnyxSignature(
  rawBody: string,
  signatureB64: string | null,
  timestamp: string | null,
  publicKeyB64: string | undefined,
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (!publicKeyB64 || !signatureB64 || !timestamp) return false;
  if (!timestampWithinTolerance(timestamp, toleranceSeconds, nowMs)) return false;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      b64ToBytes(publicKeyB64),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    const signed = new TextEncoder().encode(`${timestamp}|${rawBody}`);
    return await crypto.subtle.verify('Ed25519', key, b64ToBytes(signatureB64), signed);
  } catch {
    return false;
  }
}

/**
 * Verify an xAI webhook (Standard Webhooks v1, HMAC-SHA256).
 *
 * @param secret the `dispatch_signing_secret`, with or without the `whsec_`
 *               prefix. The bytes after the prefix are base64.
 */
export async function verifyXaiSignature(
  rawBody: string,
  webhookId: string | null,
  webhookTimestamp: string | null,
  webhookSignature: string | null,
  secret: string | undefined,
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (!secret || !webhookId || !webhookTimestamp || !webhookSignature) return false;
  if (!timestampWithinTolerance(webhookTimestamp, toleranceSeconds, nowMs)) return false;

  try {
    const raw = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
    const keyBytes = b64ToBytes(raw);
    const key = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signedContent = new TextEncoder().encode(`${webhookId}.${webhookTimestamp}.${rawBody}`);
    const macBytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, signedContent));
    const expected = bytesToB64(macBytes);

    // Space-delimited list to support zero-downtime secret rotation. Accept if
    // ANY `v1` entry matches. Note: `v1a` entries are asymmetric (ed25519) and
    // are deliberately ignored here — we only hold a symmetric secret.
    let matched = false;
    for (const entry of webhookSignature.split(' ')) {
      const comma = entry.indexOf(',');
      if (comma === -1) continue;
      if (entry.slice(0, comma) !== 'v1') continue;
      // Do not break early on match: keep the loop's work independent of where
      // the matching signature sits in the list.
      if (timingSafeEqual(entry.slice(comma + 1), expected)) matched = true;
    }
    return matched;
  } catch {
    return false;
  }
}
