// Per-participant hold, supervisor roles, and the conference on the inbound
// follow-me path -- plus the STRUCTURAL guards that keep the next change from
// reopening what these close.
//
// The wire bodies are asserted, not the reducer state, for the same reason
// test/conference.test.ts does it: `call_control_ids` and `supervisor_role`
// live only in a request body, so a test that stopped at `state.participants`
// would pass just as happily with an empty array or a missing role.

import { describe, expect, it } from 'vitest';
import { renderConsolePage } from '../src/console-ui';
import { app, telnyxEventToCallEvent } from '../src/index';
import { createJob, jobToCallRequest, r2ScheduleStore } from '../src/schedule';
import {
  type CallEffect,
  type CallEvent,
  type CallState,
  findParticipant,
  hydrateState,
  initialInboundState,
  initialState,
  type PersistedCallState,
  type PersistedParticipant,
  reduce,
} from '../src/state';
import {
  joinConference,
  setConferenceHold,
  setConferenceMute,
  type TelnyxConfig,
} from '../src/telnyx';
import {
  AddParticipantRequestSchema,
  CallRequestSchema,
  MAX_PARTICIPANTS,
  SUPERVISOR_ROLES,
  type SupervisorRole,
} from '../src/types';
import { createFakeR2 } from './fake-r2';
import { readUtf8 } from './read-utf8';
import { testEnv } from './test-env';

const T0 = 1_700_000_000_000;
const CFG: TelnyxConfig = { apiKey: 'k', connectionId: 'conn', from: '+14155550123' };

function src(file: string): string {
  return readUtf8(import.meta.url, `../src/${file}`);
}

function base(): CallState {
  return initialState({
    callId: 'call-1',
    to: '+14155550100',
    task: 'do the thing',
    voice: 'eve',
    amd: null,
    now: T0,
  });
}

function run(state: CallState, events: readonly CallEvent[]) {
  let current = state;
  const effects: CallEffect[] = [];
  for (const event of events) {
    const result = reduce(current, event);
    current = result.state;
    effects.push(...result.effects);
  }
  return { state: current, effects };
}

const CONNECT: readonly CallEvent[] = [
  { type: 'leg_a_dialed', legA: 'legA-cc', at: T0 },
  { type: 'leg_a_answered', at: T0 + 1 },
  { type: 'leg_b_dialed', legB: 'legB-cc', at: T0 + 2 },
  { type: 'leg_b_answered', at: T0 + 3 },
  { type: 'xai_incoming', xaiCallId: 'xai-1', at: T0 + 4 },
  { type: 'xai_session_ready', at: T0 + 5 },
  { type: 'conference_created', conferenceId: 'conf-1', at: T0 + 6 },
];

/** Add one participant with the given role and drive them to 'joined'. */
function addParticipant(role: SupervisorRole): readonly CallEvent[] {
  return [
    {
      type: 'participant_requested',
      to: '+14155550199',
      label: 'Sup',
      supervisorRole: role,
      at: T0 + 7,
    },
    { type: 'participant_dialed', pid: 'p0', legId: 'legP0-cc', at: T0 + 8 },
    { type: 'participant_answered', pid: 'p0', at: T0 + 9 },
    { type: 'participant_joined', pid: 'p0', at: T0 + 10 },
  ];
}

async function captureCommand(
  invoke: (impl: typeof fetch) => Promise<unknown>,
): Promise<{ url: string; body: Record<string, unknown> }> {
  let seen: { url: string; body: Record<string, unknown> } | null = null;
  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = init?.body;
    seen = {
      url: typeof input === 'string' ? input : input.toString(),
      body: typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : {},
    };
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  await invoke(impl);
  if (seen === null) throw new Error('no request was issued');
  return seen;
}

// --- Hold / unhold ----------------------------------------------------------

