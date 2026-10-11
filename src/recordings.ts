import type { Env } from './env';

export type RecordingFormat = 'wav' | 'mp3';
export type RecordingChannels = 'single' | 'dual';

interface RecordingUrlMap {
  readonly wav?: string | undefined;
  readonly mp3?: string | undefined;
}

export interface RecordingAsset {
  /** Provider recording id; retained in DO state but never sent to the browser. */
  readonly id: string;
  readonly format: RecordingFormat;
  readonly channels: RecordingChannels;
  /** Short-lived provider URL. Playback is proxied, never redirected. */
  readonly url: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
}

export interface RecordingWebhookPayload {
  readonly recording_id?: string | undefined;
  readonly format?: string | undefined;
  readonly channels?: string | undefined;
  readonly recording_started_at?: string | undefined;
  readonly recording_ended_at?: string | undefined;
  readonly recording_urls?: RecordingUrlMap | undefined;
  readonly public_recording_urls?: RecordingUrlMap | undefined;
}

const DEFAULT_RECORDING_HOSTS = ['s3.amazonaws.com', 'amazonaws.com', 'telnyx.com'];

function formatOf(value: string | undefined): RecordingFormat | null {
  return value === 'wav' || value === 'mp3' ? value : null;
}

function channelsOf(value: string | undefined): RecordingChannels | null {
  return value === 'single' || value === 'dual' ? value : null;
}

function validTimestamp(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? value : null;
}

function configuredHosts(env: Env): readonly string[] {
  const configured = (env.RECORDING_HOST_ALLOWLIST ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host.length > 0);
  return configured.length > 0 ? configured : DEFAULT_RECORDING_HOSTS;
}

function hostAllowed(hostname: string, allowed: readonly string[]): boolean {
  return allowed.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

/**
 * Accept only HTTPS URLs on an explicitly configured or known Telnyx storage
 * host. This prevents a signed webhook from turning the playback proxy into a
 * general SSRF endpoint.
 */
export function isRecordingUrlAllowed(raw: string, env: Env): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hostname.length === 0 ||
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '::1' ||
    /^[0-9.]+$/.test(url.hostname)
  ) {
    return false;
  }
  return hostAllowed(url.hostname.toLowerCase(), configuredHosts(env));
}

function urlForFormat(source: RecordingUrlMap | undefined, format: RecordingFormat): string | null {
  const candidate = source?.[format];
  return candidate && candidate.length > 0 ? candidate : null;
}

/** Convert a verified recording-saved payload into one safe, typed asset. */
export function recordingAssetFromWebhook(
  payload: RecordingWebhookPayload,
  env: Env,
): RecordingAsset | null {
  const format = formatOf(payload.format);
  const channels = channelsOf(payload.channels);
  if (!format || !channels) return null;
  const url =
    urlForFormat(payload.recording_urls, format) ??
    urlForFormat(payload.public_recording_urls, format);
  if (!url || !isRecordingUrlAllowed(url, env)) return null;
  const id = payload.recording_id?.trim() || `${format}:${url}`;
  if (id.length === 0 || id.length > 200) return null;
  return {
    id,
    format,
    channels,
    url,
    startedAt: validTimestamp(payload.recording_started_at),
    endedAt: validTimestamp(payload.recording_ended_at),
  };
}
