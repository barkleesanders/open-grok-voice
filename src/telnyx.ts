// Telnyx Call Control client.
//
// Contracts verified against developers.telnyx.com (2026-08-26):
//
//   POST /v2/calls                                   -- "Dial a number or SIP URI
//     from a given connection." `to` is documented as accepting a SIP URI
//     (example: "+18005550100 or sip:username@sip.telnyx.com;secure=srtp"),
//     which is what makes leg B into xAI possible at all.
//     Required: connection_id, to, from.
//
//   POST /v2/calls/{call_control_id}/actions/bridge  -- NOT WRAPPED, and its
//     absence is deliberate. Bridge joins exactly TWO legs, so no third party
//     can ever be added to a bridged call. Both paths that used it -- the AI
//     path and the inbound follow-me handoff -- are conferences now, and a
//     surviving wrapper would be a second way to connect two legs whose
//     teardown semantics differ from the conference's.
//
//   POST /v2/calls/{call_control_id}/actions/hangup
//
//   POST /v2/calls/{call_control_id}/actions/send_dtmf  -- "Sends DTMF tones
//     from this leg. DTMF tones will be heard by the other end of the call."
//     Verified 2026-08-28. Body: `digits` (required; 0-9, A-D, *, #, plus `w`
//     = 0.5s pause and `W` = 1s pause), optional `duration_millis` (100-500,
//     default 250), optional `client_state`, optional `command_id`. Returns
//     {"data":{"result":"ok"}} and fires NO webhooks -- so the HTTP status is
//     the only confirmation that exists, which is why `command` returns it.
//     LEG SEMANTICS: a command acts on the leg named in the URL and its media
//     reaches THAT leg's remote party -- the same rule as `speak` and
//     `playback_start`, which the command table lists in identical form
//     ("Send DTMF tones to a call" / "Speak text to a call"). Issuing this on
//     leg A is therefore what makes the IVR hear the tone; issuing it on leg B
//     would play it at xAI.
//
// `command_id` is sent on every command: "Telnyx will ignore any command with
// the same command_id for the same call_control_id" (60s window). That makes a
// retried command safe.

import { errText, log } from './log';
import type { SupervisorRole } from './types';

const TELNYX_BASE = 'https://api.telnyx.com/v2';

export interface TelnyxConfig {
  readonly apiKey: string;
  readonly connectionId: string;
  readonly from: string;
}

/** Only `User-to-User` is permitted -- the OpenAPI `SipHeader.name` is an enum of exactly that one value. */
export interface SipHeaderParam {
  readonly name: 'User-to-User';
  readonly value: string;
}

export interface DialArgs {
  /** E.164 number or a full SIP URI. */
  readonly to: string;
  /** Base64 state echoed back on every subsequent webhook for this leg. */
  readonly clientState: string;
  /** Idempotency key (UUIDv4). */
  readonly commandId: string;
  readonly webhookUrl: string;
  readonly answeringMachineDetection?: string | undefined;
  readonly sipHeaders?: readonly SipHeaderParam[] | undefined;
  /** Share a call session id with an existing leg (observability / billing correlation). */
  readonly linkTo?: string | undefined;
  /** Timeout in seconds before an unanswered call is abandoned. */
  readonly timeoutSecs?: number | undefined;
}

export interface DialResult {
  readonly callControlId: string;
  readonly callLegId: string | null;
  readonly callSessionId: string | null;
}

export interface StreamingStartArgs {
  /** Authenticated Worker endpoint that Telnyx connects to as a WebSocket. */
  readonly streamUrl: string;
  /** Monitor-only stream of both call legs. */
  readonly streamTrack: 'both_tracks';
  /** PCMU is the codec the browser monitor can decode without a provider SDK. */
  readonly streamCodec: 'PCMU';
  /** Short-lived token accepted only by the Worker media ingress route. */
  readonly streamAuthToken: string;
  readonly clientState: string;
  readonly commandId: string;
}

export interface RecordingStartArgs {
  readonly format: 'wav' | 'mp3';
  readonly channels: 'single' | 'dual';
  readonly clientState: string;
  readonly commandId: string;
}

