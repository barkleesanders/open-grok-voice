// Conference call support: the reducer's participant lifecycle, the leg-tag
// routing that keeps a participant out of leg-A/B handling, and the WIRE BODIES
// the Telnyx client actually sends.
//
// The wire-body tests exist because the design's load-bearing decision is
// invisible in state: `end_conference_on_exit` lives only in a request body, so
// asserting on `state.conferenceId` would pass just as happily with the flag
// missing, on leg B, or set to false.

import { describe, expect, it } from 'vitest';
import {
  type BillableCall,
  type BillableParticipant,
  estimateCallCost,
  participantBillableMs,
  ratesFrom,
} from '../src/cost';
import { telnyxEventToCallEvent } from '../src/index';
import { participantJoinNotice, sanitizeParticipantLabel } from '../src/instructions';
import {
  activeParticipantCount,
  type CallEvent,
  type CallState,
  findParticipant,
  initialState,
  participantView,
  reduce,
} from '../src/state';
import {
  CONFERENCE_SPEAK_XAI_VOICES,
  conferenceNoticeVoice,
  conferencePlay,
  conferenceSpeak,
  createConference,
  endConference,
  FALLBACK_NOTICE_VOICE,
  joinConference,
  noticeRenderVoice,
  setConferenceMute,
  type TelnyxConfig,
} from '../src/telnyx';
import {
  type ClientState,
  decodeClientState,
  encodeClientState,
  MAX_PARTICIPANT_ROWS,
  MAX_PARTICIPANTS,
  PARTICIPANT_ID_RE,
} from '../src/types';

const T0 = 1_700_000_000_000;

const CFG: TelnyxConfig = {
  apiKey: 'k',
  connectionId: 'conn',
  from: '+14155550123',
};

function base(participants?: readonly string[]): CallState {
  return initialState({
    callId: 'call-1',
    to: '+14155550100',
    task: 'do the thing',
    voice: 'eve',
    amd: null,
    ...(participants ? { participants } : {}),
    now: T0,
  });
}

function run(state: CallState, events: readonly CallEvent[]) {
  let current = state;
  const effects = [];
  for (const event of events) {
    const result = reduce(current, event);
    current = result.state;
    effects.push(...result.effects);
  }
  return { state: current, effects };
}

/** Drive a call all the way to a live conference with one joined participant. */
const CONNECT: readonly CallEvent[] = [
  { type: 'leg_a_dialed', legA: 'legA-cc', at: T0 },
  { type: 'leg_a_answered', at: T0 + 1 },
  { type: 'leg_b_dialed', legB: 'legB-cc', at: T0 + 2 },
  { type: 'leg_b_answered', at: T0 + 3 },
  { type: 'xai_incoming', xaiCallId: 'xai-1', at: T0 + 4 },
  { type: 'xai_session_ready', at: T0 + 5 },
  { type: 'conference_created', conferenceId: 'conf-1', at: T0 + 6 },
];

const ADD_P0: readonly CallEvent[] = [
  {
    type: 'participant_requested',
    to: '+14155550199',
    label: 'Supervisor',
    supervisorRole: 'barge',
    at: T0 + 7,
  },
  { type: 'participant_dialed', pid: 'p0', legId: 'legP0-cc', at: T0 + 8 },
  { type: 'participant_answered', pid: 'p0', at: T0 + 9 },
  { type: 'participant_joined', pid: 'p0', at: T0 + 10 },
];

/**
 * Run one conference command and return the URL and JSON body it actually sent.
 *
 * Throws when no request was issued, which matters more than it looks: every
 * assertion below reads `body['some_key']`, and against a request that was never
 * made those would all compare `undefined` to `undefined` and PASS. The throw is
 * what stops a silently-not-called client from looking like a correct one.
 */
async function captureCommand(
  run: (fetchImpl: typeof fetch) => Promise<unknown>,
): Promise<{ url: string; body: Record<string, unknown> }> {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const raw = init?.body;
    sent.push({
      url: new Request(input, init).url,
      body: typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : {},
    });
    return new Response(JSON.stringify({ data: { id: 'conf-1' } }), { status: 200 });
  };
  await run(fetchImpl);
  const first = sent[0];
  if (!first) throw new Error('the command issued no request at all');
  return first;
}

// ---------------------------------------------------------------------------

