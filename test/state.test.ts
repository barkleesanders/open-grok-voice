import { describe, expect, it } from 'vitest';
import { connectDeadlineMs, DEFAULT_CONNECT_DEADLINE_MS } from '../src/env';
import {
  type CallEffect,
  type CallEvent,
  type CallState,
  initialInboundState,
  initialState,
  MAX_TRANSCRIPT_ENTRIES,
  reduce,
} from '../src/state';
import { RECORDING_START_DTMF } from '../src/types';

const T0 = 1_700_000_000_000;

function base(): CallState {
  return initialState({
    callId: 'call-1',
    to: '+14155550123',
    task: 'Ask about the invoice.',
    voice: 'eve',
    amd: null,
    now: T0,
  });
}

/** Apply a list of events, collecting every effect emitted along the way. */
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

/**
 * Inbound starting points for the structural sweep below.
 *
 * Both inbound modes reach `dial_leg_b`: 'direct' goes straight to the AI, and
 * 'follow_me' falls back to it once the human ladder is exhausted. A sweep that
 * only seeded the outbound path would miss two of the three ways in.
 */
function inboundSeeds(): CallState[] {
  return (['direct', 'follow_me'] as const).map((mode) =>
    initialInboundState({
      callId: 'in-1',
      caller: '+14155550111',
      ownNumber: '+15555550100',
      legA: 'legA-caller',
      mode,
      forwardTargets: mode === 'follow_me' ? ['+14155550222'] : [],
      ringSecs: 20,
      task: 'take a message',
      voice: 'liora',
      now: T0,
    }),
  );
}

const dialedA: CallEvent = { type: 'leg_a_dialed', legA: 'legA-cc', at: T0 + 1 };
const answeredA: CallEvent = { type: 'leg_a_answered', at: T0 + 2 };
const dialedB: CallEvent = { type: 'leg_b_dialed', legB: 'legB-cc', at: T0 + 3 };
const answeredB: CallEvent = { type: 'leg_b_answered', at: T0 + 4 };
const xaiIn: CallEvent = { type: 'xai_incoming', xaiCallId: 'xai-1', at: T0 + 5 };
const sessionReady: CallEvent = { type: 'xai_session_ready', at: T0 + 6 };

