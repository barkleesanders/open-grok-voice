// Saved operator task presets, stored in the call-log R2 bucket.
//
// A preset is just a NAMED TASK STRING. It is deliberately not a saved
// instruction blob: the prompt is composed server-side by
// `src/instructions.ts`, so what an operator saves and reloads is only ever
// the part they authored. Nothing here can move the identity or guardrails.

import { asciiMetadataValue } from './call-log';
import { errText, log } from './log';

/** Key prefix inside CALL_LOGS. Siblings: `calls/`, `recordings/`. */
export const PRESET_PREFIX = 'presets/';

/** Object-key suffix; also how a key is turned back into a name. */
const PRESET_SUFFIX = '.json';

/** Same ceiling as `CallRequestSchema.task` — a preset IS a task. */
export const MAX_PRESET_TASK_CHARS = 16_000;

export const MAX_PRESET_NAME_CHARS = 64;

/**
 * Upper bound on stored presets.
 *
 * The bucket is shared with the call archive, and `list` is prefix-scanned on
 * every read, so an unbounded preset count would slowly make the console's
 * preset panel expensive. 50 is far past what one operator types by hand.
 */
export const MAX_PRESETS = 50;

/**
 * Names admitted into an object key.
 *
 * An allowlist, not a denylist, because this string is concatenated into an R2
 * key AND rendered in the browser. Excluding `/` is what keeps a name from
 * escaping the `presets/` prefix into `calls/` or `recordings/`; requiring an
 * alphanumeric first character keeps a name from looking like a flag or a
 * dotfile wherever it is later echoed.
 */
const PRESET_NAME_OK = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

export function validPresetName(name: string): boolean {
  return PRESET_NAME_OK.test(name);
}

/** One stored preset. */
export interface PresetRecord {
  readonly name: string;
  readonly task: string;
  /** Epoch ms of the last write. */
  readonly updatedAt: number;
}

/** A preset as the console's list renders it: no task body, so pages stay small. */
export interface PresetSummary {
  readonly name: string;
  readonly updatedAt: number;
  readonly taskChars: number;
}

export function presetKey(name: string): string {
  // Callers MUST have passed validPresetName first; this assertion is the
  // seam where that contract would otherwise be silently assumed.
  if (!validPresetName(name)) throw new Error('invalid preset name');
  return `${PRESET_PREFIX}${name}${PRESET_SUFFIX}`;
}

/** Recover the name from a key, or null when the key is not a preset object. */
export function presetNameFromKey(key: string): string | null {
  if (!key.startsWith(PRESET_PREFIX) || !key.endsWith(PRESET_SUFFIX)) return null;
  const name = key.slice(PRESET_PREFIX.length, key.length - PRESET_SUFFIX.length);
  return validPresetName(name) ? name : null;
}

function summaryMetadata(record: PresetRecord): Record<string, string> {
  return {
    name: asciiMetadataValue(record.name),
    updatedAt: String(record.updatedAt),
    taskChars: String(record.task.length),
  };
}

function positiveIntOr(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * List presets, newest first.
 *
 * The summary is assembled from custom metadata so listing N presets is one
 * R2 `list`, not N `get`s — the same trick `listCallLog` uses for call rows.
 * A row whose metadata is missing still lists, with zeroed counters, because a
 * preset that cannot be summarised must still be loadable and deletable.
 */
export async function listPresets(bucket: R2Bucket): Promise<readonly PresetSummary[]> {
  const listed: R2Objects = await bucket.list({
    prefix: PRESET_PREFIX,
    limit: MAX_PRESETS,
    include: ['customMetadata'],
  });
  const rows: PresetSummary[] = [];
  for (const object of listed.objects) {
    const name = presetNameFromKey(object.key);
    if (!name) continue;
    const meta = object.customMetadata ?? {};
    rows.push({
      name,
      updatedAt: positiveIntOr(meta['updatedAt'], object.uploaded.getTime()),
      taskChars: positiveIntOr(meta['taskChars'], 0),
    });
  }
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  return rows;
}

export async function readPreset(bucket: R2Bucket, name: string): Promise<PresetRecord | null> {
  if (!validPresetName(name)) return null;
  try {
    const object = await bucket.get(presetKey(name));
    if (!object) return null;
    const parsed = (await object.json()) as Partial<PresetRecord>;
    if (typeof parsed.task !== 'string') return null;
    return {
      name,
      task: parsed.task,
      updatedAt:
        typeof parsed.updatedAt === 'number' ? parsed.updatedAt : object.uploaded.getTime(),
    };
  } catch (err) {
    log('warn', 'preset.read.failed', { error: errText(err) });
    return null;
  }
}

export type PresetWriteResult =
  | { readonly ok: true; readonly record: PresetRecord }
  | { readonly ok: false; readonly reason: 'invalid_name' | 'too_many' | 'write_failed' };

/**
 * Create or overwrite one preset.
 *
 * Overwriting an existing name is intentional — that is how an operator edits
 * a preset — so the count check exempts a name that already exists, otherwise
 * hitting the cap would make every existing preset read-only.
 */
export async function writePreset(
  bucket: R2Bucket,
  name: string,
  task: string,
): Promise<PresetWriteResult> {
  if (!validPresetName(name)) return { ok: false, reason: 'invalid_name' };
  const key = presetKey(name);
  try {
    const existing = await bucket.head(key);
    if (!existing) {
      const current = await listPresets(bucket);
      if (current.length >= MAX_PRESETS) return { ok: false, reason: 'too_many' };
    }
    const record: PresetRecord = { name, task, updatedAt: Date.now() };
    await bucket.put(key, JSON.stringify(record), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: summaryMetadata(record),
    });
    log('info', 'preset.write.ok', { taskChars: task.length });
    return { ok: true, record };
  } catch (err) {
    log('error', 'preset.write.failed', { error: errText(err) });
    return { ok: false, reason: 'write_failed' };
  }
}

/** Delete one preset. Returns false only when the delete itself failed. */
export async function deletePreset(bucket: R2Bucket, name: string): Promise<boolean> {
  if (!validPresetName(name)) return false;
  try {
    await bucket.delete(presetKey(name));
    log('info', 'preset.delete.ok', {});
    return true;
  } catch (err) {
    log('error', 'preset.delete.failed', { error: errText(err) });
    return false;
  }
}