describe('conference wire bodies — what Telnyx actually receives', () => {
  // NAMING NOTE, learned by re-injection: this asserts the CLIENT faithfully
  // sends the leg it is handed and omits a parameter the create command does not
  // have. It does NOT assert that the reducer chooses leg B -- mutating the
  // reducer to create from leg A leaves this test green. That choice is tested
  // in test/state.test.ts ('creates the conference FROM LEG B once both
  // preconditions are met'), which was verified RED under exactly that mutation.
  it('CLIENT: create body carries the given leg and omits end_conference_on_exit', async () => {
    const { url, body } = await captureCommand((impl) =>
      createConference(
        CFG,
        {
          callControlId: 'legB-cc',
          name: 'call-1',
          clientState: encodeClientState({ callId: 'call-1', leg: 'B' }),
          commandId: 'cmd-1',
          maxParticipants: 2 + MAX_PARTICIPANTS,
        },
        impl,
      ),
    );
    expect(url).toBe('https://api.telnyx.com/v2/conferences');
    // Leg B, not leg A. See the create_conference effect comment in state.ts.
    expect(body['call_control_id']).toBe('legB-cc');
    expect(body['name']).toBe('call-1');
    expect(body['start_conference_on_create']).toBe(true);
    // Telnyx counts EVERY leg, so the cap is subject + xAI + the escalation cap.
    expect(body['max_participants']).toBe(6);
    // The create command has no such parameter; sending one would be a body
    // Telnyx may reject outright.
    expect(body).not.toHaveProperty('end_conference_on_exit');
  });

  it('joins LEG A with end_conference_on_exit TRUE', async () => {
    const { url, body } = await captureCommand((impl) =>
      joinConference(
        CFG,
        'conf-1',
        {
          callControlId: 'legA-cc',
          clientState: encodeClientState({ callId: 'call-1', leg: 'A' }),
          commandId: 'cmd-2',
          endConferenceOnExit: true,
          supervisorRole: null,
          whisperCallControlIds: [],
        },
        impl,
      ),
    );
    expect(url).toBe('https://api.telnyx.com/v2/conferences/conf-1/actions/join');
    expect(body['call_control_id']).toBe('legA-cc');
    // THE flag. Without it a subject hangup leaves xAI and every participant
    // parked and billing.
    expect(body['end_conference_on_exit']).toBe(true);
  });

  it('joins a PARTICIPANT with end_conference_on_exit FALSE', async () => {
    const { body } = await captureCommand((impl) =>
      joinConference(
        CFG,
        'conf-1',
        {
          callControlId: 'legP0-cc',
          clientState: encodeClientState({ callId: 'call-1', leg: 'P', pid: 'p0' }),
          commandId: 'cmd-3',
          endConferenceOnExit: false,
          supervisorRole: null,
          whisperCallControlIds: [],
        },
        impl,
      ),
    );
    expect(body['end_conference_on_exit']).toBe(false);
    // The participant's client_state must carry its pid, or its webhooks cannot
    // be attributed to a roster row.
    const state = decodeClientState(body['client_state'] as string);
    expect(state).toEqual({ callId: 'call-1', leg: 'P', pid: 'p0' });
  });

  it('mutes exactly ONE participant, never the whole conference', async () => {
    const { url, body } = await captureCommand((impl) =>
      setConferenceMute(CFG, 'conf-1', { callControlId: 'legP0-cc', muted: true }, impl),
    );
    expect(url).toBe('https://api.telnyx.com/v2/conferences/conf-1/actions/mute');
    // Telnyx documents an EMPTY call_control_ids as "all participants will be
    // muted" -- an accidental [] would silence the subject and the AI too.
    expect(body['call_control_ids']).toEqual(['legP0-cc']);
  });

  it('speaks the join notice to EVERYONE and never as SSML', async () => {
    const { url, body } = await captureCommand((impl) =>
      conferenceSpeak(
        CFG,
        'conf-1',
        {
          payload: participantJoinNotice('Supervisor', true),
          voice: 'Telnyx.KokoroTTS.af',
          commandId: 'c',
        },
        impl,
      ),
    );
    expect(url).toBe('https://api.telnyx.com/v2/conferences/conf-1/actions/speak');
    // OMITTED, which Telnyx documents as "all participants will hear the spoken
    // text". The recording notice has to reach the subject and the AI too.
    expect(body).not.toHaveProperty('call_control_ids');
    // 'text', never 'ssml': the label is operator-supplied, and SSML would make
    // it markup rather than words.
    expect(body['payload_type']).toBe('text');
    expect(body['voice']).toBe('Telnyx.KokoroTTS.af');
    expect(String(body['payload'])).toContain('Supervisor');
    expect(String(body['payload'])).toContain('recorded');
  });

  it('ends the conference by id', async () => {
    const { url } = await captureCommand((impl) => endConference(CFG, 'conf-1', 'cmd-9', impl));
    expect(url).toBe('https://api.telnyx.com/v2/conferences/conf-1/actions/end');
  });
});

// ---------------------------------------------------------------------------