describe('call state machine', () => {
  it('dials leg B exactly once when leg A answers, and starts the connect clock', () => {
    const { state, effects } = run(base(), [dialedA, answeredA]);
    expect(effects).toEqual([
      { type: 'start_monitor' },
      { type: 'dial_leg_b' },
      { type: 'arm_connect_deadline' },
    ]);
    expect(state.phase).toBe('dialing_b');
  });

  it('is IDEMPOTENT on a duplicated leg_a_answered (must not place a 2nd call)', () => {
    // Telnyx documents duplicate deliveries. A second dial_leg_b effect here
    // would mean a second real phone call to xAI, billed and connected.
    const { effects } = run(base(), [dialedA, answeredA, answeredA, answeredA]);
    expect(effects.filter((e) => e.type === 'dial_leg_b')).toHaveLength(1);
  });

  it('does not re-dial leg B after leg B is already dialed', () => {
    const { effects } = run(base(), [dialedA, answeredA, dialedB, answeredA]);
    expect(effects.filter((e) => e.type === 'dial_leg_b')).toHaveLength(1);
  });

  it('opens the xAI socket exactly once even if the webhook is redelivered', () => {
    const { effects } = run(base(), [dialedA, answeredA, dialedB, xaiIn, xaiIn]);
    expect(effects.filter((e) => e.type === 'open_xai_ws')).toHaveLength(1);
  });

  it('does NOT connect until BOTH leg B answered and the xAI session is ready', () => {
    const onlyAnswered = run(base(), [dialedA, answeredA, dialedB, answeredB]);
    expect(onlyAnswered.effects.filter((e) => e.type === 'create_conference')).toHaveLength(0);

    const onlyReady = run(base(), [dialedA, answeredA, dialedB, xaiIn, sessionReady]);
    expect(onlyReady.effects.filter((e) => e.type === 'create_conference')).toHaveLength(0);
  });

  // The AI path connects via a CONFERENCE, not a two-leg bridge, because
  // `POST /calls/{id}/actions/bridge` joins exactly two legs and a third party
  // could never be added to it. The `bridge` effect is not gone -- the inbound
  // follow-me path still uses it -- so these assert the AI path specifically.
  it('creates the conference FROM LEG B once both preconditions are met', () => {
    const { state, effects } = run(base(), [
      dialedA,
      answeredA,
      dialedB,
      answeredB,
      xaiIn,
      sessionReady,
    ]);
    // legB, NOT legA. end_conference_on_exit exists only on the JOIN command, so
    // whichever leg CREATES the conference cannot carry it -- and leg A is the
    // leg that must carry it, because the subject hanging up has to end the call
    // for everyone. Creating from leg A would make that unreachable and leave
    // xAI plus every participant parked and billing after a subject hangup.
    expect(effects.filter((e) => e.type === 'create_conference')).toEqual([
      { type: 'create_conference', legId: 'legB-cc', leg: 'B' },
    ]);
    expect(state.bridgeRequested).toBe(true);
  });

  it('joins LEG A with end_conference_on_exit once the conference exists', () => {
    const { state, effects } = run(base(), [
      dialedA,
      answeredA,
      dialedB,
      answeredB,
      xaiIn,
      sessionReady,
      { type: 'conference_created', conferenceId: 'conf-1', at: T0 + 6 },
    ]);
    expect(effects.filter((e) => e.type === 'join_conference')).toEqual([
      {
        type: 'join_conference',
        conferenceId: 'conf-1',
        legId: 'legA-cc',
        endConferenceOnExit: true,
        pid: null,
        supervisorRole: null,
        whisperLegIds: [],
      },
    ]);
    expect(state.conferenceId).toBe('conf-1');
  });

  it('connects once in the OPPOSITE order (session THEN answer)', () => {
    // The two providers are independent; either can win the race.
    const { effects } = run(base(), [dialedA, answeredA, dialedB, xaiIn, sessionReady, answeredB]);
    expect(effects.filter((e) => e.type === 'create_conference')).toHaveLength(1);
  });

  it('never emits a second create_conference on duplicated readiness events', () => {
    const { effects } = run(base(), [
      dialedA,
      answeredA,
      dialedB,
      answeredB,
      xaiIn,
      sessionReady,
      answeredB,
      sessionReady,
    ]);
    expect(effects.filter((e) => e.type === 'create_conference')).toHaveLength(1);
  });

  it('never joins leg A twice when conference_created is redelivered', () => {
    const created: CallEvent = { type: 'conference_created', conferenceId: 'conf-1', at: T0 + 6 };
    const { effects } = run(base(), [
      dialedA,
      answeredA,
      dialedB,
      answeredB,
      xaiIn,
      sessionReady,
      created,
      created,
    ]);
    expect(effects.filter((e) => e.type === 'join_conference')).toHaveLength(1);
  });

  it('treats call.bridged for both legs as one transition', () => {
    const evt: CallEvent = { type: 'bridge_confirmed', at: T0 + 7 };
    const { state } = run(base(), [
      dialedA,
      answeredA,
      dialedB,
      answeredB,
      xaiIn,
      sessionReady,
      evt,
      evt,
    ]);
    expect(state.phase).toBe('bridged');
  });

  it('tears down on hangup and then absorbs every later event', () => {
    const { state, effects } = run(base(), [
      dialedA,
      answeredA,
      { type: 'hangup', leg: 'A', cause: 'normal_clearing', at: T0 + 9 },
    ]);
    expect(state.phase).toBe('completed');
    expect(effects.some((e) => e.type === 'teardown')).toBe(true);

    // A late duplicate must not resurrect the call or emit a second teardown.
    const after = run(state, [answeredB, sessionReady, xaiIn]);
    expect(after.effects).toHaveLength(0);
    expect(after.state.phase).toBe('completed');
  });

  it('records a failure and tears down', () => {
    const { state, effects } = run(base(), [
      dialedA,
      { type: 'failed', reason: 'leg_b_dial: boom', at: T0 + 8 },
    ]);
    expect(state.phase).toBe('failed');
    expect(state.failureReason).toBe('leg_b_dial: boom');
    expect(effects.filter((e) => e.type === 'teardown')).toHaveLength(1);
  });

  it('emits refresh_instructions only when AMD lands AFTER the session is live', () => {
    // Early AMD: session not configured yet, so nothing to refresh.
    const early = run(base(), [
      dialedA,
      answeredA,
      { type: 'amd_result', result: 'machine', at: T0 + 3 },
    ]);
    expect(early.effects.filter((e) => e.type === 'refresh_instructions')).toHaveLength(0);
    expect(early.state.amdResult).toBe('machine');

    // Late AMD: the live session must be updated.
    const late = run(base(), [
      dialedA,
      answeredA,
      dialedB,
      xaiIn,
      sessionReady,
      { type: 'amd_result', result: 'machine', at: T0 + 10 },
    ]);
    expect(late.effects.filter((e) => e.type === 'refresh_instructions')).toHaveLength(1);
  });

  it('does not refresh instructions when AMD repeats the same result', () => {
    const amd: CallEvent = { type: 'amd_result', result: 'machine', at: T0 + 10 };
    const { effects } = run(base(), [dialedA, answeredA, dialedB, xaiIn, sessionReady, amd, amd]);
    expect(effects.filter((e) => e.type === 'refresh_instructions')).toHaveLength(1);
  });

  it('accumulates transcript entries and caps growth', () => {
    const events: CallEvent[] = [];
    for (let i = 0; i < MAX_TRANSCRIPT_ENTRIES + 25; i++) {
      events.push({ type: 'transcript', role: 'assistant', text: `line ${i}`, at: T0 + i });
    }
    const { state } = run(base(), events);
    expect(state.transcript).toHaveLength(MAX_TRANSCRIPT_ENTRIES);
    // Oldest dropped, newest kept.
    expect(state.transcript[state.transcript.length - 1]?.text).toBe(
      `line ${MAX_TRANSCRIPT_ENTRIES + 24}`,
    );
    expect(state.transcript[0]?.text).toBe('line 25');
  });

  it('accepts a recording callback after hangup and deduplicates it', () => {
    const asset = {
      id: 'recording-1',
      format: 'wav' as const,
      channels: 'dual' as const,
      url: 'https://s3.amazonaws.com/telnyx/recording.wav',
      startedAt: null,
      endedAt: null,
    };
    const afterHangup = run(base(), [
      dialedA,
      { type: 'hangup', leg: 'A', cause: 'normal_clearing', at: T0 + 8 },
      { type: 'recording_saved', asset, at: T0 + 9 },
      { type: 'recording_saved', asset, at: T0 + 10 },
    ]);
    expect(afterHangup.state.phase).toBe('completed');
    expect(afterHangup.state.recordings).toEqual([asset]);
    // Teardown once, and ONE archive_recording despite two deliveries of the
    // same asset — a second archive would re-download the whole call's audio.
    expect(afterHangup.effects).toEqual([
      { type: 'teardown', reason: 'leg_A_hangup:normal_clearing' },
      { type: 'archive_recording', asset },
    ]);

    const finalWords = reduce(afterHangup.state, {
      type: 'transcript',
      role: 'assistant',
      text: 'final words',
      at: T0 + 11,
    });
    expect(finalWords.state.transcript.at(-1)?.text).toBe('final words');
    expect(finalWords.effects).toEqual([]);
  });
});

