# open-grok-voice

Outbound phone calls for **xAI Grok Voice** — an inbound-only speech-to-speech
agent — by having Telnyx originate **both** legs and bridge them carrier-side.
xAI only ever sees an inbound call.

`POST /call {"to": "+15555550123", "task": "Ask when the invoice will be paid."}`
→ the AI calls the number, works the task, and you get a transcript, a
recording, and a cost breakdown in the operator console. A task template with
the opener, the honesty guardrail, and phone-tree guidance lives at
[`prompts/STANDARD-OPENER.md`](prompts/STANDARD-OPENER.md).

## How it works

### The problem

xAI Voice Agents are **inbound-only**. Their API surface has no create-call /
originate endpoint — the SIP documentation says it plainly: *"SIP lets you
route PSTN, contact-center, or PBX calls **into** a Speech to Speech API
session."* The only thing that mints a `call_id` is the inbound
`realtime.call.incoming` webhook, which fires when xAI receives a SIP INVITE
for a number registered as a `byo_trunk` origin.

### The trick

Telnyx originates **both** legs and bridges them. xAI only ever sees an
inbound call.

```
POST /call {to, task}
        │
        ├─► Telnyx POST /v2/calls ─────────────► dials the human            (leg A)
        │                                          │
        │        call.answered (leg A) ◄───────────┘
        │                │
        ├─► Telnyx POST /v2/calls ─────────────► dials sip:{num}@sip.voice.x.ai
        │                                          │                        (leg B)
        │        xAI: realtime.call.incoming ◄─────┘
        │                │
        │                ├─► DO opens wss://api.x.ai/v1/realtime?call_id=…
        │                │     session.update { voice, instructions: THIS CALL'S TASK }
        │                │     response.create
        │                │
        └─► Telnyx POST /v2/calls/{legA}/actions/bridge ──► legA ⇄ legB
                         │
              audio: human ⇄ Telnyx ⇄ xAI   (call audio stays carrier-side)
```

The Worker never speaks SIP and never handles the bridged call audio. Telnyx
does the SIP and bridges the live call carrier-side. The xAI WebSocket is a
**control channel** only: it injects this call's task and collects transcript
events. An optional, separate receive-only Telnyx stream feeds the operator
monitor; browser audio is rejected at the Durable Object and never reaches
Telnyx or xAI.

### Architecture

Hono + TypeScript on Cloudflare Workers, with:

- **Durable Objects** — `CallSession` (one per call: holds the xAI realtime
  socket, runs the event-sourced state machine) and `MonitorSession`
  (authenticated Telnyx-to-browser receive-only media relay for live
  monitoring).
- **D1** — Better Auth database for operator logins (Google OAuth, single
  exact-email operator policy).
