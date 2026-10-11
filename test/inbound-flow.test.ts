// Wiring tests for the INBOUND call leg: direction discrimination at the
// webhook boundary, and the reducer sequences for both inbound modes
// (allowlisted direct-to-AI, and follow-me with AMD on the forward leg).
//
// The follow-me DECISIONS themselves are covered in test/inbound.test.ts
// against the pure core; this file proves the core is actually WIRED — that a
// Telnyx event stream drives it and the right effects come out in order.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RING_SECS,
  directInboundTask,
  isAllowlistedCaller,
  parseNumberList,
  ringSecsFromEnv,
} from '../src/inbound';
import { telnyxEventToCallEvent } from '../src/index';
import {
  type CallEffect,
  type CallEvent,
  type CallState,
  initialInboundState,
  reduce,
} from '../src/state';
import { inboundInitiated, TelnyxWebhookSchema } from '../src/types';
import { readUtf8 } from './read-utf8';

const T0 = 1_700_000_000_000;

/** SYNTHETIC captured-shape fixture — see the __note__ inside it. */
const initiatedFixture: unknown = JSON.parse(
  readUtf8(import.meta.url, '../src/__fixtures__/telnyx/call-initiated-incoming.json'),
);

function run(
  state: CallState,
  events: readonly CallEvent[],
): { state: CallState; effects: CallEffect[] } {
  let s = state;
  const all: CallEffect[] = [];
  for (const e of events) {
    const r = reduce(s, e);
    s = r.state;
    all.push(...r.effects);
  }
  return { state: s, effects: all };
}

const CALLER = '+16075550100';
const TARGET_1 = '+15555550123';
const TARGET_2 = '+14155550111';
const OWN = '+15555550100';

function inbound(mode: 'direct' | 'follow_me', targets: readonly string[] = [TARGET_1, TARGET_2]) {
  return initialInboundState({
    callId: 'in-1',
    caller: CALLER,
    ownNumber: OWN,
    legA: 'legA-caller',
    mode,
    forwardTargets: targets,
    ringSecs: 20,
    task: mode === 'direct' ? directInboundTask() : 'take a message',
    voice: 'liora',
    now: T0,
  });
}

const callerAnswered: CallEvent = { type: 'leg_a_answered', at: T0 + 1 };

describe('direction discrimination at /telnyx-webhook', () => {
  it('parses the (synthetic) incoming call.initiated fixture end to end', () => {
    const parsed = TelnyxWebhookSchema.parse(initiatedFixture);
    const inb = inboundInitiated(parsed.data.event_type, parsed.data.payload);
    expect(inb).toEqual({
      callControlId: 'v3:TnlwYWxJTlBOVGdmS0ZDcmpsZFhRRW53WWpsTUlJVGxjTFZOSTBnV1hpUT0',
      from: '+15555550123',
      to: '+15555550100',
    });
  });

  it('REGRESSION: call.initiated on legs WE dialed still maps to nothing', () => {
    // Outbound legs carry client_state, so they reach telnyxEventToCallEvent —
    // which must keep ignoring their call.initiated, exactly as before.
    for (const leg of ['A', 'B', 'F'] as const) {
      expect(
        telnyxEventToCallEvent(
          { callId: 'c1', leg },
          'call.initiated',
          { call_control_id: 'cc-1' },
          T0,
        ),
      ).toBeNull();
    }
  });

  it('ignores an OUTGOING call.initiated with no client_state', () => {
    expect(
      inboundInitiated('call.initiated', {
        direction: 'outgoing',
        call_control_id: 'cc-1',
        from: OWN,
        to: CALLER,
      }),
    ).toBeNull();
  });

  it('ignores other event types and unroutable payloads', () => {
    const good = { direction: 'incoming', call_control_id: 'cc-1', from: CALLER, to: OWN };
    expect(inboundInitiated('call.answered', good)).toBeNull();
    expect(inboundInitiated('call.initiated', { ...good, call_control_id: undefined })).toBeNull();
    expect(inboundInitiated('call.initiated', { ...good, from: undefined })).toBeNull();
    expect(inboundInitiated('call.initiated', good)).not.toBeNull();
  });
});