interface TelnyxErrorItem {
  readonly detail?: string;
  readonly title?: string;
}

function extractError(bodyText: string, status: number): string {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (typeof parsed === 'object' && parsed !== null && 'errors' in parsed) {
      const errors = (parsed as { errors?: readonly TelnyxErrorItem[] }).errors;
      const first = errors?.[0];
      if (first) return first.detail ?? first.title ?? `HTTP ${status}`;
    }
  } catch {
    /* non-JSON error body */
  }
  return bodyText.slice(0, 300) || `HTTP ${status}`;
}

interface DialResponseShape {
  readonly data?: {
    readonly call_control_id?: string;
    readonly call_leg_id?: string;
    readonly call_session_id?: string;
  };
}

export async function dial(
  cfg: TelnyxConfig,
  args: DialArgs,
  fetchImpl: typeof fetch = fetch,
): Promise<DialResult> {
  const body: Record<string, unknown> = {
    connection_id: cfg.connectionId,
    to: args.to,
    from: cfg.from,
    webhook_url: args.webhookUrl,
    client_state: args.clientState,
    command_id: args.commandId,
  };
  if (args.answeringMachineDetection) {
    body['answering_machine_detection'] = args.answeringMachineDetection;
  }
  if (args.sipHeaders && args.sipHeaders.length > 0) body['sip_headers'] = args.sipHeaders;
  if (args.linkTo) body['link_to'] = args.linkTo;
  if (args.timeoutSecs != null) body['timeout_secs'] = args.timeoutSecs;

  log('info', 'telnyx.dial.start', { to: args.to, commandId: args.commandId });

  let res: Response;
  try {
    res = await fetchImpl(`${TELNYX_BASE}/calls`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    log('error', 'telnyx.dial.network_error', {
      to: args.to,
      error: errText(err),
    });
    throw new Error(`Telnyx dial network error: ${errText(err)}`);
  }

  const text = await res.text();
  if (!res.ok) {
    const detail = extractError(text, res.status);
    log('error', 'telnyx.dial.failed', {
      to: args.to,
      status: res.status,
      detail,
    });
    throw new Error(`Telnyx dial failed (${res.status}): ${detail}`);
  }

  const parsed = JSON.parse(text) as DialResponseShape;
  const callControlId = parsed.data?.call_control_id;
  if (!callControlId) {
    log('error', 'telnyx.dial.no_call_control_id', { to: args.to });
    throw new Error('Telnyx dial: response contained no call_control_id');
  }
  log('info', 'telnyx.dial.ok', {
    to: args.to,
    callLegId: parsed.data?.call_leg_id ?? null,
  });
  return {
    callControlId,
    callLegId: parsed.data?.call_leg_id ?? null,
    callSessionId: parsed.data?.call_session_id ?? null,
  };
}

/** Issue one call-control command. Returns the HTTP status on success. */
async function command(
  cfg: TelnyxConfig,
  callControlId: string,
  action: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<number> {
  const url = `${TELNYX_BASE}/calls/${encodeURIComponent(callControlId)}/actions/${action}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    log('error', 'telnyx.command.network_error', { action, error: errText(err) });
    throw new Error(`Telnyx ${action} network error: ${errText(err)}`);
  }
  if (!res.ok) {
    const detail = extractError(await res.text(), res.status);
    log('error', 'telnyx.command.failed', { action, status: res.status, detail });
    throw new Error(`Telnyx ${action} failed (${res.status}): ${detail}`);
  }
  log('info', 'telnyx.command.ok', { action });
  return res.status;
}

// --- Conferences -----------------------------------------------------------
//
// Contracts verified against Telnyx's own OpenAPI spec
// (github.com/team-telnyx/openapi, openapi/spec3.json, retrieved 2026-08-30).
// The conference subset used here is committed at
// tools/openapi/telnyx-conference.subset.json so a future reader can check the
// parameter list without re-downloading a 6.7 MB document.
//
//   POST /v2/conferences                       required: call_control_id, name.
//     "Create a conference from an existing call leg using a call_control_id
//     and a conference name. Upon creating the conference, the call will be
//     automatically bridged to the conference."
//     *** end_conference_on_exit DOES NOT EXIST HERE. Only on join. ***
//   POST /v2/conferences/{id}/actions/join     required: call_control_id.
//   POST /v2/conferences/{id}/actions/mute     call_control_ids ([] = everyone).
//   POST /v2/conferences/{id}/actions/unmute   call_control_ids ([] = everyone).
//   POST /v2/conferences/{id}/actions/hold     call_control_ids ([] = everyone).
//   POST /v2/conferences/{id}/actions/unhold   call_control_ids REQUIRED.
//   POST /v2/conferences/{id}/actions/speak    required: payload AND voice.
//   POST /v2/conferences/{id}/actions/end      "End a conference and terminate
//     all active participants."
//
// `leave` is deliberately NOT wrapped. Telnyx documents it as "Removes a call
// leg from a conference and moves it back to PARKED state" -- the leg stays up
// and keeps billing with nobody on it. Dropping a participant hangs their leg
// up instead; see the drop_participant effect in src/state.ts.

const CONFERENCE_BASE = `${TELNYX_BASE}/conferences`;

/** Issue one conference command. Mirrors `command` above, different base path. */
async function conferenceCommand(
  cfg: TelnyxConfig,
  conferenceId: string,
  action: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<number> {
  const url = `${CONFERENCE_BASE}/${encodeURIComponent(conferenceId)}/actions/${action}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    log('error', 'telnyx.conference.network_error', { action, error: errText(err) });
    throw new Error(`Telnyx conference ${action} network error: ${errText(err)}`);
  }
  if (!res.ok) {
    const detail = extractError(await res.text(), res.status);
    log('error', 'telnyx.conference.failed', { action, status: res.status, detail });
    throw new Error(`Telnyx conference ${action} failed (${res.status}): ${detail}`);
  }
  log('info', 'telnyx.conference.ok', { action });
  return res.status;
}

export interface CreateConferenceArgs {
  /** The leg the conference is created FROM. It is joined automatically. */
  readonly callControlId: string;
  /** Conference name. We use the callId, which is unique per call. */
  readonly name: string;
  readonly clientState: string;
  readonly commandId: string;
  /**
   * Hard ceiling Telnyx itself enforces, counting EVERY leg -- the subject, the
   * xAI SIP leg, and each escalation participant. Must be 2-800.
   */
  readonly maxParticipants: number;
}

interface ConferenceResponseShape {
  readonly data?: { readonly id?: string };
}

/**
 * Create a conference from an existing leg and return its id.
 *
 * `beep_enabled: 'never'` because this call already announces arrivals in
 * words (see the speak call below); a beep on top of a spoken notice is noise
 * on a line where a human is mid-sentence.
 */
export async function createConference(
  cfg: TelnyxConfig,
  args: CreateConferenceArgs,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(CONFERENCE_BASE, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        call_control_id: args.callControlId,
        name: args.name,
        client_state: args.clientState,
        command_id: args.commandId,
        beep_enabled: 'never',
        start_conference_on_create: true,
        max_participants: args.maxParticipants,
      }),
    });
  } catch (err) {
    log('error', 'telnyx.conference.create.network_error', { error: errText(err) });
    throw new Error(`Telnyx conference create network error: ${errText(err)}`);
  }
  const text = await res.text();
  if (!res.ok) {
    const detail = extractError(text, res.status);
    log('error', 'telnyx.conference.create.failed', { status: res.status, detail });
    throw new Error(`Telnyx conference create failed (${res.status}): ${detail}`);
  }
  const parsed = JSON.parse(text) as ConferenceResponseShape;
  const id = parsed.data?.id;
  if (!id) {
    log('error', 'telnyx.conference.create.no_id', {});
    throw new Error('Telnyx conference create: response contained no conference id');
  }
  log('info', 'telnyx.conference.create.ok', { conferenceId: id });
  return id;
}