describe('per-participant hold', () => {
  it('holds ONE leg, never the empty array Telnyx reads as everyone', async () => {
    const { url, body } = await captureCommand((impl) =>
      setConferenceHold(CFG, 'conf-1', { callControlId: 'legP0-cc', held: true }, impl),
    );
    expect(url).toBe('https://api.telnyx.com/v2/conferences/conf-1/actions/hold');
    expect(body['call_control_ids']).toEqual(['legP0-cc']);
  });

  it('unholds ONE leg', async () => {
    const { url, body } = await captureCommand((impl) =>
      setConferenceHold(CFG, 'conf-1', { callControlId: 'legP0-cc', held: false }, impl),
    );
    expect(url).toBe('https://api.telnyx.com/v2/conferences/conf-1/actions/unhold');
    expect(body['call_control_ids']).toEqual(['legP0-cc']);
  });

  /**
   * THE FOOTGUN, closed structurally rather than one call site at a time.
   *
   * Telnyx documents the empty `call_control_ids` case on mute and hold as
   * "all participants". A behavioural test only proves the two functions that
   * exist today are right; this fails when a THIRD one is written that spreads
   * a possibly-empty array or hardcodes `[]`.
   */
  it('STRUCTURAL: every call_control_ids in the Telnyx client is a single-leg array', () => {
    const text = src('telnyx.ts');
    // The lookbehind matters: `whisper_call_control_ids` ENDS in the same
    // characters and is a legitimately different, possibly-empty list.
    const occurrences = [...text.matchAll(/(?<![A-Za-z_])call_control_ids:\s*([^,\n]*)/g)].map(
      // Trailing `}` / whitespace from a one-line body object. Everything else
      // is kept verbatim, so `[]` or a bare variable name still fails below --
      // which is the point: this must catch what it was not written against.
      (m) => (m[1] ?? '').replace(/[}\s]+$/, ''),
    );
    // Armed: if the regex ever stops matching, this is the assertion that says so.
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
    for (const value of occurrences) {
      expect(value).toBe('[args.callControlId]');
    }
  });

  it('reduces a hold into a single-leg effect', () => {
    const { effects } = run(base(), [
      ...CONNECT,
      ...addParticipant('barge'),
      {
        type: 'participant_hold_requested',
        pid: 'p0',
        held: true,
        at: T0 + 11,
      },
    ]);
    expect(effects.filter((e) => e.type === 'set_participant_hold')).toEqual([
      { type: 'set_participant_hold', conferenceId: 'conf-1', legId: 'legP0-cc', held: true },
    ]);
  });

  it('refuses a hold for a participant that has no leg yet', () => {
    // Requested and queued, never dialed: legId is null, so an effect built
    // here would carry no call_control_id at all.
    const { state, effects } = run(base(), [
      ...CONNECT,
      {
        type: 'participant_requested',
        to: '+14155550199',
        label: null,
        supervisorRole: 'barge',
        at: T0 + 7,
      },
      { type: 'participant_hold_requested', pid: 'p0', held: true, at: T0 + 8 },
    ]);
    expect(effects.filter((e) => e.type === 'set_participant_hold')).toHaveLength(0);
    expect(findParticipant(state, 'p0')?.held).toBe(false);
  });

  it('refuses a hold for a participant who is dialing but not joined', () => {
    const { effects } = run(base(), [
      ...CONNECT,
      {
        type: 'participant_requested',
        to: '+14155550199',
        label: null,
        supervisorRole: 'barge',
        at: T0 + 7,
      },
      { type: 'participant_dialed', pid: 'p0', legId: 'legP0-cc', at: T0 + 8 },
      { type: 'participant_hold_requested', pid: 'p0', held: true, at: T0 + 9 },
    ]);
    expect(effects.filter((e) => e.type === 'set_participant_hold')).toHaveLength(0);
  });

  it('is idempotent -- a repeated hold issues no second command', () => {
    const { state, effects } = run(base(), [
      ...CONNECT,
      ...addParticipant('barge'),
      { type: 'participant_hold_requested', pid: 'p0', held: true, at: T0 + 11 },
      { type: 'participant_hold_requested', pid: 'p0', held: true, at: T0 + 12 },
    ]);
    expect(effects.filter((e) => e.type === 'set_participant_hold')).toHaveLength(1);
    expect(findParticipant(state, 'p0')?.held).toBe(true);
  });

  it('hold and mute are independent -- unmuting does not resume a held leg', () => {
    const { state } = run(base(), [
      ...CONNECT,
      ...addParticipant('barge'),
      { type: 'participant_hold_requested', pid: 'p0', held: true, at: T0 + 11 },
      { type: 'participant_mute_requested', pid: 'p0', muted: true, at: T0 + 12 },
      { type: 'participant_mute_requested', pid: 'p0', muted: false, at: T0 + 13 },
    ]);
    const row = findParticipant(state, 'p0');
    expect(row?.muted).toBe(false);
    expect(row?.held).toBe(true);
  });

  it('mute still sends its own single-leg array', async () => {
    const { body } = await captureCommand((impl) =>
      setConferenceMute(CFG, 'conf-1', { callControlId: 'legP0-cc', muted: true }, impl),
    );
    expect(body['call_control_ids']).toEqual(['legP0-cc']);
  });
});

