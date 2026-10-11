import { describe, expect, it } from 'vitest';
import { timingSafeEqual, verifyTelnyxSignature, verifyXaiSignature } from '../src/signatures';

const enc = new TextEncoder();

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// --- helpers that PRODUCE a genuinely valid signature ----------------------
// The tests below are only meaningful because these helpers sign the same way
// a real provider would. If they were wrong, the positive cases would fail --
// which is exactly what makes the negative cases trustworthy.

async function makeTelnyxSigned(body: string, timestamp: string) {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const exported = await crypto.subtle.exportKey('raw', pair.publicKey);
  // exportKey is typed ArrayBuffer | JsonWebKey; 'raw' always yields the former.
  // Narrow with a real runtime check rather than a cast.
  if (!(exported instanceof ArrayBuffer)) {
    throw new Error("exportKey('raw') did not return an ArrayBuffer");
  }
  const rawPub = new Uint8Array(exported);
  const sig = new Uint8Array(
    await crypto.subtle.sign('Ed25519', pair.privateKey, enc.encode(`${timestamp}|${body}`)),
  );
  return { publicKeyB64: bytesToB64(rawPub), signatureB64: bytesToB64(sig) };
}

async function makeXaiSigned(body: string, id: string, timestamp: string) {
  const secretBytes = crypto.getRandomValues(new Uint8Array(32));
  const secretB64 = bytesToB64(secretBytes);
  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, enc.encode(`${id}.${timestamp}.${body}`)),
  );
  return { secret: `whsec_${secretB64}`, signature: `v1,${bytesToB64(mac)}` };
}

describe('timingSafeEqual', () => {
  it('matches identical strings and rejects different ones', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });
});

describe('verifyTelnyxSignature (Ed25519)', () => {
  const body = JSON.stringify({ data: { event_type: 'call.answered' } });
  const nowMs = 1_700_000_000_000;
  const ts = String(Math.floor(nowMs / 1000));

  it('accepts a correctly signed payload', async () => {
    const { publicKeyB64, signatureB64 } = await makeTelnyxSigned(body, ts);
    await expect(
      verifyTelnyxSignature(body, signatureB64, ts, publicKeyB64, 300, nowMs),
    ).resolves.toBe(true);
  });

  // NEGATIVE CONTROL: the whole point of the check.
  it('REJECTS a tampered body', async () => {
    const { publicKeyB64, signatureB64 } = await makeTelnyxSigned(body, ts);
    const tampered = JSON.stringify({ data: { event_type: 'call.hangup' } });
    await expect(
      verifyTelnyxSignature(tampered, signatureB64, ts, publicKeyB64, 300, nowMs),
    ).resolves.toBe(false);
  });

  it('REJECTS a tampered signature', async () => {
    const { publicKeyB64, signatureB64 } = await makeTelnyxSigned(body, ts);
    const flipped = signatureB64.startsWith('A')
      ? `B${signatureB64.slice(1)}`
      : `A${signatureB64.slice(1)}`;
    await expect(verifyTelnyxSignature(body, flipped, ts, publicKeyB64, 300, nowMs)).resolves.toBe(
      false,
    );
  });

  it('REJECTS a signature from a different key', async () => {
    const a = await makeTelnyxSigned(body, ts);
    const b = await makeTelnyxSigned(body, ts);
    await expect(
      verifyTelnyxSignature(body, a.signatureB64, ts, b.publicKeyB64, 300, nowMs),
    ).resolves.toBe(false);
  });

  it('REJECTS a stale timestamp (replay window)', async () => {
    const oldTs = String(Math.floor(nowMs / 1000) - 3600);
    const { publicKeyB64, signatureB64 } = await makeTelnyxSigned(body, oldTs);
    await expect(
      verifyTelnyxSignature(body, signatureB64, oldTs, publicKeyB64, 300, nowMs),
    ).resolves.toBe(false);
  });

  it('fails closed when no public key is configured', async () => {
    const { signatureB64 } = await makeTelnyxSigned(body, ts);
    await expect(
      verifyTelnyxSignature(body, signatureB64, ts, undefined, 300, nowMs),
    ).resolves.toBe(false);
  });

  it('fails closed on missing headers', async () => {
    const { publicKeyB64 } = await makeTelnyxSigned(body, ts);
    await expect(verifyTelnyxSignature(body, null, ts, publicKeyB64, 300, nowMs)).resolves.toBe(
      false,
    );
    await expect(verifyTelnyxSignature(body, 'x', null, publicKeyB64, 300, nowMs)).resolves.toBe(
      false,
    );
  });
});