export interface JoinConferenceArgs {
  readonly callControlId: string;
  readonly clientState: string;
  readonly commandId: string;
  /**
   * "Whether the conference should end and all remaining participants be hung
   * up after the participant leaves the conference." TRUE for the leg whose
   * hangup ends the call -- leg A on both paths.
   *
   * This flag is the whole reason the conference is created from the OTHER leg
   * (leg B on the AI path, leg F on the inbound follow-me path): it does not
   * exist on the create command, so the creator can never carry it. With it on
   * leg A, the subject hanging up tears down every other leg carrier-side --
   * reproducing what an unparked `bridge` used to do for free.
   */
  readonly endConferenceOnExit: boolean;
  /**
   * How this participant is wired into the audio, or null to send no
   * `supervisor_role` at all.
   *
   * NULL AND 'barge' ARE NOT THE SAME REQUEST even though Telnyx treats them
   * the same way: null omits the field, which is what leg A and every caller
   * that predates this option send. Writing 'barge' unconditionally would make
   * every existing join a different HTTP body for no behavioural gain.
   */
  readonly supervisorRole: SupervisorRole | null;
  /**
   * Legs a 'whisper' supervisor can be heard by. Telnyx: "Array of unique
   * call_control_ids the joining supervisor can whisper to. If none provided,
   * the supervisor will join the conference as a monitoring participant only."
   *
   * So an EMPTY array is not a weaker whisper, it is a silent downgrade to
   * monitor. The caller decides that explicitly rather than discovering it on a
   * live call: `joinConference` sends the key only when the array is non-empty,
   * and the reducer that builds this list resolves 'whisper' to 'monitor'
   * up front when it has nobody to whisper to.
   */
  readonly whisperCallControlIds: readonly string[];
}