describe('participant leg tag — routing, not leg-A/B handling', () => {
  it('round-trips a participant client_state', () => {
    const encoded = encodeClientState({ callId: 'call-1', leg: 'P', pid: 'p3' });
    expect(decodeClientState(encoded)).toEqual({ callId: 'call-1', leg: 'P', pid: 'p3' });
  });

  it('REJECTS a participant state with no usable pid', () => {
    // An unroutable participant state is not a weaker one -- there is no roster
    // row it could land on, so it must not decode at all.
    for (const pid of [undefined, '', 'p', 'px', 'p0000', '../p0', 'P0']) {
      const raw = btoa(
        JSON.stringify({ callId: 'call-1', leg: 'P', ...(pid === undefined ? {} : { pid }) }),
      );
      expect(decodeClientState(raw), `pid=${String(pid)}`).toBeNull();
    }
    // Positive control: the pattern itself accepts what the minter produces, so
    // the rejections above are about the input rather than a broken regex.
    expect(PARTICIPANT_ID_RE.test('p0')).toBe(true);
    expect(PARTICIPANT_ID_RE.test('p12')).toBe(true);
  });

  it('routes a participant call.answered to the PARTICIPANT path, never leg B', () => {
    const cs: ClientState = { callId: 'call-1', leg: 'P', pid: 'p0' };
    const event = telnyxEventToCallEvent(cs, 'call.answered', { call_control_id: 'legP0-cc' }, T0);
    expect(event).toEqual({ type: 'participant_answered', pid: 'p0', at: T0 });
    // The specific misrouting this whole leg tag exists to prevent.
    expect(event?.type).not.toBe('leg_b_answered');
  });

  it('routes a participant call.hangup to participant_hangup, never `hangup`', () => {
    const cs: ClientState = { callId: 'call-1', leg: 'P', pid: 'p0' };
    const event = telnyxEventToCallEvent(cs, 'call.hangup', { hangup_cause: 'normal' }, T0);
    expect(event).toEqual({ type: 'participant_hangup', pid: 'p0', cause: 'normal', at: T0 });
    // `hangup` completes the CALL. If a participant hangup mapped to it, one
    // escalation participant putting the phone down would hang up on the subject.
    expect(event?.type).not.toBe('hangup');
  });

  it('maps leg A conference.participant.joined to bridge_confirmed', () => {
    // A conference emits no `call.bridged`, so without this the phase would sit
    // on 'connecting' for the whole of a working call.
    expect(
      telnyxEventToCallEvent({ callId: 'c', leg: 'A' }, 'conference.participant.joined', {}, T0),
    ).toEqual({
      type: 'bridge_confirmed',
      at: T0,
    });
    // Leg B joining is not the call being connected to the human.
    expect(
      telnyxEventToCallEvent({ callId: 'c', leg: 'B' }, 'conference.participant.joined', {}, T0),
    ).toBeNull();
  });

  it('STRUCTURAL: every leg tag is handled, so a future tag cannot fall through', () => {
    // This is the guard against the NEXT leg tag, not this one. It enumerates
    // the ClientState union and asserts each arm produces a leg-APPROPRIATE
    // event for the same webhook -- so adding a fifth tag without teaching this
    // function about it fails here rather than in production, where the
    // fall-through would silently become leg-B behaviour.
    const states: readonly ClientState[] = [
      { callId: 'c', leg: 'A' },
      { callId: 'c', leg: 'B' },
      { callId: 'c', leg: 'F' },
      { callId: 'c', leg: 'P', pid: 'p0' },
    ];
    const expected: Record<string, string> = {
      A: 'leg_a_answered',
      B: 'leg_b_answered',
      F: 'forward_answered',
      P: 'participant_answered',
    };
    // The union is exhausted: if a tag is added to ClientState and not to this
    // list, `covered` and the type's own arms diverge and the next assertion
    // about a missing key fails.
    const covered = states.map((s) => s.leg).sort();
    expect(covered).toEqual(['A', 'B', 'F', 'P']);
    for (const cs of states) {
      const event = telnyxEventToCallEvent(cs, 'call.answered', { call_control_id: 'cc' }, T0);
      expect(event, `leg ${cs.leg} produced no event`).not.toBeNull();
      expect(event?.type, `leg ${cs.leg} routed to the wrong handler`).toBe(expected[cs.leg]);
    }
  });
});

// ---------------------------------------------------------------------------