// --- Supervisor roles -------------------------------------------------------

describe('supervisor roles', () => {
  it('omits supervisor_role entirely when none was asked for', async () => {
    const { body } = await captureCommand((impl) =>
      joinConference(
        CFG,
        'conf-1',
        {
          callControlId: 'legA-cc',
          clientState: 'x',
          commandId: 'c',
          endConferenceOnExit: true,
          supervisorRole: null,
          whisperCallControlIds: [],
        },
        impl,
      ),
    );
    expect(body).not.toHaveProperty('supervisor_role');
    expect(body).not.toHaveProperty('whisper_call_control_ids');
  });

  it('sends supervisor_role for a monitor and still no whisper list', async () => {
    const { body } = await captureCommand((impl) =>
      joinConference(
        CFG,
        'conf-1',
        {
          callControlId: 'legP0-cc',
          clientState: 'x',
          commandId: 'c',
          endConferenceOnExit: false,
          supervisorRole: 'monitor',
          whisperCallControlIds: [],
        },
        impl,
      ),
    );
    expect(body['supervisor_role']).toBe('monitor');
    expect(body).not.toHaveProperty('whisper_call_control_ids');
  });

  it('sends the whisper targets when there are any', async () => {
    const { body } = await captureCommand((impl) =>
      joinConference(
        CFG,
        'conf-1',
        {
          callControlId: 'legP0-cc',
          clientState: 'x',
          commandId: 'c',
          endConferenceOnExit: false,
          supervisorRole: 'whisper',
          whisperCallControlIds: ['legA-cc'],
        },
        impl,
      ),
    );
    expect(body['supervisor_role']).toBe('whisper');
    expect(body['whisper_call_control_ids']).toEqual(['legA-cc']);
  });

  it('a whisper joins against LEG A, the human on the other end', () => {
    const { state, effects } = run(base(), [...CONNECT, ...addParticipant('whisper')]);
    expect(effects.filter((e) => e.type === 'join_conference' && e.pid === 'p0')).toEqual([
      {
        type: 'join_conference',
        conferenceId: 'conf-1',
        legId: 'legP0-cc',
        endConferenceOnExit: false,
        pid: 'p0',
        supervisorRole: 'whisper',
        whisperLegIds: ['legA-cc'],
      },
    ]);
    expect(findParticipant(state, 'p0')?.supervisorRole).toBe('whisper');
  });

  /**
   * The downgrade Telnyx performs silently, performed loudly instead.
   *
   * "If none provided, the supervisor will join the conference as a monitoring
   * participant only." An inbound call whose leg A is somehow absent would send
   * a whisper with no targets and get a monitor -- so the reducer resolves it
   * to 'monitor' first, and the roster reports the role that actually happened.
   */
  it('resolves a whisper with nobody to whisper to down to MONITOR', () => {
    // A conference with no leg A cannot arise through conference_created, which
    // requires one -- so it is constructed here directly.
    const seeded: CallState = {
      ...base(),
      conferenceId: 'conf-1',
      legA: null,
      participants: [
        {
          pid: 'p0',
          to: '+14155550199',
          label: null,
          legId: 'legP0-cc',
          status: 'dialing',
          answeredAt: null,
          joinedAt: null,
          leftAt: null,
          muted: false,
          held: false,
          supervisorRole: 'whisper',
        },
      ],
    };
    const { state, effects } = run(seeded, [
      { type: 'participant_answered', pid: 'p0', at: T0 + 9 },
    ]);
    const joins = effects.filter((e) => e.type === 'join_conference');
    expect(joins).toEqual([
      {
        type: 'join_conference',
        conferenceId: 'conf-1',
        legId: 'legP0-cc',
        endConferenceOnExit: false,
        pid: 'p0',
        supervisorRole: 'monitor',
        whisperLegIds: [],
      },
    ]);
    // And the ROSTER says monitor too, not the whisper that was requested.
    expect(findParticipant(state, 'p0')?.supervisorRole).toBe('monitor');
  });

  /**
   * STRUCTURAL: iterates SUPERVISOR_ROLES, so a role added later is covered
   * automatically instead of being silently untested.
   *
   * The invariant is the one Telnyx's own semantics impose: a non-empty whisper
   * list is meaningful ONLY for 'whisper', and 'whisper' without one is not a
   * whisper at all.
   */
  it('STRUCTURAL: every role emits a whisper list iff it is a whisper', () => {
    expect(SUPERVISOR_ROLES.length).toBeGreaterThanOrEqual(3);
    for (const role of SUPERVISOR_ROLES) {
      const { effects } = run(base(), [...CONNECT, ...addParticipant(role)]);
      const joins = effects.filter((e) => e.type === 'join_conference' && e.pid !== null);
      expect(joins).toHaveLength(1);
      const join = joins[0];
      if (join === undefined || join.type !== 'join_conference') throw new Error('no join effect');
      expect(join.supervisorRole).toBe(role);
      expect(join.whisperLegIds.length > 0).toBe(role === 'whisper');
      // An escalation participant NEVER ends the call, whatever their role.
      expect(join.endConferenceOnExit).toBe(false);
    }
  });

  it('the request schema accepts every role it advertises and refuses others', () => {
    for (const role of SUPERVISOR_ROLES) {
      const parsed = AddParticipantRequestSchema.safeParse({
        to: '+14155550199',
        supervisorRole: role,
      });
      expect(parsed.success).toBe(true);
    }
    // 'none' is Telnyx's own synonym for 'barge'. Refused on purpose: two wire
    // values for one behaviour is two ways to write the same call.
    expect(
      AddParticipantRequestSchema.safeParse({ to: '+14155550199', supervisorRole: 'none' }).success,
    ).toBe(false);
    // Absent is legal and means barge.
    expect(AddParticipantRequestSchema.safeParse({ to: '+14155550199' }).success).toBe(true);
  });
});

