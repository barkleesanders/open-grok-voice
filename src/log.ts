// Structured JSON logging.
//
// Every log line is a single JSON object so Cloudflare's log pipeline (and
// `wrangler tail`) can filter on fields instead of regexing prose. One rule:
//   1. Secrets NEVER appear in a log line. Not even truncated.
//
// PHONE NUMBERS ARE NOT REDACTED, here or anywhere else in this worker, and
// that is a deliberate operator decision taken 2026-08-29 with the trade-off
// stated: full E.164 destinations now enter Cloudflare Workers log retention
// and the R2 call-log archive. The reason is that masking did not survive
// contact with the job. A campaign dials many targets that share a country
// code and an area code, so "+1********00" identifies nothing -- the operator
// could not tell which facility a row or a log line referred to, which is the
// entire purpose of having the field. Redaction that cannot be read is cost
// without benefit.
//
// Do NOT reintroduce masking without the operator asking for it.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Fields safe to serialize into a log line. */
export type LogValue = string | number | boolean | null | undefined;

export interface LogFields {
  readonly [key: string]: LogValue;
}

/**
 * Emit one structured log line.
 *
 * `event` is a stable dotted identifier (e.g. "telnyx.dial.ok"), NOT a
 * human sentence, so log queries stay stable as wording changes.
 */
export function log(level: LogLevel, event: string, fields: LogFields = {}): void {
  const line: Record<string, LogValue> = {
    level,
    event,
    ts: new Date().toISOString(),
    ...fields,
  };
  const text = JSON.stringify(line);
  if (level === 'error') console.error(text);
  else if (level === 'warn') console.warn(text);
  else console.log(text);
}

/** Normalize an unknown thrown value into a loggable message. */
export function errText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  if (typeof err === 'string') return err;
  return 'non-error thrown';
}