describe('participant lifecycle in the reducer', () => {
  it('queues request-time participants and dials them when the conference exists', () => {
    const { state, effects } = run(base(['+14155550111', '+14155550222']), CONNECT);
    // Nothing is dialed before the conference exists -- a queued participant
    // would otherwise ring a third party into a call that may never answer.
    expect(state.participants.map((p) => p.status)).toEqual(['dialing', 'dialing']);
    expect(effects.filter((e) => e.type === 'dial_participant')).toEqual([
      { type: 'dial_participant', pid: 'p0', to: '+14155550111' },
      { type: 'dial_participant', pid: 'p1', to: '+14155550222' },
    ]);
  });

  it('dials a mid-call add immediately and joins it on answer', () => {
    const { state, effects } = run(base(), [...CONNECT, ...ADD_P0]);
    expect(effects.filter((e) => e.type === 'dial_participant')).toHaveLength(1);
    const joins = effects.filter((e) => e.type === 'join_conference');
    // Leg A's join plus the participant's.
    expect(joins).toHaveLength(2);
    expect(joins[1]).toEqual({
      type: 'join_conference',
      conferenceId: 'conf-1',
      legId: 'legP0-cc',
      endConferenceOnExit: false,
      pid: 'p0',
      supervisorRole: 'barge',
      whisperLegIds: [],
    });
    const p0 = findParticipant(state, 'p0');
    expect(p0?.status).toBe('joined');
    expect(p0?.answeredAt).toBe(T0 + 9);
    expect(p0?.joinedAt).toBe(T0 + 10);
  });

  it('tells Grok BEFORE speaking the notice into the call', () => {
    const { effects } = run(base(), [...CONNECT, ...ADD_P0]);
    const refresh = effects.findIndex((e) => e.type === 'refresh_instructions');
    const announce = effects.findIndex((e) => e.type === 'announce_participant');
    // Guard against the vacuous pass: indexOf returns -1 for an ABSENT effect,
    // and -1 < anything, so the ordering assertion alone would pass if either
    // effect were never emitted at all.
    expect(refresh).toBeGreaterThanOrEqual(0);
    expect(announce).toBeGreaterThanOrEqual(0);
    // The notice is audible IN the conference, so xAI hears it. Grok has to know
    // a third party joined first, or it may answer the announcement as though
    // the subject had spoken.
    expect(refresh).toBeLessThan(announce);
  });

  it('caps active participants and lets a departure free the seat', () => {
    let state = base().valueOf() as CallState;
    ({ state } = run(state, CONNECT));
    for (let i = 0; i < MAX_PARTICIPANTS; i += 1) {
      ({ state } = run(state, [
        {
          type: 'participant_requested',
          to: `+1415555010${i}`,
          label: null,
          supervisorRole: 'barge',
          at: T0 + 20 + i,
        },
      ]));
    }
    expect(state.participants).toHaveLength(MAX_PARTICIPANTS);

    // One over the cap is refused: no new row, no dial.
    const over = run(state, [
      {
        type: 'participant_requested',
        to: '+14155559999',
        label: null,
        supervisorRole: 'barge',
        at: T0 + 40,
      },
    ]);
    expect(over.state.participants).toHaveLength(MAX_PARTICIPANTS);
    expect(over.effects.filter((e) => e.type === 'dial_participant')).toHaveLength(0);

    // A participant leaving frees a seat...
    const freed = run(state, [
      { type: 'participant_hangup', pid: 'p0', cause: 'normal', at: T0 + 41 },
      {
        type: 'participant_requested',
        to: '+14155559999',
        label: null,
        supervisorRole: 'barge',
        at: T0 + 42,
      },
    ]);
    expect(freed.effects.filter((e) => e.type === 'dial_participant')).toHaveLength(1);
    // ...but the departed ROW stays, because it is what the cost model meters
    // and what the archive records about who was on the call.
    expect(freed.state.participants).toHaveLength(MAX_PARTICIPANTS + 1);
    // And the new pid does not collide with the departed one.
    expect(freed.state.participants.map((p) => p.pid)).toEqual([
      'p0',
      'p1',
      'p2',
      'p3',
      `p${MAX_PARTICIPANTS}`,
    ]);
  });

  it('ACCEPTANCE: an escalation participant hanging up does NOT end the call', () => {
    const { state, effects } = run(base(), [
      ...CONNECT,
      ...ADD_P0,
      { type: 'participant_hangup', pid: 'p0', cause: 'normal', at: T0 + 20 },
    ]);
    // The subject and the AI are still connected.
    expect(state.phase).not.toBe('completed');
    expect(state.phase).not.toBe('failed');
    expect(effects.filter((e) => e.type === 'teardown')).toHaveLength(0);
    expect(effects.filter((e) => e.type === 'end_conference')).toHaveLength(0);
    // Only that one person is marked gone.
    const p0 = findParticipant(state, 'p0');
    expect(p0?.status).toBe('left');
    expect(p0?.leftAt).toBe(T0 + 20);
  });

  it('ACCEPTANCE: the SUBJECT hanging up completes the call', () => {
    const { state, effects } = run(base(), [
      ...CONNECT,
      ...ADD_P0,
      { type: 'hangup', leg: 'A', cause: 'normal', at: T0 + 30 },
    ]);
    expect(state.phase).toBe('completed');
    expect(effects.filter((e) => e.type === 'teardown')).toHaveLength(1);
  });

  it('ACCEPTANCE: dropping a participant hangs the leg up, never `leave`', () => {
    const { effects } = run(base(), [
      ...CONNECT,
      ...ADD_P0,
      { type: 'participant_drop_requested', pid: 'p0', at: T0 + 21 },
    ]);
    // `leave` parks the leg -- up, billing, connected to nothing. The effect
    // vocabulary has no such thing, and this asserts the drop names the LEG so
    // the executor can hang it up.
    expect(effects.filter((e) => e.type === 'drop_participant')).toEqual([
      { type: 'drop_participant', pid: 'p0', legId: 'legP0-cc' },
    ]);
  });

  it('does not stamp leftAt at DROP time, only when the leg actually ends', () => {
    // Stamping at request time would shorten the metered window by however long
    // the provider call takes.
    const dropped = run(base(), [
      ...CONNECT,
      ...ADD_P0,
      { type: 'participant_drop_requested', pid: 'p0', at: T0 + 21 },
    ]);
    expect(findParticipant(dropped.state, 'p0')?.leftAt).toBeNull();
    const ended = run(dropped.state, [
      { type: 'participant_hangup', pid: 'p0', cause: 'normal', at: T0 + 25 },
    ]);
    expect(findParticipant(ended.state, 'p0')?.leftAt).toBe(T0 + 25);
  });

  it('records a participant who never answered as failed, with no billable time', () => {
    const { state } = run(base(), [
      ...CONNECT,
      {
        type: 'participant_requested',
        to: '+14155550199',
        label: null,
        supervisorRole: 'barge',
        at: T0 + 7,
      },
      { type: 'participant_dialed', pid: 'p0', legId: 'legP0-cc', at: T0 + 8 },
      { type: 'participant_hangup', pid: 'p0', cause: 'timeout', at: T0 + 40 },
    ]);
    const p0 = findParticipant(state, 'p0');
    expect(p0?.status).toBe('failed');
    expect(p0?.answeredAt).toBeNull();
  });

  it('drops a participant whose answer lands after the conference is gone', () => {
    // Their leg is up and answered but in no conference: nobody can hear them
    // and they can hear nobody, while the leg bills.
    const connected = run(base(), [...CONNECT]);
    const noConference: CallState = { ...connected.state, conferenceId: null };
    const { state, effects } = run(noConference, [
      {
        type: 'participant_requested',
        to: '+14155550199',
        label: null,
        supervisorRole: 'barge',
        at: T0 + 7,
      },
      { type: 'participant_dialed', pid: 'p0', legId: 'legP0-cc', at: T0 + 8 },
      { type: 'participant_answered', pid: 'p0', at: T0 + 9 },
    ]);
    expect(effects.filter((e) => e.type === 'drop_participant')).toHaveLength(1);
    expect(effects.filter((e) => e.type === 'join_conference')).toHaveLength(0);
    expect(findParticipant(state, 'p0')?.status).toBe('failed');
  });

  it('is idempotent across redelivered participant WEBHOOKS', () => {
    // Telnyx documents webhooks as "concurrent, duplicated, delayed, or
    // delivered out of order". Only the four provider-driven events are replayed
    // here; participant_requested is an OPERATOR command and gets its own test.
    const webhooks = ADD_P0.slice(1);
    const { state, effects } = run(base(), [...CONNECT, ...ADD_P0, ...webhooks]);
    expect(effects.filter((e) => e.type === 'dial_participant')).toHaveLength(1);
    expect(effects.filter((e) => e.type === 'join_conference')).toHaveLength(2); // leg A + p0
    // A second announcement would speak over a live conversation.
    expect(effects.filter((e) => e.type === 'announce_participant')).toHaveLength(1);
    expect(state.participants).toHaveLength(1);
  });

  it('refuses to dial a number ALREADY on the call, however the add arrives', () => {
    // The add is an HTTP request: a double-clicked button, a client retry after
    // a slow response, or a proxy replay all deliver it twice. The second must
    // not place a second real phone call to someone already talking.
    const { state, effects } = run(base(), [...CONNECT, ...ADD_P0, ...ADD_P0]);
    expect(effects.filter((e) => e.type === 'dial_participant')).toHaveLength(1);
    expect(state.participants).toHaveLength(1);

    // But the SAME number may be re-added once they have hung up, which is a
    // real thing an operator does when a call drops.
    const readded = run(state, [
      { type: 'participant_hangup', pid: 'p0', cause: 'normal', at: T0 + 30 },
      {
        type: 'participant_requested',
        to: '+14155550199',
        label: 'Supervisor',
        supervisorRole: 'barge',
        at: T0 + 31,
      },
    ]);
    expect(readded.effects.filter((e) => e.type === 'dial_participant')).toHaveLength(1);
    expect(readded.state.participants).toHaveLength(2);
  });

  it('does not move leftAt when hangup and participant.left both arrive', () => {
    // Both events report the SAME departure; whichever lands second must not
    // stretch the billable window.
    const { state } = run(base(), [
      ...CONNECT,
      ...ADD_P0,
      { type: 'participant_left', pid: 'p0', at: T0 + 20 },
      { type: 'participant_hangup', pid: 'p0', cause: 'normal', at: T0 + 26 },
    ]);
    expect(findParticipant(state, 'p0')?.leftAt).toBe(T0 + 20);
  });

  it('mutes and unmutes only a JOINED participant', () => {
    const joined = run(base(), [...CONNECT, ...ADD_P0]);
    const muted = run(joined.state, [
      { type: 'participant_mute_requested', pid: 'p0', muted: true, at: T0 + 20 },
    ]);
    expect(findParticipant(muted.state, 'p0')?.muted).toBe(true);
    expect(muted.effects.filter((e) => e.type === 'set_participant_mute')).toEqual([
      { type: 'set_participant_mute', conferenceId: 'conf-1', legId: 'legP0-cc', muted: true },
    ]);
    // Requesting the state it is already in emits nothing.
    const again = run(muted.state, [
      { type: 'participant_mute_requested', pid: 'p0', muted: true, at: T0 + 21 },
    ]);
    expect(again.effects).toHaveLength(0);

    // A participant still ringing has no conference seat to mute.
    const dialing = run(base(), [
      ...CONNECT,
      {
        type: 'participant_requested',
        to: '+14155550199',
        label: null,
        supervisorRole: 'barge',
        at: T0 + 7,
      },
      { type: 'participant_dialed', pid: 'p0', legId: 'legP0-cc', at: T0 + 8 },
      { type: 'participant_mute_requested', pid: 'p0', muted: true, at: T0 + 9 },
    ]);
    expect(dialing.effects.filter((e) => e.type === 'set_participant_mute')).toHaveLength(0);
  });

  it('ignores participant events for a pid this call does not have', () => {
    const before = run(base(), [...CONNECT, ...ADD_P0]);
    const after = run(before.state, [
      { type: 'participant_hangup', pid: 'p99', cause: 'normal', at: T0 + 30 },
      { type: 'participant_joined', pid: 'p99', at: T0 + 31 },
    ]);
    expect(after.effects).toHaveLength(0);
    expect(after.state.participants).toEqual(before.state.participants);
  });
});

