// The structural gate on the subject/provenance PAIR.
//
// WHY A STRUCTURAL TEST AND NOT ONLY A BEHAVIOURAL ONE: this repo has now
// shipped the same bug class twice. First the list route and the detail route
// each derived their own COST for a call and disagreed in production. Then
// version 3a7d4f0c threaded a `subject` through four projections and every one
// of them carried the label without its author, so the console could not tell
// an operator's name for a call from a machine's summary of the script -- and
// promoted the summary to the row headline. Measured on the 10 archived calls
// in the production bucket: 10 rows, 2 distinct subjects, 8 of them the same
// 66-character preamble.
//
// A behavioural test proves the FOUR projections that exist today are correct.
// It cannot fail for a FIFTH one that has not been written. These do.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  archivedStatusView,
  buildCallLogRecord,
  type CallLogRecord,
  callLogKey,
  listCallLog,
  listRowFromObject,
  putCallLogRecord,
  resolveCallSubject,
  subjectProjection,
} from '../src/call-log';
import { type CallState, initialState } from '../src/state';
import { createFakeR2 } from './fake-r2';

const T0 = 1_756_000_000_000;
const SRC = join(import.meta.dirname, '..', 'src');

function record(subject: string | null): CallLogRecord {
  const state: CallState = {
    ...initialState({
      callId: 'aaaaaaaa-1111-4111-8111-111111111111',
      to: '+14155550123',
      task: 'Ask the clinic about the referral.',
      voice: 'liora',
      amd: null,
      now: T0,
    }),
    phase: 'completed',
    subject,
    answeredAt: T0 + 5_000,
    updatedAt: T0 + 42_000,
  };
  return buildCallLogRecord({
    state,
    teardownReason: 'leg_A_hangup:normal',
    to: '+14155550123',
    endedAt: state.updatedAt,
  });
}

/**
 * Emission sites that construct a call's INPUT rather than projecting a call
 * OUT to a client. Each is unpaired on purpose: there is no provenance to
 * record because nothing has been resolved yet -- the operator's value is being
 * carried verbatim toward storage.
 *
 * Adding to this list is the deliberate act the gate is designed to require. An
 * entry that stops matching fails too, so a stale exemption cannot accumulate.
 */
const INPUT_CONSTRUCTION: readonly { readonly file: string; readonly line: string }[] = [
  // types.ts: the request schema. This is where an operator's subject ENTERS.
  { file: 'types.ts', line: 'subject: z.string().trim().max(120).optional(),' },
  // index.ts: Worker -> Durable Object start args, carried verbatim.
  { file: 'index.ts', line: 'subject: req.subject ?? null,' },
  // call-session.ts: DO start args -> call state.
  { file: 'call-session.ts', line: 'subject: args.subject ?? null,' },
  // call-session.ts: live registry storage - verbatim copy for enumeration.
  {
    file: 'call-session.ts',
    line: 'const body = (await request.json()) as { callId: string; to: string; subject?: string };',
  },
  { file: 'call-session.ts', line: 'subject: body.subject ?? null,' },
  // state.ts: state construction and the hydration default for a call that was
  // already in flight when the field shipped.
  { file: 'state.ts', line: 'subject: params.subject ?? null,' },
  { file: 'state.ts', line: 'subject: null as string | null,' },
  // call-log.ts: the archive BODY stores the operator's raw value. Provenance
  // is not stored beside it because the body IS the authority -- null here
  // means "no operator subject", which is what the resolver reads.
  { file: 'call-log.ts', line: 'subject: state.subject,' },
  // console-ui.ts: the browser's POST /call payload, the other end of types.ts.
  { file: 'console-ui.ts', line: "subject: byId('call-subject').value.trim() || undefined," },
  // schedule.ts: deferred-job copy of the operator's subject, carried verbatim
  // until fire hands it to startCall. Not a call-log projection.
  { file: 'schedule.ts', line: 'subject: job.subject,' },
  { file: 'schedule.ts', line: '...(job.subject ? { subject: job.subject } : {}),' },
  { file: 'schedule.ts', line: 'subject: req.subject ?? null,' },
  {
    file: 'schedule.ts',
    line: "subject: typeof rec['subject'] === 'string' ? rec['subject'] : null,",
  },
];