// --- Inbound follow-me as a conference ---------------------------------------

describe('inbound follow-me: teardown parity with the bridge it replaces', () => {
  function inboundFollowMe(): CallState {
    return initialInboundState({
      callId: 'call-in',
      caller: '+14155550111',
      ownNumber: '+15555550100',
      legA: 'legA-caller',
      task: 'take a message',
      voice: 'eve',
      mode: 'follow_me',
      forwardTargets: ['+14155550777'],
      ringSecs: 20,
      now: T0,
    });
  }

  const TO_HUMAN: readonly CallEvent[] = [
    { type: 'leg_a_answered', at: T0 + 1 },
    { type: 'forward_dialed', legF: 'ccF1', at: T0 + 2 },
    { type: 'forward_answered', legF: 'ccF1', at: T0 + 3 },
    { type: 'forward_amd', legF: 'ccF1', result: 'human', at: T0 + 4 },
    { type: 'conference_created', conferenceId: 'conf-in', at: T0 + 5 },
  ];

  it('joins the CALLER with end_conference_on_exit, and creates from leg F', () => {
    const { effects } = run(inboundFollowMe(), TO_HUMAN);
    expect(effects.filter((e) => e.type === 'create_conference')).toEqual([
      { type: 'create_conference', legId: 'ccF1', leg: 'F' },
    ]);
    expect(effects.filter((e) => e.type === 'join_conference')).toEqual([
      {
        type: 'join_conference',
        conferenceId: 'conf-in',
        legId: 'legA-caller',
        endConferenceOnExit: true,
        pid: null,
        supervisorRole: null,
        whisperLegIds: [],
      },
    ]);
  });

  it('THE CALLER hanging up tears the whole call down', () => {
    const { state, effects } = run(inboundFollowMe(), [
      ...TO_HUMAN,
      { type: 'hangup', leg: 'A', cause: 'normal_clearing', at: T0 + 20 },
    ]);
    expect(state.phase).toBe('completed');
    expect(effects.filter((e) => e.type === 'teardown')).toHaveLength(1);
  });

  it('an added PARTICIPANT hanging up does not', () => {
    const { state, effects } = run(inboundFollowMe(), [
      ...TO_HUMAN,
      {
        type: 'participant_requested',
        to: '+14155550188',
        label: null,
        supervisorRole: 'barge',
        at: T0 + 6,
      },
      { type: 'participant_dialed', pid: 'p0', legId: 'legP0-cc', at: T0 + 7 },
      { type: 'participant_answered', pid: 'p0', at: T0 + 8 },
      { type: 'participant_joined', pid: 'p0', at: T0 + 9 },
      { type: 'participant_hangup', pid: 'p0', cause: 'normal_clearing', at: T0 + 10 },
    ]);
    expect(state.phase).not.toBe('completed');
    expect(effects.filter((e) => e.type === 'teardown')).toHaveLength(0);
    expect(findParticipant(state, 'p0')?.status).toBe('left');
  });

  it('the ANSWERING HUMAN hanging up still ends the call, as the bridge did', () => {
    // Carrier-side this no longer happens for free -- a conference creator does
    // not carry end_conference_on_exit -- so the reducer is what preserves it.
    const { state, effects } = run(inboundFollowMe(), [
      ...TO_HUMAN,
      { type: 'forward_hangup', legF: 'ccF1', cause: 'normal_clearing', at: T0 + 20 },
    ]);
    expect(state.phase).toBe('completed');
    expect(effects.filter((e) => e.type === 'teardown')).toEqual([
      { type: 'teardown', reason: 'forward_hangup:normal_clearing' },
    ]);
  });

  it('an operator can now add someone to a FORWARDED call at all', () => {
    // The whole reason this path stopped being a two-leg bridge.
    const { effects } = run(inboundFollowMe(), [
      ...TO_HUMAN,
      {
        type: 'participant_requested',
        to: '+14155550188',
        label: null,
        supervisorRole: 'barge',
        at: T0 + 6,
      },
    ]);
    expect(effects.filter((e) => e.type === 'dial_participant')).toEqual([
      { type: 'dial_participant', pid: 'p0', to: '+14155550188' },
    ]);
  });

  it('STRUCTURAL: the two-leg bridge is gone from the reducer and the client', () => {
    // Not a style preference: a surviving `bridge` would be a second, untested
    // way to connect two legs whose teardown semantics differ from the
    // conference's, and nothing in the type system would point at it.
    expect(src('state.ts')).not.toContain("type: 'bridge'");
    expect(src('telnyx.ts')).not.toContain("'bridge'");
    // Armed: the string the replacement DOES use is present, so a rename that
    // broke this test's premise would show up as a failure here.
    expect(src('state.ts')).toContain("type: 'create_conference'");
  });

  it('routes a forward leg hangup to forward_hangup, never to the call-ending hangup', () => {
    // The creator's client_state is now stamped with its own leg letter. If it
    // were still hardcoded 'B', this webhook would decode as leg B and produce
    // `hangup`, which COMPLETES THE CALL for the caller.
    expect(
      telnyxEventToCallEvent(
        { callId: 'call-in', leg: 'F' },
        'call.hangup',
        {
          call_control_id: 'ccF1',
          hangup_cause: 'normal_clearing',
        },
        T0,
      ),
    ).toEqual({ type: 'forward_hangup', legF: 'ccF1', cause: 'normal_clearing', at: T0 });
  });
});

