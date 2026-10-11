// Durable per-call archive in R2.
//
// WHY THIS EXISTS: a call has only ever existed inside its own Durable Object,
// which is addressed by `idFromName(callId)`. Nothing enumerates those names, so
// closing the console tab lost the callId and with it every way back to the
// call. This module gives the console a listable index of finished calls, and
// gives recordings a home that outlives Telnyx's short-lived signed URLs.
//
// The reducer stays pure: nothing here is imported by src/state.ts. The DO calls
// into this module from the terminal transition and from the recording-archive
// effect.

import { participantBillableMs } from './cost';
import type { Env } from './env';
import { errText, log } from './log';
import { isRecordingUrlAllowed, type RecordingAsset, type RecordingFormat } from './recordings';
import {
  type CallPhase,
  type CallState,
  type ParticipantView,
  participantView,
  type TranscriptEntry,
} from './state';
import { RECORDING_MODES, type RecordingMode } from './types';

/** Key prefix for the JSON call-log records the console lists. */
export const CALL_LOG_PREFIX = 'calls/';
/** Key prefix for archived recording bytes. */
export const RECORDING_PREFIX = 'recordings/';

/**
 * Fixed far-future instant the sort field is subtracted FROM. 2100-01-01T00:00:00Z.
 * Chosen because it is exactly 13 digits, so `KEY_SORT_EPOCH_MS - endedAt` is
 * always 13 digits or fewer for any real call and the zero-pad below is exact.
 */
const KEY_SORT_EPOCH_MS = 4_102_444_800_000;
/** Width of the zero-padded descending sort field. Must match KEY_SORT_EPOCH_MS. */
const KEY_SORT_DIGITS = 13;

/** Longest sanitized recording id kept in an object key (R2 caps keys at 1024 bytes). */
const MAX_RECORDING_ID_CHARS = 96;
/** Longest value written into R2 custom metadata. Keeps the whole map far under R2's 8 KiB. */
const MAX_METADATA_VALUE_CHARS = 120;
/**
 * Longest call subject. Equal to MAX_METADATA_VALUE_CHARS on purpose: the
 * subject's whole job is to survive into custom metadata, so a longer bound
 * here would only be silently cut there.
 */
export const MAX_SUBJECT_CHARS = MAX_METADATA_VALUE_CHARS;
/**
 * Recordings larger than this are not archived. A dual-channel 8 kHz WAV runs
 * about 1.9 MB per minute, so this covers roughly a 50-minute call; anything
 * bigger is more likely a provider anomaly than a real call.
 */
export const MAX_ARCHIVED_RECORDING_BYTES = 100 * 1024 * 1024;

/** One archived recording, as referenced from a call-log record. */
export interface CallLogRecordingRef {
  readonly format: RecordingFormat;
  readonly channels: string;
  /** R2 key holding the audio bytes, or null when archival has not completed. */
  readonly archivedKey: string | null;
}

/**
 * The archived record for one finished call.
 *
 * `schema` is a version tag, not decoration: a record written by an older deploy
 * is read by newer code, exactly like PersistedCallState in src/state.ts.
 *
 * SCHEMA 2 (2026-08-28) added `answeredAt`. Readers MUST stay compatible with
 * schema-1 records, which have no answer instant at all -- there are real calls
 * in the bucket written before it existed, and the cost model reports them with
 * `durationSource: 'total'` instead of inventing a time they answered.
 *
 * SCHEMA 3 (2026-08-29) added `subject`. Same rule: schema-1 and schema-2
 * records carry no subject, and a reader must render them from `task` (see
 * `resolveCallSubject`) rather than assume the field is there.
 *
 * SCHEMA 4 (2026-08-30) added `participants` and, in custom metadata,
 * `participantMs`. Both are absent on older records, where their zero/empty
 * values are correct rather than missing -- see the field comment.
 *
 * Schema 4's participant rows carry `held` and `supervisorRole`, added the same
 * day with hold and the supervisor roles. The tag was NOT bumped for them, on
 * the then-true grounds that schema 4 had never been deployed. IT HAS SINCE
 * BEEN DEPLOYED -- the bucket held 3 schema-4 records when this paragraph was
 * corrected (2026-08-31) -- so that reasoning no longer protects anything and
 * the defensive reads are now the only thing that does. They work: the console
 * renders a missing role as no role and a missing `held` as not held. The
 * lesson is the one this file keeps re-learning: a comment asserting a fact
 * about the BUCKET decays the moment someone deploys, so bump the tag.
 *
 * SCHEMA 5 (2026-08-31) added `recordingMode` and `noticeEnabled` -- the
 * operator's recording DECISION, as opposed to `recorded`, which is the
 * OUTCOME. Before this, a call recorded with the spoken notice switched off
 * was indistinguishable in the archive from one recorded with it on; that fact
 * lived only in Workers log retention and aged out.
 *
 * BOTH READ AS null ON SCHEMA 1-4, MEANING "the writer never recorded this" --
 * NOT "auto" and NOT "notice on". That is deliberate and it is the opposite of
 * what HYDRATED_DEFAULTS does for the same two field names in src/state.ts,
 * which hydrates them to 'auto'/true. The two are answering different
 * questions. Hydration resurrects a LIVE call whose behaviour is produced by
 * running code, and 'auto' reproduces the pre-feature behaviour exactly. This
 * is a PAST call whose operator decision was simply never written down, and
 * the only honest answer is that we do not know it. Every record in the bucket
 * at the time of writing (14, newest ended 05:49:12Z) predates the feature, so
 * 'auto' would even have been true for all of them -- but a call completing
 * between that measurement and this deploy would be a schema-4 record whose
 * real mode was on_demand, and nothing in the record could tell it apart.
 * Three outcomes, never two: recorded-with-notice / recorded-without / unknown.
 *
 * The schema tag alone CANNOT answer "did a human write this label". A schema-3
 * record may still have `subject: null` and be rendered from its task, and a
 * schema-1 record's metadata may hold a derived label written by the backfill.
 * That question is answered by `SubjectSource`, never inferred from the tag.
 */