describe('recording is a per-call decision, and only the dialed leg makes it', () => {
  const press = (digit: string, leg: 'A' | 'B' | 'F' | 'P'): CallEvent => ({
    type: 'dtmf_received',
    digit,
    leg,
    at: T0 + 99,
  });

  function bridged(mode: 'auto' | 'on_demand' | 'off', notice = true): CallState {
    const start = initialState({
      callId: 'call-1',
      to: '+14155550123',
      task: 'Ask about the invoice.',
      voice: 'eve',
      amd: null,
      recordingMode: mode,
      noticeEnabled: notice,
      now: T0,
    });
    // Drive it to a conference so announce_recording has somewhere to play.
    return { ...run(start, [dialedA, answeredA]).state, conferenceId: 'conf-1' };
  }

  it('does NOT record on its own under the on_demand default', () => {
    const { effects } = run(base(), [dialedA, answeredA]);
    expect(effects).not.toContainEqual({ type: 'start_recording' });
    // Positive control: media still comes up, so this is a scoped change and
    // not a reducer that stopped emitting anything.
    expect(effects).toContainEqual({ type: 'start_monitor' });
  });

  it('DOES record on its own under auto — the old behaviour, still available', () => {
    const auto = initialState({
      callId: 'call-1',
      to: '+14155550123',
      task: 'Ask about the invoice.',
      voice: 'eve',
      amd: null,
      recordingMode: 'auto',
      now: T0,
    });
    const { effects } = run(auto, [dialedA, answeredA]);
    expect(effects).toContainEqual({ type: 'start_recording' });
  });

  it('starts recording when the DIALED leg presses the key', () => {
    const { state, effects } = run(bridged('on_demand'), [press(RECORDING_START_DTMF, 'A')]);
    expect(effects).toContainEqual({ type: 'start_recording' });
    expect(effects).toContainEqual({
      type: 'announce_recording',
      conferenceId: 'conf-1',
      toEveryone: true,
    });
    expect(state.recordingStarted).toBe(true);
  });

  it('IGNORES the same key from a participant, a forward leg, and the AI', () => {
    // The whole point of carrying `leg` on the event. A third party we
    // conferenced in must not be able to start recording the person who
    // invited them.
    for (const leg of ['P', 'F', 'B'] as const) {
      const { state, effects } = run(bridged('on_demand'), [press(RECORDING_START_DTMF, leg)]);
      expect(effects).toEqual([]);
      expect(state.recordingStarted).toBe(false);
    }
  });

  it('ignores every OTHER digit from the dialed leg', () => {
    // An operator navigating an IVR types a lot of keys. Only one is ours.
    for (const digit of ['0', '1', '5', '8', '#', '*']) {
      expect(run(bridged('on_demand'), [press(digit, 'A')]).effects).toEqual([]);
    }
  });

  it('refuses the key when the operator set recording OFF', () => {
    const { state, effects } = run(bridged('off'), [press(RECORDING_START_DTMF, 'A')]);
    expect(effects).toEqual([]);
    expect(state.recordingStarted).toBe(false);
  });

  it('is IDEMPOTENT — a held key must not bill for N recordings', () => {
    const first = run(bridged('on_demand'), [press(RECORDING_START_DTMF, 'A')]);
    expect(first.effects).toContainEqual({ type: 'start_recording' });
    const second = run(first.state, [press(RECORDING_START_DTMF, 'A')]);
    expect(second.effects).toEqual([]);
  });

  it('keeps the confirmation PRIVATE when the notice is switched off', () => {
    // The operator disabled the announcement but still asked to be told the
    // keypress landed. Broadcasting it would reinstate the thing they turned
    // off; `toEveryone: false` is what scopes it to their own leg.
    const { effects } = run(bridged('on_demand', false), [press(RECORDING_START_DTMF, 'A')]);
    expect(effects).toContainEqual({
      type: 'announce_recording',
      conferenceId: 'conf-1',
      toEveryone: false,
    });
  });
});