// --- Start-of-call participants ---------------------------------------------

describe('participants supplied on the call request', () => {
  it('the schema takes them and caps them', () => {
    const many = Array.from({ length: MAX_PARTICIPANTS + 1 }, (_, i) => `+141555501${10 + i}`);
    expect(
      CallRequestSchema.safeParse({ to: '+14155550100', task: 't', participants: many }).success,
    ).toBe(false);
    expect(
      CallRequestSchema.safeParse({
        to: '+14155550100',
        task: 't',
        participants: many.slice(0, MAX_PARTICIPANTS),
      }).success,
    ).toBe(true);
    // Same E.164 rule as `to`, not a looser one.
    expect(
      CallRequestSchema.safeParse({ to: '+14155550100', task: 't', participants: ['4155550111'] })
        .success,
    ).toBe(false);
  });

  it('a SCHEDULED call carries them through to the fired request', () => {
    // Without this the console's run-at field would place a call the operator
    // believed had three people on it with one.
    const job = createJob(
      {
        to: '+14155550100',
        task: 'later',
        participants: ['+14155550199', '+14155550188'],
        runAt: T0 + 60_000,
      },
      T0,
      'sch_11111111-1111-4111-8111-111111111111',
    );
    expect(job.participants).toEqual(['+14155550199', '+14155550188']);
    expect(jobToCallRequest(job).participants).toEqual(['+14155550199', '+14155550188']);
  });

  it('a job written BEFORE the field existed reads back as nobody, not a crash', () => {
    // The real reader, over bytes that genuinely lack the key -- not a literal
    // this test then asserts about itself. `parseJob` is private, so the store
    // is the seam: write the old JSON straight into the bucket and list it.
    const r2 = createFakeR2();
    const id = 'sch_22222222-2222-4222-8222-222222222222';
    const legacyJson = JSON.stringify({
      id,
      to: '+14155550100',
      task: 't',
      subject: null,
      voice: null,
      amd: null,
      busy: [],
      windowDays: 7,
      slots: [],
      slotMinutes: 30,
      runAt: T0,
      status: 'pending',
      createdAt: T0,
      claimedAt: null,
      firedAt: null,
      firedCallId: null,
      failedDetail: null,
    });
    expect(legacyJson).not.toContain('participants');
    return (async () => {
      await r2.bucket.put(`schedules/${id}.json`, legacyJson);
      const jobs = await r2ScheduleStore(r2.bucket).list();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.participants).toEqual([]);
      // And it survives the whole way to the request the tick would fire.
      const job = jobs[0];
      if (!job) throw new Error('no job');
      expect(jobToCallRequest(job).participants).toEqual([]);
    })();
  });
});