export async function joinConference(
  cfg: TelnyxConfig,
  conferenceId: string,
  args: JoinConferenceArgs,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await conferenceCommand(
    cfg,
    conferenceId,
    'join',
    {
      call_control_id: args.callControlId,
      client_state: args.clientState,
      command_id: args.commandId,
      end_conference_on_exit: args.endConferenceOnExit,
      ...(args.supervisorRole === null ? {} : { supervisor_role: args.supervisorRole }),
      ...(args.whisperCallControlIds.length === 0
        ? {}
        : { whisper_call_control_ids: [...args.whisperCallControlIds] }),
    },
    fetchImpl,
  );
}

/**
 * Put ONE participant on hold, or take them off it.
 *
 * `call_control_ids` is always a one-element array and never omitted, for the
 * same reason as mute and with a worse blast radius: Telnyx documents hold's
 * empty case as "When empty all participants will be placed on hold", so an
 * accidental `[]` would freeze the entire call -- the subject, the AI, and
 * everybody else -- while the operator believed they had parked one person.
 * `unhold` does not even allow it: `call_control_ids` is REQUIRED there.
 * (tools/openapi/telnyx-conference.subset.json, retrieved 2026-08-30.)
 */
export async function setConferenceHold(
  cfg: TelnyxConfig,
  conferenceId: string,
  args: { readonly callControlId: string; readonly held: boolean },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await conferenceCommand(
    cfg,
    conferenceId,
    args.held ? 'hold' : 'unhold',
    { call_control_ids: [args.callControlId] },
    fetchImpl,
  );
}

/**
 * Mute or unmute ONE participant.
 *
 * `call_control_ids` is always a one-element array and never omitted: Telnyx
 * documents the empty case as "When empty all participants will be muted", so
 * an accidental `[]` would silence the entire call including the AI.
 */
export async function setConferenceMute(
  cfg: TelnyxConfig,
  conferenceId: string,
  args: { readonly callControlId: string; readonly muted: boolean },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await conferenceCommand(
    cfg,
    conferenceId,
    args.muted ? 'mute' : 'unmute',
    { call_control_ids: [args.callControlId] },
    fetchImpl,
  );
}

