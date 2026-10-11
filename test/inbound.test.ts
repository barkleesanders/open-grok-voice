import { describe, expect, it } from 'vitest';
import {
  type InboundConfig,
  inboundTask,
  isVoicemail,
  nextInboundAction,
  usableTargets,
} from '../src/inbound';

const OWN = '+15555550100';
const CFG: InboundConfig = {
  forwardTargets: ['+15555550123', '+14155550111'],
  ringSecs: 20,
  ownNumber: OWN,
};

describe('usableTargets — the loop guard', () => {
  it('refuses to forward to our OWN number', () => {
    // Forwarding to ourselves re-enters this same flow: an unbounded billing
    // loop that presents as a hung call.
    const cfg = { ...CFG, forwardTargets: [OWN, '+15555550123'] };
    expect(usableTargets(cfg)).toEqual(['+15555550123']);
  });

  it('drops malformed numbers and de-duplicates', () => {
    const cfg = {
      ...CFG,
      forwardTargets: ['not-a-number', '', '+15555550123', '+15555550123', '555'],
    };
    expect(usableTargets(cfg)).toEqual(['+15555550123']);
  });

  it('preserves the configured ORDER — it is a priority list', () => {
    expect(usableTargets(CFG)).toEqual(['+15555550123', '+14155550111']);
  });
});

describe('nextInboundAction — the follow-me ladder', () => {
  it('rings the first target on a fresh call', () => {
    expect(nextInboundAction(CFG, { attempted: 0 })).toEqual({
      kind: 'ring',
      to: '+15555550123',
      index: 0,
      timeoutSecs: 20,
    });
  });

  it('advances to the second target after the first goes unanswered', () => {
    const a = nextInboundAction(CFG, { attempted: 1, answered: false });
    expect(a).toMatchObject({ kind: 'ring', to: '+14155550111', index: 1 });
  });

  it('bridges immediately when a HUMAN answers', () => {
    const a = nextInboundAction(CFG, { attempted: 1, answered: true, amdResult: 'human' });
    expect(a).toEqual({ kind: 'bridge_human', to: '+15555550123' });
  });

  // THE BUG THIS PREVENTS: a phone that is off sends the call to its own
  // voicemail, which the carrier reports as "answered". Without the AMD check
  // the caller is bridged into a voicemail beep and the AI never runs.
  it('does NOT bridge when the "answer" was a voicemail — it keeps going', () => {
    const a = nextInboundAction(CFG, { attempted: 1, answered: true, amdResult: 'machine' });
    expect(a).not.toMatchObject({ kind: 'bridge_human' });
    expect(a).toMatchObject({ kind: 'ring', to: '+14155550111' });
  });

  it('positive control — same state but amd=human DOES bridge', () => {
    // Proves the rejection above is caused by the AMD verdict alone.
    const a = nextInboundAction(CFG, { attempted: 1, answered: true, amdResult: 'human' });
    expect(a).toMatchObject({ kind: 'bridge_human' });
  });

  it('treats fax and silence as not-a-human too', () => {
    for (const amd of ['machine', 'fax_detected', 'silence']) {
      expect(isVoicemail(amd), amd).toBe(true);
    }
    for (const amd of ['human', 'human_residence', 'human_business', 'not_sure', null, undefined]) {
      expect(isVoicemail(amd), String(amd)).toBe(false);
    }
  });

  it('falls back to the AI once every target is exhausted', () => {
    expect(nextInboundAction(CFG, { attempted: 2, answered: false })).toEqual({
      kind: 'ai_fallback',
      reason: 'all_targets_exhausted',
    });
  });

  it('reports voicemail as the reason when the LAST target was a machine', () => {
    const a = nextInboundAction(CFG, { attempted: 2, answered: true, amdResult: 'machine' });
    expect(a).toEqual({ kind: 'ai_fallback', reason: 'target_was_voicemail' });
  });

  it('goes straight to the AI when nothing is configured', () => {
    const empty = { ...CFG, forwardTargets: [] };
    expect(nextInboundAction(empty, { attempted: 0 })).toEqual({
      kind: 'ai_fallback',
      reason: 'no_targets_configured',
    });
  });

  it('goes straight to the AI when the only target is our own number', () => {
    const selfOnly = { ...CFG, forwardTargets: [OWN] };
    expect(nextInboundAction(selfOnly, { attempted: 0 })).toMatchObject({ kind: 'ai_fallback' });
  });

  it('TERMINATES — driving the loop to completion never cycles', () => {
    // A follow-me that can re-ring a target it already tried bills forever.
    let state = { attempted: 0 } as { attempted: number; answered?: boolean };
    const rung: string[] = [];
    for (let i = 0; i < 50; i++) {
      const a = nextInboundAction(CFG, state);
      if (a.kind !== 'ring') {
        expect(a.kind).toBe('ai_fallback');
        break;
      }
      rung.push(a.to);
      state = { attempted: state.attempted + 1, answered: false };
    }
    expect(rung).toEqual(['+15555550123', '+14155550111']);
    expect(new Set(rung).size).toBe(rung.length);
  });
});

describe('inboundTask — not the outbound prompt', () => {
  it('frames the call as inbound and never implies we called them', () => {
    const t = inboundTask(null);
    expect(t).toContain('INBOUND');
    expect(t).toContain('you did not call them');
    expect(t.toLowerCase()).not.toContain('you are placing an outbound');
  });

  it('takes a message and does not promise a callback time', () => {
    const t = inboundTask(null);
    expect(t).toContain('take a message');
    expect(t).toContain('Do not promise when the operator will call back');
  });

  it('mentions scheduling only when availability exists', () => {
    expect(inboundTask(null)).not.toContain('offer a time');
    expect(inboundTask('AVAILABILITY: ...')).toContain('offer a time');
  });
});
