// The keypad tool, end to end through the REAL Durable Object.
//
// test/dtmf.test.ts proves the validator; test/telnyx.test.ts proves the wire
// format. This file proves the part that neither can: that a tool call arriving
// on the xAI socket becomes a send_dtmf on LEG A -- the IVR -- and never on leg
// B, which is the SIP leg into xAI. Getting that backwards would play the tones
// at the model instead of at the phone tree, and it would fail SILENTLY: this
// command emits no webhook and Telnyx answers 200 either way.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallSession } from '../src/call-session';
import {
  buildInstructions,
  GUARDRAILS,
  IDENTITY_LINE,
  KEYPAD_DIRECTIVE,
  keypadAvailable,
  POST_KEYPAD_TURN_INSTRUCTIONS,
} from '../src/instructions';
import { type CallState, initialState } from '../src/state';
import {
  buildSessionUpdate,
  classifyServerEvent,
  SEND_DTMF_TOOL,
  SEND_DTMF_TOOL_NAME,
} from '../src/xai';
import { createFakeDurableObjectState, type FakeDurableObjectState } from './fake-do';
import { testEnv } from './test-env';

const CALL_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const LEG_A = 'legA-the-ivr';
const LEG_B = 'legB-into-xai';
const T0 = 1_756_000_000_000;

/** Records what the DO sends up the control socket. */
interface FakeSocket {
  readonly sent: string[];
  deliver(raw: string): void;
  readonly socket: WebSocket;
}

function createFakeSocket(): FakeSocket {
  const sent: string[] = [];
  const listeners = new Map<string, (event: unknown) => void>();
  const socket = {
    accept: () => undefined,
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    send: (data: string) => sent.push(data),
    close: () => undefined,
  } as unknown as WebSocket;
  return {
    sent,
    socket,
    deliver(raw: string) {
      const onMessage = listeners.get('message');
      if (!onMessage) throw new Error('DO never registered a message listener');
      onMessage({ data: raw });
    },
  };
}

interface Harness {
  readonly doState: FakeDurableObjectState;
  readonly ws: FakeSocket;
  /** Every Telnyx call-control request the DO issued, in order. */
  readonly telnyx: Request[];
  press(args: unknown, callId?: string): Promise<void>;
}

/**
 * Stand a real CallSession up mid-call with a live control socket.
 *
 * The socket is reached the way production reaches it: the DO handles an
 * `xai_incoming` event, which emits the `open_xai_ws` effect, which fetches the
 * upgrade. Stubbing the fetch is what lets a plain node test drive the genuine
 * class rather than a re-implementation of it.
 */
async function harness(overrides: Partial<CallState> = {}, telnyxStatus = 200): Promise<Harness> {
  const doState = createFakeDurableObjectState();
  const ws = createFakeSocket();
  const telnyx: Request[] = [];

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('https://api.x.ai/v1/realtime')) {
      return { status: 101, webSocket: ws.socket } as unknown as Response;
    }
    telnyx.push(new Request(input, init));
    return new Response('{"data":{"result":"ok"}}', { status: telnyxStatus });
  });

  const session = new CallSession(doState.ctx, testEnv());
  const seeded: CallState = {
    ...initialState({
      callId: CALL_ID,
      to: '+13154263600',
      task: 'Ask about an inpatient bed.',
      voice: 'eve',
      amd: null,
      now: T0,
    }),
    phase: 'connecting',
    legA: LEG_A,
    legB: LEG_B,
    legBAnswered: true,
    ...overrides,
  };
  await doState.ctx.storage.put('state', seeded);

  await session.fetch(
    new Request('https://do/event', {
      method: 'POST',
      body: JSON.stringify({ type: 'xai_incoming', xaiCallId: 'xai-call-1', at: T0 + 1 }),
    }),
  );
  telnyx.length = 0; // discard bridge/media commands from the setup transition
  ws.sent.length = 0;

  return {
    doState,
    ws,
    telnyx,
    async press(args: unknown, callId = 'call_001') {
      ws.deliver(
        JSON.stringify({
          type: 'response.function_call_arguments.done',
          event_id: 'event_fc01',
          call_id: callId,
          name: SEND_DTMF_TOOL_NAME,
          arguments: typeof args === 'string' ? args : JSON.stringify(args),
        }),
      );
      await doState.drain();
    },
  };
}

