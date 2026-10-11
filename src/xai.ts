// xAI Grok Speech-to-Speech (realtime) client -- CONTROL CHANNEL ONLY.
//
// We never carry audio. Telnyx bridges the media carrier-side; this WebSocket
// exists to (a) inject THIS call's task via session.update, (b) start the
// agent talking, and (c) collect transcript events.
//
// Contracts verified against docs.x.ai (2026-08-26):
//   - Join:  wss://api.x.ai/v1/realtime?call_id={call_id}, authenticated with
//     `Authorization: Bearer $XAI_API_KEY`. The docs are explicit that
//     "ephemeral client secrets are not supported for SIP call_id sessions",
//     so the bearer header is the ONLY auth path here.
//   - Then send `session.update`, then `response.create`.
//   - Server events used below are from the realtime event reference:
//       session.updated
//       conversation.item.input_audio_transcription.completed  (user speech)
//       response.output_audio_transcript.done                  (agent speech)
//       error
//     NOTE: `transcript.partial` / `transcript.done` belong to the SEPARATE
//     STT endpoint (wss://api.x.ai/v1/stt) and are NOT emitted here.

import { log } from './log';

export const XAI_REALTIME_URL = 'https://api.x.ai/v1/realtime';

/**
 * Open the outbound realtime WebSocket.
 *
 * Uses fetch()-with-Upgrade rather than `new WebSocket(url)` for one decisive
 * reason: the WebSocket constructor cannot set request headers, and this
 * endpoint requires `Authorization`. Cloudflare's documented outbound pattern
 * is a fetch with `Upgrade: websocket`, then read `response.webSocket` and call
 * `.accept()`.
 *
 * Holding this socket open is also what keeps the Durable Object alive:
 * Cloudflare documents that an active outbound WebSocket blocks hibernation and
 * eviction, so the DO survives the whole call without any alarm.
 */
export async function openRealtimeSocket(
  apiKey: string,
  xaiCallId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WebSocket> {
  const url = `${XAI_REALTIME_URL}?call_id=${encodeURIComponent(xaiCallId)}`;
  const resp = await fetchImpl(url, {
    headers: {
      Upgrade: 'websocket',
      Authorization: `Bearer ${apiKey}`,
    },
  });
  const ws = resp.webSocket;
  if (!ws) {
    log('error', 'xai.ws.upgrade_failed', { status: resp.status });
    throw new Error(`xAI realtime upgrade failed: HTTP ${resp.status}`);
  }
  ws.accept();
  log('info', 'xai.ws.open', { status: resp.status });
  return ws;
}

export interface SessionUpdateOptions {
  readonly voice: string;
  readonly instructions: string;
  /**
   * Enable server-side transcription of the CALLER's audio so we can store a
   * user-side transcript. Costs extra and, per the docs, the
   * `input_audio_transcription.*` events are only emitted when this is set.
   */
  readonly inputTranscription: boolean;
  /**
   * Phrase -> spoken-substitution map applied BEFORE TTS. Fixes pronunciation
   * without altering the transcript, so the stored text stays accurate while
   * the audio says the right thing.
   */
  readonly replace?: Readonly<Record<string, string>>;
  /**
   * Offer the agent the `send_dtmf` tool. Gated by the caller rather than
   * always-on: the tool plays tones at leg A's remote party, which is an IVR
   * on a call WE placed but a live human on a call that came TO us.
   */
  readonly dtmfTool?: boolean;
  /**
   * Offer the agent the `add_conference_participant` tool. Gated by the caller
   * rather than always-on: outbound calls only, never inbound.
   */
  readonly conferenceTool?: boolean;
}

/**
 * Characters xAI allows in a `replace` KEY.
 *
 * Measured against the live API 2026-08-26, not inferred: letters, digits,
 * apostrophes and spaces are accepted; a dot or slash returns
 *   400 replace key "cal.com" may not contain punctuation or symbols
 * Because a rejected session.update would kill the call outright, an invalid
 * key is strictly worse than no substitution at all.
 */
export const REPLACE_KEY_OK = /^[A-Za-z0-9' ]+$/;

/**
 * Pronunciation fixes for terms the model mangles on a phone call.
 *
 * NOTE the charset limit above: a URL CANNOT be a key here. The spoken form of
 * the booking link is produced in the prompt instead (see spokenUrl() in
 * availability.ts); this map only covers punctuation-free words.
 */
export const PRONUNCIATION: Readonly<Record<string, string>> = {
  johndoe: 'john doe',
  Amara: 'Ah mar ah',
};

/** Drop keys xAI would reject, so one bad entry cannot fail the whole session. */
export function sanitizeReplace(map: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    if (REPLACE_KEY_OK.test(k)) out[k] = v;
    else log('warn', 'xai.replace.key_dropped', { key: k });
  }
  return out;
}
/** Name of the keypad tool, shared by the declaration and the dispatcher. */
export const SEND_DTMF_TOOL_NAME = 'send_dtmf';
/** Name of the conference tool, shared by the declaration and the dispatcher. */
export const ADD_CONFERENCE_PARTICIPANT_TOOL_NAME = 'add_conference_participant';

/**
 * The keypad tool, declared in xAI's CANONICAL nested form.
 *
 * WHY NESTED, when the prose docs show a FLAT `{type, name, description,
 * parameters}`: the two published sources disagree, and a rejected
 * `session.update` kills the call outright, so the shape was settled against
 * the live API (2026-08-28) rather than chosen. Probing
 * wss://api.x.ai/v1/realtime with the flat form, the nested form, and both at
 * once: all three were ACCEPTED, and in every case the server's `session.updated`
 * echo came back NORMALIZED to this nested shape. That echo is also what proves
 * the tool is genuinely parsed rather than ignored -- a deliberately bogus
 * `{type:'not_a_tool_type'}` is echoed back verbatim, unnormalized.
 * The nested form therefore matches both the machine-readable schema at
 * docs.x.ai/voice-realtime.ws.json and the server's own canonical output.
 */
export interface FunctionToolDefinition {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    /** JSON Schema object describing the function parameters. */
    readonly parameters: {
      readonly type: 'object';
      readonly properties: Readonly<
        Record<string, { readonly type: string; readonly description: string }>
      >;
      readonly required: readonly string[];
    };
  };
}

