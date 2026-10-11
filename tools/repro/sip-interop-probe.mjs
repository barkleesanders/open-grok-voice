#!/usr/bin/env node
/**
 * sip-interop-probe -- the ONE experiment that collapses the biggest unknown
 * in this project.
 *
 * Everything else in open-grok-voice is verified against published API
 * contracts. Exactly one link is not, and cannot be, verified without a live
 * call: whether a Telnyx-originated INVITE to sip:{number}@sip.voice.x.ai is
 * ACCEPTED by xAI (codec negotiation, TLS, and the IP allowlist all have to
 * line up), and whether xAI then fires realtime.call.incoming at our webhook.
 *
 * This probe deliberately does NOT place a call to a human. It dials ONLY leg
 * B -- the SIP leg into xAI -- which is the cheapest possible end-to-end test
 * of the risky link.
 *
 * SAFETY: dry-run by default. It will not place a call unless you pass --live.
 * It is never invoked by `npm test`, `npm run check`, or any hook.
 *
 * Usage:
 *   node tools/repro/sip-interop-probe.mjs                 # dry run, no call
 *   node tools/repro/sip-interop-probe.mjs --live          # places ONE call
 *   node tools/repro/sip-interop-probe.mjs --live --watch 45
 *
 * Required environment (never hardcode these):
 *   TELNYX_API_KEY         Telnyx V2 API key
 *   TELNYX_CONNECTION_ID   Voice API Application (Call Control) connection id
 *   TELNYX_FROM_NUMBER     E.164 number on that connection
 *   XAI_PHONE_NUMBER       the E.164 number registered with xAI (byo_trunk)
 * Optional:
 *   XAI_SIP_HOST           default sip.voice.x.ai
 *   PUBLIC_BASE_URL        your deployed Worker; call events are sent to
 *                          {PUBLIC_BASE_URL}/telnyx-webhook so you can watch
 *                          them with `wrangler tail`
 */

const TELNYX_BASE = 'https://api.telnyx.com/v2';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

const LIVE = process.argv.includes('--live');
const WATCH_SECONDS = Number(arg('--watch', '40')) || 40;

function redact(v) {
  if (!v) return '(unset)';
  const digits = String(v).replace(/\D/g, '');
  if (digits.length < 5) return '***';
  return `${String(v).trimStart().startsWith('+') ? '+' : ''}${digits[0]}${'*'.repeat(digits.length - 3)}${digits.slice(-2)}`;
}

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`MISSING ENV: ${name}`);
    return null;
  }
  return v;
}

const cfg = {
  apiKey: need('TELNYX_API_KEY'),
  connectionId: need('TELNYX_CONNECTION_ID'),
  from: need('TELNYX_FROM_NUMBER'),
  xaiNumber: need('XAI_PHONE_NUMBER'),
  sipHost: process.env.XAI_SIP_HOST || 'sip.voice.x.ai',
  baseUrl: process.env.PUBLIC_BASE_URL || '',
};

if (Object.values(cfg).some((v) => v === null)) {
  console.error('\nAborting: set the missing environment variables above.');
  process.exit(2);
}

const sipUri = `sip:${cfg.xaiNumber}@${cfg.sipHost};transport=tls`;
const probeId = `sip-probe-${Date.now()}`;
const body = {
  connection_id: cfg.connectionId,
  to: sipUri,
  from: cfg.from,
  command_id: crypto.randomUUID(),
  client_state: Buffer.from(JSON.stringify({ probe: probeId })).toString('base64'),
  sip_headers: [{ name: 'User-to-User', value: probeId }],
  timeout_secs: 30,
  ...(cfg.baseUrl ? { webhook_url: `${cfg.baseUrl}/telnyx-webhook` } : {}),
};

console.log('='.repeat(72));
console.log('SIP INTEROP PROBE  (Telnyx -> xAI)');
console.log('='.repeat(72));
console.log(
  `mode          : ${LIVE ? 'LIVE (will place ONE real call)' : 'DRY RUN (no call placed)'}`,
);
console.log(`target        : sip:${redact(cfg.xaiNumber)}@${cfg.sipHost};transport=tls`);
console.log(`from          : ${redact(cfg.from)}`);
console.log(`connection_id : ${cfg.connectionId}`);
console.log(`probe id      : ${probeId}   (sent as the User-to-User SIP header)`);
console.log(
  `event webhook : ${cfg.baseUrl ? `${cfg.baseUrl}/telnyx-webhook` : '(none - set PUBLIC_BASE_URL to receive call events)'}`,
);
console.log('');