export interface CallLogRecord {
  readonly schema: 1 | 2 | 3 | 4 | 5;
  readonly callId: string;
  readonly phase: CallPhase;
  readonly direction: CallState['direction'];
  readonly inboundMode: CallState['inboundMode'];
  /**
   * The remote number in full E.164, the same string the console renders.
   *
   * NOT redacted, by operator decision (see the header of src/log.ts).
   *
   * READERS MUST NOT ASSUME THIS IS DIALABLE. Until 2026-08-29 the writer
   * masked this field to country code + last 2 ("+1********00") and the raw
   * digits were never written here at all, so every record archived before
   * that date still holds a masked value and no code change can recover the
   * digits from the archive. Treat this as "whatever the writer stored".
   */
  readonly to: string;
  readonly task: string;
  /**
   * Operator-supplied name for this call ("ACME Medical Center"), or
   * null when none was given.
   *
   * THIS IS THE ONLY FIELD THAT CAN TELL TWO CALLS APART, and that is a
   * measurement rather than a preference. The console's rows previously showed
   * time, number, phase and duration -- all of which two calls to the
   * same switchboard share. The obvious alternative, deriving a label from
   * `task`, was measured against the real corpus that produced the calls now in
   * the bucket: 41 queued calls drew their task from 4 files whose first 120
   * characters collapse to 2 distinct strings (32 + 9), because the operator's
   * per-target name never entered the task at all. A derived label would have
   * rendered 32 rows identically and looked like a fix.
   *
   * Null is therefore a real state, not a defect: `resolveCallSubject` falls
   * back to a derived summary, TAGGED 'derived', which separates DIFFERENT
   * scripts even though it cannot separate two targets sharing one script.
   * The tag is what stops the console presenting that summary as a name a
   * human chose.
   */
  readonly subject: string | null;
  readonly voice: string;
  readonly amdResult: string | null;
  readonly failureReason: string | null;
  readonly inboundFallbackReason: string | null;
  readonly forwardAttempted: number;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly durationMs: number;
  /**
   * When the human leg was answered, or null.
   *
   * Added in schema 2. null means either "this call was never answered" or
   * "this record predates the field"; the two are told apart by `phase` plus
   * the schema version, never guessed. Carriers bill from answer, so this is
   * the difference between a cost estimate and a wrong cost estimate.
   */
  readonly answeredAt: number | null;
  /** Why the call ended, as handed to the teardown effect. */
  readonly teardownReason: string;
  readonly transcript: readonly TranscriptEntry[];
  readonly recordings: readonly CallLogRecordingRef[];
  /**
   * Everyone conferenced onto this call besides the subject and the AI.
   *
   * OPTIONAL IN THE TYPE, and that is not laziness -- it is the same rule
   * `PersistedCallState` enforces in src/state.ts. A schema 1-3 object on disk
   * has no `participants` key at all, so declaring it required would tell every
   * reader the property is there while `record.participants` is `undefined` at
   * runtime, and the first `.map` on it throws. Readers use `?? []`.
   *
   * For those older records the empty list is the FACT rather than a fallback:
   * conference support did not exist, so those calls had no participants. That
   * is why this field needs no backfill, unlike `subject`.
   */
  readonly participants?: readonly ParticipantView[];
  /**
   * What the operator chose about recording, added in schema 5.
   *
   * OPTIONAL FOR THE SAME REASON `participants` IS: a schema 1-4 object on disk
   * has no such key, and declaring it required would tell every reader the
   * value is there while it is `undefined` at runtime.
   *
   * Unlike `participants`, absent here is NOT a fact -- it is ignorance. An old
   * record's empty participant list is true (conferences did not exist); an old
   * record's missing mode is unknown. See the schema-5 paragraph on this type
   * for why that differs from HYDRATED_DEFAULTS in src/state.ts, which hydrates
   * these same two field names to 'auto'/true.
   */
  readonly recordingMode?: RecordingMode | undefined;
  /**
   * Whether the spoken notice was enabled for this call, added in schema 5.
   *
   * Independent of `recordingMode`, exactly as it is at call time: the two
   * answer "is audio kept" and "is anyone told", which are separate questions.
   * This is the field that makes a recording made in silence auditable after
   * the Workers logs have aged out.
   */
  readonly noticeEnabled?: boolean | undefined;
}

