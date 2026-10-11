// The gate that keeps phone-number masking OUT.
//
// WHY A STRUCTURAL TEST AND NOT ONLY A BEHAVIOURAL ONE: masking was removed on
// 2026-08-29 at the operator's explicit request, from TWELVE call sites across
// four files. A behavioural test can only pin the paths that happen to have a
// test today -- and five of those twelve sites live in telnyx.ts, whose dial
// logging no test observes at all. So a future edit could reintroduce
// `redactPhone` there and every suite would stay green.
//
// The decision itself, so a reader does not have to re-derive it: masking to
// country code + last two digits identified nothing. A campaign dials many
// targets sharing an area code, so every row read "+1********00" and the field
// could not answer the only question it existed to answer -- which facility is
// this? The accepted cost is that full E.164 destinations now enter Cloudflare
// Workers log retention and the R2 archive. That is intended, not an oversight.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { asciiMetadataValue } from '../src/call-log';
import { log } from '../src/log';

const SRC = join(import.meta.dirname, '..', 'src');

/** The helpers that were deleted. Naming them is what makes a revival visible. */
const DELETED_HELPERS = ['redactPhone', 'maskDigits', 'maskEmbeddedDigitRuns'] as const;

function srcFiles(): readonly { readonly name: string; readonly text: string }[] {
  return readdirSync(SRC)
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(SRC, name), 'utf8') }));
}

describe('phone numbers are not masked anywhere in src/', () => {
  it('defines none of the deleted masking helpers, in any file', () => {
    const revived = srcFiles().flatMap(({ name, text }) =>
      DELETED_HELPERS.filter((fn) =>
        new RegExp(`function\\s+${fn}\\b|const\\s+${fn}\\s*=`).test(text),
      ).map((fn) => `${name}: ${fn}`),
    );
    expect(revived).toEqual([]);
  });

  it('calls none of them either, which is what covers telnyx.ts', () => {
    // Comments are stripped first: the files legitimately NAME these helpers
    // when explaining why they are gone, and a gate that fires on its own
    // documentation gets deleted by the next person who trips over it.
    const called = srcFiles().flatMap(({ name, text }) => {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      return DELETED_HELPERS.filter((fn) => new RegExp(`\\b${fn}\\s*\\(`).test(code)).map(
        (fn) => `${name}: ${fn}()`,
      );
    });
    expect(called).toEqual([]);
  });

  it('writes a full E.164 into a structured log line', () => {
    // The behavioural half. src/log.ts is the only place a mask could be
    // reapplied to every log line at once, so this asserts the emitted JSON.
    const seen: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((text: string) => {
      seen.push(text);
    });
    log('info', 'call.started', { callId: 'c1', to: '+13154263600' });
    spy.mockRestore();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('"to":"+13154263600"');
    expect(seen[0]).not.toContain('*');
  });
});

describe('the inbound caller is constrained without being masked', () => {
  // Removing redactPhone removed an INCIDENTAL constraint nobody had named.
  // An inbound call sets state.to from the caller's own SIP identity
  // (call-session.ts: caller: args.from -> state.ts: to: params.caller). The
  // webhook signature proves Telnyx sent the event, not that the caller is
  // honest, and the E.164 regex in types.ts guards only the outbound /call
  // body. Three projections then render state.to. The constraint now sits at
  // the boundary instead, so a fourth projection inherits it for free.
  it('passes a real E.164 through byte-identical — this is not masking', () => {
    for (const n of ['+13154263600', '+15555550100', '+442071838750']) {
      expect(asciiMetadataValue(n)).toBe(n);
    }
  });

  it('drops control bytes and non-ASCII from a hostile caller id', () => {
    expect(asciiMetadataValue('+1315\r\nX-Injected: 1')).toBe('+1315X-Injected: 1');
    expect(asciiMetadataValue('+1315\u202e0063624')).toBe('+13150063624');
  });

  it('wires that constraint into the inbound entry point', () => {
    // Structural, because reaching handleInboundStart needs a Durable Object
    // harness this suite does not have. Without it the two tests above pass
    // while the boundary goes unguarded.
    const src = readFileSync(join(SRC, 'call-session.ts'), 'utf8');
    expect(src).toContain('caller: asciiMetadataValue(args.from)');
  });
});