// --- Console surface --------------------------------------------------------

describe('console: the fields these controls need', () => {
  const PAGE = renderConsolePage('test-nonce', 'authorized', { name: 'Operator', image: null });
  const SCRIPT = (() => {
    const match = PAGE.match(/<script nonce="test-nonce">([\s\S]*?)<\/script>/);
    if (!match || match[1] === undefined) throw new Error('console script tag not found');
    return match[1];
  })();

  it('the browser script is syntactically valid JavaScript', () => {
    // A syntax error here is a console that is 100% dead, and every other
    // assertion in this file about the page would still pass.
    expect(() => new Function(SCRIPT)).not.toThrow();
    expect(SCRIPT.length).toBeGreaterThan(1000);
  });

  it('the NEW-CALL form takes participants and sends them', () => {
    expect(PAGE).toContain('id="call-participants"');
    expect(SCRIPT).toContain("parseParticipants(byId('call-participants').value)");
    expect(SCRIPT).toContain('participants: participants.length > 0 ? participants : undefined');
  });

  it('the browser validates with the SAME E.164 regex the server compiles', () => {
    // One literal, three consumers. A second regex written here is exactly the
    // drift src/types.ts exports E164_PATTERN to prevent.
    expect(SCRIPT).toContain('const E164 = new RegExp("^\\\\+[1-9]\\\\d{6,14}$")');
    expect(PAGE).toContain('pattern="^\\+[1-9]\\d{6,14}$"');
    expect(SCRIPT).toContain(`const MAX_PARTICIPANTS = ${MAX_PARTICIPANTS};`);
  });

  it('the roster offers hold and the add form offers a role', () => {
    expect(SCRIPT).toContain("toggle(participant.held ? 'unhold' : 'hold'");
    expect(SCRIPT).toContain("toggle(participant.muted ? 'unmute' : 'mute'");
    expect(PAGE).toContain('id="participant-role"');
    for (const role of SUPERVISOR_ROLES) {
      expect(PAGE).toContain(`value="${role}"`);
    }
    expect(SCRIPT).toContain('supervisorRole: roleNode.value');
  });

  it('states plainly what a whisper with nobody to whisper to becomes', () => {
    // The spec downgrades it to monitor-only. Saying so is the difference
    // between a documented behaviour and a surprise on a live call.
    expect(PAGE).toContain('listen-only');
  });

  it('adds no inline handler, which the nonce CSP would refuse', () => {
    // The MARKUP only. The script block legitimately contains the word
    // "onclick=" inside a comment explaining why there is no such attribute,
    // and a check that could not tell those apart would be measuring prose.
    const markup = PAGE.replace(/<script nonce="test-nonce">[\s\S]*?<\/script>/, '');
    expect(markup.length).toBeGreaterThan(1000);
    expect(markup).not.toMatch(/\son[a-z]+\s*=/i);
  });
});

