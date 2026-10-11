import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { app } from '../src/index';
import {
  deletePreset,
  listPresets,
  MAX_PRESETS,
  presetKey,
  presetNameFromKey,
  readPreset,
  validPresetName,
  writePreset,
} from '../src/presets';
import { createFakeR2, type FakeR2 } from './fake-r2';
import { testEnv } from './test-env';

describe('preset names are an allowlist, because the name becomes an object key', () => {
  it('admits ordinary operator names', () => {
    for (const name of ['Dentist', 'dentist reschedule', 'VA_claim-2026', 'a', 'Plan 9.beta']) {
      expect(validPresetName(name), name).toBe(true);
    }
  });

  it('rejects anything that could escape the presets/ prefix or confuse a reader', () => {
    const hostile = [
      '',
      '../calls/evil',
      'a/b',
      '.hidden',
      '-flag',
      ' leading-space',
      'newline\nname',
      'tab\tname',
      'emoji \u{1F600}',
      '<script>',
      'a'.repeat(65),
    ];
    for (const name of hostile) {
      expect(validPresetName(name), JSON.stringify(name)).toBe(false);
    }
  });

  it('round-trips a valid name through its key and refuses to build a key for a bad one', () => {
    expect(presetKey('Dentist call')).toBe('presets/Dentist call.json');
    expect(presetNameFromKey('presets/Dentist call.json')).toBe('Dentist call');
    expect(presetNameFromKey('calls/00000.json')).toBeNull();
    expect(presetNameFromKey('presets/notjson')).toBeNull();
    expect(() => presetKey('../calls/x')).toThrow();
  });
});

describe('preset storage', () => {
  it('saves, lists, reads back, and deletes', async () => {
    const r2 = createFakeR2();
    const saved = await writePreset(r2.bucket, 'Dentist', 'Reschedule the cleaning.');
    expect(saved.ok).toBe(true);

    const listed = await listPresets(r2.bucket);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.name).toBe('Dentist');
    expect(listed[0]?.taskChars).toBe('Reschedule the cleaning.'.length);

    const read = await readPreset(r2.bucket, 'Dentist');
    expect(read?.task).toBe('Reschedule the cleaning.');

    expect(await deletePreset(r2.bucket, 'Dentist')).toBe(true);
    expect(await listPresets(r2.bucket)).toHaveLength(0);
    expect(await readPreset(r2.bucket, 'Dentist')).toBeNull();
  });

  it('writes under the presets/ prefix only, never beside the call archive', async () => {
    const r2 = createFakeR2();
    await writePreset(r2.bucket, 'Dentist', 'x');
    expect(r2.keys()).toEqual(['presets/Dentist.json']);
  });

  it('overwrites in place rather than adding a second row', async () => {
    const r2 = createFakeR2();
    await writePreset(r2.bucket, 'Dentist', 'first');
    await writePreset(r2.bucket, 'Dentist', 'second');
    expect(await listPresets(r2.bucket)).toHaveLength(1);
    expect((await readPreset(r2.bucket, 'Dentist'))?.task).toBe('second');
  });

  it('lists newest first, not lexicographically', async () => {
    const r2 = createFakeR2();
    // R2 returns keys in ascending lexicographic order, so "Alpha" would lead
    // by key while "Zulu" is the more recently touched preset.
    await writePreset(r2.bucket, 'Alpha', 'a');
    await new Promise((resolve) => setTimeout(resolve, 3));
    await writePreset(r2.bucket, 'Zulu', 'z');
    const listed = await listPresets(r2.bucket);
    expect(listed.map((row) => row.name)).toEqual(['Zulu', 'Alpha']);
  });

  it('caps new presets but still lets an existing one be edited at the cap', async () => {
    const r2 = createFakeR2();
    for (let index = 0; index < MAX_PRESETS; index += 1) {
      const result = await writePreset(r2.bucket, `p${String(index).padStart(3, '0')}`, 'x');
      expect(result.ok).toBe(true);
    }
    const overflow = await writePreset(r2.bucket, 'one-too-many', 'x');
    expect(overflow).toEqual({ ok: false, reason: 'too_many' });

    // The cap must not turn the existing presets read-only.
    const edit = await writePreset(r2.bucket, 'p000', 'edited');
    expect(edit.ok).toBe(true);
    expect((await readPreset(r2.bucket, 'p000'))?.task).toBe('edited');
  });

  it('does not write anything for an invalid name', async () => {
    const r2 = createFakeR2();
    expect(await writePreset(r2.bucket, '../calls/x', 'x')).toEqual({
      ok: false,
      reason: 'invalid_name',
    });
    expect(r2.keys()).toHaveLength(0);
  });

  it('reports a write failure instead of throwing', async () => {
    const r2 = createFakeR2();
    r2.failNext('put', 1);
    expect(await writePreset(r2.bucket, 'Dentist', 'x')).toEqual({
      ok: false,
      reason: 'write_failed',
    });
  });
});

describe('preset routes', () => {
  function envWith(r2: FakeR2): Env {
    return testEnv({ CALL_LOGS: r2.bucket });
  }
  async function request(path: string, init: RequestInit, env: Env): Promise<Response> {
    return app.fetch(new Request(`https://bridge.example.test${path}`, init), env);
  }

  it('rejects every anonymous verb before it reaches the bucket', async () => {
    const r2 = createFakeR2();
    const env = envWith(r2);
    const cases: ReadonlyArray<readonly [string, RequestInit]> = [
      ['/api/console/presets', {}],
      ['/api/console/presets/Dentist', {}],
      [
        '/api/console/presets/Dentist',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ task: 'x' }),
        },
      ],
      ['/api/console/presets/Dentist', { method: 'DELETE' }],
    ];
    for (const [path, init] of cases) {
      const response = await request(path, init, env);
      expect(response.status, `${init.method ?? 'GET'} ${path}`).toBe(401);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    }
    // The gate ran before any storage did.
    expect(r2.keys()).toHaveLength(0);
    expect(r2.putCount()).toBe(0);
  });

  it('never answers 500 when the bucket is unbound', async () => {
    const response = await request('/api/console/presets', {}, testEnv());
    // Auth fails first for an anonymous caller; the point is that an absent
    // binding degrades rather than throwing.
    expect([401, 503]).toContain(response.status);
  });
});
