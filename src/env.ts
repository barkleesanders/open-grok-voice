import type { TranscriptionRunner } from './transcribe';

/**
 * Worker environment bindings.
 *
 * Every field below marked "secret" is set with `wrangler secret put <NAME>`
 * and MUST NOT appear in wrangler.toml or any committed file.
 */
export interface Env {
  // --- Durable Object -------------------------------------------------------
  readonly CALL_SESSION: DurableObjectNamespace;
  /** One monitor relay per call. Provisioned by the v2 migration below. */
  readonly MONITOR_SESSION?: DurableObjectNamespace;

  /** Better Auth's D1 database. Missing in an unprovisioned environment fails closed. */
  readonly DB?: D1Database;

  /**
   * Durable per-call archive: one JSON record per finished call plus the
   * recording bytes. Optional for the same reason DB and MONITOR_SESSION are —
   * an environment without the bucket degrades to the pre-archive behaviour
   * (calls still work, the console's call log reports it is unconfigured)
   * instead of failing every request.
   */
  readonly CALL_LOGS?: R2Bucket;

  /**
   * Workers AI, used only to transcribe the operator's own dictation into the
   * console task box. Optional for the same reason DB, MONITOR_SESSION, and
   * CALL_LOGS are: an environment without the binding degrades to a typed-only
   * console rather than failing every console request.
   *
   * Typed as the ONE method this Worker calls rather than the whole `Ai`
   * class. The runtime binding satisfies it structurally, and narrowing it
   * here states what the Worker is actually allowed to do with Workers AI —
   * and lets a test supply a real implementation instead of casting a stub.
   */
  readonly AI?: TranscriptionRunner;

  // --- Secrets --------------------------------------------------------------
  /** secret: xAI API key ("xai-..."). Authenticates the realtime WebSocket. */
  readonly XAI_API_KEY: string;
  /**
   * secret: xAI webhook signing secret. This is the `dispatch_signing_secret`
   * returned ONCE by POST /v2/phone-numbers, in the form "whsec_<base64>".
   * Standard Webhooks v1, HMAC-SHA256.
   */
  readonly XAI_WEBHOOK_SECRET: string;
  /** secret: Telnyx V2 API key (Bearer). */
  readonly TELNYX_API_KEY: string;
  /** secret: Telnyx account Ed25519 webhook public key (base64). */
  readonly TELNYX_PUBLIC_KEY: string;
  /** secret: long random string callers send as X-API-Key on POST /call. */
  readonly APP_API_KEY: string;
  /** Better Auth signing/encryption secret. */
  readonly BETTER_AUTH_SECRET?: string;
  /** Google OAuth web client id. */
  readonly GOOGLE_CLIENT_ID?: string;
  /** Google OAuth web client secret. */
  readonly GOOGLE_CLIENT_SECRET?: string;

