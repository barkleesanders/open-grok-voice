// The console surfaces cost and a working transport, and does it without
// weakening the page's CSP.

import { describe, expect, it } from 'vitest';
import { renderConsolePage } from '../src/console-ui';
import { TRAILING_WINDOW_DAYS } from '../src/cost-rollup';

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

/**
 * The body of one arrow function in the console script, by brace matching.
 *
 * A fixed-character window around a match would pass on a line that merely
 * MENTIONS the thing; scoping to the real function body is what makes
 * "is it rendered here, and is it rendered unconditionally" answerable.
 * Unbalanced braces throw rather than returning a truncated body that would
 * quietly weaken every assertion made against it.
 */
function functionBody(script: string, declaration: string): string {
  const at = script.indexOf(declaration);
  if (at < 0) throw new Error(`${declaration} not found in the console script`);
  const open = script.indexOf('{', at);
  if (open < 0) throw new Error(`${declaration} has no body`);
  let depth = 0;
  for (let i = open; i < script.length; i += 1) {
    if (script[i] === '{') depth += 1;
    else if (script[i] === '}') {
      depth -= 1;
      if (depth === 0) return script.slice(open, i + 1);
    }
  }
  throw new Error(`${declaration} has unbalanced braces`);
}

/** Brace depth at an offset within a body, counting the body's own brace as 1. */
function depthAt(body: string, offset: number): number {
  let depth = 0;
  for (let i = 0; i <= offset; i += 1) {
    if (body[i] === '{') depth += 1;
    else if (body[i] === '}') depth -= 1;
  }
  return depth;
}

describe('cost panel', () => {
  it('renders a period selector covering day, week, month and year', () => {
    expect(PAGE).toContain('id="cost-window"');
    for (const window of ['day', 'week', 'month', 'year']) {
      expect(PAGE).toContain(`value="${window}"`);
    }
    expect(PAGE).toContain('id="cost-summary"');
    expect(PAGE).toContain('id="cost-series"');
    expect(PAGE).toContain('id="call-cost"');
  });

  it('queries the costs endpoint with the selected window', () => {
    const script = consoleScript(PAGE);
    expect(script).toContain('/api/console/costs?window=');
  });

  it('labels the forecast with its method rather than printing a bare number', () => {
    // A projection shown next to measured figures reads as measured unless the
    // method is on screen with it.
    const script = consoleScript(PAGE);
    expect(script).toContain('forecast.method');
    expect(script).toContain('not enough data');
  });

  it('renders the trailing-window total among the cost lines', () => {
    const body = functionBody(consoleScript(PAGE), 'const renderCostRollup =');
    expect(body).toContain('trailing30');
    expect(body).toContain("'Last '");
    // The number the operator reads has to be the trailing USD, not a
    // relabelled copy of the period total.
    expect(body).toContain('costLine(trailingLabel, trailing.usd)');
    // Server horizon and the UI's malformed-payload fallback must not drift.
    expect(body).toContain(`trailing.days || ${TRAILING_WINDOW_DAYS}`);
  });

  it('renders it for EVERY window, at the same nesting as the other cost lines', () => {
    // The design decision, asserted: no "the period looks young" gate. Any such
    // gate would need a threshold, and there is no measured behaviour to set one
    // from. Nesting depth is how a gate would show up -- an `if` wrapper puts the
    // append one level deeper than its unconditional siblings.
    const body = functionBody(consoleScript(PAGE), 'const renderCostRollup =');
    const trailingAt = body.indexOf('costLine(trailingLabel');
    const averageAt = body.indexOf("costLine('Average per call'");
    expect(trailingAt).toBeGreaterThan(-1);
    expect(averageAt).toBeGreaterThan(-1);
    expect(depthAt(body, trailingAt)).toBe(depthAt(body, averageAt));
  });

  it('surfaces loose durations, truncation and rate staleness', () => {
    const script = consoleScript(PAGE);
    // Each of these is a way the number can be less solid than it looks, so
    // each has to be sayable in the UI.
    expect(script).toContain('looseDurationCalls');
    expect(script).toContain('truncated');
    expect(script).toContain('rateConfidence');
    expect(script).toContain('FLOOR');
  });
});