/** Parse the JSON the DO pushed up the socket. */
function sentEvents(ws: FakeSocket): Record<string, unknown>[] {
  return ws.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the tool declaration xAI actually accepts', () => {
  it('uses the nested {type, function:{...}} form the live API normalizes to', () => {
    // Settled against the live API on 2026-08-28, not chosen: the prose docs
    // show a FLAT shape and docs.x.ai/voice-realtime.ws.json shows this nested
    // one. Probing wss://api.x.ai/v1/realtime, all three of flat / nested /
    // both were accepted and every session.updated echo came back in THIS
    // shape. A rejected session.update kills the call, so the shape is pinned.
    expect(SEND_DTMF_TOOL).toEqual({
      type: 'function',
      function: {
        name: 'send_dtmf',
        description: expect.stringContaining('keypad'),
        parameters: {
          type: 'object',
          properties: { digits: { type: 'string', description: expect.any(String) } },
          required: ['digits'],
        },
      },
    });
  });

  it('tells the model in the tool description that speaking a digit is not pressing it', () => {
    const description = (SEND_DTMF_TOOL['function'] as { description: string }).description;
    expect(description).toMatch(/does NOT press it/i);
  });

  it('is attached to session.update only when the call is offered a keypad', () => {
    const base = { voice: 'eve', instructions: 'x', inputTranscription: false };
    expect(buildSessionUpdate({ ...base, dtmfTool: true })['session']).toHaveProperty('tools', [
      SEND_DTMF_TOOL,
    ]);
    expect(buildSessionUpdate({ ...base, dtmfTool: false })['session']).not.toHaveProperty('tools');
    expect(buildSessionUpdate(base)['session']).not.toHaveProperty('tools');
  });
});

describe('classifying the tool-call event', () => {
  it('reads name, call_id and arguments from the TOP LEVEL of the event', () => {
    // Field placement verified against docs.x.ai/voice-realtime.ws.json. Reading
    // them from a nested item -- the shape another vendor's realtime API uses --
    // would silently classify every tool call as 'ignored'.
    expect(
      classifyServerEvent(
        JSON.stringify({
          type: 'response.function_call_arguments.done',
          call_id: 'call_001',
          name: 'send_dtmf',
          arguments: '{"digits": "0"}',
        }),
      ),
    ).toEqual({
      kind: 'function_call',
      name: 'send_dtmf',
      callId: 'call_001',
      args: '{"digits": "0"}',
    });
  });

  it('ignores a malformed tool call rather than acting on half of one', () => {
    for (const partial of [
      { type: 'response.function_call_arguments.done', name: 'send_dtmf' },
      { type: 'response.function_call_arguments.done', call_id: 'call_001' },
    ]) {
      expect(classifyServerEvent(JSON.stringify(partial)).kind).toBe('ignored');
    }
  });

  it('degrades absent arguments to an empty string instead of throwing', () => {
    const event = classifyServerEvent(
      JSON.stringify({
        type: 'response.function_call_arguments.done',
        call_id: 'c',
        name: 'send_dtmf',
      }),
    );
    expect(event).toEqual({ kind: 'function_call', name: 'send_dtmf', callId: 'c', args: '' });
  });
});

