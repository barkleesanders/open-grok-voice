#!/usr/bin/env node
// gvb - open-grok-voice CLI
// Thin wrapper for placing parallel calls, listing live calls, and hanging up.
//
// Install: ln -sf $(pwd)/tools/gvb.mjs ~/.local/bin/gvb
//
// Examples:
//   gvb call --to +14155550123 --task "Ask if my order shipped."
//   gvb list-live                  # List all active calls
//   gvb hangup <callId>            # Hang up one call
//   gvb me                         # Check auth status

import { readFileSync } from 'node:fs';

const BASE = process.env.BRIDGE_BASE ?? 'https://open-grok-voice.example.com';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

const _has = (name) => process.argv.includes(`--${name}`);

function getApiKey() {
  if (process.env.APP_API_KEY) return process.env.APP_API_KEY.trim();
  try {
    return readFileSync(new URL('../.app_api_key.txt', import.meta.url), 'utf8').trim();
  } catch {
    console.error('Error: No API key found. Set APP_API_KEY env var or create .app_api_key.txt');
    process.exit(1);
  }
}

async function apiCall(path, options = {}) {
  const key = getApiKey();
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      ...options.headers,
    },
  });
  const text = await res.text();
  console.log(res.status, text);
  return { ok: res.ok, status: res.status, body: text };
}

async function cmdCall() {
  const to = arg('to');
  const task = arg('task');
  if (!to || !task) {
    console.error('usage: gvb call --to +1XXXXXXXXXX --task "..."');
    process.exit(2);
  }
  const result = await apiCall('/call', {
    method: 'POST',
    body: JSON.stringify({ to, task }),
  });
  process.exit(result.ok ? 0 : 1);
}

async function cmdListLive() {
  const result = await apiCall('/api/console/calls/live');
  if (result.ok) {
    try {
      const data = JSON.parse(result.body);
      if (Array.isArray(data.calls) && data.calls.length > 0) {
        console.log('\nLive calls:');
        data.calls.forEach((call) => {
          const elapsed = Math.floor((Date.now() - call.startedAt) / 1000);
          const subject = call.subject || call.to;
          console.log(`  ${call.callId}  ${subject}  ${elapsed}s`);
        });
      } else {
        console.log('\nNo active calls.');
      }
    } catch (err) {
      console.error('Failed to parse response:', err.message);
    }
  }
  process.exit(result.ok ? 0 : 1);
}

async function cmdHangup() {
  const callId = process.argv[3];
  if (!callId || !/^[0-9a-f-]{36}$/i.test(callId)) {
    console.error('usage: gvb hangup <callId>');
    process.exit(2);
  }
  const result = await apiCall(`/api/console/calls/${callId}/hangup`, {
    method: 'POST',
  });
  process.exit(result.ok ? 0 : 1);
}

async function cmdMe() {
  const result = await apiCall('/api/me');
  process.exit(result.ok ? 0 : 1);
}

function usage() {
  console.error(`usage: gvb <command> [options]

Commands:
  call         Place a new outbound call
  list-live    List all active (non-terminal) calls
  hangup       Hang up a specific call
  me           Check authentication status

Examples:
  gvb call --to +14155550123 --task "Ask if my order shipped."
  gvb list-live
  gvb hangup 550e8400-e29b-41d4-a716-446655440000
  gvb me`);
  process.exit(2);
}

const cmd = process.argv[2];
switch (cmd) {
  case 'call':
    await cmdCall();
    break;
  case 'list-live':
    await cmdListLive();
    break;
  case 'hangup':
    await cmdHangup();
    break;
  case 'me':
    await cmdMe();
    break;
  default:
    usage();
}