- **R2** — durable call log: one JSON record per finished call plus archived
  recording bytes (outlives Telnyx's short-lived signed recording URLs).
- **Workers AI** — Whisper transcribes the operator's dictation into the
  console task box.
- **Telnyx Call Control API** — dial, bridge, hangup, streaming, recording.
- **xAI** — SIP (`sip.voice.x.ai`, `byo_trunk` origin) + realtime WebSocket.

Why a Durable Object: the xAI socket must stay open for the whole call while
webhooks from two independent providers land on unrelated HTTP requests.
Cloudflare documents that **"outbound connections keep Durable Objects
alive"** — an active outbound WebSocket blocks both hibernation and
eviction — so the socket survives the call with no keepalive of ours. And no
alarms: DO alarms cap at 15 minutes and would truncate a 20-minute call
mid-call; every wake-up here is an inbound webhook HTTP request, which has no
documented duration limit.

## The four accounts

You need all four before the first call. None of these steps are performed by
this repo — each one costs money or creates real infrastructure.

1. **Cloudflare** — Workers **paid** plan (Durable Objects require it), plus
   D1, R2, and Workers AI on the account.
2. **Telnyx** — a Voice API Application (**Call Control**), a voice-capable
   phone number, a V2 API key, and the account's Ed25519 webhook **public**
   key (portal.telnyx.com → API Keys → public key). Enable at least one of
   **G.711 µ-law, G.711 A-law, G.722** on the application — xAI accepts no
   other codec, and a mismatch is the single most likely failure.
3. **xAI** — an API key, plus registering the number xAI should answer on as
   `origin: "byo_trunk"` (see setup step 3). That registration returns a
   one-time `dispatch_signing_secret`.
4. **Google Cloud** — an OAuth **web** client for the operator console's
   Google sign-in.

## Setup — what a human must do before the first call

1. **Telnyx**: create a Voice API Application (Call Control). Note the
   `connection_id`. In *Inbound settings* set destination number format to
   **E.164**. Enable at least one of **G.711 µ-law, G.711 A-law, G.722** — xAI
   accepts no other codec, and a mismatch is the single most likely failure.
2. **Telnyx**: buy/assign a voice-capable number → `TELNYX_FROM_NUMBER`.
3. **xAI**: register the number you want xAI to answer on. `agent_id` and
   `webhook` are **mutually exclusive** — we need `webhook`:
   ```bash
   curl -X POST https://api.x.ai/v2/phone-numbers \
     -H "Authorization: Bearer $XAI_API_KEY" -H 'Content-Type: application/json' \
     -d '{
       "origin": "byo_trunk",
       "name": "open-grok-voice",
       "phone_number": "+1XXXXXXXXXX",
       "webhook": { "name": "open-grok-voice", "url": "https://<worker>/xai-webhook" },
       "sip_auth": { "allowed_addresses": ["<telnyx signaling CIDRs>"] }
     }'
   ```
   The response contains `webhook.dispatch_signing_secret` (`whsec_…`).
   **It is returned once and cannot be recovered.** Save it immediately.
4. **Provision the operator database**. Create a dedicated D1 database, set
   its name and ID in the `[[d1_databases]]` block in `wrangler.toml`, and
   apply the committed Better Auth schema. This repository does not create or
   mutate the database automatically:
   ```bash
   ./node_modules/.bin/wrangler d1 migrations apply <database-name> --remote -c ./wrangler.toml
   ```
   The `DB` binding must be present at runtime. If it is absent, `/console`
   returns a generic configuration screen and protected APIs fail closed.
5. **Create a Google web OAuth client**. Add the Worker origin's callback URL
   `https://<worker>/api/auth/callback/google` to its authorized redirect URIs.
   Set the exact Worker origin in `BETTER_AUTH_URL` when it differs from
   `PUBLIC_BASE_URL`; list any additional exact operator origins in
   `BETTER_AUTH_TRUSTED_ORIGINS`. The OAuth client ID and secret are Worker
   secrets, never `[vars]`.
6. **Fill `wrangler.toml`**: replace every `REPLACE_ME`.
7. **Set secrets** (never commit them):
   ```bash
   for s in XAI_API_KEY XAI_WEBHOOK_SECRET TELNYX_API_KEY TELNYX_PUBLIC_KEY APP_API_KEY BETTER_AUTH_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET; do
     ./node_modules/.bin/wrangler secret put "$s" -c ./wrangler.toml
   done
   ```
   `TELNYX_PUBLIC_KEY` is the account Ed25519 **public** key from
   portal.telnyx.com/#/api-keys/public-key.

   | Secret | What it is |
   |---|---|
   | `XAI_API_KEY` | xAI API key (`xai-…`). Authenticates the realtime WebSocket. |
   | `XAI_WEBHOOK_SECRET` | The `dispatch_signing_secret` (`whsec_…`) from step 3 — returned once, unrecoverable. |
   | `TELNYX_API_KEY` | Telnyx V2 API key (Bearer). |
   | `TELNYX_PUBLIC_KEY` | Telnyx account Ed25519 webhook public key (base64). |
   | `APP_API_KEY` | Long random string callers send as `X-API-Key`. |
   | `BETTER_AUTH_SECRET` | ≥32 random characters for Better Auth cookies. |
   | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth web client. |

8. **Deploy**, then point the Telnyx application's webhook URL at
   `https://<worker>/telnyx-webhook`.
9. **Run the interop probe** (below) before ever calling a human. Confirm the
   media and recording commands are enabled for the Call Control application
   and review the operator consent/recording policy for every destination.
10. **Inbound routing** (optional, non-secret — set in `wrangler.toml [vars]`):
    `INBOUND_ALLOWLIST` (comma-separated E.164 numbers that reach the AI
    directly), `FORWARD_TARGETS` (comma-separated E.164 follow-me numbers, in
    priority order), `INBOUND_RING_SECS` (5–120, default 20). All empty is the
    safe degraded mode: every inbound call goes straight to the AI.

## First deploy

```bash
npm install
# 1. Fill wrangler.toml: replace every REPLACE_ME (see Setup step 6).
# 2. Set secrets (see Setup step 7).
./node_modules/.bin/wrangler d1 migrations apply <database-name> --remote -c ./wrangler.toml
npm run dryrun   # typecheck + tests + wrangler deploy --dry-run; must be green
./node_modules/.bin/wrangler deploy -c ./wrangler.toml
# 3. Point the Telnyx application's webhook URL at https://<worker>/telnyx-webhook
```

## The interop probe — the one live experiment

The highest-risk unknown is whether a Telnyx INVITE to `sip.voice.x.ai` is
accepted at all. `tools/repro/sip-interop-probe.mjs` tests exactly that, and
nothing else, by dialing **only leg B** — no human is called.

```bash
node tools/repro/sip-interop-probe.mjs          # dry run: prints, sends nothing
node tools/repro/sip-interop-probe.mjs --live   # places ONE call
```

Read the result from the webhooks, not the script:

| Signal | Meaning |
|---|---|
| `call.answered` on leg B | xAI accepted the INVITE — SIP + codec OK |
| `call.hangup` cause `403` | IP allowlist / `sip_auth` mismatch |
| `call.hangup` cause `488` | Codec negotiation failed — enable G.711u/G.711a/G.722 |
| `call.hangup` cause `404`/`480` | Number not registered with xAI as `byo_trunk` |
| `xai.webhook.correlated` in `wrangler tail` | End-to-end proof the design works |

## First-call checklist

1. Probe dry-run prints sane values; `--live` shows `call.answered` on leg B.
2. `wrangler tail` shows `xai.webhook.correlated`, and either
   `xai.correlate.via_sip_header` (exact, concurrency-safe) or
   `xai.correlate.via_registry` (correct for serial calling only — see
   Unverified #2).
3. Draft the task from [`prompts/STANDARD-OPENER.md`](prompts/STANDARD-OPENER.md)
   — fill in `<YOUR NAME>` and `<SUBJECT>`.
4. Place the first real call (console or API), watch it live in `/console`,
   then read the transcript and listen to the archived recording.
5. Check `/api/console/costs` for the spend estimate before scaling up.

## Cost notes (estimates — verify current published rates)

Every call consumes billable resources on **two** providers at once, and
rates change — check the current published pricing before budgeting:

- **Telnyx**: two concurrent legs for the full call duration (the outbound
  PSTN leg to the human **plus** the SIP leg into xAI). See
  telnyx.com/pricing for current per-minute voice rates.
- **xAI**: speech-to-speech voice session minutes for the bridged duration.
  See x.ai pricing for current voice rates.
- **Cloudflare**: Workers requests + Durable Object duration, D1 reads/writes,
  R2 storage for call logs/recordings, Workers AI Whisper minutes for console
  dictation. On small volumes this is the cheapest leg; it still isn't zero.

Rough shape of a call's cost: `2 × Telnyx minutes + xAI voice minutes +
Cloudflare usage`. The console's `/api/console/costs` route reports an
estimated spend over day/week/month/year windows from recorded calls.

## Operator console

`GET /console` — Google sign-in (single exact-email operator policy), then:

1. **Start a call** using the form. The Start button stays enabled as long as
   you're under the concurrent limit (5 simultaneous outbound calls,
   configurable via `MAX_CONCURRENT_OUTBOUND`).
2. **Select a call** from the **Active calls** list to view its transcript and
   controls.
3. **Start another call** while the first is still live — both appear in the
   Active calls list.
4. **Switch between calls** by clicking them. Hangup and monitor controls
   always target the selected call.
5. **Hang up** operates on the selected call only — other calls stay live.

Each call is fully isolated: separate transcript, recording, and costs. Use
the `subject` field to label calls so you can tell them apart in the list.
Over capacity, `POST /call` returns `409 Conflict` with
`{"error":"concurrent call limit reached"}`; hanging up or completing a call
frees a slot immediately.

`tools/call.mjs` places a call with **live calendar availability** attached
(busy geometry computed locally from your own calendar — no meeting content
leaves the machine):

```bash
node tools/call.mjs --to +15555550123 --task "Ask if my order shipped."
node tools/call.mjs --to ... --task ... --dry-run     # print, do not dial
node tools/call.mjs --to ... --task ... --no-calendar # omit availability
```

### gvb CLI

A thin CLI wrapper at `tools/gvb.mjs` for quick parallel call management:

```bash
# Install
ln -sf $(pwd)/tools/gvb.mjs ~/.local/bin/gvb

# Set your API key
export APP_API_KEY=<redacted>
# or create .app_api_key.txt

# Place calls
gvb call --to +15555550111 --task "Ask about the shipment"
gvb call --to +15555550222 --task "Follow up on invoice"

# List active calls
gvb list-live

# Hang up a specific call
gvb hangup 550e8400-e29b-41d4-a716-446655440000

# Check auth
gvb me
```

## API

```bash
# Place a call
curl -X POST https://<worker>/call \
-H "X-API-Key: <redacted>" \
  -d '{"to":"+15555550123","task":"Ask when the invoice will be paid.","voice":"eve","amd":"premium"}'
# -> 202 {"callId":"<uuid>","status":"dialing"}

# Status + transcript so far
curl https://<worker>/call/<uuid> -H "X-API-Key: $APP_API_KEY"

# Conference someone into a call already in progress. The legId to drop or mute
# them with comes back in `participants[].legId` on the status route above.
curl -X POST https://<worker>/call/<uuid>/participants \
-H "X-API-Key: <redacted>" \
  -d '{"to":"+15555550199","label":"Dr. Levine'"'"'s office"}'

curl -X DELETE https://<worker>/call/<uuid>/participants/<legId> -H "X-API-Key: $APP_API_KEY"
curl -X POST https://<worker>/call/<uuid>/participants/<legId>/mute -H "X-API-Key: $APP_API_KEY"
curl -X POST https://<worker>/call/<uuid>/participants/<legId>/hold -H "X-API-Key: $APP_API_KEY"
```

Adds are idempotent against an ACTIVE participant: a retry or a double-click
returns 409 rather than placing a second call to someone already talking. The
same number may be re-added once they have hung up.

`POST /telnyx-webhook` and `POST /xai-webhook` are public by necessity (neither
provider can traverse Cloudflare Access) and are protected by signature
verification, which **fails closed**: missing key, missing header, bad
timestamp, or any thrown error all reject.

The operator routes are same-origin and session-protected:

| Route | Purpose |
|---|---|
| `GET /console` | Google-only operator UI |
| `GET,POST /api/auth/*` | Better Auth OAuth and session handlers |
| `GET /api/me` | Safe session check |
| `GET /api/console/calls` | List archived finished calls, newest first, cursor-paged |
| `GET /api/console/calls/live` | List active (non-terminal) calls |
| `POST /api/console/calls` | Start a call after the UI consent acknowledgement |
| `GET /api/console/calls/{id}` | Phase, AMD, transcript, recording metadata, monitor status (falls back to the R2 archive) |
| `POST /api/console/script-preview` | Read-only: the prompt this task would produce, in labelled segments |
| `GET /api/console/presets` | List saved task presets, newest first |
| `GET /api/console/presets/{name}` | Read one preset's task |
| `PUT /api/console/presets/{name}` | Create or overwrite a preset |
| `DELETE /api/console/presets/{name}` | Delete a preset |
| `POST /api/console/transcribe` | Transcribe an operator recording (Workers AI) |
| `POST /api/console/calls/{id}/hangup` | Operator hangup |
| `POST /api/console/calls/{id}/participants` | Dial a number and conference it into the live call |
| `DELETE /api/console/calls/{id}/participants/{legId}` | Drop a participant (hangs up their leg) |
| `POST /api/console/calls/{id}/participants/{legId}/{mute\|unmute\|hold\|unhold}` | Mute, unmute, hold or unhold one participant |
| `GET /api/console/costs` | Estimated spend over a day/week/month/year |
| `POST /api/console/calls/{id}/media-token` | Mint a 90-second browser monitor token |
| `GET /api/console/calls/{id}/monitor` | Authenticated browser WebSocket |
| `GET /api/console/calls/{id}/recording/{wav\|mp3}` | Authenticated recording proxy |

`GET /telnyx-media/{opaque-id}` is the provider-facing WebSocket ingress. It
accepts only a short-lived server token created for that call; it is not a
browser API.

## Inbound calls

A call TO your number arrives as `call.initiated` with
`payload.direction: "incoming"` and no `client_state` (we tag every leg we
originate; a caller cannot). The Worker answers it via call-control — the
answer command attaches our `client_state`, adopting the caller's leg as
**leg A** — then routes by caller ID:

- **Allowlisted caller** (`INBOUND_ALLOWLIST`): the operator calling their own
  agent. The call goes straight into the existing leg-B → xAI machinery with
  a direct-assistant task. Caller ID is spoofable, so this is convenience, not
  authentication — the direct task grants conversation, never authority.
- **Anyone else**: follow-me. Each `FORWARD_TARGETS` number is rung in order
  for `INBOUND_RING_SECS` with **AMD on the forward leg** — a dead phone's
  voicemail counts as "answered" to the carrier, and the AMD verdict is the
  only thing separating "caller reaches a human" from "caller dumped into a
  voicemail beep". A live human is bridged carrier-side; a machine gets hung
  up and the ladder advances; when targets are exhausted (or none are
  configured) the AI answers with a message-taking task, and
  `inboundFallbackReason` on `GET /call/:id` says why.

## Layout

| File | Role |
|---|---|
| `src/index.ts` | Routes, auth, signature verification, correlation |
| `src/auth.ts` | Per-request Better Auth configuration and exact operator policy |
| `src/console-ui.ts` | Nonce/CSP-protected industrial operator console |
| `src/presets.ts` | Saved task presets in R2 under `presets/` |
| `src/transcribe.ts` | Operator dictation via Workers AI Whisper |
| `src/call-session.ts` | The Durable Object: holds the xAI socket, runs effects |
| `src/monitor-session.ts` | Authenticated Telnyx-to-browser receive-only media relay |
| `src/media.ts` | Short-lived media tokens and Telnyx stream parser |
| `src/recordings.ts` | Recording callback validation and URL allowlist |
| `src/call-log.ts` | R2 archive: key scheme, list projection, recording archival |
| `src/state.ts` | **Pure** reducer `(state, event) → {state, effects}` |
| `src/signatures.ts` | Telnyx Ed25519 + xAI Standard Webhooks HMAC |
| `src/telnyx.ts` | dial / bridge / hangup / streaming_start / record_start |
| `src/xai.ts` | Realtime socket, `session.update`, server-event classification |
| `src/instructions.ts` | Per-call system-prompt assembly |
| `src/types.ts` | Zod schemas for both webhook trust boundaries |
| `tools/repro/sip-interop-probe.mjs` | The one live experiment (dry-run by default) |
| `tools/repro/r2-call-log/` | Probe that runs `src/call-log.ts` against the REAL bucket |

## Unverified — read before trusting this in production

Everything else was checked against a primary source. These were not, and
cannot be without live infrastructure:

1. **Telnyx ⇄ xAI SIP interop.** Never exercised by this project. Codec
   negotiation, TLS, and the IP allowlist are all unproven. This is what the
   probe is for.
2. **Whether xAI forwards the inbound `User-to-User` SIP header** into
   `data.sip_headers` on the incoming-call webhook. If it does, correlation is
   exact and concurrency-safe. If it does not, we fall back to a FIFO registry
   claim, which is correct for **serial** calling but can mis-pair a call with
   the wrong task under true concurrency. Check `wrangler tail` for
   `xai.correlate.via_sip_header` vs `xai.correlate.via_registry` on the first
   live call — that single log line tells you which regime you are in.
3. **Outbound WebSocket with an `Authorization` header from a DO.** The
   fetch-with-`Upgrade` pattern is documented; passing `Authorization` on it is
   not explicitly documented. xAI forbids ephemeral client secrets for SIP
   `call_id` sessions, so the Bearer `XAI_API_KEY` is the only documented auth
   path — but it is unproven on Workers.
4. **Bridge body field name.** The OpenAPI schema requires `call_control_id`;
   the published SDK samples use `call_control_id_to_bridge_with`. We speak
   raw HTTP, so we send the schema's name. If a bridge 422s, this is the first
   thing to check.
5. **`audio.input.transcription`** on a SIP session. Setting it should not
   disturb SIP-negotiated codecs, but that is inference, not observation. Set
   `XAI_INPUT_TRANSCRIPTION="false"` if caller audio misbehaves.
6. **Cost.** Two Telnyx legs run for the full call duration, plus xAI
   speech-to-speech minutes. Not measured here.
7. **Function calling on a SIP `call_id` session.** Tool declaration and the
   `response.function_call_arguments.done` contract were verified against the
   live API — but on a DIRECT WebSocket session (`?model=`), which is the only
   kind reachable without placing a real call. The SIP path uses the same
   endpoint and the same `session.update`, and xAI's own SIP docs state that
   session resumption "caches transcripts and tool results", which presupposes
   tool calls on SIP. Still, that the model actually EMITS a tool call on a
   bridged SIP call is unproven until the first live call. Watch
   `wrangler tail` for `dtmf.sent` — that one line is the whole question. Its
   absence, on a call where the transcript shows the agent talking about
   pressing a key, means the model narrated instead of calling the tool.
8. **What the turn after a keypress sounds like.** `response.create` is sent
   with an instruction to stay silent and listen, because the documented flow
   requires the continuation and skipping it risks stalling the turn. Whether
   the model reliably stays quiet, rather than emitting a short acknowledgement
   over the menu, is a model behaviour and has not been observed on a call.

## Safety notes

- Signature verification fails closed on both surfaces.
- `ALLOW_UNSIGNED_WEBHOOKS="true"` disables it. **Local dev only.**
- **Phone numbers are NOT redacted**, in logs or in the archive. This is a
  deliberate operator decision with the trade-off stated: full E.164
  destinations enter Cloudflare Workers log retention and the R2 call-log
  archive. Masking to country code + last two digits was considered and
  rejected because it could not do its job — a campaign dials many targets
  sharing an area code, so a masked number identified nothing and the operator
  could not tell which destination a row referred to.
- Secrets are never logged, not even truncated.
- The state machine is idempotent: Telnyx documents duplicate and out-of-order
  delivery, so a replayed `call.answered` must not place a second call. That is
  asserted directly in `test/state.test.ts`.

## Development

```bash
npm install
npm run check   # typecheck + vitest run + wrangler deploy --dry-run
npx biome check .
```

The checks are the gate: `npm run check` must be green before any commit.
`tools/repro/*` harnesses are never invoked by the test suite and never deploy.

## License

MIT — see [LICENSE](LICENSE).