if (!LIVE) {
  console.log('Request that WOULD be sent:');
  console.log(`  POST ${TELNYX_BASE}/calls`);
  console.log(`  Authorization: Bearer ${'*'.repeat(12)}`);
  console.log(
    JSON.stringify(
      {
        ...body,
        to: `sip:${redact(cfg.xaiNumber)}@${cfg.sipHost};transport=tls`,
        from: redact(cfg.from),
      },
      null,
      2,
    ),
  );
  console.log('');
  console.log('Nothing was sent. Re-run with --live to actually place the call.');
  console.log('Before you do, confirm ALL of the following:');
  console.log('  1. The xAI number is registered  (POST /v2/phone-numbers, origin=byo_trunk).');
  console.log('  2. If you set sip_auth.allowed_addresses, it contains Telnyx signaling CIDRs.');
  console.log('  3. The Telnyx connection enables G.711 mu-law, G.711 A-law, or G.722 -- xAI');
  console.log('     accepts no other codec, and a codec mismatch is the most likely failure.');
  console.log('  4. You are tailing the Worker:  npx wrangler tail -c ./wrangler.toml');
  process.exit(0);
}

// --- LIVE ------------------------------------------------------------------

async function telnyx(path, init = {}) {
  const res = await fetch(`${TELNYX_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* keep raw */
  }
  return { status: res.status, ok: res.ok, json, text };
}

const startedAt = Date.now();
console.log('Placing the call...');
const dialRes = await telnyx('/calls', { method: 'POST', body: JSON.stringify(body) });

if (!dialRes.ok) {
  console.log('');
  console.log('RESULT: INVITE NOT SENT -- Telnyx rejected the dial request.');
  console.log(`  HTTP ${dialRes.status}`);
  console.log(`  ${dialRes.json?.errors?.[0]?.detail || dialRes.text.slice(0, 400)}`);
  console.log('');
  console.log('This is a Telnyx-side configuration problem, not a codec/interop problem.');
  console.log(
    'Check: API key scope, connection_id validity, and that `from` is on that connection.',
  );
  process.exit(1);
}

const ccid = dialRes.json?.data?.call_control_id;
console.log(
  `  accepted by Telnyx. call_control_id = ${ccid ? `${ccid.slice(0, 18)}...` : '(none)'}`,
);
console.log('');
console.log(`Watching call status for up to ${WATCH_SECONDS}s...`);
console.log('(Meanwhile: `npx wrangler tail -c ./wrangler.toml` should show xai.webhook.* lines');
console.log(' if xAI accepted the INVITE and fired realtime.call.incoming.)');
console.log('');

let answered = false;
let lastStatus = '';
const deadline = Date.now() + WATCH_SECONDS * 1000;

while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000));
  const st = await telnyx(`/calls/${encodeURIComponent(ccid)}`);
  if (!st.ok) {
    // Telnyx drops completed calls from this endpoint; that itself is a signal.
    console.log(
      `  [${Math.round((Date.now() - startedAt) / 1000)}s] call record no longer retrievable (HTTP ${st.status}) - call has ended`,
    );
    break;
  }
  const data = st.json?.data ?? {};
  const status = `${data.call_leg_id ? 'leg ' : ''}${data.record_type || ''} answered=${data.is_alive ?? 'unknown'}`;
  if (status !== lastStatus) {
    console.log(
      `  [${Math.round((Date.now() - startedAt) / 1000)}s] ${JSON.stringify(data).slice(0, 240)}`,
    );
    lastStatus = status;
  }
  if (data.is_alive === true) answered = true;
}

console.log('');
console.log('Hanging up the probe call (best effort)...');
await telnyx(`/calls/${encodeURIComponent(ccid)}/actions/hangup`, {
  method: 'POST',
  body: JSON.stringify({ command_id: crypto.randomUUID() }),
});

console.log('');
console.log('='.repeat(72));
console.log('HOW TO READ THIS RESULT');
console.log('='.repeat(72));
console.log(`Telnyx accepted the dial request : YES`);
console.log(`Call became alive (INVITE OK)    : ${answered ? 'YES' : 'NO / not observed'}`);
console.log('');
console.log('The authoritative answers are in the webhooks, not here:');
console.log('  * call.answered for this leg   => xAI ACCEPTED the INVITE (SIP + codec OK).');
console.log('  * call.hangup with a SIP cause  => xAI REJECTED it. The cause tells you why:');
console.log('        403 Forbidden        -> IP allowlist / sip_auth mismatch');
console.log(
  '        488 Not Acceptable   -> codec negotiation failed (enable G.711u/G.711a/G.722)',
);
console.log('        404 / 480            -> the number is not registered with xAI as byo_trunk');
console.log('  * xai.webhook.correlated in `wrangler tail` => xAI fired realtime.call.incoming,');
console.log('    which is the end-to-end proof the whole bridge design works.');
console.log('');
console.log(`probe id for log correlation: ${probeId}`);
