// DTMF digit validation for the agent-callable `send_dtmf` tool.
//
// This module exists as a separate, dependency-free unit because it is the
// ONLY thing standing between a language model's free-text output and a
// telephony command that emits real audio on a live call. It has to be
// trivially testable in isolation.
//
// Charset verified against the Telnyx Send DTMF reference (2026-08-28):
//   "DTMF digits to send. Valid digits are 0-9, A-D, *, and #. Pauses can be
//    added using w (0.5s) and W (1s)."
// Telnyx's own SDK sample uses "1www2WABCDw9", which is the charset in full.

/**
 * Upper bound on ONE tool call.
 *
 * Long enough for a real IVR step — a menu key, an extension, a member ID —
 * with `w` pauses interleaved. Measured on the SANITIZED string, so padding
 * cannot smuggle length past it.
 *
 * Be precise about what this does NOT do. It bounds a single call, not a call
 * sequence: 16 digits is enough to through-dial an international number and 9
 * is enough for an SSN, so anything that fits in 32 characters is reachable in
 * one press, and anything longer is reachable by pressing twice. What bounds a
 * RUNAWAY is the per-call press budget in `CallSession`
 * (`DTMF_MAX_PRESSES_PER_CALL`); what bounds what the agent is ASKED to type is
 * an operator policy on task text. This constant is the innermost of those
 * three, and the weakest.
 */
export const DTMF_MAX_DIGITS = 32;

/**
 * Telnyx's documented charset, plus lowercase a-d which we normalize below.
 *
 * `w`/`W` are pauses, NOT digits, and they are case-SENSITIVE (0.5s vs 1s), so
 * they must never be folded by the normalizer.
 */
export const DTMF_ALLOWED = /^[0-9A-Da-d*#wW]+$/;

/*
 * A-D is accepted here but deliberately NOT advertised in the tool schema
 * (src/xai.ts). Telnyx documents A-D as valid, so accepting them keeps this
 * validator honest about the provider's real contract; not advertising them
 * keeps the model from reaching for tones that essentially every commercial
 * IVR ignores. The asymmetry is intentional, not drift.
 */

export type DtmfValidation =
  | { readonly ok: true; readonly digits: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Validate and normalize a model-supplied digit string.
 *
 * Whitespace is STRIPPED rather than rejected. A model asked for a keypad
 * sequence very plausibly emits "1 2 3", and failing a live call over a cosmetic
 * space would be the wrong trade — while stripping is safe precisely because
 * whitespace is not a valid DTMF character, so it can never carry meaning or
 * smuggle a digit past the charset check.
 *
 * Lowercase a-d IS folded to uppercase: Telnyx documents only A-D, so passing
 * the lowercase form through would be relying on undocumented behaviour.
 */
export function validateDtmfDigits(raw: unknown): DtmfValidation {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'digits must be a string' };
  }
  const stripped = raw.replace(/\s+/g, '');
  if (stripped.length === 0) {
    return { ok: false, reason: 'digits must not be empty' };
  }
  if (stripped.length > DTMF_MAX_DIGITS) {
    return { ok: false, reason: `digits must be at most ${DTMF_MAX_DIGITS} characters` };
  }
  if (!DTMF_ALLOWED.test(stripped)) {
    return {
      ok: false,
      reason: 'digits may only contain 0-9, A-D, *, #, and the pause characters w and W',
    };
  }
  // Fold ONLY a-d. Folding w would turn a 0.5s pause into a 1s pause.
  const normalized = stripped.replace(/[a-d]/g, (ch) => ch.toUpperCase());
  return { ok: true, digits: normalized };
}