export interface ConferenceSpeakArgs {
  /** Text or SSML. Telnyx caps this at 3,000 characters. */
  readonly payload: string;
  /**
   * REQUIRED by Telnyx, in the form `<Provider>.<Model>.<VoiceId>`.
   * Configurable via the CONFERENCE_NOTICE_VOICE var -- see src/env.ts for what
   * is and is not verified about the default.
   */
  readonly voice: string;
  readonly commandId: string;
}

/**
 * CEILING, not a policy choice. Telnyx's OpenAPI spec describes the `payload`
 * property of ConferenceSpeakRequest verbatim as "The text or SSML to be
 * converted into speech. There is a 3,000 character limit."
 * (github.com/team-telnyx/openapi openapi/spec3.json, retrieved 2026-08-30;
 * the same text is in tools/openapi/telnyx-conference.subset.json in this repo.)
 *
 * CORPUS: the only thing this Worker ever speaks into a conference is the join
 * notice built by `participantJoinNotice`, whose longest possible form is the
 * fixed sentence plus a label bounded at 60 characters by
 * AddParticipantRequestSchema -- about 130 characters, so 0% of real payloads
 * are anywhere near the cap. The slice below is therefore a guard against a
 * future caller, not something today's traffic reaches.
 */
export const CONFERENCE_SPEAK_MAX_CHARS = 3000;

/**
 * Speak to EVERY participant.
 *
 * `call_control_ids` is deliberately omitted, which Telnyx documents as "When
 * empty all participants will hear the spoken text". That is the point for a
 * recording/consent notice: the subject, the AI, and the person who just joined
 * all have to hear the same words.
 */
export async function conferenceSpeak(
  cfg: TelnyxConfig,
  conferenceId: string,
  args: ConferenceSpeakArgs,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await conferenceCommand(
    cfg,
    conferenceId,
    'speak',
    {
      payload: args.payload.slice(0, CONFERENCE_SPEAK_MAX_CHARS),
      payload_type: 'text',
      language: 'en-US',
      voice: args.voice,
      command_id: args.commandId,
    },
    fetchImpl,
  );
}

/** End the conference and terminate every remaining participant. */
export async function endConference(
  cfg: TelnyxConfig,
  conferenceId: string,
  commandId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await conferenceCommand(cfg, conferenceId, 'end', { command_id: commandId }, fetchImpl);
}

/**
 * Answer an inbound call.
 *
 * `client_state` here is load-bearing: Telnyx stores it on the leg and echoes
 * it on every subsequent webhook ("Use this field to add state to every
 * subsequent webhook"), which is how a caller-originated leg — one we never
 * dialed and so never tagged — gets adopted into the same correlation channel
 * as our own legs. Answering an already-answered call fails with a 4xx, which
 * the inbound path uses as its duplicate-webhook-delivery guard.
 */