describe('telnyxEventToCallEvent — forward leg (F) mapping', () => {
  it('maps answered / AMD / hangup with the leg id attached', () => {
    expect(
      telnyxEventToCallEvent(
        { callId: 'c1', leg: 'F' },
        'call.answered',
        { call_control_id: 'ccF' },
        T0,
      ),
    ).toEqual({
      type: 'forward_answered',
      legF: 'ccF',
      at: T0,
    });
    expect(
      telnyxEventToCallEvent(
        { callId: 'c1', leg: 'F' },
        'call.machine.detection.ended',
        { call_control_id: 'ccF', result: 'machine' },
        T0,
      ),
    ).toEqual({ type: 'forward_amd', legF: 'ccF', result: 'machine', at: T0 });
    expect(
      telnyxEventToCallEvent(
        { callId: 'c1', leg: 'F' },
        'call.hangup',
        { call_control_id: 'ccF', hangup_cause: 'timeout' },
        T0,
      ),
    ).toEqual({ type: 'forward_hangup', legF: 'ccF', cause: 'timeout', at: T0 });
  });

  it('drops an F event with no call_control_id — it cannot be attributed', () => {
    expect(telnyxEventToCallEvent({ callId: 'c1', leg: 'F' }, 'call.answered', {}, T0)).toBeNull();
  });
});

describe('inbound DIRECT mode — allowlisted caller straight to the AI', () => {
  it('classifies the caller by exact E.164 match', () => {
    expect(isAllowlistedCaller(CALLER, [CALLER, TARGET_1])).toBe(true);
    expect(isAllowlistedCaller('+19995550000', [CALLER])).toBe(false);
    expect(isAllowlistedCaller(CALLER, [])).toBe(false);
  });

  it('dials leg B on answer and reuses the whole outbound connect machinery', () => {
    const { state, effects } = run(inbound('direct'), [
      callerAnswered,
      { type: 'leg_b_dialed', legB: 'legB-xai', at: T0 + 2 },
      { type: 'leg_b_answered', at: T0 + 3 },
      { type: 'xai_incoming', xaiCallId: 'xai-1', at: T0 + 4 },
      { type: 'xai_session_ready', at: T0 + 5 },
    ]);
    expect(effects.filter((e) => e.type === 'dial_leg_b')).toHaveLength(1);
    // Direct inbound reaches the AI through the SAME path as an outbound call,
    // so it gets the conference too -- which means an allowlisted caller can
    // also have a third party conferenced in. Leg B creates it for the same
    // reason as outbound: only the JOIN carries end_conference_on_exit, and the
    // CALLER's leg is the one that must carry it.
    expect(effects.filter((e) => e.type === 'create_conference')).toEqual([
      { type: 'create_conference', legId: 'legB-xai', leg: 'B' },
    ]);
    expect(state.direction).toBe('inbound');
    expect(effects.filter((e) => e.type === 'dial_forward')).toHaveLength(0);
  });

  it('joins the CALLER leg with end_conference_on_exit, so their hangup ends it', () => {
    const { effects } = run(inbound('direct'), [
      callerAnswered,
      { type: 'leg_b_dialed', legB: 'legB-xai', at: T0 + 2 },
      { type: 'leg_b_answered', at: T0 + 3 },
      { type: 'xai_incoming', xaiCallId: 'xai-1', at: T0 + 4 },
      { type: 'xai_session_ready', at: T0 + 5 },
      { type: 'conference_created', conferenceId: 'conf-i', at: T0 + 6 },
    ]);
    expect(effects.filter((e) => e.type === 'join_conference')).toEqual([
      {
        type: 'join_conference',
        conferenceId: 'conf-i',
        legId: 'legA-caller',
        endConferenceOnExit: true,
        pid: null,
        supervisorRole: null,
        whisperLegIds: [],
      },
    ]);
  });

  it('is idempotent on a duplicated caller-answer webhook', () => {
    const { effects } = run(inbound('direct'), [callerAnswered, callerAnswered]);
    expect(effects.filter((e) => e.type === 'dial_leg_b')).toHaveLength(1);
  });
});