// ---------------------------------------------------------------------------

describe('participant projection and label handling', () => {
  it('carries answeredAt so ONE function meters participants', () => {
    const { state } = run(base(), [...CONNECT, ...ADD_P0]);
    const p0 = findParticipant(state, 'p0');
    expect(p0).not.toBeNull();
    if (!p0) return;
    const view = participantView(p0);
    // The billing input has to reach the wire, or the live route and the archive
    // would each have to precompute a duration against their own clock.
    expect(view.answeredAt).toBe(T0 + 9);
    expect(view.legId).toBe('legP0-cc');
    expect(view.to).toBe('+14155550199');
    expect(view.label).toBe('Supervisor');
  });

  it('strips control, zero-width and bidi characters from a label', () => {
    // These are invisible where the operator types them, survive a naive filter,
    // and reach both Telnyx TTS and Grok's system prompt.
    expect(sanitizeParticipantLabel('Dr. Levine\n\nOffice')).toBe('Dr. Levine Office');
    expect(sanitizeParticipantLabel('Dr‮ Levine')).toBe('Dr Levine');
    expect(sanitizeParticipantLabel('A​B')).toBe('A B');
    expect(sanitizeParticipantLabel('   ')).toBeNull();
    expect(sanitizeParticipantLabel(null)).toBeNull();
    // Positive control: ordinary text is untouched, so the assertions above are
    // about the stripping rather than about everything being erased.
    expect(sanitizeParticipantLabel("O'Brien & Co.")).toBe("O'Brien & Co.");
  });

  it('always states that the call is recorded, named or not', () => {
    // The person who just joined never heard the notice given at the top of the
    // call, so their consent has to be sought when they arrive.
    expect(participantJoinNotice('Supervisor', true)).toContain('recorded');
    expect(participantJoinNotice(null, true)).toContain('recorded');
    expect(participantJoinNotice(null, true)).toContain('Someone else');
    // *** THE NOTICE MAY NOT CLAIM A RECORDING THAT IS NOT HAPPENING. ***
    // Recording is on-demand by default, so the un-recorded form is now the
    // COMMON path, not an edge case. A notice that says "this call is being
    // recorded" while nothing records is the one sentence a listener is
    // entitled to rely on, and it would be relied on precisely in the
    // jurisdictions that make the notice matter.
    expect(participantJoinNotice('Supervisor', false)).not.toContain('recorded');
    expect(participantJoinNotice(null, false)).not.toContain('recorded');
    // Positive control: it still says the thing it is actually for.
    expect(participantJoinNotice('Supervisor', false)).toContain('has joined');
  });
});