describe('a tool call becomes a real keypress on the IVR', () => {
  it('POSTs send_dtmf to LEG A -- the IVR -- and never to leg B', async () => {
    const h = await harness();
    await h.press({ digits: '0' });

    expect(h.telnyx).toHaveLength(1);
    const request = h.telnyx[0];
    if (!request) throw new Error('no Telnyx request issued');

    expect(request.url).toBe(`https://api.telnyx.com/v2/calls/${LEG_A}/actions/send_dtmf`);
    // The assertion that actually catches the bug: leg B must appear nowhere.
    expect(request.url).not.toContain(LEG_B);
    expect(await request.clone().text()).not.toContain(LEG_B);

    const body = (await request.clone().json()) as Record<string, unknown>;
    expect(body['digits']).toBe('0');
  });

  it('normalizes the digits before they reach the provider', async () => {
    const h = await harness();
    await h.press({ digits: ' 1 2 a ' });

    const request = h.telnyx[0];
    if (!request) throw new Error('no Telnyx request issued');
    const body = (await request.clone().json()) as Record<string, unknown>;
    expect(body['digits']).toBe('12A');
  });

  it('returns the result to the model and asks it to stay quiet and listen', async () => {
    const h = await harness();
    await h.press({ digits: '0' });

    const events = sentEvents(h.ws);
    expect(events.map((e) => e['type'])).toEqual(['conversation.item.create', 'response.create']);

    const item = events[0]?.['item'] as Record<string, unknown>;
    expect(item['type']).toBe('function_call_output');
    expect(item['call_id']).toBe('call_001');
    // `output` is documented as a JSON STRING, not an object.
    expect(typeof item['output']).toBe('string');
    expect(JSON.parse(String(item['output']))).toMatchObject({ ok: true, digits: '0' });

    // Without this override the turn after a keypress talks over the menu the
    // keypress just requested.
    const response = events[1]?.['response'] as Record<string, unknown>;
    expect(String(response['instructions'])).toMatch(/say nothing/i);
  });
});

describe('the turn after a keypress keeps the safety block', () => {
  it('carries the identity line and guardrails in the per-response override', () => {
    // MEASURED against the live API 2026-08-28, not assumed: a per-response
    // `instructions` override REPLACES the session instructions rather than
    // appending. Probe -- session "always include BANANA" + override "say CAT"
    // returned "CAT"; the same session without an override returned "BANANA".
    // So anything omitted here is GONE for that turn, and the turn after a
    // keypress is exactly when an IVR asks for a Social Security number.
    expect(POST_KEYPAD_TURN_INSTRUCTIONS).toContain(IDENTITY_LINE);
    expect(POST_KEYPAD_TURN_INSTRUCTIONS).toContain(GUARDRAILS);
    expect(POST_KEYPAD_TURN_INSTRUCTIONS).toMatch(/say nothing/i);
  });

  it('sends that override on the wire after a real keypress', async () => {
    const h = await harness();
    await h.press({ digits: '0' });

    const response = sentEvents(h.ws)[1]?.['response'] as Record<string, unknown>;
    const instructions = String(response['instructions']);
    expect(instructions).toContain(IDENTITY_LINE);
    expect(instructions).toContain('Do not volunteer personal identifiers');
  });
});

describe('the per-call keypress budget', () => {
  it('allows a realistic navigation and then stops', async () => {
    const h = await harness();
    for (let i = 0; i < 25; i++) await h.press({ digits: '1' });
    expect(h.telnyx).toHaveLength(25);

    // The 26th is refused WITHOUT touching the provider. The motivating
    // failure was a menu that looped; a looping menu plus an agent told to
    // keep working the tree is a loop with nothing else to stop it.
    await h.press({ digits: '1' });
    expect(h.telnyx).toHaveLength(25);

    const events = sentEvents(h.ws);
    const last = events[events.length - 2]?.['item'] as Record<string, unknown>;
    expect(JSON.parse(String(last['output']))).toMatchObject({ ok: false });
  });

  it('spends budget even when the provider keeps failing', async () => {
    // Counted before the send, so a loop of FAILING presses still terminates.
    const h = await harness({}, 500);
    for (let i = 0; i < 26; i++) await h.press({ digits: '1' });
    expect(h.telnyx).toHaveLength(25);
  });
});