export async function answer(
  cfg: TelnyxConfig,
  callControlId: string,
  args: { readonly clientState: string; readonly commandId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await command(
    cfg,
    callControlId,
    'answer',
    { client_state: args.clientState, command_id: args.commandId },
    fetchImpl,
  );
}

export async function hangup(
  cfg: TelnyxConfig,
  callControlId: string,
  commandId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await command(cfg, callControlId, 'hangup', { command_id: commandId }, fetchImpl);
}

/**
 * Start a one-way Telnyx media stream for the active human leg.
 *
 * `stream_bidirectional_mode` is intentionally omitted: this console is a
 * monitor, not an audio injection surface. The provider therefore cannot
 * receive browser audio even if a client is compromised.
 */
export async function startStreaming(
  cfg: TelnyxConfig,
  callControlId: string,
  args: StreamingStartArgs,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await command(
    cfg,
    callControlId,
    'streaming_start',
    {
      stream_url: args.streamUrl,
      stream_track: args.streamTrack,
      stream_codec: args.streamCodec,
      stream_auth_token: args.streamAuthToken,
      client_state: args.clientState,
      command_id: args.commandId,
    },
    fetchImpl,
  );
}

/** Start a dual-channel post-call recording on the human leg. */
export async function startRecording(
  cfg: TelnyxConfig,
  callControlId: string,
  args: RecordingStartArgs,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await command(
    cfg,
    callControlId,
    'record_start',
    {
      format: args.format,
      channels: args.channels,
      client_state: args.clientState,
      command_id: args.commandId,
    },
    fetchImpl,
  );
}

export interface SendDtmfArgs {
  /**
   * Already-validated digit string. Callers MUST pass the output of
   * `validateDtmfDigits` (src/dtmf.ts) -- this function does not re-check the
   * charset, because the model-facing validation belongs in one place.
   */
  readonly digits: string;
  readonly clientState: string;
  readonly commandId: string;
  /** 100-500ms per digit; Telnyx defaults to 250 when omitted. */
  readonly durationMillis?: number | undefined;
}

/**
 * Play DTMF tones toward the remote party of `callControlId`.
 *
 * ALWAYS issue this on LEG A. Leg A's remote party is the IVR we dialed; leg
 * B's remote party is xAI, so the same command on leg B would play the tones
 * at the model instead of at the phone tree -- silently, because this command
 * fires no webhooks and Telnyx returns 200 either way. That is the whole bug
 * class this helper exists to make hard to write.
 *
 * Returns the HTTP status, which is the ONLY confirmation Telnyx offers.
 */
export async function sendDtmf(
  cfg: TelnyxConfig,
  callControlId: string,
  args: SendDtmfArgs,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const body: Record<string, unknown> = {
    digits: args.digits,
    client_state: args.clientState,
    command_id: args.commandId,
  };
  if (args.durationMillis != null) body['duration_millis'] = args.durationMillis;
  return await command(cfg, callControlId, 'send_dtmf', body, fetchImpl);
}

/**
 * The Telnyx TTS voice used to RENDER the notice audio.
 *
 * DERIVED FROM THE CALL'S OWN AGENT VOICE by default, so the announcement is
 * spoken in the same voice the subject has been listening to instead of a
 * stranger cutting in mid-conversation. Telnyx exposes xAI as a TTS provider in
 * the `<Provider>.<VoiceId>` form, which is what makes this possible at all.
 *
 * VERIFIED LIVE on this account 2026-08-30 against
 * POST /v2/text-to-speech/speech, with an armed negative control:
 *   xAI.liora (this Worker's DEFAULT_VOICE)  -> 200, 39,168 bytes of audio
 *   xAI.eve                                  -> 200, 39,168 bytes
 *   xAI.rex                                  -> 200, 36,480 bytes
 *   xAI.not_a_real_voice                     -> 400 "Voice 'not_a_real_voice' not found"
 * The control is what makes the successes mean something: the endpoint really
 * does validate the voice id, per voice, rather than accepting anything.
 *
 * NOTE the limitation honestly: that is the text-to-speech endpoint, NOT
 * /conferences/{id}/actions/speak, which cannot be probed without a live
 * conference (it resolves the conference id before validating the body). So
 * this proves the ACCOUNT has these voices; it does not prove the conference
 * command accepts the same catalog. Announcing stays best-effort.
 *
 * INJECTION: the charset is re-checked here rather than trusted. The value
 * reaches a provider JSON body, and a voice containing a '.' would silently
 * become a different provider/model segment. `CallRequestSchema.voice` already
 * bounds it to [A-Za-z0-9_-], so this is defence in depth, not the only guard.
 */
export function noticeRenderVoice(callVoice: string, override?: string | undefined): string {
  const configured = override?.trim();
  if (configured) return configured;
  return /^[A-Za-z0-9_-]{1,64}$/.test(callVoice) ? `xAI.${callVoice}` : FALLBACK_NOTICE_VOICE;
}

/**
 * The voice for the `speak` FALLBACK -- a DIFFERENT question, with a different
 * and much smaller answer.
 *
 * The caveat two comments up ("it does not prove the conference command accepts
 * the same catalog") is now resolved, and it resolved against us: `speak`
 * accepts only five xAI voices, and the Worker's default is not one of them.
 * See CONFERENCE_SPEAK_XAI_VOICES for the measured 422 and the spec text.
 *
 * So this returns `xAI.<v>` ONLY for a voice `speak` actually accepts, and the
 * Telnyx house voice otherwise. Returning the call's own voice here -- which is
 * what the previous single function did for every voice -- is precisely the bug
 * that made the notice silently never play.
 *
 * The allowlist also subsumes the old charset guard: every value it can return
 * is a literal from this module, so no caller-supplied '.' can rewrite the
 * provider segment.
 */
export function conferenceNoticeVoice(callVoice: string, override?: string | undefined): string {
  const configured = override?.trim();
  if (configured) return configured;
  return (CONFERENCE_SPEAK_XAI_VOICES as readonly string[]).includes(callVoice)
    ? `xAI.${callVoice}`
    : FALLBACK_NOTICE_VOICE;
}

/**
 * Used only when the call's voice is unusable as a TTS voice id. Telnyx's own
 * model, so it depends on no other provider being enabled on the account; it is
 * the `example` value on the spec's `voice` property, and it returned 10,154
 * bytes of audio in the same probe above.
 */
export const FALLBACK_NOTICE_VOICE = 'Telnyx.KokoroTTS.af';

/** Build the xAI SIP URI for leg B. */
export function xaiSipUri(phoneNumber: string, sipHost: string): string {
  return `sip:${phoneNumber}@${sipHost};transport=tls`;
}

// ---------------------------------------------------------------------------
// Join notice: RENDER in the call's own voice, then PLAY it.
// ---------------------------------------------------------------------------

/**
 * The xAI voices Telnyx's conference `speak` command accepts -- FIVE of the 28
 * voices xAI actually ships.
 *
 * MEASURED, not inferred. The live failure on 2026-08-30 (call
 * 5ed08d10-52ba-4044-9555-26e9146a2d4b) was
 *   telnyx.conference.failed action=speak status=422
 *     detail:"The 'voice' parameter Invalid voice."
 * on a call whose voice was `liora`. Telnyx's own OpenAPI description of the
 * `voice` property on POST /conferences/{id}/actions/speak says:
 *   "**xAI:** Use `xAI.<VoiceId>` (e.g., `xAI.eve`).
 *    Available voices: `eve`, `ara`, `rex`, `sal`, `leo`."
 *
 * `liora` is not among them -- and it is the value the console ships as its
 * DEFAULT (console-ui.ts, `<input id="call-voice" value="liora">`). So the
 * notice was failing for the default configuration, and for 23 of the 28
 * voices an operator can pick. It failed quietly, because announcing is
 * best-effort: a 422 cost the notice and nothing else surfaced.
 *
 * The TTS endpoint POST /v2/text-to-speech/speech carries the FULL xAI catalog
 * (`xAI.liora` -> 200, 39,168 bytes of MP3, measured 2026-08-30 with armed
 * negative controls: `xAI.not_a_real_voice` -> 400, `NotAProvider.Nope.Nope`
 * -> 422). That difference between the two endpoints is the whole reason the
 * notice is now RENDERED there and PLAYED, instead of spoken by `speak`.
 */
export const CONFERENCE_SPEAK_XAI_VOICES = ['eve', 'ara', 'rex', 'sal', 'leo'] as const;

/**
 * TTL on the uploaded notice audio.
 *
 * ceiling: 630,720,000s (20 years) per the spec's `ttl_secs`; the spec's own
 * default is 172,800s (2 days). The real need is one upload->play round trip,
 * which is sub-second -- so an hour is ~3,600x the measured requirement and
 * still 48x tighter than the default. The file is played once and is dead
 * weight afterwards; a short TTL is what stops one media object accumulating
 * per participant join, forever, on the account.
 */
export const NOTICE_MEDIA_TTL_SECS = 3600;

/** Audio the notice is rendered to. Telnyx TTS returns MP3 by default. */
const NOTICE_AUDIO_TYPE = 'audio/mpeg';

/**
 * Synthesize `text` in `voice` and return the raw audio bytes.
 *
 * This is the endpoint with the full xAI voice catalog -- see
 * CONFERENCE_SPEAK_XAI_VOICES for why that matters and why we do not just
 * hand the same voice to `speak`.
 */
export async function synthesizeSpeech(
  cfg: TelnyxConfig,
  args: { readonly text: string; readonly voice: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ArrayBuffer> {
  const url = `${TELNYX_BASE}/text-to-speech/speech`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: args.text.slice(0, CONFERENCE_SPEAK_MAX_CHARS),
        voice: args.voice,
      }),
    });
  } catch (err) {
    log('error', 'telnyx.tts.network_error', { error: errText(err) });
    throw new Error(`Telnyx TTS network error: ${errText(err)}`);
  }
  if (!res.ok) {
    const detail = extractError(await res.text(), res.status);
    log('error', 'telnyx.tts.failed', { status: res.status, detail });
    throw new Error(`Telnyx TTS failed (${res.status}): ${detail}`);
  }
  const bytes = await res.arrayBuffer();
  // A 200 carrying no audio would otherwise upload a 0-byte file and play
  // silence -- which is indistinguishable, on the call, from the notice
  // working. Fail loudly here instead.
  if (bytes.byteLength === 0) {
    log('error', 'telnyx.tts.empty', { voice: args.voice });
    throw new Error('Telnyx TTS returned 0 bytes');
  }
  log('info', 'telnyx.tts.ok', { bytes: bytes.byteLength });
  return bytes;
}