/** Every `subject`-keyed line in src/, with enough context to classify it. */
function subjectLines(): readonly {
  readonly file: string;
  readonly lineNo: number;
  readonly text: string;
  readonly window: string;
}[] {
  const out: { file: string; lineNo: number; text: string; window: string }[] = [];
  for (const name of readdirSync(SRC)
    .filter((f) => f.endsWith('.ts'))
    .sort()) {
    const lines = readFileSync(join(SRC, name), 'utf8').split('\n');
    lines.forEach((raw, index) => {
      if (!/(?<![A-Za-z0-9_$])subject\??\s*:/.test(raw)) return;
      out.push({
        file: name,
        lineNo: index + 1,
        text: raw.trim(),
        // The pair is often written across two lines of one object literal, so
        // pairing is judged over a tight window rather than a single line.
        window: lines.slice(Math.max(0, index - 3), index + 4).join('\n'),
      });
    });
  }
  return out;
}

describe('no projection can carry a subject without its provenance', () => {
  it('classifies EVERY subject-keyed line in src/, and fails on one it cannot', () => {
    const lines = subjectLines();
    // Positive control: a regex that matched nothing would pass this whole file
    // vacuously, which is the failure mode the Negative-Result rule exists for.
    expect(lines.length).toBeGreaterThan(10);

    const unmatchedExemptions = INPUT_CONSTRUCTION.filter(
      (entry) => !lines.some((line) => line.file === entry.file && line.text === entry.line),
    );
    expect(unmatchedExemptions).toEqual([]);

    let paired = 0;
    const unclassified: string[] = [];
    for (const line of lines) {
      // A comment describing the field.
      if (/^(\*|\/\/)/.test(line.text)) continue;
      // A type declaration: `readonly subject: T` / `subject?: T`, never an
      // emission. Declaring the field does not project it anywhere.
      if (
        /^(readonly\s+)?subject\??\s*:\s*(string|number|boolean|null|SubjectSource)/.test(line.text)
      )
        continue;
      // An ARGUMENT handed TO the resolver, which is the opposite of an
      // unpaired emission: the caller is asking what the subject and its author
      // are, and receives both. The spread of the result is the emission, and
      // it is on this same line.
      if (/(?:resolveCallSubject|subjectProjection|subjectMetadata)\(\s*\{/.test(line.text)) {
        paired += 1;
        continue;
      }
      // A resolved pair. This is the only shape a projection may use.
      if (/(?<![A-Za-z0-9_$])subjectSource\s*:/.test(line.window)) {
        paired += 1;
        continue;
      }
      // A named, justified input-construction site.
      if (INPUT_CONSTRUCTION.some((e) => e.file === line.file && e.line === line.text)) continue;
      unclassified.push(`${line.file}:${line.lineNo}  ${line.text}`);
    }

    // Positive control on the PAIRED bucket specifically: if the pairing regex
    // silently stopped matching, every real projection would fall through to
    // `unclassified` -- but a future refactor could also legitimately reduce the
    // count, so this asserts only that pairing is still a live category.
    expect(paired).toBeGreaterThan(0);
    expect(unclassified).toEqual([]);
  });

  it('offers no way to resolve a subject without also learning who wrote it', () => {
    // The lossy `callSubject(record): string | null` is deliberately gone. It
    // was the reason four projections could each carry the text alone: it was
    // simply the function that was there to call.
    const exports = readFileSync(join(SRC, 'call-log.ts'), 'utf8');
    expect(exports).not.toMatch(/export function callSubject\b/);
    expect(exports).toMatch(/export function resolveCallSubject\b/);
  });
});

describe('every projection of one call reports the same pair', () => {
  const cases = [
    { name: 'operator subject', subject: 'ECMC Admissions', source: 'operator' },
    { name: 'derived subject', subject: null, source: 'derived' },
  ] as const;

  for (const testCase of cases) {
    it(`list row, archived detail and the shared projector agree (${testCase.name})`, async () => {
      const fake = createFakeR2();
      const rec = record(testCase.subject);
      const key = callLogKey(rec.callId, rec.endedAt);
      await putCallLogRecord(fake.bucket, key, rec);

      const expected = resolveCallSubject(rec);
      expect(expected.source).toBe(testCase.source);

      const listed = (await listCallLog(fake.bucket, { limit: 5 })).calls[0];
      const detail = archivedStatusView(rec);
      const shared = subjectProjection(rec);

      for (const view of [listed, detail, shared] as Record<string, unknown>[]) {
        expect(view['subject']).toBe(expected.text);
        expect(view['subjectSource']).toBe(expected.source);
      }
    });
  }

  it('drops the label when its author was never recorded, rather than passing it on', () => {
    // A projection handed an unattributed label must not hand it onward as a
    // bare string. That is the input that produced the regression, and the next
    // renderer would have no more information than the last one did.
    const row = listRowFromObject({
      key: 'calls/2345678901234-abc.json',
      customMetadata: { callId: 'abc', subject: 'You are an assistant placing a call.' },
    });
    expect(row.subject).toBeNull();
    expect(row.subjectSource).toBeNull();
  });
});
