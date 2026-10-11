import { describe, expect, it } from 'vitest';
import { renderConsolePage } from '../src/console-ui';

function consoleScript(html: string): string {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1])
    .filter((script): script is string => Boolean(script?.trim()));
  const script = scripts[0];
  if (scripts.length !== 1 || script === undefined) {
    throw new Error(`expected exactly one inline script, found ${scripts.length}`);
  }
  return script;
}

const PAGE = renderConsolePage('test-nonce', 'authorized', { name: 'Operator', image: null });
const SCRIPT = consoleScript(PAGE);

describe('schedule controls on the console', () => {
  it('offers a run-at control and a pending list', () => {
    expect(PAGE).toContain('id="call-run-at"');
    expect(PAGE).toContain('type="datetime-local"');
    expect(PAGE).toContain('id="schedule-list"');
    expect(PAGE).toContain('id="schedule-refresh"');
    expect(PAGE).toContain('>Scheduled<');
  });

  it('posts run-at with the call body when set, and omits it when empty', () => {
    expect(SCRIPT).toContain("byId('call-run-at').value");
    expect(SCRIPT).toContain('runAt: Number.isFinite(runAt) ? runAt : undefined');
  });

  it('lists pending jobs and cancels via DELETE', () => {
    expect(SCRIPT).toContain("jsonApi('/api/console/schedules'");
    expect(SCRIPT).toContain(
      "jsonApi('/api/console/schedules/' + encodeURIComponent(job.id), { method: 'DELETE' }",
    );
  });

  it("renders each job's run-at in the JOB's zone, not the viewer's", () => {
    // A bare toLocaleString() shows the VIEWER's zone, so one 2pm job reads as
    // 2pm in California and 5pm in New York with nothing to tell them apart.
    expect(SCRIPT).toContain('job.timeZone');
    expect(SCRIPT).toContain('timeZone: zone');
    expect(SCRIPT).toContain("timeZoneName: 'short'");
    // The ONLY zone-less render left is the catch fallback for an unusable
    // stored zone, which must degrade rather than blank the whole list. Assert
    // that explicitly instead of banning the call outright -- and assert the
    // positions were actually found, since indexOf returns -1 and -1 < n.
    const rowAt = SCRIPT.indexOf("className = 'schedule-row'");
    const endAt = SCRIPT.indexOf('scheduleList.appendChild', rowAt);
    expect(rowAt).toBeGreaterThan(-1);
    expect(endAt).toBeGreaterThan(rowAt);
    const meta = SCRIPT.slice(rowAt, endAt);
    const bare = [...meta.matchAll(/new Date\(job\.runAt\)\.toLocaleString\(\)/g)];
    expect(bare).toHaveLength(1);
    expect(meta.slice(0, bare[0]?.index ?? 0)).toContain('catch (error)');
  });

  it('shows WHY a failed job was refused', () => {
    // Too late / outside calling hours / claim stranded are invisible
    // otherwise: the row would say FAILED and nothing else.
    expect(SCRIPT).toContain('job.failedDetail');
  });

  it('carries no helper subtitle under the run-at field', () => {
    expect(PAGE).not.toContain('Leave blank to dial now');
    expect(PAGE).not.toContain('Eastern time');
  });
});