// ---------------------------------------------------------------------------

describe('cost model scales with real participant legs', () => {
  const RATES = ratesFrom({});
  const MINUTE = 60_000;

  it('adds nothing when there are no participants', () => {
    const call: BillableCall = {
      startedAt: T0,
      endedAt: T0 + MINUTE,
      answeredAt: T0,
      durationMs: MINUTE,
      answered: true,
    };
    const cost = estimateCallCost({ call, rates: RATES, recorded: false, now: T0 });
    expect(cost.telnyxParticipants).toBe(0);
    expect(cost.participantBillableMs).toBe(0);
  });

  it('meters each participant from ITS OWN answer to ITS OWN departure', () => {
    // A one-minute escalation on a ten-minute call must not be billed for ten
    // minutes. That is the direction that matters: overstating by 10x reads as a
    // real number and nothing ever revisits it.
    const endedAt = T0 + 10 * MINUTE;
    const participants: readonly BillableParticipant[] = [
      { answeredAt: T0 + 2 * MINUTE, leftAt: T0 + 3 * MINUTE }, // 1 minute
      { answeredAt: T0 + 5 * MINUTE, leftAt: null }, //             5 minutes, still on
      { answeredAt: null, leftAt: null }, //                        never answered: 0
    ];
    expect(participantBillableMs(participants, endedAt)).toBe(6 * MINUTE);

    const call: BillableCall = {
      startedAt: T0,
      endedAt,
      answeredAt: T0,
      durationMs: 10 * MINUTE,
      answered: true,
      participantBillableMs: participantBillableMs(participants, endedAt),
    };
    const cost = estimateCallCost({ call, rates: RATES, recorded: false, now: T0 });
    // Each participant leg is a PSTN call: Call Control + SIP trunking, and
    // neither media streaming (one stream per call) nor AMD (not requested).
    expect(cost.telnyxParticipants).toBeCloseTo(6 * (0.002 + 0.005), 9);
    expect(cost.participantBillableMs).toBe(6 * MINUTE);
  });

  it('a conference call costs MORE than the same call without participants', () => {
    // The two-leg assumption this replaced would have priced these identically.
    const shared = {
      startedAt: T0,
      endedAt: T0 + 5 * MINUTE,
      answeredAt: T0,
      durationMs: 5 * MINUTE,
      answered: true,
    };
    const plain = estimateCallCost({
      call: shared,
      rates: RATES,
      recorded: false,
      now: T0,
    });
    const conference = estimateCallCost({
      call: { ...shared, participantBillableMs: 5 * MINUTE },
      rates: RATES,
      recorded: false,
      now: T0,
    });
    expect(conference.total).toBeGreaterThan(plain.total);
    // And the delta is exactly the participant line, so the total still adds up.
    expect(conference.total - plain.total).toBeCloseTo(conference.telnyxParticipants, 9);
  });

  it('never bills a participant for time before they answered', () => {
    // leftAt <= answeredAt is a clock skew or an out-of-order webhook, not a
    // negative duration to subtract from the bill.
    expect(participantBillableMs([{ answeredAt: T0 + 100, leftAt: T0 }], T0 + 500)).toBe(0);
    expect(participantBillableMs([{ answeredAt: T0, leftAt: T0 }], T0 + 500)).toBe(0);
  });

  it('prices a legacy call with no participants field at exactly zero extra', () => {
    // Every call archived before conferences existed. Zero is the FACT about
    // them, not a fallback that hides a missing number.
    const call: BillableCall = {
      startedAt: T0,
      endedAt: T0 + MINUTE,
      answeredAt: T0,
      durationMs: MINUTE,
      answered: true,
    };
    const legacy = estimateCallCost({ call, rates: RATES, recorded: false, now: T0 });
    const explicitZero = estimateCallCost({
      call: { ...call, participantBillableMs: 0 },
      rates: RATES,
      recorded: false,
      now: T0,
    });
    expect(legacy.total).toBe(explicitZero.total);
  });
});