// --- Hydration of roster rows ------------------------------------------------

describe('a roster row written by an older deploy', () => {
  it('gains held and supervisorRole rather than reaching the wire as undefined', () => {
    // The top-level HYDRATED_DEFAULTS spread fills a MISSING `participants`
    // key; it does nothing to a PRESENT array of stale rows. The failure that
    // would cause is quiet: `supervisor_role: undefined` is dropped by
    // JSON.stringify, so Telnyx gets a correct body while the console and the
    // archive record a role the participant never had.
    const stale: PersistedParticipant = {
      pid: 'p0',
      to: '+14155550199',
      label: null,
      legId: 'legP0-cc',
      status: 'joined' as const,
      answeredAt: T0,
      joinedAt: T0,
      leftAt: null,
      muted: false,
    };
    const persisted: PersistedCallState = {
      ...base(),
      conferenceId: 'conf-1',
      participants: [stale],
    };
    const row = hydrateState(persisted).participants[0];
    expect(row?.held).toBe(false);
    expect(row?.supervisorRole).toBe('barge');
    // Armed: the stale row genuinely lacks them, so this is not asserting
    // about a value the test itself supplied.
    expect(Object.hasOwn(stale, 'held')).toBe(false);
    expect(Object.hasOwn(stale, 'supervisorRole')).toBe(false);
  });

  /**
   * STRUCTURAL, and it closes the CLASS rather than these two fields: every key
   * a fresh row has must be either present on a stale row or defaulted by
   * hydration. The next field added to `Participant` fails here until it is
   * accounted for, which is the only thing that stops the quiet failure above
   * from being reintroduced.
   */
  it('STRUCTURAL: every Participant key survives hydration of a bare row', () => {
    const fresh = run(base(), [...CONNECT, ...addParticipant('barge')]).state.participants[0];
    if (!fresh) throw new Error('no participant');
    const keys = Object.keys(fresh);
    expect(keys.length).toBeGreaterThanOrEqual(10);
    // A row stripped to the fields the FIRST version of the roster had. Typed
    // as PersistedParticipant, not smuggled past the compiler with a cast --
    // that type exists precisely to describe a row this shape.
    const bare: PersistedParticipant = {
      pid: fresh.pid,
      to: fresh.to,
      label: fresh.label,
      legId: fresh.legId,
      status: fresh.status,
      answeredAt: fresh.answeredAt,
      joinedAt: fresh.joinedAt,
      leftAt: fresh.leftAt,
      muted: fresh.muted,
    };
    const persistedBare: PersistedCallState = { ...base(), participants: [bare] };
    const hydrated = hydrateState(persistedBare).participants[0];
    if (!hydrated) throw new Error('no hydrated participant');
    for (const key of keys) {
      expect(hydrated[key as keyof typeof hydrated], `hydration dropped ${key}`).toBeDefined();
    }
  });
});

// --- The follow-me conference reaching 'bridged' -----------------------------