/**
 * The answered-to-bridged window.
 *
 * REGRESSION ORIGIN — production call 102dec69-5269-470a-b64e-99866e0d4845,
 * 2026-08-31. Leg A answered, the xAI socket opened, session.update and
 * response.create were both sent, and xAI's `session.updated` NEVER came back.
 * `maybeConnect` gates the conference on `xaiSessionReady`, so the conference
 * was never created, there was no media path, and the caller sat in silence
 * for 11.6s before hanging up. The call archived as phase 'completed' with
 * failureReason null and 0 transcript entries -- a false success.
 *
 * Proof it was ONLY that gate, from the Workers logs of the three consecutive
 * calls to the same number:
 *   102dec69  ws.open OK  session.configured OK  session_ready NEVER  bridge NEVER
 *   35659a59  ws.open OK  session.configured OK  session_ready +1.27s  bridge +6.51s
 *   5cde5a89  ws.open OK  session.configured OK  session_ready +1.39s  bridge +6.94s
 * Dual-channel recording of 102dec69 confirms it on the wire: the caller's
 * channel carries speech (RMS 410, peak 9340) while the AI channel is
 * digitally flat for all 12.28s (RMS 1.0, peak 1, 0.00% of samples > 500).
 */
describe('connect deadline (answered -> bridged must be bounded)', () => {
  const deadline: CallEvent = { type: 'connect_deadline', at: T0 + 90 };

  it('FAILS the call when xAI never completes the session handshake', () => {
    // The exact production sequence: everything happens EXCEPT xai_session_ready.
    const { state, effects } = run(base(), [dialedA, answeredA, dialedB, xaiIn, answeredB]);
    expect(state.phase).toBe('connecting');
    expect(effects.filter((e) => e.type === 'create_conference')).toHaveLength(0);

    const timed = reduce(state, deadline);
    expect(timed.state.phase).toBe('failed');
    // The phase is carried so the operator can tell WHICH party went missing.
    expect(timed.state.failureReason).toBe('connect_timeout:connecting');
    expect(timed.effects).toEqual([{ type: 'teardown', reason: 'connect_timeout:connecting' }]);
  });

  it('names leg B when it is Telnyx, not xAI, that went missing', () => {
    const { state } = run(base(), [dialedA, answeredA]);
    expect(reduce(state, deadline).state.failureReason).toBe('connect_timeout:dialing_b');
  });

  // --- The control: it must be incapable of harming a working call ---------
  it('is a NO-OP once the call is bridged (a late timer must not cut a live call)', () => {
    const { state } = run(base(), [
      dialedA,
      answeredA,
      dialedB,
      xaiIn,
      sessionReady,
      answeredB,
      { type: 'conference_created', conferenceId: 'conf-1', at: T0 + 7 },
      { type: 'bridge_confirmed', at: T0 + 8 },
    ]);
    expect(state.phase).toBe('bridged');
    const timed = reduce(state, deadline);
    expect(timed.state.phase).toBe('bridged');
    expect(timed.state.failureReason).toBeNull();
    expect(timed.effects).toEqual([]);
  });

  it('is a NO-OP in the gap after the conference is requested but before it is confirmed', () => {
    // maybeConnect sets bridgeRequested a beat before Telnyx confirms. A
    // deadline landing in that gap would kill a call that is about to work.
    const { state } = run(base(), [dialedA, answeredA, dialedB, xaiIn, sessionReady, answeredB]);
    expect(state.bridgeRequested).toBe(true);
    expect(state.phase).not.toBe('bridged');
    expect(reduce(state, deadline).effects).toEqual([]);
  });

  it('is a NO-OP on a call that already ended', () => {
    const { state } = run(base(), [
      dialedA,
      answeredA,
      { type: 'hangup', leg: 'A', cause: 'normal_clearing', at: T0 + 9 },
    ]);
    expect(state.phase).toBe('completed');
    const timed = reduce(state, deadline);
    expect(timed.state.phase).toBe('completed');
    expect(timed.state.failureReason).toBeNull();
  });

  /**
   * STRUCTURAL GUARD — this is the one that catches a FUTURE violator.
   *
   * The bug class is not "we forgot a timeout on session.updated"; it is
   * "a path put a live human on the line and then waited on an external party
   * with no clock". Any new path that dials leg B reopens that window. Rather
   * than trusting a reviewer to notice, this drives every CallEvent against
   * every reachable state and asserts the pairing holds everywhere.
   */
  it('STRUCTURAL: every path that emits dial_leg_b also arms the deadline', () => {
    const events: CallEvent[] = [
      dialedA,
      answeredA,
      dialedB,
      answeredB,
      xaiIn,
      sessionReady,
      { type: 'amd_result', result: 'human', at: T0 + 10 },
      { type: 'bridge_confirmed', at: T0 + 11 },
      { type: 'conference_created', conferenceId: 'conf-1', at: T0 + 12 },
      { type: 'forward_dialed', legF: 'legF-cc', at: T0 + 13 },
      { type: 'forward_answered', legF: 'legF-cc', at: T0 + 14 },
      { type: 'forward_amd', legF: 'legF-cc', result: 'human', at: T0 + 15 },
      { type: 'forward_hangup', legF: 'legF-cc', cause: 'busy', at: T0 + 16 },
      { type: 'forward_dial_failed', at: T0 + 17 },
      { type: 'hangup', leg: 'A', cause: 'normal_clearing', at: T0 + 18 },
      { type: 'failed', reason: 'boom', at: T0 + 19 },
      deadline,
    ];

    // Breadth-first over reachable states, so this covers the outbound path,
    // the inbound direct path, and the follow-me ladder's fallback to the AI.
    const seeds: CallState[] = [base(), ...inboundSeeds()];
    const seen = new Set<string>();
    const queue: CallState[] = [...seeds];
    let dialCount = 0;
    while (queue.length > 0) {
      const s = queue.shift() as CallState;
      const key = JSON.stringify(s);
      if (seen.has(key)) continue;
      seen.add(key);
      for (const e of events) {
        const r = reduce(s, e);
        const dials = r.effects.filter((x) => x.type === 'dial_leg_b').length;
        const arms = r.effects.filter((x) => x.type === 'arm_connect_deadline').length;
        if (dials > 0) {
          dialCount += dials;
          expect(
            arms,
            `event '${e.type}' from phase '${s.phase}' emitted ${dials} dial_leg_b but ${arms} arm_connect_deadline`,
          ).toBe(dials);
        }
        if (!seen.has(JSON.stringify(r.state))) queue.push(r.state);
      }
    }
    // Guard the guard: a traversal that never reached a dial would pass
    // vacuously and prove nothing.
    expect(dialCount).toBeGreaterThan(0);
  });
});