// ---------------------------------------------------------------------------

describe('the roster is bounded over the whole call, not just concurrently', () => {
  it('stops accepting adds after MAX_PARTICIPANT_ROWS, however many have left', () => {
    // Rows are append-only, so add-then-drop on a long call would otherwise grow
    // the persisted state without limit -- and past a thousand rows the minted
    // `p${n}` stops matching PARTICIPANT_ID_RE, at which point that
    // participant's webhooks are rejected at the boundary and their answered,
    // BILLING leg is never tracked or torn down.
    let state = run(base(), CONNECT).state;
    for (let i = 0; i < MAX_PARTICIPANT_ROWS; i += 1) {
      const to = `+1415555${String(1000 + i).padStart(4, '0')}`;
      state = run(state, [
        {
          type: 'participant_requested',
          to,
          label: null,
          supervisorRole: 'barge',
          at: T0 + 100 + i * 2,
        },
        // Immediately gone, so the CONCURRENT cap never binds and only the
        // lifetime budget can stop this.
        { type: 'participant_hangup', pid: `p${i}`, cause: 'normal', at: T0 + 101 + i * 2 },
      ]).state;
    }
    expect(state.participants).toHaveLength(MAX_PARTICIPANT_ROWS);
    expect(activeParticipantCount(state)).toBe(0);

    const over = run(state, [
      {
        type: 'participant_requested',
        to: '+14155559999',
        label: null,
        supervisorRole: 'barge',
        at: T0 + 900,
      },
    ]);
    expect(over.state.participants).toHaveLength(MAX_PARTICIPANT_ROWS);
    expect(over.effects.filter((e) => e.type === 'dial_participant')).toHaveLength(0);
  });

  it('keeps every minted pid inside the pattern the decoder accepts', () => {
    // The budget is only a real guard if it holds the id below the boundary's
    // ceiling. This asserts the two constants agree rather than trusting that
    // 25 "looks small enough".
    for (let i = 0; i < MAX_PARTICIPANT_ROWS; i += 1) {
      expect(PARTICIPANT_ID_RE.test(`p${i}`), `p${i} must decode`).toBe(true);
    }
    // Positive control: the pattern DOES reject something, so the loop above is
    // not passing because the regex accepts everything.
    expect(PARTICIPANT_ID_RE.test('p1000')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('the join notice carries the call’s own agent voice', () => {
  // xAI ships 28 built-in voices (GET /v1/tts/voices, verified live 2026-08-26).
  // A representative slice, deliberately including `liora` -- the value the
  // console ships as its default -- and all five that `speak` accepts.
  const XAI_VOICES = [
    'liora',
    'eve',
    'ara',
    'rex',
    'sal',
    'leo',
    'atlas',
    'luna',
    'aurora',
    'orion',
  ] as const;

  it('renders in the call’s own voice, whatever it is', () => {
    // VERIFIED LIVE 2026-08-30 against POST /v2/text-to-speech/speech, with an
    // armed negative control:
    //   xAI.liora -> 200, 39,168 bytes of audio
    //   xAI.not_a_real_voice -> 400 "Voice 'not_a_real_voice' not found"
    // This endpoint carries the FULL xAI catalog, which is why the notice is
    // rendered here and played, rather than handed to `speak`.
    expect(noticeRenderVoice('liora')).toBe('xAI.liora');
    expect(noticeRenderVoice('eve')).toBe('xAI.eve');
    expect(noticeRenderVoice('atlas')).toBe('xAI.atlas');
  });

  it('never hands `speak` an xAI voice Telnyx rejects', () => {
    // *** THE BUG THIS FILE PREVIOUSLY MISSED. ***
    // One function served both endpoints and returned `xAI.<v>` for ANY v. The
    // old test asserted xAI.liora reached the wire -- and it did. Telnyx
    // answered 422 "The 'voice' parameter Invalid voice." (live, call
    // 5ed08d10-52ba-4044-9555-26e9146a2d4b), so the notice never played on any
    // call. The test checked OUR half of the exchange and never the contract.
    //
    // Structural, not behavioural: it fails on a voice added to the console
    // later, not merely on the two spellings written today.
    for (const v of XAI_VOICES) {
      const out = conferenceNoticeVoice(v);
      if (out.startsWith('xAI.')) {
        expect(CONFERENCE_SPEAK_XAI_VOICES).toContain(out.slice('xAI.'.length));
      } else {
        expect(out).toBe(FALLBACK_NOTICE_VOICE);
      }
    }
  });

  it('falls back to a house voice for the 23 voices `speak` cannot say', () => {
    expect(conferenceNoticeVoice('liora')).toBe(FALLBACK_NOTICE_VOICE);
    expect(conferenceNoticeVoice('atlas')).toBe(FALLBACK_NOTICE_VOICE);
    // Positive control: the five it CAN say still come through as the agent's.
    expect(conferenceNoticeVoice('eve')).toBe('xAI.eve');
    expect(conferenceNoticeVoice('leo')).toBe('xAI.leo');
  });

  it('lets an operator pin ONE notice voice across every call', () => {
    expect(conferenceNoticeVoice('liora', 'Telnyx.KokoroTTS.af')).toBe('Telnyx.KokoroTTS.af');
    expect(noticeRenderVoice('liora', 'Telnyx.KokoroTTS.af')).toBe('Telnyx.KokoroTTS.af');
    // Whitespace-only is not an override; it is an unset var with a stray space,
    // and treating it as a voice would send Telnyx an empty string.
    expect(noticeRenderVoice('liora', '   ')).toBe('xAI.liora');
    expect(noticeRenderVoice('liora', undefined)).toBe('xAI.liora');
  });

  it('refuses to interpolate a voice that could change the provider segment', () => {
    // The value lands in a provider JSON body as <Provider>.<VoiceId>. A voice
    // containing a dot would silently become a DIFFERENT provider/model.
    // CallRequestSchema.voice already bounds this to [A-Za-z0-9_-]; this is the
    // second guard, at the point of use.
    expect(noticeRenderVoice('AWS.Polly.Joanna')).toBe(FALLBACK_NOTICE_VOICE);
    expect(noticeRenderVoice('../../etc')).toBe(FALLBACK_NOTICE_VOICE);
    expect(noticeRenderVoice('')).toBe(FALLBACK_NOTICE_VOICE);
    expect(noticeRenderVoice('a'.repeat(65))).toBe(FALLBACK_NOTICE_VOICE);
    // Positive control: the guard is not simply rejecting everything.
    expect(noticeRenderVoice('a'.repeat(64))).toBe(`xAI.${'a'.repeat(64)}`);
    // conferenceNoticeVoice cannot be reached by any of these at all -- its
    // allowlist can only ever emit a literal from the module.
    expect(conferenceNoticeVoice('AWS.Polly.Joanna')).toBe(FALLBACK_NOTICE_VOICE);
  });

  it('plays the rendered notice to the WHOLE conference', async () => {
    const { url, body } = await captureCommand((impl) =>
      conferencePlay(CFG, 'conf-1', { mediaName: 'notice-abc', commandId: 'c' }, impl),
    );
    expect(url).toContain('/conferences/conf-1/actions/play');
    expect(body['media_name']).toBe('notice-abc');
    // Omitted call_control_ids is what Telnyx reads as "the entire conference".
    // A consent notice that reached only the new arrival would be worthless.
    expect(body['call_control_ids']).toBeUndefined();
  });
});