/** One row of the console's call-log list, read back from R2 custom metadata. */
export interface CallLogListRow {
  readonly callId: string;
  /**
   * What the call was about.
   *
   * Carried in R2 CUSTOM METADATA for the same reason `answeredAt` is: `list()`
   * returns metadata inline, so a page of rows can name itself without a GET
   * per call. Null on every object written before schema 3 -- POST
   * /api/console/calls/backfill-subjects fills those in.
   *
   * MEANINGLESS WITHOUT `subjectSource`. Read them together, always.
   */
  readonly subject: string | null;
  /**
   * Who authored `subject`, or null when the object cannot say.
   *
   * THIS FIELD EXISTS BECAUSE ITS ABSENCE SHIPPED A REGRESSION. Version
   * 3a7d4f0c wrote both an operator's label and a task-derived fallback into
   * ONE metadata key, so the renderer could not tell them apart and promoted
   * every label to the row's headline. Measured on the 10 archived calls in
   * production: 10 rows, 2 distinct subjects, 8 of them the same boilerplate
   * preamble -- a wall of identical text where the number used to lead.
   *
   * Null is a THIRD state, not a synonym for 'derived': it means the object
   * predates this field and its provenance was never recorded. The renderer
   * treats null exactly as it treats 'derived' (do not promote), which is the
   * safe direction, and the backfill resolves it from the record body. Absent
   * must stay distinguishable from a known value -- the same rule
   * `positiveIntOrNull` enforces for numbers, where collapsing '' into 0 once
   * priced a call at $2,756,368.
   */
  readonly subjectSource: SubjectSource | null;
  readonly phase: CallPhase | 'unknown';
  readonly direction: CallState['direction'] | 'unknown';
  readonly to: string;
  readonly endedAt: number | null;
  readonly durationMs: number | null;
  readonly transcriptEntries: number | null;
  /**
   * Answer instant, or null when unknown.
   *
   * Carried in R2 CUSTOM METADATA on purpose: `list()` returns metadata inline,
   * so the cost rollup can price a whole month from list pages without a GET per
   * call. Fetching every record to read one number would turn a cheap panel into
   * an O(calls) fan-out on a request path.
   */
  readonly answeredAt: number | null;
  /**
   * Summed billable milliseconds across escalation participants, or null when
   * the object never recorded it.
   *
   * NULL AND ZERO MEAN THE SAME THING HERE, unlike answeredAt -- a record
   * written before conference support had no participants to bill. The
   * distinction is kept in the type anyway because `positiveIntOrNull` is the
   * shared reader and collapsing '' to 0 in it is the mistake that once priced
   * a call at $2,756,368.
   */
  readonly participantBillableMs: number | null;
  /** Whether any recording bytes were archived, which decides the recording line. */
  readonly recorded: boolean;
  /** Schema version of the underlying record; 1 means it predates `answeredAt`. */
  readonly schema: number | null;
  /**
   * The operator's recording decision, or null on records written before
   * schema 5. Null is "not written down", never a default -- pairing it with
   * `recorded` above is what separates "recorded on purpose" from "recorded
   * because that is all the code could do".
   */
  readonly recordingMode: RecordingMode | null;
  /** Whether the spoken notice was on; null on pre-schema-5 records. */
  readonly noticeEnabled: boolean | null;
}

export interface CallLogPage {
  readonly calls: readonly CallLogListRow[];
  /** Opaque continuation token, or null when this is the last page. */
  readonly cursor: string | null;
}

/**
 * Build the R2 key for a call-log record.
 *
 * R2 `list()` is ordered LEXICOGRAPHICALLY ASCENDING and there is no reverse
 * option — R2ListOptions is only { limit, prefix, cursor, delimiter, startAfter,
 * include } (verified against the Workers binding API reference and against
 * @cloudflare/workers-types, 2026-08-28). Newest-first therefore has to be baked
 * into the key itself, so the sort field is a DESCENDING clock: a fixed
 * far-future instant minus the call's end time, zero-padded to a fixed width so
 * lexicographic order equals numeric order.
 *
 * DO NOT "fix" this back to a plain timestamp. That would make the first page of
 * the console's call log the OLDEST calls, and there is no server-side way to
 * reverse it short of listing the entire bucket on every request.
 */
export function callLogKey(callId: string, endedAt: number): string {
  const bounded = Number.isFinite(endedAt) ? Math.trunc(endedAt) : 0;
  const clamped = Math.min(Math.max(bounded, 0), KEY_SORT_EPOCH_MS);
  const descending = String(KEY_SORT_EPOCH_MS - clamped).padStart(KEY_SORT_DIGITS, '0');
  return `${CALL_LOG_PREFIX}${descending}-${callId}.json`;
}

/**
 * Recover a call's end time from its archive key.
 *
 * The key's sort field IS the end time, inverted (see callLogKey), so this needs
 * no metadata and no GET. The cost rollup uses it to decide where a window ends
 * even for an object whose custom metadata is missing or was written by a
 * version that did not record it.
 */
export function endedAtFromKey(key: string): number | null {
  if (!key.startsWith(CALL_LOG_PREFIX)) return null;
  const sortField = key.slice(CALL_LOG_PREFIX.length, CALL_LOG_PREFIX.length + KEY_SORT_DIGITS);
  if (!/^[0-9]+$/.test(sortField)) return null;
  const descending = Number(sortField);
  if (!Number.isSafeInteger(descending)) return null;
  const endedAt = KEY_SORT_EPOCH_MS - descending;
  return endedAt >= 0 ? endedAt : null;
}