/**
 * The deadline VALUE. A bad env var here fails every call the moment it is
 * answered, so the parser is graded on its behaviour under garbage, not just
 * on the happy path.
 */
describe('connectDeadlineMs', () => {
  it('defaults to 20s — ~2.9x the 6.94s worst case measured over 10 real calls', () => {
    expect(connectDeadlineMs({})).toBe(20_000);
    expect(DEFAULT_CONNECT_DEADLINE_MS).toBe(20_000);
  });

  it('honours a valid override', () => {
    expect(connectDeadlineMs({ CONNECT_DEADLINE_MS: '30000' })).toBe(30_000);
  });

  it('falls back rather than yielding NaN, which would fail every call instantly', () => {
    for (const bad of ['', 'abc', 'NaN', '  ']) {
      expect(connectDeadlineMs({ CONNECT_DEADLINE_MS: bad })).toBe(DEFAULT_CONNECT_DEADLINE_MS);
    }
  });

  it('clamps out-of-range values at BOTH ends', () => {
    // 0 would kill every answered call; a huge value restores the original bug.
    expect(connectDeadlineMs({ CONNECT_DEADLINE_MS: '0' })).toBe(DEFAULT_CONNECT_DEADLINE_MS);
    expect(connectDeadlineMs({ CONNECT_DEADLINE_MS: '-5000' })).toBe(DEFAULT_CONNECT_DEADLINE_MS);
    expect(connectDeadlineMs({ CONNECT_DEADLINE_MS: '999999999' })).toBe(
      DEFAULT_CONNECT_DEADLINE_MS,
    );
  });
});