export const SEND_DTMF_TOOL: FunctionToolDefinition = {
  type: 'function',
  function: {
    name: SEND_DTMF_TOOL_NAME,
    description:
      'Press keys on the phone keypad (DTMF touch tones) so the other end hears them. ' +
      'Use this to choose an option in a phone menu, dial an extension, or send a ' +
      'voicemail. Saying a digit out loud does NOT press it -- only this tool does.',
    parameters: {
      type: 'object',
      properties: {
        digits: {
          type: 'string',
          description:
            'The keys to press, in order, with no spaces. Digits 0-9, plus * and #. ' +
            'Use w for a half-second pause and W for a one-second pause between keys, ' +
            'for example "1w234". Send only the keys for this one step.',
        },
      },
      required: ['digits'],
    },
  },
};

/**
 * The conference tool, for conferencing someone into the live call.
 *
 * Declared in the same nested form as SEND_DTMF_TOOL for the same reason:
 * the server normalizes to this shape, and a rejected session.update kills
 * the call outright.
 */
export const ADD_CONFERENCE_PARTICIPANT_TOOL: FunctionToolDefinition = {
  type: 'function',
  function: {
    name: ADD_CONFERENCE_PARTICIPANT_TOOL_NAME,
    description:
      'Conference a third party into this call. Use this when asked to bring someone else ' +
      'onto the line, loop in a supervisor, or connect with another person. The number you ' +
      'dial will ring and when they answer they will join this conversation. You can add up ' +
      'to 4 participants total.',
    parameters: {
      type: 'object',
      properties: {
        phone_number: {
          type: 'string',
          description:
            'The E.164 phone number to dial, e.g. +14155550123. Must start with + followed by ' +
            'country code and the full number with no spaces or formatting.',
        },
        label: {
          type: 'string',
          description:
            'Optional name for this person, e.g. "Dr. Smith" or "billing department". This helps ' +
            'identify them on the call but is not required.',
        },
      },
      required: ['phone_number'],
    },
  },
};

/**
 * Build the `session.update` payload.
 *
 * Deliberately does NOT set `audio.input.format` / `audio.output.format`: on a
 * SIP call the codec is negotiated in SIP (xAI supports G.711 mu-law, G.711
 * A-law, G.722), and pinning a PCM format here would fight that negotiation.
 */