/**
 * Build the R2 key for one archived recording.
 *
 * `asset.id` is Telnyx's recording_id when it sends one, but falls back to
 * `${format}:${url}` (see recordingAssetFromWebhook), which contains ':' and '/'
 * and would otherwise fabricate directory levels in the key. Strip to a safe
 * character set and keep the TAIL, which is where both a UUID and a URL carry
 * their distinguishing bytes.
 */
export function recordingObjectKey(callId: string, asset: RecordingAsset): string {
  const safe = asset.id.replace(/[^A-Za-z0-9._-]/g, '');
  const tail = safe.slice(-MAX_RECORDING_ID_CHARS);
  const id = tail.length > 0 ? tail : 'recording';
  return `${RECORDING_PREFIX}${callId}/${id}.${asset.format}`;
}

/**
 * Constrain one value before it is stored as R2 custom metadata.
 *
 * MEASURED, not assumed (real bucket, Workers binding, 2026-08-28): R2 ACCEPTS
 * non-ASCII custom metadata and returns it byte-identical — a value containing
 * an em-dash, an accented name and an emoji round-tripped intact. So this is not
 * a correctness workaround for a put that would otherwise fail, and nobody
 * should delete it believing it is.
 *
 * What it actually buys:
 *   - a LENGTH bound. R2 caps total object metadata at 8 KiB, and `to` comes
 *     from the carrier's `from` field on an inbound SIP call, which has no
 *     length we control.
 *   - readability outside the Workers binding. The S3-compatible API carries
 *     custom metadata in `x-amz-meta-*` HTTP headers, where non-ASCII is at the
 *     mercy of whatever client is reading.
 *   - control bytes stripped, which is the genuinely hazardous class.
 */
export function asciiMetadataValue(raw: string): string {
  let out = '';
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    // Printable US-ASCII only: drop control bytes, DEL, and everything above.
    if (code >= 0x20 && code <= 0x7e) out += char;
    if (out.length >= MAX_METADATA_VALUE_CHARS) break;
  }
  return out;
}

/**
 * Best-effort subject for a call that was placed WITHOUT an explicit one.
 *
 * Deliberately modest, because its ceiling was measured rather than hoped for.
 * The task is the operator's script, and a script is reused across targets: in
 * the campaign that produced the calls currently in the bucket, 41 calls drew
 * their task from 4 files, and those files' first sentences collapse to 2
 * distinct strings. So this CANNOT separate two calls that ran the same script
 * -- only an explicit `subject` can. What it does buy is separating DIFFERENT
 * scripts from each other and from ad-hoc calls, which is strictly more than
 * the nothing that was rendered before.
 *
 * Digit runs are passed through unchanged. This string is rendered beside
 * `to`, which is itself a full E.164, so masking a number the operator typed
 * would hide it from the one person who wrote it while the number it was
 * hiding sat unmasked in the next column.
 */
export function deriveCallSubject(task: string): string | null {
  const flat = task.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return null;
  // First sentence, when there is one short enough to be a label. Falling back
  // to a hard cut is intentional: a truncated first sentence still says more
  // than a phase and a duration.
  const stop = flat.search(/[.!?](?:\s|$)/);
  const sentence = stop > 0 ? flat.slice(0, stop + 1) : flat;
  const chosen = sentence.length <= MAX_SUBJECT_CHARS ? sentence : flat.slice(0, MAX_SUBJECT_CHARS);
  const out = chosen.trim();
  return out.length > 0 ? out : null;
}

/**
 * Who authored a call's subject.
 *
 * 'operator' is a label a human typed for THIS call, so it identifies the call.
 * 'derived' is a machine summary of the task, which is a SCRIPT reused across
 * targets -- measured on the corpus that produced the archive, 41 calls drew
 * their task from 4 files whose first sentences collapse to 2 distinct strings.
 * The two are not interchangeable and a renderer must be able to tell them
 * apart, which is exactly what version 3a7d4f0c could not do.
 */
export type SubjectSource = 'operator' | 'derived';

/**
 * A subject and its provenance, which only ever travel together.
 *
 * `source` is null if and only if `text` is null. Anything else would be a
 * label with no accountable author.
 */
export interface ResolvedCallSubject {
  readonly text: string | null;
  readonly source: SubjectSource | null;
}

/**
 * The subject to store or display for a record, AND where it came from.
 *
 * ONE function so the write path, the list projection, the detail projection
 * and the backfill cannot disagree about what a call is called. They have
 * disagreed before -- the list and detail routes once reported two different
 * costs for the same call, in production, because each derived its own.
 *
 * It returns a PAIR, and there is deliberately no single-value variant to
 * reach for. The previous `callSubject` returned the text alone, every
 * projection dutifully carried that one value, and the renderer was left
 * unable to distinguish an operator's label from a machine's guess. Deleting
 * the lossy signature is the fix; a projection that wants a subject now gets
 * its provenance whether it thought to ask or not.
 */
export function resolveCallSubject(record: {
  readonly subject?: string | null | undefined;
  readonly task: string;
}): ResolvedCallSubject {
  const explicit = record.subject?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    return { text: explicit.slice(0, MAX_SUBJECT_CHARS), source: 'operator' };
  }
  const derived = deriveCallSubject(record.task);
  return derived === null ? { text: null, source: null } : { text: derived, source: 'derived' };
}