  // --- Non-secret vars ------------------------------------------------------
  /** Telnyx Voice API Application (Call Control) connection id. */
  readonly TELNYX_CONNECTION_ID: string;
  /** E.164 number Telnyx dials FROM, e.g. "+14155550123". */
  readonly TELNYX_FROM_NUMBER: string;
  /**
   * The E.164 number registered with xAI as a `byo_trunk` Direct SIP number.
   * Leg B is dialed to sip:{this}@{XAI_SIP_HOST};transport=tls
   */
  readonly XAI_PHONE_NUMBER: string;
  /** xAI SIP host. Defaults to sip.voice.x.ai. */
  readonly XAI_SIP_HOST: string;
  /** Public https base URL of this Worker; Telnyx posts call events here. */
  readonly PUBLIC_BASE_URL: string;
  /** Canonical Better Auth origin; defaults to PUBLIC_BASE_URL. */
  readonly BETTER_AUTH_URL?: string;
  /** Comma-separated additional exact trusted origins (never request-derived). */
  readonly BETTER_AUTH_TRUSTED_ORIGINS?: string;
  /** Recording format requested from Telnyx. Defaults to wav. */
  readonly RECORDING_FORMAT?: string;
  /** Optional comma-separated HTTPS host allowlist for recording playback. */
  readonly RECORDING_HOST_ALLOWLIST?: string;
  /**
   * "false" disables server-side transcription of the CALLER's audio.
   * When enabled (default) xAI emits
   * conversation.item.input_audio_transcription.* events, which is the only
   * way to capture the human side of the transcript. Costs extra.
   */
  readonly XAI_INPUT_TRANSCRIPTION?: string;
  /** Default voice id when the caller does not pass one. */
  readonly DEFAULT_VOICE: string;
  /**
   * OVERRIDE for the spoken conference join notice's TTS voice.
   *
   * NORMALLY LEAVE THIS UNSET. The default is derived from the CALL'S OWN agent
   * voice as `xAI.<voice>` (see conferenceNoticeVoice in src/telnyx.ts), so the
   * announcement is spoken in the voice the subject has already been listening
   * to rather than a stranger cutting in mid-conversation. Setting this pins one
   * voice for every call regardless of the agent's.
   *
   * Telnyx's own `<Provider>.<Model>.<VoiceId>` form, NOT an xAI voice id --
   * `xAI.eve`, `Telnyx.KokoroTTS.af`, `AWS.Polly.Joanna-Neural`. DEFAULT_VOICE
   * is the other namespace (a bare xAI id sent over the realtime WebSocket) and
   * the two are not interchangeable.
   *
   * VERIFIED LIVE 2026-08-30 with an armed negative control -- see the block
   * comment on conferenceNoticeVoice for the measurements and, importantly, for
   * what that probe does and does not prove about the conference command.
   */
  readonly CONFERENCE_NOTICE_VOICE?: string;
  /** Public booking page read aloud when no offered time works. Config, not caller input. */
  readonly CALCOM_BOOKING_URL: string;
  // --- Inbound routing ------------------------------------------------------
  /**
   * Comma-separated E.164 numbers whose inbound calls skip follow-me and go
   * straight to the AI as a direct assistant session (the operator calling their own
   * agent). Caller-ID match is a CONVENIENCE, not authentication — caller ID
   * is spoofable, so the direct task must never unlock anything sensitive.
   * Absent/empty: nobody is allowlisted.
   */
  readonly INBOUND_ALLOWLIST?: string;
  /**
   * Comma-separated E.164 follow-me targets, in priority order. Rung one at a
   * time with AMD on the forward leg before the AI fallback. Absent/empty:
   * every non-allowlisted inbound call goes straight to the AI.
   */
  readonly FORWARD_TARGETS?: string;
  /** Seconds to ring each forward target before advancing. Default 20. */
  readonly INBOUND_RING_SECS?: string;
  /**
   * Milliseconds allowed between leg A answering and the call being bridged,
   * before the call is failed rather than left in silence. Default 20000.
   *
   * The default is not a guess. Across the 10 successful calls in the archive
   * on 2026-08-30/31, answered-to-bridged ran 3.65s-6.94s (median ~5.2s), so
   * 20s is ~2.9x the measured worst case -- wide enough that a merely slow
   * call still connects, narrow enough that a broken one stops burning a live
   * caller's patience. Re-measure before tightening it.
   */
  readonly CONNECT_DEADLINE_MS?: string;
  /**
   * Optional. "true" disables webhook signature enforcement. LOCAL DEV ONLY —
   * never set in production. Absent/any-other-value means "verify".
   */
  readonly ALLOW_UNSIGNED_WEBHOOKS?: string;

  // --- Cost model overrides -------------------------------------------------
  /**
   * Optional per-minute (or per-call) rate overrides, in plain USD, e.g. "0.0042".
   *
   * These exist so the built-in list rates in src/cost.ts can be corrected
   * against a REAL provider invoice without a code change. A malformed value is
   * logged and IGNORED in favour of the published rate: a typo here must never
   * become NaN and render every cost in the console as "$NaN".
   *
   * A rate set here is reported with confidence 'override', because its
   * provenance is the operator's invoice rather than a page this code read.
   */
  readonly RATE_XAI_PER_MIN?: string;
  /** Telnyx Call Control, charged PER LEG. This architecture runs two legs. */
  readonly RATE_TELNYX_LEG_PER_MIN?: string;
  /** Telnyx SIP trunking termination. Published as a "starting at" floor. */
  readonly RATE_TELNYX_SIP_PER_MIN?: string;
  readonly RATE_TELNYX_RECORDING_PER_MIN?: string;
  readonly RATE_TELNYX_MEDIA_STREAM_PER_MIN?: string;
  /** Answering-machine detection, charged per CALL rather than per minute. */
  readonly RATE_TELNYX_AMD_PER_CALL?: string;
}

/** Default answered-to-bridged budget. See CONNECT_DEADLINE_MS above. */
export const DEFAULT_CONNECT_DEADLINE_MS = 20_000;

/**
 * Resolve the answered-to-bridged budget.
 *
 * A malformed or out-of-range value falls back to the default rather than
 * throwing or yielding NaN: `scheduler.wait(NaN)` would resolve immediately and
 * fail every call the instant it was answered, which is a far worse outcome
 * than ignoring a typo. Bounded at both ends for the same reason -- 0 would
 * kill every call, and an unbounded value would restore the original bug.
 */
export function connectDeadlineMs(env: Pick<Env, 'CONNECT_DEADLINE_MS'>): number {
  const n = Number.parseInt(env.CONNECT_DEADLINE_MS ?? '', 10);
  return Number.isFinite(n) && n >= 5_000 && n <= 120_000 ? n : DEFAULT_CONNECT_DEADLINE_MS;
}
