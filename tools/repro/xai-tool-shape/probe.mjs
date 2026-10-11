#!/usr/bin/env node
// Which tool-declaration shape does xAI's realtime API actually accept?
//
// WHY THIS EXISTS: two published xAI sources disagree. The prose docs show a
// FLAT tool `{type, name, description, parameters}`; the machine-readable
// schema at docs.x.ai/voice-realtime.ws.json shows a NESTED
// `{type, function:{name, description, parameters}}`. A rejected
// `session.update` kills a live call, so this is not a guess we can afford.
//
// RESULT (2026-08-28): all three variants are ACCEPTED, and the server's
// `session.updated` echo normalizes EVERY one of them to the nested form.
// src/xai.ts therefore ships the nested form.
//
// The echo is also the proof the tool is genuinely parsed rather than ignored:
// the `bogus_tool_type` control below is echoed back verbatim, unnormalized.
// And `bogus_event_type` proves this probe can detect a rejection at all --
// without it, "no error" would be indistinguishable from "not validated".
//
// Opens a DIRECT WebSocket session (no call_id), so it places no phone call.
//   XAI_API_KEY=... node tools/repro/xai-test-key/probe.mjs
//
// NOTE: `ws` is resolved transitively (via wrangler), not a declared dependency
// of this package. This is a repro script, not shipped code -- nothing in
// src/ imports it, and it is not in the Worker bundle.

import WebSocket from 'ws';

const KEY = process.env['XAI_API_KEY'];
if (!KEY) {
  console.error('XAI_API_KEY is not set');
  process.exit(2);
}

const FN = {
  name: 'send_dtmf',
  description: 'Press touch-tone keypad digits on the phone line.',
  parameters: {
    type: 'object',
    properties: { digits: { type: 'string', description: 'Digits to press' } },
    required: ['digits'],
  },
};

const CASES = {
  'flat (prose docs)': { session: { tools: [{ type: 'function', ...FN }] } },
  'nested (ws.json)': { session: { tools: [{ type: 'function', function: FN }] } },
  'both at once': { session: { tools: [{ type: 'function', ...FN, function: FN }] } },
  // Control: parsed tools get normalized; an unknown type is echoed verbatim.
  bogus_tool_type: { session: { tools: [{ type: 'not_a_tool_type' }] } },
  // Control: proves the probe can see a rejection.
  bogus_event_type: { bogusEvent: true },
};

function probe(payload) {
  return new Promise((resolve) => {
    const ws = new WebSocket('wss://api.x.ai/v1/realtime?model=grok-voice-latest', {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    let settled = false;
    const done = (verdict) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      resolve(verdict);
    };
    const timer = setTimeout(() => done('NO RESPONSE'), 12_000);
    ws.on('open', () => {
      ws.send(
        JSON.stringify(
          payload.bogusEvent
            ? { type: 'totally.not.a.real.event' }
            : { type: 'session.update', session: { voice: 'eve', ...payload.session } },
        ),
      );
    });
    ws.on('message', (raw) => {
      let event;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (event.type === 'session.updated') {
        clearTimeout(timer);
        done(`ACCEPTED  echo=${JSON.stringify(event.session?.tools)}`);
      }
      if (event.type === 'error') {
        clearTimeout(timer);
        done(`REJECTED  ${JSON.stringify(event.error ?? event).slice(0, 200)}`);
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      done(`WS_ERROR  ${err.message}`);
    });
  });
}

for (const [label, payload] of Object.entries(CASES)) {
  console.log(`\n--- ${label} ---`);
  console.log(await probe(payload));
}