/** The two keys a JSON projection MUST emit together. Spread it; do not unpack it. */
export interface SubjectProjection {
  readonly subject: string | null;
  readonly subjectSource: SubjectSource | null;
}

/**
 * The subject pair as a spreadable JSON fragment.
 *
 * Every projection that shows a client a subject spreads THIS, so the pair
 * cannot be split by a projection that only remembered the half it wanted.
 */
export function subjectProjection(record: {
  readonly subject?: string | null | undefined;
  readonly task: string;
}): SubjectProjection {
  const resolved = resolveCallSubject(record);
  return { subject: resolved.text, subjectSource: resolved.source };
}

/**
 * Metadata-only token for "this object HAS recorded its provenance, and the
 * answer is that there is no subject at all".
 *
 * It exists so the marker is never the empty string. `subjectSource: ''` would
 * be indistinguishable from an absent key at the read site -- and the backfill
 * decides whether to rewrite an object by whether that key is RECOGNIZED, so an
 * unrecognizable marker would make it rewrite the same object on every run,
 * forever, while reporting each pass as work done.
 *
 * It never reaches a client: `subjectFromMetadata` decodes it to null, which is
 * the same thing the client sees for a genuinely absent subject.
 */
const SUBJECT_SOURCE_NONE = 'none';

/** Every value `subjectSource` metadata may legitimately hold. */
const SUBJECT_SOURCE_TOKENS: ReadonlySet<string> = new Set<string>([
  'operator',
  'derived',
  SUBJECT_SOURCE_NONE,
]);

/**
 * Whether an object's custom metadata already records who wrote its subject.
 *
 * The backfill's skip condition, and the reason it is exported: the route must
 * not decide this for itself. Version 3a7d4f0c's backfill skipped on "subject
 * is non-empty", which is exactly the state a mis-keyed legacy object is in, so
 * re-running it after this change would skip every object it needs to fix.
 */
export function subjectProvenanceRecorded(meta: Record<string, string> | undefined): boolean {
  const raw = meta?.['subjectSource']?.trim();
  return raw !== undefined && SUBJECT_SOURCE_TOKENS.has(raw);
}

/**
 * The subject pair as spreadable R2 custom metadata.
 *
 * Both keys are always written, because R2 custom metadata holds strings only
 * and a key omitted on one write is not cleared by a later one -- it is simply
 * whatever the previous write left there. Writing the pair unconditionally is
 * how a stale value is retracted.
 */
function subjectMetadata(record: {
  readonly subject?: string | null | undefined;
  readonly task: string;
}): { subject: string; subjectSource: string } {
  const resolved = resolveCallSubject(record);
  return {
    subject: asciiMetadataValue(resolved.text ?? ''),
    subjectSource: resolved.source ?? SUBJECT_SOURCE_NONE,
  };
}

/**
 * The subject pair read back OUT of R2 custom metadata.
 *
 * THREE outcomes, never two. An unrecognized or absent `subjectSource` reads as
 * null -- "this object never recorded its provenance" -- and is NOT quietly
 * folded into 'derived', because those are different facts and the backfill
 * treats them differently: unrecorded means migrate, 'derived' means already
 * correct.
 *
 * The text is dropped when the provenance is missing. A label whose author is
 * unknown is exactly the input that produced the regression, and handing it to
 * a renderer as though it were merely un-tagged invites the next renderer to
 * promote it again. The backfill restores both from the record body.
 */
function subjectFromMetadata(meta: Record<string, string>): SubjectProjection {
  const raw = meta['subjectSource']?.trim();
  const source: SubjectSource | null = raw === 'operator' || raw === 'derived' ? raw : null;
  // ONE guard, deliberately, and it is this conditional. An earlier draft also
  // returned early on !subjectProvenanceRecorded(meta), and a negative control
  // showed removing that early return changed NOTHING -- this line was already
  // doing the work. A second guard that cannot be observed to fail is not
  // defence in depth, it is a line no test can hold accountable.
  return {
    subject: source === null ? null : nonEmptyOrNull(meta['subject']),
    subjectSource: source,
  };
}

/** Custom metadata for a call-log object: everything a list row renders. */
function listMetadata(record: CallLogRecord): Record<string, string> {
  return {
    callId: asciiMetadataValue(record.callId),
    phase: asciiMetadataValue(record.phase),
    direction: asciiMetadataValue(record.direction),
    to: asciiMetadataValue(record.to),
    // Both subject keys, or neither. Spread rather than written by hand so a
    // future field added here cannot carry the label without its provenance --
    // which is precisely how the label ended up outranking the number.
    ...subjectMetadata(record),
    endedAt: String(record.endedAt),
    durationMs: String(record.durationMs),
    transcriptEntries: String(record.transcript.length),
    // Everything the cost rollup needs, so it never has to GET the record body.
    schema: String(record.schema),
    answeredAt: record.answeredAt === null ? '' : String(record.answeredAt),
    // Summed participant billable milliseconds, so the LIST route can price a
    // conference call from list metadata alone -- the same reason answeredAt is
    // here. Without it the list and the detail panel would price the same
    // conference call differently, which is a bug this project has already
    // shipped once and does not intend to ship twice.
    participantMs: String(participantBillableMs(record.participants ?? [], record.endedAt)),
    recorded: record.recordings.some((ref) => ref.archivedKey !== null) ? '1' : '0',
    // The DECISION, beside the outcome above. Absent reads as '' rather than a
    // default, so a schema 1-4 object stays legible as "unknown" instead of
    // claiming the operator chose something.
    recordingMode: record.recordingMode ?? '',
    // NOT `? '1' : '0'` -- that collapses `undefined` into '0' and would make
    // every pre-schema-5 record assert the notice was OFF, which is exactly the
    // false-evidence failure this field exists to prevent. Three states, three
    // encodings.
    noticeEnabled: record.noticeEnabled === undefined ? '' : record.noticeEnabled ? '1' : '0',
  };
}