describe('what the tool refuses to do', () => {
  it('rejects a bad digit string without calling the provider at all', async () => {
    const h = await harness();
    await h.press({ digits: 'press one please' });

    expect(h.telnyx).toHaveLength(0);
    const item = sentEvents(h.ws)[0]?.['item'] as Record<string, unknown>;
    expect(JSON.parse(String(item['output']))).toMatchObject({ ok: false });
  });

  it('rejects an over-long string without calling the provider', async () => {
    const h = await harness();
    await h.press({ digits: '1'.repeat(500) });
    expect(h.telnyx).toHaveLength(0);
  });

  it('survives unparseable arguments and still answers the model', async () => {
    const h = await harness();
    await h.press('{not json');

    expect(h.telnyx).toHaveLength(0);
    // The model MUST get a result even on failure: a call left waiting on a
    // tool it invoked stalls or starts improvising, and on a live phone call
    // both are worse than being told plainly that it did not go through.
    const events = sentEvents(h.ws);
    expect(events).toHaveLength(2);
    const item = events[0]?.['item'] as Record<string, unknown>;
    expect(JSON.parse(String(item['output']))).toMatchObject({ ok: false });
  });

  it('refuses when the call has no leg A yet', async () => {
    const h = await harness({ legA: null });
    await h.press({ digits: '0' });

    expect(h.telnyx).toHaveLength(0);
    const item = sentEvents(h.ws)[0]?.['item'] as Record<string, unknown>;
    expect(JSON.parse(String(item['output']))).toMatchObject({ ok: false });
  });

  it('refuses on an INBOUND call, where leg A is a live human', async () => {
    const h = await harness({ direction: 'inbound' });
    await h.press({ digits: '0' });

    expect(h.telnyx).toHaveLength(0);
    const item = sentEvents(h.ws)[0]?.['item'] as Record<string, unknown>;
    expect(JSON.parse(String(item['output']))).toMatchObject({ ok: false });
  });

  it('reports a provider failure to the model rather than claiming success', async () => {
    const h = await harness({}, 422);
    await h.press({ digits: '0' });

    expect(h.telnyx).toHaveLength(1);
    const item = sentEvents(h.ws)[0]?.['item'] as Record<string, unknown>;
    expect(JSON.parse(String(item['output']))).toMatchObject({ ok: false });
  });

  it('truncates an unbounded tool name before logging or echoing it', async () => {
    const h = await harness();
    h.ws.deliver(
      JSON.stringify({
        type: 'response.function_call_arguments.done',
        call_id: 'call_003',
        name: 'x'.repeat(5000),
        arguments: '{}',
      }),
    );
    await h.doState.drain();

    expect(h.telnyx).toHaveLength(0);
    const item = sentEvents(h.ws)[0]?.['item'] as Record<string, unknown>;
    const output = JSON.parse(String(item['output'])) as { error: string };
    expect(output.error.length).toBeLessThan(200);
  });

  it('ignores a call to a tool it does not implement', async () => {
    const h = await harness();
    h.ws.deliver(
      JSON.stringify({
        type: 'response.function_call_arguments.done',
        call_id: 'call_002',
        name: 'transfer_all_funds',
        arguments: '{}',
      }),
    );
    await h.doState.drain();

    expect(h.telnyx).toHaveLength(0);
    const item = sentEvents(h.ws)[0]?.['item'] as Record<string, unknown>;
    expect(JSON.parse(String(item['output']))).toMatchObject({ ok: false });
  });
});

describe('the prompt and the tool cannot disagree', () => {
  it('offers the keypad on outbound calls and withholds it on inbound', () => {
    expect(keypadAvailable('outbound')).toBe(true);
    expect(keypadAvailable(undefined)).toBe(true);
    expect(keypadAvailable('inbound')).toBe(false);
  });

  it('mentions the keypad in the prompt exactly when the tool is declared', () => {
    // The failure this guards is silent and ugly: a prompt that promises a
    // keypad on a call where no tool was declared, so every press vanishes.
    for (const direction of ['outbound', 'inbound'] as const) {
      const prompt = buildInstructions({ task: 'Ask about a bed.', direction });
      const session = buildSessionUpdate({
        voice: 'eve',
        instructions: prompt,
        inputTranscription: false,
        dtmfTool: keypadAvailable(direction),
      })['session'] as Record<string, unknown>;

      // The equivalence IS the assertion: the prompt mentions the keypad if
      // and only if the session actually declared the tool.
      const declared = 'tools' in session;
      expect(declared).toBe(keypadAvailable(direction));
      expect(prompt.includes(KEYPAD_DIRECTIVE)).toBe(declared);
    }
  });

  it('puts the keypad directive ahead of the operator task', () => {
    const task = 'For billing press 3.';
    const prompt = buildInstructions({ task });
    expect(prompt.indexOf(KEYPAD_DIRECTIVE)).toBeLessThan(prompt.indexOf(task));
  });
});