/**
 * Upload audio bytes to Telnyx media storage under `mediaName`.
 *
 * Sent as multipart/form-data, which POST /v2/media accepts alongside the
 * JSON `media_url` form. The multipart form is the one that matters here:
 * `media_url` would make Telnyx FETCH the audio, which means hosting the
 * notice at a publicly reachable URL -- and the notice contains a
 * participant's name. Pushing the bytes directly means no route ever exposes
 * one.
 */
export async function uploadMedia(
  cfg: TelnyxConfig,
  args: {
    readonly bytes: ArrayBuffer;
    readonly mediaName: string;
    readonly ttlSecs: number;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const form = new FormData();
  form.append('media', new Blob([args.bytes], { type: NOTICE_AUDIO_TYPE }), 'notice.mp3');
  form.append('media_name', args.mediaName);
  form.append('ttl_secs', String(args.ttlSecs));
  let res: Response;
  try {
    // NOTE: no explicit Content-Type -- fetch must set the multipart boundary.
    res = await fetchImpl(`${TELNYX_BASE}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: form,
    });
  } catch (err) {
    log('error', 'telnyx.media.network_error', { error: errText(err) });
    throw new Error(`Telnyx media upload network error: ${errText(err)}`);
  }
  if (!res.ok) {
    const detail = extractError(await res.text(), res.status);
    log('error', 'telnyx.media.failed', { status: res.status, detail });
    throw new Error(`Telnyx media upload failed (${res.status}): ${detail}`);
  }
  log('info', 'telnyx.media.ok', { bytes: args.bytes.byteLength });
}

/**
 * Play a stored media file to EVERY participant on the conference.
 *
 * `call_control_ids` is omitted for the same reason `conferenceSpeak` omits it:
 * Telnyx documents an empty list as "played to the entire conference", and a
 * consent notice has to reach the subject, the AI, and the new arrival alike.
 */
export async function conferencePlay(
  cfg: TelnyxConfig,
  conferenceId: string,
  args: {
    readonly mediaName: string;
    readonly commandId: string;
    /**
     * Legs that should hear it. OMITTED means the whole conference, which is
     * what a disclosure needs. Supplying exactly one leg is how a private
     * confirmation reaches the operator without becoming an announcement.
     */
    readonly callControlIds?: readonly string[] | undefined;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const body: Record<string, unknown> = {
    media_name: args.mediaName,
    command_id: args.commandId,
  };
  // Send the key ONLY when scoping. An empty array is not "nobody" to Telnyx --
  // it documents an empty list as EVERY participant, so a caller that meant to
  // scope and passed [] would broadcast instead.
  if (args.callControlIds && args.callControlIds.length > 0) {
    body['call_control_ids'] = [...args.callControlIds];
  }
  await conferenceCommand(cfg, conferenceId, 'play', body, fetchImpl);
}