describe('recording transport', () => {
  it('preloads metadata so the scrub bar is live before playback starts', () => {
    // With preload='none' the browser knows no duration until play is pressed,
    // so the slider is dead even against a server that answers ranges.
    const script = consoleScript(PAGE);
    expect(script).toContain("audio.preload = 'metadata'");
    expect(script).not.toContain("audio.preload = 'none'");
  });

  it('ships a seek bar, skip controls and a speed control', () => {
    const script = consoleScript(PAGE);
    expect(script).toContain('transport-bar');
    expect(script).toContain('-10s');
    expect(script).toContain('+10s');
    expect(script).toContain('playbackRate');
    expect(script).toContain('currentTime');
  });

  it('reports whether the response is actually seekable', () => {
    // Honest failure: if the server ever stops answering ranges, the bar says
    // so instead of silently ignoring clicks -- which is how the original bug
    // went unnoticed.
    const script = consoleScript(PAGE);
    expect(script).toContain('audio.seekable');
  });
});

describe('CSP is not weakened for any of this', () => {
  it('keeps a nonce-only script-src and loads no third-party script', () => {
    // A CDN player (wavesurfer, Plyr, howler) would need script-src widened on
    // an authenticated page showing call transcripts and recordings. It also
    // would not have fixed seeking, which is a server-side range problem.
    expect(PAGE).toContain("script-src 'nonce-test-nonce'");
    expect(PAGE).toContain("default-src 'none'");
    expect(PAGE).toContain("media-src 'self'");
    expect(PAGE).not.toMatch(/<script[^>]+\bsrc=/);
    expect(PAGE).not.toContain('unsafe-inline');
    expect(PAGE).not.toContain('unsafe-eval');
    expect(PAGE).not.toContain('cdn.jsdelivr.net');
    expect(PAGE).not.toContain('unpkg.com');
    expect(PAGE).not.toContain('cdnjs.cloudflare.com');
  });

  it('still parses as one self-contained script', () => {
    const script = consoleScript(PAGE);
    expect(() => new Function(script)).not.toThrow();
    // Balance check: an unclosed brace would make the appended '}' legal.
    expect(() => new Function(`${script} }`)).toThrow(SyntaxError);
  });
});

describe('cost per minute in the console', () => {
  const body = () => functionBody(consoleScript(PAGE), 'const renderCostRollup =');

  it('renders the rate with the 4-decimal formatter, never money()', () => {
    // money() prints 0.0983 as "$0.10" and the 0.0925 floor as "$0.09" -- the
    // same string for a 6% overage. Passing `perMinute` is what keeps the row
    // and the floor note comparable, so pin the ARGUMENT, not just the label.
    expect(body()).toContain("costLine('Cost per minute', data.usdPerMinute, perMinute)");

    const fmt = functionBody(consoleScript(PAGE), 'const perMinute =');
    expect(fmt).toContain('toFixed(4)');
    expect(fmt).not.toContain('toFixed(2)');
  });

  it('says "no answered minutes" rather than $0.0000/min when nothing answered', () => {
    // A window of rang-out calls has calls > 0 and zero billable minutes. The
    // backend sends null there; rendering a zero rate would state a measured
    // price of zero, which is a different claim from "nothing to measure".
    const rendered = body();
    expect(rendered).toContain('no answered minutes');
    expect(rendered).toContain("typeof data.usdPerMinute === 'number'");
  });

  it('shows the two-party floor so the rate has a reference frame', () => {
    const rendered = body();
    expect(rendered).toContain('data.usdPerMinuteFloor');
    expect(rendered).toContain('data.usdPerMinuteFloorXai');
    // Derived and sent by the backend -- a literal here would keep rendering
    // after a rate change and silently compare against a dead price.
    expect(rendered).not.toContain('0.0925');
  });
});