describe('verifyXaiSignature (Standard Webhooks v1 HMAC-SHA256)', () => {
  const body = JSON.stringify({ type: 'realtime.call.incoming', data: { call_id: 'abc' } });
  const id = 'evt_123';
  const nowMs = 1_700_000_000_000;
  const ts = String(Math.floor(nowMs / 1000));

  it('accepts a correctly signed payload', async () => {
    const { secret, signature } = await makeXaiSigned(body, id, ts);
    await expect(verifyXaiSignature(body, id, ts, signature, secret, 300, nowMs)).resolves.toBe(
      true,
    );
  });

  it('accepts a secret supplied without the whsec_ prefix', async () => {
    const { secret, signature } = await makeXaiSigned(body, id, ts);
    const bare = secret.slice('whsec_'.length);
    await expect(verifyXaiSignature(body, id, ts, signature, bare, 300, nowMs)).resolves.toBe(true);
  });

  it('accepts when the correct signature is one of several (key rotation)', async () => {
    const { secret, signature } = await makeXaiSigned(body, id, ts);
    const multi = `v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= ${signature}`;
    await expect(verifyXaiSignature(body, id, ts, multi, secret, 300, nowMs)).resolves.toBe(true);
  });

  // NEGATIVE CONTROL.
  it('REJECTS a tampered body', async () => {
    const { secret, signature } = await makeXaiSigned(body, id, ts);
    const tampered = JSON.stringify({
      type: 'realtime.call.incoming',
      data: { call_id: 'EVIL' },
    });
    await expect(verifyXaiSignature(tampered, id, ts, signature, secret, 300, nowMs)).resolves.toBe(
      false,
    );
  });

  it('REJECTS a tampered signature', async () => {
    const { secret, signature } = await makeXaiSigned(body, id, ts);
    const tampered = `v1,AAAA${signature.slice(7)}`;
    await expect(verifyXaiSignature(body, id, ts, tampered, secret, 300, nowMs)).resolves.toBe(
      false,
    );
  });

  it('REJECTS a signature bound to a DIFFERENT webhook-id', async () => {
    // Proves the id is genuinely part of the signed content, not decoration.
    const { secret, signature } = await makeXaiSigned(body, id, ts);
    await expect(
      verifyXaiSignature(body, 'evt_OTHER', ts, signature, secret, 300, nowMs),
    ).resolves.toBe(false);
  });

  it('REJECTS a v1a (asymmetric) entry even if the bytes match', async () => {
    const { secret, signature } = await makeXaiSigned(body, id, ts);
    const asV1a = signature.replace('v1,', 'v1a,');
    await expect(verifyXaiSignature(body, id, ts, asV1a, secret, 300, nowMs)).resolves.toBe(false);
  });

  it('REJECTS a stale timestamp (replay window)', async () => {
    const oldTs = String(Math.floor(nowMs / 1000) - 3600);
    const { secret, signature } = await makeXaiSigned(body, id, oldTs);
    await expect(verifyXaiSignature(body, id, oldTs, signature, secret, 300, nowMs)).resolves.toBe(
      false,
    );
  });

  it('fails closed when no secret is configured', async () => {
    const { signature } = await makeXaiSigned(body, id, ts);
    await expect(verifyXaiSignature(body, id, ts, signature, undefined, 300, nowMs)).resolves.toBe(
      false,
    );
  });

  it('fails closed on a malformed signature header', async () => {
    const { secret } = await makeXaiSigned(body, id, ts);
    await expect(
      verifyXaiSignature(body, id, ts, 'not-a-signature', secret, 300, nowMs),
    ).resolves.toBe(false);
  });
});
