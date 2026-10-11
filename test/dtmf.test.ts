import { describe, expect, it } from 'vitest';
import { DTMF_MAX_DIGITS, validateDtmfDigits } from '../src/dtmf';

describe('validateDtmfDigits', () => {
  it('accepts every character Telnyx documents as valid', () => {
    // "Valid digits are 0-9, A-D, *, and #. Pauses can be added using w (0.5s)
    // and W (1s)." -- Telnyx Send DTMF reference, and their own SDK sample
    // string, which exercises the charset in full.
    for (const digits of [
      '0',
      '1234567890',
      '*',
      '#',
      '*#',
      'ABCD',
      '1w2',
      '1W2',
      '1www2WABCDw9',
    ]) {
      expect(validateDtmfDigits(digits)).toEqual({ ok: true, digits });
    }
  });

  it('folds lowercase a-d to uppercase, because only A-D is documented', () => {
    expect(validateDtmfDigits('abcd')).toEqual({ ok: true, digits: 'ABCD' });
    expect(validateDtmfDigits('1a2b')).toEqual({ ok: true, digits: '1A2B' });
  });

  it('NEVER folds the pause characters, which are case-sensitive', () => {
    // w is 0.5s and W is 1s. A blanket toUpperCase() would silently double
    // every short pause -- the kind of bug that only shows up as an IVR
    // timing out, on someone else's phone system.
    expect(validateDtmfDigits('1w2')).toEqual({ ok: true, digits: '1w2' });
    expect(validateDtmfDigits('1W2')).toEqual({ ok: true, digits: '1W2' });
    expect(validateDtmfDigits('wW')).toEqual({ ok: true, digits: 'wW' });
  });

  it('strips whitespace rather than failing a live call over it', () => {
    // A model asked for keypad input plausibly emits "1 2 3". Stripping is
    // safe because whitespace is not a valid DTMF character, so it can never
    // carry meaning or smuggle a digit past the charset check.
    expect(validateDtmfDigits(' 1 2 3 ')).toEqual({ ok: true, digits: '123' });
    expect(validateDtmfDigits('1\n2\t3')).toEqual({ ok: true, digits: '123' });
  });

  it('rejects characters outside the charset', () => {
    for (const bad of ['1;2', '1,2', 'press 1', '1-800', 'E', 'z', '+15551234567', '1.2']) {
      const result = validateDtmfDigits(bad);
      expect(result.ok, `expected ${JSON.stringify(bad)} to be rejected`).toBe(false);
    }
  });

  it('rejects a non-string, including the shapes a model actually emits', () => {
    for (const bad of [undefined, null, 1, 0, ['1'], { digits: '1' }, true]) {
      expect(validateDtmfDigits(bad).ok, `expected ${JSON.stringify(bad)} rejected`).toBe(false);
    }
  });

  it('rejects empty, and treats whitespace-only as empty', () => {
    expect(validateDtmfDigits('')).toEqual({ ok: false, reason: 'digits must not be empty' });
    expect(validateDtmfDigits('   ')).toEqual({ ok: false, reason: 'digits must not be empty' });
  });

  it('caps length so a runaway model cannot hold the line dialing', () => {
    const atCap = '1'.repeat(DTMF_MAX_DIGITS);
    expect(validateDtmfDigits(atCap)).toEqual({ ok: true, digits: atCap });

    const overCap = '1'.repeat(DTMF_MAX_DIGITS + 1);
    expect(validateDtmfDigits(overCap).ok).toBe(false);
  });

  it('measures the cap AFTER stripping, so padding cannot smuggle length past it', () => {
    // '1 '.repeat(cap) is 2x the cap in raw length but exactly the cap in
    // real digits. Checking length before stripping would reject this.
    const padded = '1 '.repeat(DTMF_MAX_DIGITS);
    expect(validateDtmfDigits(padded)).toEqual({ ok: true, digits: '1'.repeat(DTMF_MAX_DIGITS) });

    // And the reverse: padding must not let an over-length string through.
    const paddedOver = '1 '.repeat(DTMF_MAX_DIGITS + 1);
    expect(validateDtmfDigits(paddedOver).ok).toBe(false);
  });
});