describe('inbound FOLLOW-ME mode — ring humans, fall back to the AI', () => {
  it('rings the first target when the caller is answered', () => {
    const { state, effects } = run(inbound('follow_me'), [callerAnswered]);
    expect(effects).toEqual([
      { type: 'start_monitor' },
      { type: 'dial_forward', to: TARGET_1, index: 0, timeoutSecs: 20 },
    ]);
    expect(state.phase).toBe('forwarding');
  });

  it('waits for the AMD verdict — an answer alone bridges nothing', () => {
    const { effects } = run(inbound('follow_me'), [
      callerAnswered,
      { type: 'forward_dialed', legF: 'ccF1', at: T0 + 2 },
      { type: 'forward_answered', legF: 'ccF1', at: T0 + 3 },
    ]);
    expect(effects.filter((e) => e.type === 'create_conference')).toHaveLength(0);
  });

  it('conferences the caller with a live HUMAN, creating FROM LEG F', () => {
    const { state, effects } = run(inbound('follow_me'), [
      callerAnswered,
      { type: 'forward_dialed', legF: 'ccF1', at: T0 + 2 },
      { type: 'forward_answered', legF: 'ccF1', at: T0 + 3 },
      { type: 'forward_amd', legF: 'ccF1', result: 'human', at: T0 + 4 },
    ]);
    // LEG F, NOT LEG A -- the same rule as the AI path, not a second one.
    // `end_conference_on_exit` exists only on `join`, and the leg that must
    // carry it is the CALLER (leg A), whose hangup ends the call for everyone.
    // A creator cannot carry the flag, so the caller cannot be the creator.
    expect(effects.filter((e) => e.type === 'create_conference')).toEqual([
      { type: 'create_conference', legId: 'ccF1', leg: 'F' },
    ]);
    expect(state.bridgeRequested).toBe(true);
    // No AI involved: leg B is never dialed.
    expect(effects.filter((e) => e.type === 'dial_leg_b')).toHaveLength(0);
  });

  // THE defining failure mode: a dead phone's voicemail "answers".
  it('VOICEMAIL: hangs up the machine leg and rings the next target', () => {
    const { state, effects } = run(inbound('follow_me'), [
      callerAnswered,
      { type: 'forward_dialed', legF: 'ccF1', at: T0 + 2 },
      { type: 'forward_answered', legF: 'ccF1', at: T0 + 3 },
      { type: 'forward_amd', legF: 'ccF1', result: 'machine', at: T0 + 4 },
    ]);
    expect(effects.filter((e) => e.type === 'create_conference')).toHaveLength(0);
    expect(effects.slice(-2)).toEqual([
      { type: 'hangup_forward', legF: 'ccF1' },
      { type: 'dial_forward', to: TARGET_2, index: 1, timeoutSecs: 20 },
    ]);
    expect(state.forwardAttempted).toBe(1);
    expect(state.legF).toBeNull();
  });

  it('VOICEMAIL on the LAST target: AI takes over, reason recorded', () => {
    const { state, effects } = run(inbound('follow_me'), [
      callerAnswered,
      { type: 'forward_dialed', legF: 'ccF1', at: T0 + 2 },
      { type: 'forward_answered', legF: 'ccF1', at: T0 + 3 },
      { type: 'forward_amd', legF: 'ccF1', result: 'machine', at: T0 + 4 },
      { type: 'forward_dialed', legF: 'ccF2', at: T0 + 5 },
      { type: 'forward_answered', legF: 'ccF2', at: T0 + 6 },
      { type: 'forward_amd', legF: 'ccF2', result: 'machine', at: T0 + 7 },
    ]);
    expect(effects.filter((e) => e.type === 'dial_leg_b')).toHaveLength(1);
    expect(state.phase).toBe('dialing_b');
    expect(state.inboundFallbackReason).toBe('target_was_voicemail');
  });

  it('rang-out targets advance the ladder; exhausting them dials the AI', () => {
    const { state, effects } = run(inbound('follow_me'), [
      callerAnswered,
      { type: 'forward_dialed', legF: 'ccF1', at: T0 + 2 },
      { type: 'forward_hangup', legF: 'ccF1', cause: 'timeout', at: T0 + 3 },
      { type: 'forward_dialed', legF: 'ccF2', at: T0 + 4 },
      { type: 'forward_hangup', legF: 'ccF2', cause: 'timeout', at: T0 + 5 },
    ]);
    const forwards = effects.filter((e) => e.type === 'dial_forward');
    expect(forwards.map((e) => (e.type === 'dial_forward' ? e.to : ''))).toEqual([
      TARGET_1,
      TARGET_2,
    ]);
    expect(effects.filter((e) => e.type === 'dial_leg_b')).toHaveLength(1);
    expect(state.inboundFallbackReason).toBe('all_targets_exhausted');
  });

  it('drops STALE forward events from an attempt already resolved', () => {
    const { state, effects } = run(inbound('follow_me'), [
      callerAnswered,
      { type: 'forward_dialed', legF: 'ccF1', at: T0 + 2 },
      { type: 'forward_hangup', legF: 'ccF1', cause: 'timeout', at: T0 + 3 },
      { type: 'forward_dialed', legF: 'ccF2', at: T0 + 4 },
      // Redeliveries about the DEAD first leg must not touch attempt #2.
      { type: 'forward_answered', legF: 'ccF1', at: T0 + 5 },
      { type: 'forward_amd', legF: 'ccF1', result: 'human', at: T0 + 6 },
      { type: 'forward_hangup', legF: 'ccF1', cause: 'timeout', at: T0 + 7 },
    ]);
    expect(effects.filter((e) => e.type === 'create_conference')).toHaveLength(0);
    expect(state.legF).toBe('ccF2');
    expect(state.forwardAttempted).toBe(1);
  });

  it('a dial-API failure never strands the caller — the ladder advances', () => {
    const { effects } = run(inbound('follow_me'), [
      callerAnswered,
      { type: 'forward_dial_failed', at: T0 + 2 },
      { type: 'forward_dialed', legF: 'ccF2', at: T0 + 3 },
      { type: 'forward_hangup', legF: 'ccF2', cause: 'timeout', at: T0 + 4 },
    ]);
    expect(effects.filter((e) => e.type === 'dial_leg_b')).toHaveLength(1);
  });

  it('the CALLER hanging up mid-ladder tears the call down', () => {
    const { state, effects } = run(inbound('follow_me'), [
      callerAnswered,
      { type: 'forward_dialed', legF: 'ccF1', at: T0 + 2 },
      { type: 'hangup', leg: 'A', cause: 'normal_clearing', at: T0 + 3 },
    ]);
    expect(state.phase).toBe('completed');
    expect(effects.filter((e) => e.type === 'teardown')).toHaveLength(1);
  });

  it('the bridged human hanging up completes the call', () => {
    const { state } = run(inbound('follow_me'), [
      callerAnswered,
      { type: 'forward_dialed', legF: 'ccF1', at: T0 + 2 },
      { type: 'forward_answered', legF: 'ccF1', at: T0 + 3 },
      { type: 'forward_amd', legF: 'ccF1', result: 'human', at: T0 + 4 },
      { type: 'bridge_confirmed', at: T0 + 5 },
      { type: 'forward_hangup', legF: 'ccF1', cause: 'normal_clearing', at: T0 + 6 },
    ]);
    expect(state.phase).toBe('completed');
  });
});