export function buildSessionUpdate(opts: SessionUpdateOptions): Record<string, unknown> {
  const session: Record<string, unknown> = {
    voice: opts.voice,
    instructions: opts.instructions,
    turn_detection: { type: 'server_vad' },
  };
  if (opts.inputTranscription) {
    session['audio'] = { input: { transcription: { model: 'grok-transcribe' } } };
  }
  const replace = sanitizeReplace(opts.replace ?? PRONUNCIATION);
  if (Object.keys(replace).length > 0) session['replace'] = replace;
  // Tools array: conditionally include dtmf and/or conference tools
  const tools: FunctionToolDefinition[] = [];
  if (opts.dtmfTool) tools.push(SEND_DTMF_TOOL);
  if (opts.conferenceTool) tools.push(ADD_CONFERENCE_PARTICIPANT_TOOL);
  if (tools.length > 0) session['tools'] = tools;
  return { type: 'session.update', session };
}

/**
 * `response.create`, optionally overriding the prompt for THIS turn only.
 *
 * The per-response `instructions` override is documented as applying to a
 * single response, after which the session prompt resumes. It is what lets the
 * turn that follows a keypress be told to stay quiet and listen, without
 * rewriting the whole session.
 */
export function buildResponseCreate(instructions?: string): Record<string, unknown> {
  if (!instructions) return { type: 'response.create' };
  return { type: 'response.create', response: { instructions } };
}

/**
 * Return a tool result to the model.
 *
 * `output` is documented as a STRING ("JSON string of the function result"),
 * not an object, so callers hand this a already-serialized payload.
 */
export function buildFunctionCallOutput(callId: string, output: string): Record<string, unknown> {
  return {
    type: 'conversation.item.create',
    item: { type: 'function_call_output', call_id: callId, output },
  };
}

// --- Server event handling -------------------------------------------------

export type XaiServerEvent =
  | { readonly kind: 'session_ready' }
  | { readonly kind: 'transcript'; readonly role: 'user' | 'assistant'; readonly text: string }
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly kind: 'function_call';
      readonly name: string;
      readonly callId: string;
      /** Raw JSON string of the arguments, exactly as the server sent it. */
      readonly args: string;
    }
  | { readonly kind: 'ignored'; readonly type: string };

function readString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Classify one server event. Returns `ignored` for the many events we do not
 * act on (audio deltas, content parts, item lifecycle) so the caller can log a
 * count without a giant switch.
 */
export function classifyServerEvent(raw: string): XaiServerEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'error', message: 'unparseable server event' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { kind: 'error', message: 'server event was not an object' };
  }
  const obj = parsed as Record<string, unknown>;
  const type = readString(obj, 'type') ?? 'unknown';

  switch (type) {
    case 'session.updated':
      return { kind: 'session_ready' };

    case 'conversation.item.input_audio_transcription.completed': {
      const text = readString(obj, 'transcript');
      return text ? { kind: 'transcript', role: 'user', text } : { kind: 'ignored', type };
    }

    case 'response.output_audio_transcript.done': {
      const text = readString(obj, 'transcript');
      return text ? { kind: 'transcript', role: 'assistant', text } : { kind: 'ignored', type };
    }

    // Field names verified against docs.x.ai/voice-realtime.ws.json (2026-08-28):
    // `call_id`, `name` and `arguments` all sit at the TOP LEVEL of the event,
    // not nested under an item. `arguments` may legitimately be absent for a
    // zero-parameter tool, so it degrades to '' and the dispatcher -- not the
    // classifier -- decides whether that is valid for the named tool.
    case 'response.function_call_arguments.done': {
      const name = readString(obj, 'name');
      const callId = readString(obj, 'call_id');
      if (!name || !callId) return { kind: 'ignored', type };
      const rawArgs = obj['arguments'];
      return {
        kind: 'function_call',
        name,
        callId,
        args: typeof rawArgs === 'string' ? rawArgs : '',
      };
    }

    case 'error': {
      // The error payload is documented as carrying a `message`; some
      // realtime implementations nest it under `error`. Handle both without
      // resorting to `any`.
      const direct = readString(obj, 'message');
      if (direct) return { kind: 'error', message: direct };
      const nested = obj['error'];
      if (typeof nested === 'object' && nested !== null) {
        const msg = readString(nested as Record<string, unknown>, 'message');
        if (msg) return { kind: 'error', message: msg };
      }
      return { kind: 'error', message: 'unspecified realtime error' };
    }

    default:
      return { kind: 'ignored', type };
  }
}