describe('the follow-me conference reports itself connected', () => {
  it("leg A's conference.participant.joined is what sets phase 'bridged'", () => {
    // Leg F is the CREATOR and its own joined event maps to null, which is
    // correct but leaves only one event able to confirm the connection. If
    // leg A's mapping were lost the console would sit on 'forwarding' for the
    // whole of a working call, so it is asserted rather than assumed.
    const event = telnyxEventToCallEvent(
      { callId: 'call-in', leg: 'A' },
      'conference.participant.joined',
      { call_control_id: 'legA-caller' },
      T0 + 6,
    );
    expect(event).toEqual({ type: 'bridge_confirmed', at: T0 + 6 });
    const seeded: CallState = {
      ...initialInboundState({
        callId: 'call-in',
        caller: '+14155550111',
        ownNumber: '+15555550100',
        legA: 'legA-caller',
        task: 't',
        voice: 'eve',
        mode: 'follow_me',
        forwardTargets: ['+14155550777'],
        ringSecs: 20,
        now: T0,
      }),
      phase: 'forwarding',
      legF: 'ccF1',
      bridgeRequested: true,
      conferenceId: 'conf-in',
    };
    if (event === null) throw new Error('event was not mapped');
    expect(run(seeded, [event]).state.phase).toBe('bridged');
  });
});

// --- Recording ---------------------------------------------------------------

describe('recording stays on leg A, and the ingest matches what is started', () => {
  /**
   * The gate on a future migration to conference-level recording.
   *
   * `POST /conferences/{id}/actions/record_start` has NO `client_state`
   * parameter (verified in tools/openapi/telnyx-conference.subset.json), while
   * the ONLY thing that attributes a saved recording to a call is
   * `decodeClientState(payload.client_state)`. So starting a conference
   * recording without also teaching the webhook how to attribute
   * `conference.recording.saved` drops the audio silently -- a 200 ack and no
   * archived asset. This test fails the moment the first half is written
   * without the second.
   */
  it('STRUCTURAL: a conference record_start requires a conference.recording.saved handler', () => {
    const startsConferenceRecording =
      /CONFERENCE_BASE[\s\S]{0,400}record_start/.test(src('telnyx.ts')) ||
      /conferenceCommand\([\s\S]{0,200}'record_start'/.test(src('telnyx.ts'));
    if (startsConferenceRecording) {
      expect(src('index.ts')).toContain('conference.recording.saved');
    }
    // Armed either way: the leg-level recording this Worker DOES start must
    // keep the ingest it has, so a deletion of one half is caught too.
    expect(src('index.ts')).toContain("'call.recording.saved'");
    expect(src('call-session.ts')).toContain("channels: 'dual'");
  });

  it('a recording webhook is attributed by leg A and nothing else', () => {
    // Same guard the recording ingest applies. Stated as a test so that
    // widening it later is a deliberate edit rather than a silent one.
    expect(src('index.ts')).toContain("recordingState?.leg !== 'A'");
  });
});

/**
 * REGRESSION: every participant control route 400'd on a live call because
 * `plausibleLegId` omitted ':' while every Telnyx call_control_id is version
 * prefixed. Captured from a real conference on 2026-08-30 -- deliberately NOT a
 * hand-written fixture, because a hand-written one is what hid this: the whole
 * suite used ids shaped like 'legA-cc', so it only ever proved the validator
 * agreed with itself.
 */
describe('plausibleLegId accepts real Telnyx call_control_ids', () => {
  const REAL_TELNYX_LEG_ID = 'v3:GkLIkATR7cCiH0PrdkxzJifm0iSrddSeZrGhRW54ALM_rFdVugxdFA';

  it('routes a real, colon-prefixed leg id through to the Durable Object', async () => {
    // 400 here means the ROUTE rejected it; anything else means it got past the
    // validator, which is the only thing this test is about.
    const res = await app.request(
      `/call/67107914-2b26-479a-8a98-5a8e7373ddd0/participants/${REAL_TELNYX_LEG_ID}/mute`,
      { method: 'POST', headers: { 'x-api-key': 'k' } },
      { ...testEnv(), APP_API_KEY: 'k' },
    );
    expect(res.status).not.toBe(400);
  });

  it('still refuses a path segment carrying characters no provider id contains', async () => {
    for (const bad of ['a b', 'a/../b', 'a\nb', '<script>']) {
      const res = await app.request(
        `/call/67107914-2b26-479a-8a98-5a8e7373ddd0/participants/${encodeURIComponent(bad)}/mute`,
        { method: 'POST', headers: { 'x-api-key': 'k' } },
        { ...testEnv(), APP_API_KEY: 'k' },
      );
      expect(res.status).toBe(400);
    }
  });
});