describe('inbound with NO configuration — safe degraded mode', () => {
  it('no forward targets: the AI answers, reason no_targets_configured', () => {
    const { state, effects } = run(inbound('follow_me', []), [callerAnswered]);
    // arm_connect_deadline rides with every dial_leg_b, this fallback included:
    // the caller is already live, so the answered-to-bridged window is open.
    expect(effects).toEqual([
      { type: 'start_monitor' },
      { type: 'dial_leg_b' },
      { type: 'arm_connect_deadline' },
    ]);
    expect(state.phase).toBe('dialing_b');
    expect(state.inboundFallbackReason).toBe('no_targets_configured');
  });

  it('parseNumberList degrades on absent/empty/padded input', () => {
    expect(parseNumberList(undefined)).toEqual([]);
    expect(parseNumberList('')).toEqual([]);
    expect(parseNumberList(' +15555550123 , +14155550111 ,, ')).toEqual([TARGET_1, TARGET_2]);
  });

  it('ringSecsFromEnv clamps garbage to the default', () => {
    expect(ringSecsFromEnv(undefined)).toBe(DEFAULT_RING_SECS);
    expect(ringSecsFromEnv('banana')).toBe(DEFAULT_RING_SECS);
    expect(ringSecsFromEnv('0')).toBe(DEFAULT_RING_SECS);
    expect(ringSecsFromEnv('999')).toBe(DEFAULT_RING_SECS);
    expect(ringSecsFromEnv('30')).toBe(30);
  });
});

describe('directInboundTask — no message-taking framing', () => {
  it('assumes the operator is the caller and forbids unavailable/message framing', () => {
    const t = directInboundTask();
    expect(t).toContain('operator');
    expect(t).toContain('Do not say he is unavailable');
    expect(t.toLowerCase()).not.toContain('could not pick up');
  });

  it('grants conversation, not authority (caller ID is spoofable)', () => {
    expect(directInboundTask()).toContain('spoofed');
  });
});