/**
 * Read a non-negative integer out of custom metadata, or null.
 *
 * THE EMPTY STRING MUST BE null, NOT ZERO. R2 custom metadata holds strings
 * only, so an absent number is written as ''. `Number('')` is 0, so the obvious
 * version silently turns "this call was never answered" into "this call was
 * answered at the Unix epoch" -- and the cost model then bills from 1970.
 * Measured before the guard: one such record priced at $2,756,368.
 */
function positiveIntOrNull(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Read a non-empty string out of custom metadata, or null.
 *
 * The sibling of positiveIntOrNull, and it exists for the same reason: R2
 * custom metadata holds strings only, so an absent value arrives as '' and the
 * obvious version would hand the renderer an empty label it would then draw as
 * a blank line. Absent must stay distinguishable from empty.
 */
function nonEmptyOrNull(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Read a recording mode out of custom metadata, or null.
 *
 * VALIDATES against the real enum rather than casting. Metadata is a string map
 * an older or a future writer also touches, so an unrecognised value is
 * "unknown", never a mode the rest of the code will then branch on.
 */
function recordingModeOrNull(raw: string | undefined): RecordingMode | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return (RECORDING_MODES as readonly string[]).includes(trimmed)
    ? (trimmed as RecordingMode)
    : null;
}

/**
 * Read a tri-state flag out of custom metadata: '1' true, '0' false, else null.
 *
 * The sibling of positiveIntOrNull, and it exists for the same reason. The
 * obvious `meta['x'] === '1'` -- which is what `recorded` above correctly does,
 * because for THAT field absent really does mean no -- collapses absent into
 * false. For an evidence field absent means UNKNOWN, and reporting "the notice
 * was off" about a call whose notice setting was never written down is a
 * fabrication with the shape of a fact.
 */
function boolFlagOrNull(raw: string | undefined): boolean | null {
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

const PHASES: ReadonlySet<string> = new Set<CallPhase>([
  'created',
  'dialing_a',
  'a_answered',
  'forwarding',
  'dialing_b',
  'connecting',
  'bridged',
  'completed',
  'failed',
]);

function phaseOrUnknown(raw: string | undefined): CallLogListRow['phase'] {
  return raw !== undefined && PHASES.has(raw) ? (raw as CallPhase) : 'unknown';
}

function directionOrUnknown(raw: string | undefined): CallLogListRow['direction'] {
  return raw === 'outbound' || raw === 'inbound' ? raw : 'unknown';
}

/**
 * Recover the callId from an object key when metadata is missing.
 * Keys are `calls/<13 digits>-<callId>.json`, so the id is everything between
 * the first '-' after the sort field and the extension.
 */
function callIdFromKey(key: string): string {
  const name = key.slice(CALL_LOG_PREFIX.length).replace(/\.json$/, '');
  const dash = name.indexOf('-');
  return dash >= 0 ? name.slice(dash + 1) : name;
}

/**
 * Project one listed R2 object into a console row.
 *
 * Metadata is read defensively for the same reason PersistedCallState exists:
 * an object written by an older deploy can be missing a field a newer reader
 * expects, and a half-rendered row beats a thrown request.
 */
export function listRowFromObject(object: {
  readonly key: string;
  readonly customMetadata?: Record<string, string> | undefined;
}): CallLogListRow {
  const meta = object.customMetadata ?? {};
  return {
    callId: meta['callId'] ?? callIdFromKey(object.key),
    phase: phaseOrUnknown(meta['phase']),
    direction: directionOrUnknown(meta['direction']),
    to: meta['to'] ?? '',
    // '' and undefined both mean "this object never recorded this", and both
    // must read as null rather than as an empty label -- the renderer needs to
    // know it has nothing so it can fall back, instead of drawing a blank line.
    ...subjectFromMetadata(meta),
    endedAt: positiveIntOrNull(meta['endedAt']),
    durationMs: positiveIntOrNull(meta['durationMs']),
    transcriptEntries: positiveIntOrNull(meta['transcriptEntries']),
    // Absent on every object written before schema 2, which is exactly why each
    // of these is read defensively rather than assumed present.
    answeredAt: positiveIntOrNull(meta['answeredAt']),
    participantBillableMs: positiveIntOrNull(meta['participantMs']),
    recorded: meta['recorded'] === '1',
    schema: positiveIntOrNull(meta['schema']),
    recordingMode: recordingModeOrNull(meta['recordingMode']),
    noticeEnabled: boolFlagOrNull(meta['noticeEnabled']),
  };
}

export interface BuildCallLogArgs {
  readonly state: CallState;
  readonly teardownReason: string;
  /** The remote number in full E.164, exactly as dialed. */
  readonly to: string;
  readonly endedAt: number;
  /**
   * R2 keys whose audio bytes the caller has CONFIRMED landed. A recording is
   * reported as available only if its key is in here.
   *
   * This exists because the obvious version was a lie: deriving archivedKey
   * from recordingObjectKey() alone always yields a non-null string, so
   * `available` was unconditionally true even when archiveRecording() had
   * returned null and nothing was stored. A playback button that reports
   * "available" for audio that is not there is worse than one that reports the
   * truth, because the truth is recoverable and the lie is not.
   */
  readonly archivedKeys?: readonly string[] | undefined;
}

/** Assemble the archive record for a finished call. Pure. */
export function buildCallLogRecord(args: BuildCallLogArgs): CallLogRecord {
  const { state } = args;
  const archived = new Set(args.archivedKeys ?? []);
  return {
    schema: 5,
    callId: state.callId,
    // The decision, carried from the live state so the archive can answer
    // "was this recorded in silence" after the Workers logs age out.
    recordingMode: state.recordingMode,
    noticeEnabled: state.noticeEnabled,
    phase: state.phase,
    direction: state.direction,
    inboundMode: state.inboundMode,
    to: args.to,
    task: state.task,
    subject: state.subject,
    voice: state.voice,
    amdResult: state.amdResult,
    failureReason: state.failureReason,
    inboundFallbackReason: state.inboundFallbackReason,
    forwardAttempted: state.forwardAttempted,
    startedAt: state.createdAt,
    endedAt: args.endedAt,
    durationMs: Math.max(0, args.endedAt - state.createdAt),
    answeredAt: state.answeredAt,
    teardownReason: args.teardownReason,
    transcript: state.transcript,
    // The SAME projection the live status route uses, so an operator watching a
    // call end does not see the roster change shape as it hands over to the
    // archive.
    participants: state.participants.map(participantView),
    recordings: state.recordings.map((asset) => {
      const key = recordingObjectKey(state.callId, asset);
      return {
        format: asset.format,
        channels: asset.channels,
        // null when the bytes never landed — see BuildCallLogArgs.archivedKeys.
        archivedKey: archived.has(key) ? key : null,
      };
    }),
  };
}

/**
 * Write one call-log record. Returns true when the object landed.
 *
 * Idempotent by construction: the caller supplies a key derived from the
 * terminal transition, so a retry overwrites the same object with the same
 * content rather than adding a second row to the console's list.
 */
export async function putCallLogRecord(
  bucket: R2Bucket,
  key: string,
  record: CallLogRecord,
): Promise<boolean> {
  try {
    await bucket.put(key, JSON.stringify(record), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: listMetadata(record),
    });
    log('info', 'calllog.write.ok', {
      callId: record.callId,
      phase: record.phase,
      transcriptEntries: record.transcript.length,
    });
    return true;
  } catch (err) {
    // Never fatal. Losing the archive must not change how a call ends.
    log('error', 'calllog.write.failed', { callId: record.callId, error: errText(err) });
    return false;
  }
}

/** Read the archived record at `key`, or null when it is absent or unreadable. */
export async function readCallLogRecord(
  bucket: R2Bucket,
  key: string,
): Promise<CallLogRecord | null> {
  try {
    const object = await bucket.get(key);
    if (!object) return null;
    return (await object.json()) as CallLogRecord;
  } catch (err) {
    log('warn', 'calllog.read.failed', { error: errText(err) });
    return null;
  }
}

/** Maximum list pages scanned when resolving a callId back to its archive key. */
const MAX_ARCHIVE_SCAN_PAGES = 3;

/**
 * Find the archive key for a callId.
 *
 * The key embeds the call's end time, which a caller holding only a callId does
 * not have, so this scans the prefix. Bounded at MAX_ARCHIVE_SCAN_PAGES (3,000
 * objects) because this runs only on the fallback path where the Durable Object
 * has no state, and an unbounded scan on a request path is how a cheap fallback
 * becomes an outage.
 */
export async function findArchiveKey(bucket: R2Bucket, callId: string): Promise<string | null> {
  const suffix = `-${callId}.json`;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_ARCHIVE_SCAN_PAGES; page += 1) {
    const listed: R2Objects = await bucket.list({
      prefix: CALL_LOG_PREFIX,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    const hit = listed.objects.find((object) => object.key.endsWith(suffix));
    if (hit) return hit.key;
    // Trust `truncated`, not the returned count: the docs are explicit that a
    // page can hold fewer than `limit` objects and still have more to come.
    if (!listed.truncated) return null;
    cursor = listed.cursor;
  }
  log('warn', 'calllog.scan.exhausted', { callId });
  return null;
}

/** One page of finished calls, newest first. */
export async function listCallLog(
  bucket: R2Bucket,
  options: { readonly limit: number; readonly cursor?: string | undefined },
): Promise<CallLogPage> {
  const listed: R2Objects = await bucket.list({
    prefix: CALL_LOG_PREFIX,
    limit: options.limit,
    include: ['customMetadata'],
    ...(options.cursor ? { cursor: options.cursor } : {}),
  });
  return {
    calls: listed.objects.map((object) => listRowFromObject(object)),
    cursor: listed.truncated ? listed.cursor : null,
  };
}

/**
 * Copy one recording's bytes from the provider into R2.
 *
 * Telnyx hands us a SIGNED, short-lived URL. Once it expires the console's
 * playback proxy has nothing to fetch and the audio is gone for good, so this is
 * a data-loss fix, not a convenience. Returns the object key on success.
 *
 * The URL is re-checked against the recording host allowlist even though the
 * webhook parser already checked it: this runs later, from stored state, and the
 * allowlist is the only thing standing between a signed webhook and an
 * arbitrary-host fetch.
 */
export async function archiveRecording(
  bucket: R2Bucket,
  asset: RecordingAsset,
  callId: string,
  allowUrl: (url: string) => boolean,
): Promise<string | null> {
  if (!allowUrl(asset.url)) {
    log('warn', 'recording.archive.url_rejected', { callId, format: asset.format });
    return null;
  }
  const key = recordingObjectKey(callId, asset);
  try {
    // Already archived: a redelivered webhook must not re-download the audio.
    const existing = await bucket.head(key);
    if (existing) {
      log('info', 'recording.archive.exists', { callId, format: asset.format });
      return key;
    }
    // 'manual', NOT 'error'. workerd does not implement redirect:'error' and
    // throws a TypeError at the call — which made this whole path a silent
    // no-op until a probe against the real bucket caught it (2026-08-28). Node's
    // fetch DOES implement it, so no unit test could ever have seen this.
    // 'manual' gives us the 3xx as a response, which is what we wanted anyway:
    // the signed URL is a capability, and following a redirect off it would let
    // the provider steer this fetch at an unvetted host.
    const response = await fetch(asset.url, { redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      log('warn', 'recording.archive.redirected', { callId, status: response.status });
      return null;
    }
    if (!response.ok || !response.body) {
      log('warn', 'recording.archive.provider_failed', { callId, status: response.status });
      return null;
    }
    // Require a declared length. R2 needs a known size to accept a stream, and
    // it is also the only way to enforce the cap without buffering the audio.
    const declared = Number(response.headers.get('Content-Length'));
    if (!Number.isFinite(declared) || declared <= 0) {
      log('warn', 'recording.archive.no_length', { callId, format: asset.format });
      return null;
    }
    if (declared > MAX_ARCHIVED_RECORDING_BYTES) {
      log('warn', 'recording.archive.too_large', { callId, bytes: declared });
      return null;
    }
    await bucket.put(key, response.body, {
      httpMetadata: { contentType: asset.format === 'wav' ? 'audio/wav' : 'audio/mpeg' },
      customMetadata: {
        callId: asciiMetadataValue(callId),
        format: asciiMetadataValue(asset.format),
        channels: asciiMetadataValue(asset.channels),
      },
    });
    log('info', 'recording.archive.ok', { callId, format: asset.format, bytes: declared });
    return key;
  } catch (err) {
    log('error', 'recording.archive.failed', { callId, error: errText(err) });
    return null;
  }
}

/**
 * Project an archived record into the same shape the live status endpoint
 * returns, so the console renders a finished call with the code it already has
 * and does not grow a second renderer for archived calls.
 */
export function archivedStatusView(record: CallLogRecord): Record<string, unknown> {
  return {
    callId: record.callId,
    phase: record.phase,
    to: record.to,
    // Resolved with subjectProjection, exactly as the list projection and the
    // live DO status resolve it. These views disagreeing about one call is not
    // hypothetical: they already shipped two different COSTS for the same call
    // to production, and version 3a7d4f0c then shipped a subject whose
    // provenance no view carried at all.
    ...subjectProjection(record),
    task: record.task,
    direction: record.direction,
    inboundMode: record.inboundMode,
    forwardAttempted: record.forwardAttempted,
    inboundFallbackReason: record.inboundFallbackReason,
    voice: record.voice,
    amdResult: record.amdResult,
    failureReason: record.failureReason,
    createdAt: record.startedAt,
    updatedAt: record.endedAt,
    answeredAt: record.answeredAt ?? null,
    // The schema tag has to travel WITH answeredAt. This projection always
    // emits the key, so a reader that infers "this record knows about answer
    // times" from key presence would read a schema-1 null as "never answered"
    // and price a real call at zero -- while the list route, which reads the
    // tag, priced the same call correctly. Two numbers for one call.
    schema: record.schema,
    transcript: record.transcript,
    // Empty on schema 1-3 records, which is accurate: they predate conferences.
    participants: record.participants ?? [],
    // Null on schema 1-4, which is NOT accurate-as-a-fact but accurate-as-an-
    // admission: those records never stored the decision. The detail view must
    // say "unknown" rather than draw a default the operator never chose.
    recordingMode: record.recordingMode ?? null,
    noticeEnabled: record.noticeEnabled ?? null,
    // Precomputed here rather than left to the caller, for the same reason the
    // subject is: every view of one call must price it identically, and the
    // list route reads this number out of metadata rather than out of a roster
    // it does not have.
    participantBillableMs: participantBillableMs(record.participants ?? [], record.endedAt),
    recordings: record.recordings.map((ref) => ({
      format: ref.format,
      channels: ref.channels,
      available: ref.archivedKey !== null,
    })),
    // A finished call has nothing live to monitor, whatever the bindings say.
    monitoring: { available: false, track: 'both_tracks', codec: 'PCMU' },
    archived: true,
  };
}

/** Recording-host policy as a plain predicate, so archiveRecording takes no Env. */
export function recordingUrlGuard(env: Env): (url: string) => boolean {
  return (url: string): boolean => isRecordingUrlAllowed(url, env);
}
