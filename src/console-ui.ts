import type { OperatorUser } from './auth';
import { E164_PATTERN, MAX_PARTICIPANTS, SUPERVISOR_ROLES } from './types';

export type ConsolePageMode = 'login' | 'authorized' | 'config_error';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function nonceValue(value: string): string {
  return escapeHtml(value.replace(/[^A-Za-z0-9_-]/g, ''));
}

const FAVICON_DATA_URI =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iOCIgZmlsbD0iI2Q2YTE0MiIvPjxwYXRoIGQ9Ik0xNiAyMGgzMnY4SDE2em0wIDE2aDI0djhIMTZ6IiBmaWxsPSIjMWYyMTFkIi8+PC9zdmc+';

const CONSOLE_SCRIPT = `
(() => {
  const byId = (id) => document.getElementById(id);
  // THE SAME regex the server's zod schema compiles, interpolated from the one
  // exported literal in src/types.ts. Writing a second one here is the failure
  // that export exists to prevent: a browser check that accepts a number the
  // dialer rejects turns a typo into a 400 the operator has to decode.
  const E164 = new RegExp(${JSON.stringify(E164_PATTERN)});
  const MAX_PARTICIPANTS = ${MAX_PARTICIPANTS};
  const SUPERVISOR_ROLES = ${JSON.stringify([...SUPERVISOR_ROLES])};
  /**
   * Split the start-of-call participants box into validated E.164 numbers.
   *
   * Throws rather than silently dropping a bad entry: a form that quietly
   * discarded one number would place a call the operator believed had three
   * people on it. The cap is checked here too, so the operator is told before a
   * call is placed rather than after the server refuses the fourth dial.
   */
  const parseParticipants = (raw) => {
    const parts = String(raw || '').split(/[\\s,;]+/).filter((value) => value.length > 0);
    parts.forEach((value) => {
      if (!E164.test(value)) throw new Error(value + ' is not E.164, e.g. +14155550123');
    });
    if (parts.length > MAX_PARTICIPANTS) {
      throw new Error('at most ' + MAX_PARTICIPANTS + ' participants per call');
    }
    const seen = new Set();
    parts.forEach((value) => {
      if (seen.has(value)) throw new Error(value + ' is listed twice');
      seen.add(value);
    });
    return parts;
  };
  const statusNode = byId('console-status');
  const notice = (message, tone) => {
    statusNode.textContent = message;
    statusNode.dataset.tone = tone || 'neutral';
  };
  const jsonApi = async (url, init) => {
    const response = await fetch(url, Object.assign({ headers: { 'Content-Type': 'application/json' } }, init || {}));
    let body = null;
    try { body = await response.json(); } catch (_) { body = null; }
    if (!response.ok) {
      const message = body && typeof body.error === 'string' ? body.error : 'request failed';
      throw new Error(message);
    }
    return body;
  };
  const formatTime = (value) => {
    if (typeof value !== 'number') return '—';
    return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };
  const setText = (id, value) => { const node = byId(id); if (node) node.textContent = value == null ? '—' : String(value); };

  const loginButton = byId('google-login');
  if (loginButton) {
    loginButton.addEventListener('click', async () => {
      loginButton.disabled = true;
      notice('Opening Google sign-in…', 'neutral');
      try {
        const body = await jsonApi('/api/auth/sign-in/social', {
          method: 'POST',
          body: JSON.stringify({ provider: 'google', callbackURL: location.origin + '/console', disableRedirect: true })
        });
        if (!body || typeof body.url !== 'string') throw new Error('Google sign-in URL was not returned');
        location.assign(body.url);
      } catch (error) {
        notice(error instanceof Error ? error.message : 'sign-in failed', 'bad');
        loginButton.disabled = false;
      }
    });
    return;
  }

  let activeCallId = null;
  let liveCalls = [];
  let selectedCallId = null;
  let liveCallsPollTimer = 0;
  let pollTimer = 0;
  let terminalPollsRemaining = 0;
  let callLogCursor = null;
  // The call whose archive row we have already asked the list for, so a
  // terminal poll does not refetch the log on every tick.
  let loggedCallId = null;
  let monitorSocket = null;
  let audioContext = null;
  let nextAudioTime = { inbound: 0, outbound: 0 };
  let trackGains = null;

  const phaseNode = byId('phase');
  const subjectView = byId('call-subject-view');
  const transcriptNode = byId('transcript');
  const recordingNode = byId('recordings');
  const callLogNode = byId('calllog');
  const costNode = byId('cost-summary');
  const costSeriesNode = byId('cost-series');
  const costWindowNode = byId('cost-window');
  const callCostNode = byId('call-cost');
  const monitorButton = byId('monitor-call');
  const hangupButton = byId('hangup-call');
  const startButton = byId('start-call');
  const moreButton = byId('calllog-more');
  const callIdNode = byId('call-id');
  const participantsNode = byId('participants');
  const participantAddButton = byId('participant-add');

  const renderTranscript = (entries) => {
    transcriptNode.replaceChildren();
    if (!Array.isArray(entries) || entries.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No transcript events yet.';
      transcriptNode.appendChild(empty);
      return;
    }
    entries.forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'transcript-row';
      const meta = document.createElement('span');
      meta.className = 'transcript-meta';
      meta.textContent = String(entry.role || 'event').toUpperCase() + '  ' + formatTime(entry.at);
      const text = document.createElement('p');
      text.textContent = typeof entry.text === 'string' ? entry.text : '';
      row.append(meta, text);
      transcriptNode.appendChild(row);
    });
    transcriptNode.scrollTop = transcriptNode.scrollHeight;
  };

  const clock = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
    const whole = Math.floor(seconds);
    const mins = Math.floor(whole / 60);
    const secs = whole % 60;
    return String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
  };

  // A self-contained transport. No CDN library: this page's CSP is
  // default-src 'none' with a nonce-only script-src, and it displays call
  // transcripts and recordings behind auth. Loading a third-party player would
  // mean widening script-src on an authenticated PII surface to gain a scrub bar
  // we already get for free now that the server answers ranged requests.
  const buildTransport = (audio) => {
    const transport = document.createElement('div');
    transport.className = 'transport';

    const bar = document.createElement('div');
    bar.className = 'transport-bar';
    bar.setAttribute('role', 'slider');
    bar.setAttribute('aria-label', 'Seek within the recording');
    bar.setAttribute('aria-valuemin', '0');
    bar.tabIndex = 0;
    const fill = document.createElement('i');
    bar.appendChild(fill);

    const readout = document.createElement('span');
    readout.className = 'transport-time';
    readout.textContent = '--:-- / --:--';

    const controls = document.createElement('div');
    controls.className = 'transport-controls';

    const skip = (delta, label) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button quiet';
      button.textContent = label;
      button.addEventListener('click', () => {
        if (!Number.isFinite(audio.duration)) return;
        audio.currentTime = Math.min(Math.max(0, audio.currentTime + delta), audio.duration);
      });
      return button;
    };

    const speed = document.createElement('select');
    speed.className = 'transport-speed';
    speed.setAttribute('aria-label', 'Playback speed');
    [0.75, 1, 1.25, 1.5, 2].forEach((rate) => {
      const option = document.createElement('option');
      option.value = String(rate);
      option.textContent = rate + 'x';
      if (rate === 1) option.selected = true;
      speed.appendChild(option);
    });
    speed.addEventListener('change', () => {
      const rate = Number(speed.value);
      if (Number.isFinite(rate) && rate > 0) audio.playbackRate = rate;
    });

    controls.append(skip(-10, '-10s'), skip(10, '+10s'), speed);

    const paint = () => {
      const duration = audio.duration;
      const known = Number.isFinite(duration) && duration > 0;
      const ratio = known ? Math.min(1, audio.currentTime / duration) : 0;
      fill.style.width = (ratio * 100).toFixed(2) + '%';
      readout.textContent = clock(audio.currentTime) + ' / ' + (known ? clock(duration) : '--:--');
      bar.setAttribute('aria-valuemax', known ? String(Math.floor(duration)) : '0');
      bar.setAttribute('aria-valuenow', String(Math.floor(audio.currentTime)));
      bar.setAttribute('aria-valuetext', clock(audio.currentTime));
      // seekable is EMPTY unless the server answered with a range-capable
      // response. Reporting that honestly beats a slider that silently does
      // nothing, which is exactly the bug this feature was built to fix.
      bar.dataset.seekable = audio.seekable && audio.seekable.length > 0 ? 'yes' : 'no';
    };

    const seekToClientX = (clientX) => {
      const duration = audio.duration;
      if (!Number.isFinite(duration) || duration <= 0) return;
      const box = bar.getBoundingClientRect();
      if (box.width <= 0) return;
      const ratio = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
      audio.currentTime = ratio * duration;
      paint();
    };

    bar.addEventListener('click', (event) => { seekToClientX(event.clientX); });
    bar.addEventListener('keydown', (event) => {
      const duration = audio.duration;
      if (!Number.isFinite(duration) || duration <= 0) return;
      const step = event.key === 'ArrowLeft' ? -5 : event.key === 'ArrowRight' ? 5 : 0;
      if (step === 0) return;
      event.preventDefault();
      audio.currentTime = Math.min(Math.max(0, audio.currentTime + step), duration);
      paint();
    });

    ['loadedmetadata', 'timeupdate', 'durationchange', 'seeked', 'ended'].forEach((name) => {
      audio.addEventListener(name, paint);
    });
    paint();

    transport.append(bar, readout, controls);
    return transport;
  };

  const renderRecordings = (recordings) => {
    recordingNode.replaceChildren();
    if (!Array.isArray(recordings) || recordings.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'empty';
      empty.textContent = 'Waiting for Telnyx recording callback.';
      recordingNode.appendChild(empty);
      return;
    }
    recordings.forEach((recording) => {
      if (!recording || (recording.format !== 'wav' && recording.format !== 'mp3')) return;
      const wrap = document.createElement('div');
      wrap.className = 'recording-item';
      const label = document.createElement('span');
      label.textContent = String(recording.format).toUpperCase() + ' / ' + String(recording.channels || 'dual');
      const audio = document.createElement('audio');
      audio.controls = true;
      // 'metadata', NOT 'none'. With 'none' the browser knows no duration until
      // playback starts, so the scrub bar is dead on arrival even against a
      // server that answers ranges correctly.
      audio.preload = 'metadata';
      audio.src = '/api/console/calls/' + encodeURIComponent(activeCallId) + '/recording/' + recording.format;
      wrap.append(label, audio, buildTransport(audio));
      recordingNode.appendChild(wrap);
    });
  };

  // --- Participants ----------------------------------------------------------
  // Rows are built with createElement and listeners attached in JS. The page CSP
  // admits scripts by nonce ONLY, so an onclick= attribute would be a control
  // that silently does nothing -- the same reason every other panel here uses
  // addEventListener. (This comment ships to the browser inside CONSOLE_SCRIPT,
  // so it deliberately avoids naming the CSP keyword it is talking about:
  // test/console-cost-ui.test.ts greps the rendered page for that token as a
  // policy-weakening canary, and a comment mentioning it trips the canary.)
  const PARTICIPANT_STATUS_TEXT = {
    queued: 'QUEUED',
    dialing: 'DIALING',
    joined: 'ON CALL',
    left: 'LEFT',
    failed: 'FAILED'
  };

  const participantAction = async (path, init, failure) => {
    if (!activeCallId) return;
    try {
      await jsonApi(path, init);
      await poll();
    } catch (error) {
      notice(error instanceof Error ? error.message : failure, 'bad');
    }
  };

  const participantRow = (participant) => {
    const row = document.createElement('div');
    row.className = 'participant-row';
    row.dataset.status = String(participant.status || 'unknown');

    const who = document.createElement('span');
    who.className = 'participant-who';
    const label = typeof participant.label === 'string' ? participant.label.trim() : '';
    // The NUMBER always shows. A label is the operator's own shorthand and two
    // people can share one, so hiding the number behind it would make a roster
    // where two rows are indistinguishable -- the exact defect the call log's
    // subject line was rebuilt to avoid.
    who.textContent = label ? label + '  ' + (participant.to || '') : (participant.to || '—');

    const meta = document.createElement('span');
    meta.className = 'participant-meta';
    const status = PARTICIPANT_STATUS_TEXT[participant.status] || String(participant.status || '');
    const since = typeof participant.joinedAt === 'number' ? '  ' + formatTime(participant.joinedAt) : '';
    // The role shown is the one the SERVER resolved, not the one the operator
    // picked: a whisper with nobody to whisper to comes back as 'monitor', and
    // the roster has to say so rather than repeat the request back.
    const role = SUPERVISOR_ROLES.indexOf(participant.supervisorRole) >= 0 && participant.supervisorRole !== 'barge'
      ? '  ' + String(participant.supervisorRole).toUpperCase()
      : '';
    meta.textContent = status + since + role + (participant.muted ? '  MUTED' : '') + (participant.held ? '  ON HOLD' : '');

    const actions = document.createElement('div');
    actions.className = 'participant-actions';
    // Only a participant with a live leg can be muted or dropped. A queued row
    // has no leg yet and a departed one has nothing left to act on, so the
    // buttons are omitted rather than shown and then failing at the server.
    const legId = typeof participant.legId === 'string' ? participant.legId : '';
    const live = legId !== '' && participant.status !== 'left' && participant.status !== 'failed';
    if (live) {
      if (participant.status === 'joined') {
        // ONE builder for both toggles. Two near-identical blocks is where the
        // verb and the button that carries it drift apart, and here that would
        // mean a button labelled Unmute issuing a hold.
        const toggle = (verb, label) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'button quiet';
          button.textContent = label;
          button.addEventListener('click', () => {
            participantAction(
              '/api/console/calls/' + encodeURIComponent(activeCallId) + '/participants/' + encodeURIComponent(legId) + '/' + verb,
              { method: 'POST' },
              verb + ' failed'
            );
          });
          actions.appendChild(button);
        };
        toggle(participant.muted ? 'unmute' : 'mute', participant.muted ? 'Unmute' : 'Mute');
        toggle(participant.held ? 'unhold' : 'hold', participant.held ? 'Resume' : 'Hold');
      }
      const drop = document.createElement('button');
      drop.type = 'button';
      drop.className = 'button danger';
      drop.textContent = 'Drop';
      drop.addEventListener('click', () => {
        participantAction(
          '/api/console/calls/' + encodeURIComponent(activeCallId) + '/participants/' + encodeURIComponent(legId),
          { method: 'DELETE' },
          'drop failed'
        );
      });
      actions.appendChild(drop);
    }

    row.append(who, meta, actions);
    return row;
  };

  const renderParticipants = (entries, phase) => {
    const rows = Array.isArray(entries) ? entries : [];
    participantsNode.replaceChildren();
    if (rows.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Nobody else on this call.';
      participantsNode.appendChild(empty);
    } else {
      rows.forEach((participant) => {
        if (participant && typeof participant === 'object') {
          participantsNode.appendChild(participantRow(participant));
        }
      });
    }
    const active = rows.filter((row) => row && row.status !== 'left' && row.status !== 'failed').length;
    setText('participant-count', String(active));
    const terminal = phase === 'completed' || phase === 'failed';
    participantAddButton.disabled = !activeCallId || terminal;
  };

  const renderStatus = (data) => {
    if (!data) return;
    setText('phase', data.phase);
    setText('direction', data.direction);
    setText('destination', data.to);
    setText('amd', data.amdResult || 'pending');
    setText('updated', formatTime(data.updatedAt));
    // The full answer to "what was this call about" belongs here, not in the
    // 120-character list row. Hidden outright when the server sent neither, so
    // an older archived call shows nothing rather than an empty labelled box.
    const subjectText = typeof data.subject === 'string' ? data.subject.trim() : '';
    const taskText = typeof data.task === 'string' ? data.task.trim() : '';
    subjectView.hidden = subjectText === '' && taskText === '';
    setText('subject-line', subjectText || '—');
    // Name the author in the label rather than in a sentence under it. The panel
    // has room for the derived text -- the operator opened this call on purpose
    // -- but presenting a machine summary under the same word as a label they
    // typed themselves is the small lie the list row already stopped telling.
    setText(
      'subject-label',
      subjectText !== '' && data.subjectSource !== 'operator' ? 'SUBJECT (DERIVED FROM TASK)' : 'SUBJECT'
    );
    byId('task-view').hidden = taskText === '';
    byId('task-text').textContent = taskText;
    const monitor = data.monitoring && data.monitoring.available;
    setText('monitor-state', monitor ? 'READY / BOTH TRACKS' : 'UNAVAILABLE');
    setText('codec-state', data.monitoring ? data.monitoring.codec : '—');
    renderTranscript(data.transcript);
    renderRecordings(data.recordings);
    renderParticipants(data.participants, data.phase);
    renderCallCost(data.cost);
    phaseNode.dataset.phase = data.phase || 'unknown';
    const terminal = data.phase === 'completed' || data.phase === 'failed';
    // Start button is controlled by concurrent cap in renderLiveCalls, not terminal status
    hangupButton.disabled = terminal || !selectedCallId;
    monitorButton.disabled = !monitor || terminal;
    notice('Status synchronized at ' + formatTime(data.updatedAt), terminal ? 'neutral' : 'good');
  };

  const stopMonitor = () => {
    if (monitorSocket) {
      monitorSocket.close(1000, 'operator stopped monitor');
      monitorSocket = null;
    }
    setText('monitor-connection', 'OFFLINE');
    if (audioContext) {
      audioContext.close().catch(() => {});
      audioContext = null;
    }
    trackGains = null;
    nextAudioTime = { inbound: 0, outbound: 0 };
  };

  const base64Bytes = (encoded) => {
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    const binary = atob(normalized + padding);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };
  const mulawSample = (value) => {
    const u = (~value) & 0xff;
    const magnitude = ((u & 0x0f) << 3) + 132;
    const sample = magnitude << ((u & 0x70) >> 4);
    return (u & 0x80) ? (132 - sample) / 32768 : (sample - 132) / 32768;
  };
  const playMedia = (event) => {
    if (!audioContext || !trackGains || event.codec && event.codec !== 'PCMU') return;
    let bytes;
    try { bytes = base64Bytes(event.payload); } catch (_) { return; }
    if (!bytes.length) return;
    const samples = new Float32Array(bytes.length);
    for (let i = 0; i < bytes.length; i += 1) samples[i] = mulawSample(bytes[i]);
    const buffer = audioContext.createBuffer(1, samples.length, 8000);
    buffer.copyToChannel(samples, 0);
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(trackGains[event.track] || audioContext.destination);
    const startAt = Math.max(audioContext.currentTime + 0.03, nextAudioTime[event.track]);
    source.start(startAt);
    nextAudioTime[event.track] = startAt + buffer.duration;
  };

  const startMonitor = async () => {
    if (!activeCallId || monitorSocket) return;
    try {
      const tokenBody = await jsonApi('/api/console/calls/' + encodeURIComponent(activeCallId) + '/media-token', { method: 'POST' });
      if (!tokenBody || typeof tokenBody.token !== 'string') throw new Error('monitor token was not returned');
      audioContext = new AudioContext();
      await audioContext.resume();
      const inbound = audioContext.createGain();
      const outbound = audioContext.createGain();
      inbound.connect(audioContext.destination);
      outbound.connect(audioContext.destination);
      trackGains = { inbound, outbound };
      const wsUrl = new URL('/api/console/calls/' + encodeURIComponent(activeCallId) + '/monitor', location.href);
      wsUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrl.searchParams.set('token', tokenBody.token);
      monitorSocket = new WebSocket(wsUrl);
      monitorSocket.addEventListener('open', () => setText('monitor-connection', 'LIVE / BOTH TRACKS'));
      monitorSocket.addEventListener('message', (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch (_) { return; }
        if (message.type === 'start') {
          setText('codec-state', message.codec + ' / ' + message.sampleRate + ' Hz');
          if (message.codec !== 'PCMU') notice('Monitor codec ' + message.codec + ' is not browser-decoded.', 'bad');
        }
        if (message.type === 'media') playMedia(message);
        if (message.type === 'stop') stopMonitor();
      });
      monitorSocket.addEventListener('close', () => { monitorSocket = null; setText('monitor-connection', 'OFFLINE'); });
      monitorSocket.addEventListener('error', () => notice('Monitor WebSocket failed.', 'bad'));
    } catch (error) {
      stopMonitor();
      notice(error instanceof Error ? error.message : 'monitor failed', 'bad');
    }
  };

  const loadLiveCalls = async () => {
    try {
      const data = await jsonApi('/api/console/calls/live');
      liveCalls = Array.isArray(data && data.calls) ? data.calls : [];
      renderLiveCalls();
      // Poll again in 2 seconds for live status
      window.clearTimeout(liveCallsPollTimer);
      liveCallsPollTimer = window.setTimeout(loadLiveCalls, 2000);
    } catch (error) {
      // Don't spam errors on every poll tick
      liveCalls = [];
      renderLiveCalls();
      window.clearTimeout(liveCallsPollTimer);
      liveCallsPollTimer = window.setTimeout(loadLiveCalls, 5000);
    }
  };

  const renderLiveCalls = () => {
    const container = byId('live-calls');
    if (!container) return;
    container.replaceChildren();
    if (liveCalls.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No active calls.';
      container.appendChild(empty);
      startButton.disabled = false;
      return;
    }
    const MAX_CONCURRENT = 5; // MAX_CONCURRENT_OUTBOUND
    liveCalls.forEach((call) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'live-call-row';
      if (call.callId === selectedCallId) row.classList.add('selected');
      const subject = call.subject || call.to || 'Unknown';
      const elapsed = Math.floor((Date.now() - call.startedAt) / 1000);
      row.textContent = subject + '  ' + clock(elapsed);
      row.addEventListener('click', () => { selectCall(call.callId); });
      container.appendChild(row);
    });
    startButton.disabled = liveCalls.length >= MAX_CONCURRENT;
  };

  const poll = async () => {
    if (!activeCallId) return;
    try {
      const data = await jsonApi('/api/console/calls/' + encodeURIComponent(activeCallId));
      renderStatus(data);
      if (data.phase !== 'completed' && data.phase !== 'failed') {
        pollTimer = window.setTimeout(poll, 1500);
      } else {
        // The archive record is written at the terminal transition, so this is
        // the first moment the finished call can appear in the list.
        if (loggedCallId !== activeCallId) {
          loggedCallId = activeCallId;
          loadCallLog(false);
        }
        if (terminalPollsRemaining > 0 && (!Array.isArray(data.recordings) || data.recordings.length === 0)) {
          terminalPollsRemaining -= 1;
          pollTimer = window.setTimeout(poll, 5000);
        }
      }
    } catch (error) {
      notice(error instanceof Error ? error.message : 'status request failed', 'bad');
      pollTimer = window.setTimeout(poll, 3000);
    }
  };

  const selectCall = async (id) => {
    stopMonitor();
    window.clearTimeout(pollTimer);
    activeCallId = id;
    selectedCallId = id;
    loggedCallId = id;
    // An archived call is finished: nothing new is coming, so do not keep
    // re-polling it waiting for a recording that already landed or never will.
    terminalPollsRemaining = 0;
    callIdNode.textContent = id;
    renderLiveCalls(); // Update selected state in live list
    await poll();
  };

  const money = (usd) => {
    if (typeof usd !== 'number' || !Number.isFinite(usd)) return '—';
    // Sub-cent line items are real at this scale, so a call is shown to a tenth
    // of a cent rather than rounded to $0.00 and read as free.
    if (usd > 0 && usd < 0.01) return '$' + usd.toFixed(4);
    return '$' + usd.toFixed(2);
  };

  const perMinute = (usd) => {
    if (typeof usd !== 'number' || !Number.isFinite(usd)) return '\u2014';
    // FOUR decimals, always -- do NOT reuse money() here. money() renders
    // 0.0983 as "$0.10" and the $0.0925 two-party floor as "$0.09", which
    // collapses a 6% overage into a 1-cent gap and destroys the only
    // comparison this row exists to make.
    return '$' + usd.toFixed(4) + '/min';
  };

  const CONFIDENCE_TEXT = {
    verified: 'Rates read from provider pricing pages within the last 30 days.',
    stale: 'At least one rate has not been re-checked in over 30 days and may have moved.',
    override: 'At least one rate is an operator override from wrangler vars.'
  };

  const costLine = (label, value, format) => {
    const row = document.createElement('div');
    row.className = 'cost-line';
    const name = document.createElement('span');
    name.textContent = label;
    const amount = document.createElement('strong');
    amount.textContent = (format || money)(value);
    row.append(name, amount);
    return row;
  };

  const renderCallCost = (cost) => {
    callCostNode.replaceChildren();
    if (!cost || typeof cost.total !== 'number') {
      const empty = document.createElement('span');
      empty.className = 'empty';
      empty.textContent = 'No cost estimate for this call.';
      callCostNode.appendChild(empty);
      return;
    }
    const head = document.createElement('div');
    head.className = 'cost-total';
    const total = document.createElement('strong');
    total.textContent = money(cost.total);
    const caption = document.createElement('span');
    // Never let the headline number read as a bill, and never let a running
    // call's partial total read as a final one.
    caption.textContent = cost.inProgress ? 'estimated so far' : 'estimated total';
    head.append(total, caption);
    callCostNode.appendChild(head);

    callCostNode.appendChild(costLine('xAI audio', cost.xai));
    callCostNode.appendChild(costLine('Telnyx leg A (PSTN)', cost.telnyxLegA));
    callCostNode.appendChild(costLine('Telnyx leg B (SIP to xAI)', cost.telnyxLegB));
    callCostNode.appendChild(costLine('SIP trunking', cost.telnyxSip));
    callCostNode.appendChild(costLine('Recording', cost.telnyxRecording));
    callCostNode.appendChild(costLine('Media streaming', cost.telnyxMediaStreaming));
    callCostNode.appendChild(costLine('Answering-machine detection', cost.telnyxAmd));

    const basis = document.createElement('p');
    basis.className = 'fine-print';
    const seconds = Math.round((cost.billableMs || 0) / 1000);
    const source = cost.durationSource === 'answered'
      ? 'billed from answer'
      : cost.durationSource === 'unanswered'
        ? 'never answered, so nothing metered'
        : 'billed from total call time, which includes ring time and so runs high';
    basis.textContent = seconds + 's ' + source + '. ' + (cost.disclaimer || '');
    callCostNode.appendChild(basis);

    if (cost.rateConfidence && cost.rateConfidence !== 'verified') {
      const warn = document.createElement('p');
      warn.className = 'fine-print cost-warn';
      warn.textContent = CONFIDENCE_TEXT[cost.rateConfidence] || '';
      callCostNode.appendChild(warn);
    }
  };

  const renderCostSeries = (series, window) => {
    costSeriesNode.replaceChildren();
    if (!Array.isArray(series) || series.length === 0) return;
    let peak = 0;
    series.forEach((bucket) => {
      if (bucket && typeof bucket.usd === 'number' && bucket.usd > peak) peak = bucket.usd;
    });
    series.forEach((bucket) => {
      if (!bucket) return;
      const usd = typeof bucket.usd === 'number' ? bucket.usd : 0;
      const column = document.createElement('div');
      column.className = 'cost-bar';
      // A zero bucket still gets a visible 1% stub so the axis reads as a
      // timeline with a gap rather than as missing data.
      const height = peak > 0 ? Math.max(1, Math.round((usd / peak) * 100)) : 1;
      column.style.height = height + '%';
      const when = new Date(bucket.startMs);
      const label = window === 'day'
        ? String(when.getUTCHours()).padStart(2, '0') + ':00 UTC'
        : window === 'year'
          ? when.toLocaleDateString([], { month: 'short', timeZone: 'UTC' })
          : when.toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' });
      column.title = label + ' — ' + money(usd) + ' over ' + (bucket.calls || 0) + ' call(s)';
      costSeriesNode.appendChild(column);
    });
  };

  const renderCostRollup = (data) => {
    costNode.replaceChildren();
    if (!data || typeof data.totalUsd !== 'number') {
      const empty = document.createElement('span');
      empty.className = 'empty';
      empty.textContent = 'No cost data.';
      costNode.appendChild(empty);
      return;
    }
    const head = document.createElement('div');
    head.className = 'cost-total';
    const total = document.createElement('strong');
    total.textContent = money(data.totalUsd);
    const caption = document.createElement('span');
    caption.textContent = 'estimated spend, ' + (data.calls || 0) + ' call(s)';
    head.append(total, caption);
    costNode.appendChild(head);

    costNode.appendChild(costLine('xAI', data.byProvider ? data.byProvider.xai : 0));
    costNode.appendChild(costLine('Telnyx', data.byProvider ? data.byProvider.telnyx : 0));
    costNode.appendChild(costLine('Recording', data.byProvider ? data.byProvider.telnyxRecording : 0));
    costNode.appendChild(costLine('Average per call', data.averageUsdPerCall));

    // Cost per minute. The one figure that is comparable ACROSS periods and
    // across vendors -- a total moves with volume and an average-per-call moves
    // with call length, so neither answers "is this getting more expensive?".
    if (typeof data.usdPerMinute === 'number') {
      costNode.appendChild(costLine('Cost per minute', data.usdPerMinute, perMinute));
    } else if (data.calls > 0) {
      // Calls exist but no billable minutes: every one of them rang out. Say so.
      // Rendering "$0.0000/min" here would assert a MEASURED rate of zero, which
      // is a claim about pricing rather than the absence of anything to measure.
      costNode.appendChild(
        costLine('Cost per minute', null, () => 'no answered minutes')
      );
    }

    // The trailing window, shown for EVERY period and never gated on "this
    // period looks young".
    //
    // A young-period gate would need a threshold, and any threshold here would
    // be an invented number with no measured behaviour behind it. Unconditional
    // meets the actual goal -- the panel is never bare -- strictly more
    // robustly, with no magic constant, and stays useful all month: "this month
    // $12 / last 30 days $19" is information, not noise.
    //
    // It sits among the other costLine rows on purpose. It is the SAME estimate
    // from the SAME published list rates over a DIFFERENT window, so it must
    // read as a peer of those figures rather than as a more authoritative one,
    // and the disclaimer printed below covers it exactly as it covers them.
    const trailing = data.trailing30 || {};
    // The 30 is only a fallback so a malformed payload cannot print "Last
    // undefined days"; the horizon itself is TRAILING_WINDOW_DAYS on the server.
    const trailingLabel = 'Last ' + (trailing.days || 30) + ' days ('
      + (trailing.calls || 0) + ' call(s))';
    costNode.appendChild(costLine(trailingLabel, trailing.usd));

    const forecast = data.forecast || {};
    const projection = document.createElement('div');
    projection.className = 'cost-line cost-forecast';
    const forecastLabel = document.createElement('span');
    // Name the METHOD next to the number. A projection printed bare beside
    // measured figures reads as though it were measured too.
    forecastLabel.textContent = typeof forecast.usd === 'number'
      ? 'Projected (' + (forecast.method || 'unknown method') + ', ' + (forecast.sampleDays || 0) + 'd sample)'
      : 'Projected';
    const forecastValue = document.createElement('strong');
    forecastValue.textContent = typeof forecast.usd === 'number'
      ? money(forecast.usd)
      : 'not enough data';
    projection.append(forecastLabel, forecastValue);
    costNode.appendChild(projection);

    if (typeof forecast.usd !== 'number' && forecast.reason) {
      const why = document.createElement('p');
      why.className = 'fine-print';
      why.textContent = forecast.reason + '.';
      costNode.appendChild(why);
    }

    const notes = [];
    if (data.disclaimer) notes.push(data.disclaimer);
    if (data.truncated) {
      notes.push('Scan hit its page cap, so this total is a FLOOR rather than the full period.');
    }
    if (trailing.truncated) {
      notes.push('Scan hit its page cap before covering the trailing window, so that figure is a FLOOR too.');
    }
    if (data.looseDurationCalls > 0) {
      notes.push(
        data.looseDurationCalls + ' call(s) predate answer-time tracking and are estimated from '
        + 'total call time, which includes ring time and so runs high.'
      );
    }
    if (typeof data.usdPerMinute === 'number' && typeof data.usdPerMinuteFloor === 'number') {
      // "Compared to what?" -- a rate with no reference frame is a number.
      // Above the floor is the EXPECTED shape for recorded, short (the $0.002
      // answering-machine-detection fee is per call, so it amortises badly over
      // a short one) or conference calls, so this is framing, not an alarm.
      notes.push(
        'A plain unrecorded two-party minute costs $' + data.usdPerMinuteFloor.toFixed(4)
        + ' at current rates'
        + (typeof data.usdPerMinuteFloorXai === 'number'
            ? ', $' + data.usdPerMinuteFloorXai.toFixed(4) + ' of it the xAI model'
            : '')
        + '. Recorded, short, and conference calls price above that.'
      );
    }
    if (data.rateConfidence && data.rateConfidence !== 'verified') {
      notes.push(CONFIDENCE_TEXT[data.rateConfidence] || '');
    }
    notes.filter(Boolean).forEach((text) => {
      const note = document.createElement('p');
      note.className = 'fine-print';
      note.textContent = text;
      costNode.appendChild(note);
    });

    renderCostSeries(data.series, data.window);
  };

  const loadCosts = async () => {
    const window = costWindowNode.value || 'month';
    try {
      const data = await jsonApi('/api/console/costs?window=' + encodeURIComponent(window));
      renderCostRollup(data);
    } catch (error) {
      costNode.replaceChildren();
      const failed = document.createElement('span');
      failed.className = 'empty';
      failed.textContent = error instanceof Error ? error.message : 'cost request failed';
      costNode.appendChild(failed);
      costSeriesNode.replaceChildren();
    }
  };

  const callLogRow = (call) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'calllog-row';
    row.dataset.phase = call.phase || 'unknown';
    const when = document.createElement('span');
    when.className = 'calllog-when';
    when.textContent = typeof call.endedAt === 'number'
      ? new Date(call.endedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '—';
    // ONLY a label a human wrote for THIS call earns the headline, which is why
    // the row reads subjectSource and not just subject. A DERIVED subject
    // summarises the TASK, and a task is a script reused across every target in
    // a campaign: measured on the 10 archived calls, 2 distinct derived
    // subjects, 8 of them the same 66-character preamble. Promoting those
    // replaced ten legible numbers with a wall of identical boilerplate, which
    // is strictly worse than the number-first row it displaced.
    //
    // subjectSource null -- an object that never recorded who wrote its label --
    // is treated exactly as 'derived'. That is the safe direction: the cost of
    // demoting a real operator label is one extra line to read, the cost of
    // promoting a machine summary is the regression above.
    //
    // The derived text is deliberately NOT given a line of its own here. It is
    // identical across 8 of 10 rows, so it costs vertical space in a 300px
    // scroll box and buys no way to tell those rows apart; it still travels in
    // the payload, and the detail panel shows it in full, labelled as derived.
    const number = (call.direction === 'inbound' ? '← ' : '→ ') + (call.to || '—');
    const named = call.subjectSource === 'operator' && typeof call.subject === 'string' && call.subject.trim()
      ? call.subject.trim()
      : '';
    const title = document.createElement('span');
    title.className = 'calllog-subject';
    title.textContent = named || number;
    const who = document.createElement('span');
    who.className = 'calllog-who';
    // Never print the number twice. When it is already the headline the second
    // line carries the time instead, so the row still shows two facts.
    who.textContent = named ? number : when.textContent;
    const meta = document.createElement('span');
    meta.className = 'calllog-meta';
    const seconds = typeof call.durationMs === 'number' ? Math.round(call.durationMs / 1000) : null;
    const cost = call.cost && typeof call.cost.total === 'number' ? '  ' + money(call.cost.total) : '';
    meta.textContent = String(call.phase || 'unknown').toUpperCase() + (seconds === null ? '' : '  ' + seconds + 's') + cost;
    if (named) row.append(title, who, when, meta);
    else row.append(title, when, meta);
    row.addEventListener('click', () => { selectCall(call.callId); });
    return row;
  };

  const loadCallLog = async (append) => {
    if (!append) { callLogCursor = null; callLogNode.replaceChildren(); }
    try {
      const query = append && callLogCursor ? '?cursor=' + encodeURIComponent(callLogCursor) : '';
      const body = await jsonApi('/api/console/calls' + query);
      const rows = Array.isArray(body && body.calls) ? body.calls : [];
      rows.forEach((call) => { if (call && typeof call.callId === 'string') callLogNode.appendChild(callLogRow(call)); });
      callLogCursor = body && typeof body.cursor === 'string' ? body.cursor : null;
      moreButton.disabled = callLogCursor === null;
      if (callLogNode.childElementCount === 0) {
        const empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = 'No calls archived yet.';
        callLogNode.appendChild(empty);
      }
    } catch (error) {
      callLogNode.replaceChildren();
      const failed = document.createElement('p');
      failed.className = 'empty';
      failed.textContent = error instanceof Error ? error.message : 'call log unavailable';
      callLogNode.appendChild(failed);
      moreButton.disabled = true;
    }
  };

  // --- Script preview (read-only) --------------------------------------------
  // Segments come from the Worker, which builds them with the SAME function
  // CallSession uses for session.update.instructions. Nothing here re-derives
  // the prompt, so this panel cannot drift from what is actually dialed.
  const scriptNode = byId('script-preview');
  const voicemailToggle = byId('script-voicemail');
  let scriptTimer = 0;
  const SEGMENT_LABEL = {
    identity: 'Fixed',
    preamble: 'Fixed',
    guardrails: 'Guardrail',
    keypad: 'Keypad',
    availability: 'Calendar',
    heading: 'Fixed',
    operator: 'Your task',
    voicemail: 'If voicemail'
  };
  const renderScript = (segments) => {
    scriptNode.replaceChildren();
    for (const segment of segments) {
      if (!segment || segment.kind === 'blank' || !segment.text) continue;
      const row = document.createElement('div');
      row.className = 'script-seg';
      row.dataset.kind = String(segment.kind);
      const kind = document.createElement('span');
      kind.className = 'script-kind';
      kind.textContent = SEGMENT_LABEL[segment.kind] || String(segment.kind);
      const text = document.createElement('p');
      // textContent, never innerHTML: this is the operator's own bytes coming
      // back from the server, and the page has no HTML-sanitising layer.
      text.textContent = String(segment.text);
      row.append(kind, text);
      scriptNode.appendChild(row);
    }
  };
  const fetchScript = async () => {
    try {
      const calcomSlug = byId('call-calcom-slug').value.trim();
      const windowDaysRaw = byId('call-window-days').value;
      const slotMinutesRaw = byId('call-slot-minutes').value;
      const windowDays = windowDaysRaw ? parseInt(windowDaysRaw, 10) : undefined;
      const slotMinutes = slotMinutesRaw ? parseInt(slotMinutesRaw, 10) : undefined;
      
      const body = await jsonApi('/api/console/script-preview', {
        method: 'POST',
        body: JSON.stringify({
          task: byId('call-task').value,
          voicemail: voicemailToggle.checked,
          calcomEventTypeSlug: calcomSlug || undefined,
          windowDays: Number.isFinite(windowDays) ? windowDays : undefined,
          slotMinutes: Number.isFinite(slotMinutes) ? slotMinutes : undefined,
        })
      });
      renderScript(body && Array.isArray(body.segments) ? body.segments : []);
    } catch (error) {
      scriptNode.replaceChildren();
      const failed = document.createElement('p');
      failed.className = 'empty';
      failed.textContent = error instanceof Error ? error.message : 'preview unavailable';
      scriptNode.appendChild(failed);
    }
  };
  const refreshScript = () => {
    window.clearTimeout(scriptTimer);
    scriptTimer = window.setTimeout(fetchScript, 250);
  };

  // --- Saved presets ----------------------------------------------------------
  const presetSelect = byId('preset-select');
  const presetName = byId('preset-name');
  const presetPath = (name) => '/api/console/presets/' + encodeURIComponent(name);
  const loadPresetList = async (selectName) => {
    try {
      const body = await jsonApi('/api/console/presets');
      const rows = body && Array.isArray(body.presets) ? body.presets : [];
      presetSelect.replaceChildren();
      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = rows.length === 0 ? 'No presets saved' : 'Select a preset';
      presetSelect.appendChild(blank);
      for (const row of rows) {
        const option = document.createElement('option');
        option.value = String(row.name);
        // A preset name is operator input that is rendered back here.
        option.textContent = String(row.name);
        presetSelect.appendChild(option);
      }
      if (selectName) presetSelect.value = selectName;
    } catch (error) {
      presetSelect.replaceChildren();
      const option = document.createElement('option');
      option.value = '';
      option.textContent = error instanceof Error ? error.message : 'presets unavailable';
      presetSelect.appendChild(option);
    }
  };
  byId('preset-save').addEventListener('click', async () => {
    const name = presetName.value.trim();
    const task = byId('call-task').value.trim();
    if (name.length === 0) { notice('Name the preset before saving.', 'bad'); return; }
    if (task.length === 0) { notice('The task is empty.', 'bad'); return; }
    try {
      await jsonApi(presetPath(name), { method: 'PUT', body: JSON.stringify({ task: task }) });
      notice('Preset saved.', 'good');
      await loadPresetList(name);
    } catch (error) {
      notice(error instanceof Error ? error.message : 'could not save preset', 'bad');
    }
  });
  byId('preset-load').addEventListener('click', async () => {
    const name = presetSelect.value;
    if (!name) { notice('Select a preset to load.', 'bad'); return; }
    try {
      const body = await jsonApi(presetPath(name));
      byId('call-task').value = body && typeof body.task === 'string' ? body.task : '';
      presetName.value = name;
      refreshScript();
      notice('Preset loaded.', 'good');
    } catch (error) {
      notice(error instanceof Error ? error.message : 'could not load preset', 'bad');
    }
  });
  byId('preset-delete').addEventListener('click', async () => {
    const name = presetSelect.value;
    if (!name) { notice('Select a preset to delete.', 'bad'); return; }
    try {
      await jsonApi(presetPath(name), { method: 'DELETE' });
      notice('Preset deleted.', 'good');
      await loadPresetList();
    } catch (error) {
      notice(error instanceof Error ? error.message : 'could not delete preset', 'bad');
    }
  });

  // --- Dictation --------------------------------------------------------------
  // Matches the server's MAX_AUDIO_SECONDS. Stopping here makes the ceiling
  // visible instead of letting the operator talk into a request that will 413.
  const MAX_DICTATION_SECONDS = 120;
  let recorder = null;
  let recorderStream = null;
  let recordChunks = [];
  let recordStopTimer = 0;
  const dictateButton = byId('dictate');
  const dictateState = byId('dictate-state');
  const releaseMic = () => {
    if (recorderStream) {
      // Stopping the tracks is what clears the browser's recording indicator.
      for (const track of recorderStream.getTracks()) track.stop();
      recorderStream = null;
    }
    window.clearTimeout(recordStopTimer);
    recorder = null;
    dictateButton.dataset.recording = 'false';
    dictateButton.textContent = 'Dictate';
  };
  const appendDictation = (text) => {
    const box = byId('call-task');
    const existing = box.value.trim();
    // APPEND, never replace. The operator may have already typed part of the
    // task; replacing would destroy work with no undo, while an unwanted
    // append is one selection away from being removed.
    box.value = existing.length > 0 ? existing + ' ' + text : text;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
    refreshScript();
  };
  const sendRecording = async (blob) => {
    if (blob.size === 0) { notice('Nothing was recorded.', 'bad'); return; }
    dictateState.textContent = 'transcribing';
    try {
      const response = await fetch('/api/console/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': blob.type || 'audio/webm' },
        body: blob
      });
      let body = null;
      try { body = await response.json(); } catch (_) { body = null; }
      if (!response.ok) {
        throw new Error(body && typeof body.error === 'string' ? body.error : 'transcription failed');
      }
      appendDictation(String(body.text));
      notice('Transcript added to the task.', 'good');
    } catch (error) {
      notice(error instanceof Error ? error.message : 'transcription failed', 'bad');
    } finally {
      dictateState.textContent = '';
    }
  };
  dictateButton.addEventListener('click', async () => {
    if (recorder) { recorder.stop(); return; }
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function' || typeof MediaRecorder === 'undefined') {
      notice('This browser cannot record audio.', 'bad');
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      // Each of these is a different thing for the operator to DO about it, so
      // they get different messages rather than one generic failure.
      const name = error && error.name ? error.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        notice('Microphone permission was denied. Allow it for this site, then try again.', 'bad');
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        notice('No microphone was found.', 'bad');
      } else if (name === 'NotReadableError') {
        notice('The microphone is in use by another application.', 'bad');
      } else {
        notice('Could not open the microphone: ' + (name || 'unknown error'), 'bad');
      }
      return;
    }
    recorderStream = stream;
    recordChunks = [];
    try {
      // No mimeType is forced: Chrome picks audio/webm;codecs=opus and Safari
      // picks audio/mp4, and the model was verified to decode both.
      recorder = new MediaRecorder(stream);
    } catch (_) {
      releaseMic();
      notice('This browser cannot record audio.', 'bad');
      return;
    }
    const mimeType = recorder.mimeType || 'audio/webm';
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size > 0) recordChunks.push(event.data);
    });
    recorder.addEventListener('stop', () => {
      const blob = new Blob(recordChunks, { type: mimeType });
      releaseMic();
      sendRecording(blob);
    });
    recorder.start();
    dictateButton.dataset.recording = 'true';
    dictateButton.textContent = 'Stop dictation';
    notice('Recording. Press stop when finished.', 'neutral');
    recordStopTimer = window.setTimeout(() => { if (recorder) recorder.stop(); }, MAX_DICTATION_SECONDS * 1000);
  });

  byId('call-task').addEventListener('input', refreshScript);
  voicemailToggle.addEventListener('change', fetchScript);
  byId('call-calcom-slug').addEventListener('input', refreshScript);
  byId('call-window-days').addEventListener('input', refreshScript);
  byId('call-slot-minutes').addEventListener('input', refreshScript);

  startButton.addEventListener('click', async () => {
    if (!byId('recording-consent').checked) {
      notice('Confirm monitoring and recording authority before starting.', 'bad');
      return;
    }
    let participants;
    try {
      participants = parseParticipants(byId('call-participants').value);
    } catch (error) {
      notice(error instanceof Error ? error.message : 'invalid participant', 'bad');
      return;
    }
    startButton.disabled = true;
    const runAtRaw = byId('call-run-at').value;
    const runAt = runAtRaw ? new Date(runAtRaw).getTime() : undefined;
    const calcomSlug = byId('call-calcom-slug').value.trim();
    const windowDaysRaw = byId('call-window-days').value;
    const slotMinutesRaw = byId('call-slot-minutes').value;
    const windowDays = windowDaysRaw ? parseInt(windowDaysRaw, 10) : undefined;
    const slotMinutes = slotMinutesRaw ? parseInt(slotMinutesRaw, 10) : undefined;
    notice(Number.isFinite(runAt) ? 'Scheduling…' : 'Requesting Telnyx call…', 'neutral');
    try {
      const body = await jsonApi('/api/console/calls', {
        method: 'POST',
        body: JSON.stringify({
          to: byId('call-to').value,
          // Omitted rather than sent empty: the schema treats absent as "derive
          // one from the task", and '' would fail its min-length check.
          subject: byId('call-subject').value.trim() || undefined,
          task: byId('call-task').value,
          voice: byId('call-voice').value || undefined,
          amd: byId('call-amd').value || undefined,
          recording: byId('call-recording').value || undefined,
          notice: byId('call-notice').value !== 'off',
          // Omitted when empty for the same reason subject is: the schema
          // treats absent as "nobody else", and [] would be a list of zero.
          participants: participants.length > 0 ? participants : undefined,
          calcomEventTypeSlug: calcomSlug || undefined,
          windowDays: Number.isFinite(windowDays) ? windowDays : undefined,
          slotMinutes: Number.isFinite(slotMinutes) ? slotMinutes : undefined,
          runAt: Number.isFinite(runAt) ? runAt : undefined,
          recordingNoticeAcknowledged: true
        })
      });
      if (body.status === 'scheduled') {
        notice('Scheduled.', 'good');
        startButton.disabled = false;
        loadSchedules();
        return;
      }
      activeCallId = body.callId;
      selectedCallId = body.callId;
      terminalPollsRemaining = 120;
      callIdNode.textContent = activeCallId;
      monitorButton.disabled = true;
      hangupButton.disabled = false;
      window.clearTimeout(pollTimer);
      await poll();
      loadLiveCalls(); // Refresh live calls list
    } catch (error) {
      notice(error instanceof Error ? error.message : 'call request failed', 'bad');
      startButton.disabled = false;
    }
  });
  hangupButton.addEventListener('click', async () => {
    if (!selectedCallId) return;
    hangupButton.disabled = true;
    try {
      await jsonApi('/api/console/calls/' + encodeURIComponent(selectedCallId) + '/hangup', { method: 'POST' });
      stopMonitor();
      await poll();
      loadLiveCalls(); // Refresh live calls list
    } catch (error) {
      notice(error instanceof Error ? error.message : 'hangup failed', 'bad');
      hangupButton.disabled = false;
    }
  });
  participantAddButton.addEventListener('click', async () => {
    if (!activeCallId) {
      notice('Start or open a call first.', 'bad');
      return;
    }
    const toNode = byId('participant-to');
    const labelNode = byId('participant-label');
    const roleNode = byId('participant-role');
    const to = toNode.value.trim();
    if (!to) {
      notice('Enter a number to add.', 'bad');
      return;
    }
    if (!E164.test(to)) {
      notice(to + ' is not E.164, e.g. +14155550123', 'bad');
      return;
    }
    participantAddButton.disabled = true;
    notice('Dialing ' + to + '…', 'neutral');
    try {
      await jsonApi('/api/console/calls/' + encodeURIComponent(activeCallId) + '/participants', {
        method: 'POST',
        // Omitted rather than sent empty: the schema treats an absent label as
        // "no name", and '' would be a name of zero characters.
        // The role is always sent: the select has a real value in every state,
        // so there is no "absent" to mean anything different from 'barge'.
        body: JSON.stringify({ to, label: labelNode.value.trim() || undefined, supervisorRole: roleNode.value })
      });
      toNode.value = '';
      labelNode.value = '';
      await poll();
    } catch (error) {
      notice(error instanceof Error ? error.message : 'could not add participant', 'bad');
    } finally {
      // poll() -> renderStatus -> renderParticipants owns the enabled state, but
      // a FAILED add never reaches it, so the button is restored here too or one
      // rejected number would leave the panel permanently dead.
      participantAddButton.disabled = false;
    }
  });
  monitorButton.addEventListener('click', startMonitor);
  byId('stop-monitor').addEventListener('click', stopMonitor);
  const scheduleList = byId('schedule-list');
  const loadSchedules = async () => {
    try {
      const body = await jsonApi('/api/console/schedules');
      const rows = Array.isArray(body && body.schedules) ? body.schedules : [];
      scheduleList.replaceChildren();
      if (rows.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = 'None.';
        scheduleList.appendChild(empty);
        return;
      }
      rows.forEach((job) => {
        if (!job || typeof job.id !== 'string') return;
        const row = document.createElement('div');
        row.className = 'schedule-row';
        const title = document.createElement('span');
        title.className = 'calllog-subject';
        title.textContent = (typeof job.subject === 'string' && job.subject.trim()) ? job.subject.trim() : String(job.to || '');
        const meta = document.createElement('span');
        meta.className = 'calllog-meta';
        // Rendered in the job's OWN zone, with the zone named. A bare
        // toLocaleString() shows the VIEWER's zone, so the same 2pm job reads
        // as 2pm in California and 5pm in New York and neither reader can tell
        // which was meant. An unusable stored zone falls back to the viewer's
        // rather than throwing the whole list away.
        let when = '';
        if (typeof job.runAt === 'number') {
          const zone = typeof job.timeZone === 'string' && job.timeZone ? job.timeZone : undefined;
          try {
            when = new Date(job.runAt).toLocaleString(undefined, { timeZone: zone, dateStyle: 'medium', timeStyle: 'short', timeZoneName: 'short' });
          } catch (error) {
            when = new Date(job.runAt).toLocaleString();
          }
        }
        meta.textContent = String(job.status || '').toUpperCase() + (when ? '  ' + when : '');
        row.append(title, meta);
        // The refusal reasons (too late, outside calling hours, claim
        // stranded) are otherwise invisible: the row would say FAILED and the
        // operator would have to read Worker logs to learn the call never went.
        if (job.status === 'failed' && typeof job.failedDetail === 'string' && job.failedDetail) {
          const why = document.createElement('span');
          why.className = 'calllog-meta';
          why.textContent = job.failedDetail;
          row.appendChild(why);
        }
        if (job.status === 'pending') {
          const cancel = document.createElement('button');
          cancel.className = 'button quiet';
          cancel.type = 'button';
          cancel.textContent = 'Cancel';
          cancel.addEventListener('click', async () => {
            try {
              await jsonApi('/api/console/schedules/' + encodeURIComponent(job.id), { method: 'DELETE' });
              loadSchedules();
            } catch (error) {
              notice(error instanceof Error ? error.message : 'cancel failed', 'bad');
            }
          });
          row.appendChild(cancel);
        }
        scheduleList.appendChild(row);
      });
    } catch (error) {
      scheduleList.replaceChildren();
      const failed = document.createElement('p');
      failed.className = 'empty';
      failed.textContent = error instanceof Error ? error.message : 'unavailable';
      scheduleList.appendChild(failed);
    }
  };
  byId('schedule-refresh').addEventListener('click', () => { loadSchedules(); });
  byId('calllog-refresh').addEventListener('click', () => { loadCallLog(false); });
  costWindowNode.addEventListener('change', () => { loadCosts(); });
  byId('cost-refresh').addEventListener('click', () => { loadCosts(); });
  loadCosts();
  moreButton.addEventListener('click', () => { loadCallLog(true); });
  byId('logout').addEventListener('click', async () => {
    try { await fetch('/api/auth/sign-out', { method: 'POST' }); } finally { location.reload(); }
  });
  renderTranscript([]);
  renderRecordings([]);
  renderParticipants([], null);
  loadCallLog(false);
  loadSchedules();
  loadPresetList();
  fetchScript();
  loadLiveCalls(); // Start live calls polling
})();
`;

export function renderConsolePage(
  nonce: string,
  mode: ConsolePageMode,
  user: OperatorUser | null = null,
): string {
  const safeNonce = nonceValue(nonce);
  const safeName = user ? escapeHtml(user.name) : '';
  const configMessage =
    'Console auth is not configured. Provision the DB binding and Better Auth secrets before use.';
  const headerUser =
    mode === 'authorized'
      ? `<span class="operator-name">${safeName}</span><button id="logout" class="button quiet" type="button">Sign out</button>`
      : '';
  const body =
    mode === 'authorized'
      ? `<main class="workspace" aria-label="Operator workspace">
  <section class="utility-bar">
    <div><span class="eyebrow">CALL CONTROL</span><h1>Grok voice bridge</h1></div>
    <div class="operator-block">${headerUser}</div>
  </section>
  <section class="status-strip" aria-label="Call status">
    <div><span class="label">PHASE</span><strong id="phase" data-phase="idle">IDLE</strong></div>
    <div><span class="label">DIRECTION</span><strong id="direction">—</strong></div>
    <div><span class="label">DESTINATION</span><strong id="destination">—</strong></div>
    <div><span class="label">AMD</span><strong id="amd">—</strong></div>
    <div><span class="label">UPDATED</span><strong id="updated">—</strong></div>
  </section>
  <div id="call-subject-view" class="subject-view" hidden><span class="label" id="subject-label">SUBJECT</span><strong id="subject-line">—</strong><details id="task-view"><summary>Task</summary><p id="task-text"></p></details></div>
  <div id="console-status" class="status-line" data-tone="neutral" role="status">Ready for an operator call.</div>
  <section class="workspace-grid">
    <div class="column column-primary">
      <section class="panel command-panel">
        <div class="panel-heading"><div><span class="eyebrow">01 / COMMAND</span><h2>Start a call</h2></div><span class="panel-code">TELNYX → xAI</span></div>
        <label for="call-to">Destination</label><input id="call-to" type="tel" inputmode="tel" pattern="${E164_PATTERN}" autocomplete="off" placeholder="+14155550123">
        <label for="call-subject">Subject</label><input id="call-subject" maxlength="120" autocomplete="off" placeholder="Who or what this call is about">
        <label for="call-task">Operator task</label><textarea id="call-task" rows="5" maxlength="16000" placeholder="Describe what the agent should accomplish."></textarea>
        <div class="button-row"><button id="dictate" class="button" type="button">Dictate</button><span id="dictate-state" class="dictate-state"></span></div>
        <div class="field-row"><div><label for="preset-select">Presets</label><select id="preset-select"></select></div><div><label for="preset-name">Preset name</label><input id="preset-name" maxlength="64" autocomplete="off" spellcheck="false"></div></div>
        <div class="button-row"><button id="preset-load" class="button quiet" type="button">Load</button><button id="preset-save" class="button quiet" type="button">Save</button><button id="preset-delete" class="button quiet" type="button">Delete</button></div>
        <div class="field-row"><div><label for="call-voice">Voice</label><input id="call-voice" value="liora" maxlength="64"></div><div><label for="call-amd">AMD</label><select id="call-amd"><option value="detect">detect</option><option value="disabled">disabled</option><option value="detect_beep">detect_beep</option><option value="premium">premium</option></select></div></div><div class="field-row"><div><label for="call-recording">Recording</label><select id="call-recording"><option value="on_demand">Press 9 to start</option><option value="auto">Record whole call</option><option value="off">Never record</option></select></div><div><label for="call-notice">Spoken notice</label><select id="call-notice"><option value="on">On</option><option value="off">Off</option></select></div></div>
        <label for="call-participants">Conference in</label><input id="call-participants" inputmode="tel" autocomplete="off" placeholder="+14155550123, +14155550124">
        <label for="call-calcom-slug">Cal.com event type (optional)</label><input id="call-calcom-slug" maxlength="128" autocomplete="off" spellcheck="false" placeholder="your-username/30min">
        <div class="field-row"><div><label for="call-window-days">Availability window</label><input id="call-window-days" type="number" min="1" max="30" placeholder="7 days"></div><div><label for="call-slot-minutes">Slot duration</label><input id="call-slot-minutes" type="number" min="5" max="480" placeholder="30 min"></div></div>
        <label for="call-run-at">Run at</label><input id="call-run-at" type="datetime-local">
        <label class="consent"><input id="recording-consent" type="checkbox"><span>I confirm I have authority to monitor and record this call.</span></label>
        <div class="button-row"><button id="start-call" class="button primary" type="button">Start call</button><button id="hangup-call" class="button danger" type="button" disabled>Hang up</button></div>
        <p class="fine-print">Recording is requested in dual-channel WAV by default. Playback appears after Telnyx reports the saved asset.</p>
      </section>
      <section class="panel script-panel">
        <div class="panel-heading"><div><span class="eyebrow">02 / SCRIPT</span><h2>Prompt as sent</h2></div><label class="script-toggle"><input id="script-voicemail" type="checkbox"><span>Voicemail</span></label></div>
        <div id="script-preview" class="script" aria-live="polite"></div>
        <p class="fine-print">Read-only. The Worker composes this; the browser cannot submit instructions.</p>
      </section>
      <section class="panel transcript-panel"><div class="panel-heading"><div><span class="eyebrow">03 / TRANSCRIPT</span><h2>Live conversation</h2></div><span class="panel-code" id="call-id">NO CALL</span></div><div id="transcript" class="transcript" aria-live="polite"></div></section>
      <section class="panel participants-panel"><div class="panel-heading"><div><span class="eyebrow">09 / PARTICIPANTS</span><h2>Conference</h2></div><span class="panel-code" id="participant-count">0</span></div><div class="field-row"><div><label for="participant-to">Add number</label><input id="participant-to" type="tel" inputmode="tel" pattern="${E164_PATTERN}" autocomplete="off" placeholder="+14155550123"></div><div><label for="participant-label">Name</label><input id="participant-label" maxlength="60" autocomplete="off" placeholder="Optional"></div></div><label for="participant-role">Role</label><select id="participant-role"><option value="barge">Speaking participant</option><option value="monitor">Listen only</option><option value="whisper">Whisper to the person you called</option></select><div class="button-row"><button id="participant-add" class="button" type="button" disabled>Add to call</button></div><div id="participants" class="participants"></div><p class="fine-print">Everyone on the call hears a spoken notice naming each person as they join. Whisper is heard only by the person you called; with nobody to whisper to it becomes listen-only.</p></section>
    </div>
    <div class="column column-secondary">
      <section class="panel live-calls-panel"><div class="panel-heading"><div><span class="eyebrow">00 / LIVE</span><h2>Active calls</h2></div><span class="panel-code" id="live-count">0</span></div><div id="live-calls" class="live-calls"></div><p class="fine-print">Select a call to view details. Start button enabled when under concurrent limit.</p></section>
      <section class="panel monitor-panel"><div class="panel-heading"><div><span class="eyebrow">04 / MONITOR</span><h2>Both tracks</h2></div><span class="signal" id="monitor-connection">OFFLINE</span></div><div class="technical-grid"><div><span class="label">RELAY</span><strong id="monitor-state">—</strong></div><div><span class="label">CODEC</span><strong id="codec-state">—</strong></div></div><div class="track-bars"><div><span>INBOUND</span><i></i></div><div><span>OUTBOUND</span><i></i></div></div><div class="button-row"><button id="monitor-call" class="button primary" type="button" disabled>Monitor live</button><button id="stop-monitor" class="button quiet" type="button">Stop monitor</button></div><p class="fine-print">Monitor is receive-only. Browser audio is never sent to Telnyx or xAI.</p></section>
      <section class="panel recording-panel"><div class="panel-heading"><div><span class="eyebrow">05 / RECORDINGS</span><h2>Post-call audio</h2></div><span class="panel-code">WAV / MP3</span></div><div id="recordings" class="recordings"></div><p class="fine-print">Assets are proxied through the authenticated console. Provider URLs are not exposed to the browser.</p><div id="call-cost" class="call-cost"></div></section>
      <section class="panel calllog-panel"><div class="panel-heading"><div><span class="eyebrow">06 / CALL LOG</span><h2>Past calls</h2></div><button id="calllog-refresh" class="button quiet" type="button">Refresh</button></div><div id="calllog" class="calllog"></div><div class="button-row"><button id="calllog-more" class="button quiet" type="button" disabled>Load more</button></div></section>
      <section class="panel schedule-panel"><div class="panel-heading"><div><span class="eyebrow">08 / SCHEDULED</span><h2>Scheduled</h2></div><button id="schedule-refresh" class="button quiet" type="button">Refresh</button></div><div id="schedule-list" class="calllog"></div></section>
      <section class="panel cost-panel"><div class="panel-heading"><div><span class="eyebrow">07 / SPEND</span><h2>Estimated cost</h2></div><button id="cost-refresh" class="button quiet" type="button">Refresh</button></div><label for="cost-window">Period</label><select id="cost-window"><option value="day">Today</option><option value="week">This week</option><option value="month" selected>This month</option><option value="year">This year</option></select><div id="cost-series" class="cost-series"></div><div id="cost-summary" class="cost-summary"></div></section>
    </div>
  </section>
  <footer class="footer-note">Operator surface · explicit consent required · monitor-only media path</footer>
</main>`
      : `<main class="login-shell"><section class="login-panel"><span class="eyebrow">PRIVATE OPERATOR SURFACE</span><h1>Grok voice bridge</h1><p>Call control, transcript telemetry, and receive-only monitoring for the active bridge.</p>${mode === 'config_error' ? `<p class="config-warning">${configMessage}</p>` : '<p>Sign in with the authorized Google account to continue.</p>'}<button id="google-login" class="button primary" type="button"${mode === 'config_error' ? ' disabled' : ''}>Continue with Google</button><div id="console-status" class="status-line" data-tone="neutral" role="status">Sign-in is ready.</div><p class="fine-print">Only the configured operator account is admitted. This surface is not a public signup.</p></section></main>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${safeNonce}'; style-src 'nonce-${safeNonce}'; img-src 'self' data:; connect-src 'self'; media-src 'self'; base-uri 'none'; form-action 'self'; object-src 'none'"><link rel="icon" type="image/svg+xml" href="${FAVICON_DATA_URI}"><title>Grok voice bridge · operator</title><style nonce="${safeNonce}">
:root{--paper:oklch(20% .025 92);--paper-deep:oklch(15% .02 92);--panel:oklch(24% .03 94);--panel-hot:oklch(28% .035 94);--ink:oklch(90% .025 90);--muted:oklch(67% .035 90);--line:oklch(43% .035 92);--line-soft:oklch(33% .03 92);--accent:oklch(77% .13 74);--accent-deep:oklch(48% .1 68);--good:oklch(74% .12 150);--bad:oklch(70% .15 28);--serif:"Iowan Old Style","Palatino Linotype",Georgia,serif;--mono:"IBM Plex Mono","SFMono-Regular",Menlo,Monaco,monospace}*{box-sizing:border-box}html{min-width:320px;background:var(--paper-deep)}body{margin:0;background:var(--paper-deep);color:var(--ink);font-family:var(--mono);font-size:13px;line-height:1.5}button,input,select,textarea{font:inherit}button{cursor:pointer}button:disabled{cursor:not-allowed;opacity:.45}.workspace,.login-shell{width:min(1500px,100%);margin:0 auto;padding:22px clamp(16px,3vw,44px) 34px}.utility-bar,.status-strip,.workspace-grid{display:grid;gap:12px}.utility-bar{grid-template-columns:1fr auto;align-items:end;border-bottom:1px solid var(--line);padding-bottom:15px}.eyebrow,.label,.panel-code,.signal{display:block;color:var(--muted);font-size:10px;letter-spacing:.12em;text-transform:uppercase}.utility-bar h1,.login-panel h1{margin:3px 0 0;font-family:var(--serif);font-size:clamp(25px,4vw,42px);font-weight:500;letter-spacing:-.02em}.operator-block{display:flex;align-items:center;gap:14px;color:var(--muted)}.operator-name{color:var(--ink)}.status-strip{grid-template-columns:repeat(5,1fr);margin:14px 0;border-bottom:1px solid var(--line);border-top:1px solid var(--line);background:var(--panel);padding:9px 12px}.status-strip strong,.technical-grid strong{display:block;margin-top:2px;color:var(--ink);font-size:12px;letter-spacing:.05em;text-transform:uppercase}.status-strip strong[data-phase="bridged"]{color:var(--good)}.status-strip strong[data-phase="failed"]{color:var(--bad)}.subject-view{border-left:3px solid var(--accent);background:var(--panel);margin-bottom:14px;padding:8px 11px}.subject-view strong{display:block;margin-top:2px;color:var(--ink);font-family:var(--serif);font-size:17px;font-weight:500;overflow-wrap:anywhere}.subject-view details{margin-top:7px}.subject-view summary{color:var(--muted);cursor:pointer;font-size:10px;letter-spacing:.12em;text-transform:uppercase}.subject-view p{margin:7px 0 0;max-height:220px;overflow:auto;color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere}.status-line{min-height:26px;border-left:3px solid var(--line);padding:4px 9px;margin-bottom:14px;color:var(--muted)}.status-line[data-tone="good"]{border-color:var(--good);color:var(--good)}.status-line[data-tone="bad"]{border-color:var(--bad);color:var(--bad)}.workspace-grid{grid-template-columns:minmax(0,1.25fr) minmax(300px,.75fr);align-items:start}.column{display:grid;gap:12px}.panel{border:1px solid var(--line);background:var(--panel);padding:16px}.panel-heading{display:flex;align-items:start;justify-content:space-between;gap:12px;border-bottom:1px solid var(--line-soft);margin-bottom:15px;padding-bottom:10px}.panel h2{margin:2px 0 0;font-family:var(--serif);font-size:23px;font-weight:500}.panel-code,.signal{padding-top:2px;text-align:right}.signal{color:var(--muted)}label{display:block;margin:11px 0 5px;color:var(--muted);font-size:11px;letter-spacing:.08em;text-transform:uppercase}input,textarea,select{width:100%;border:1px solid var(--line);border-radius:0;background:var(--paper-deep);color:var(--ink);padding:9px 10px;outline:none}textarea{resize:vertical;min-height:120px}input:focus,textarea:focus,select:focus{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent-deep)}.field-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}.consent{display:flex;align-items:start;gap:9px;margin-top:15px;color:var(--ink);text-transform:none;letter-spacing:0}.consent input{width:auto;margin-top:3px;accent-color:var(--accent)}.button-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}.button{border:1px solid var(--line);border-radius:0;background:transparent;color:var(--ink);padding:8px 12px;letter-spacing:.08em;text-transform:uppercase;font-size:11px}.button:hover:not(:disabled){border-color:var(--accent);color:var(--accent)}.button.primary{border-color:var(--accent-deep);background:var(--accent-deep);color:var(--ink)}.button.primary:hover:not(:disabled){background:var(--accent);border-color:var(--accent);color:var(--paper-deep)}.button.danger{border-color:var(--bad);color:var(--bad)}.button.quiet{color:var(--muted)}.fine-print{margin:12px 0 0;color:var(--muted);font-size:11px}.transcript{height:410px;overflow:auto;background:var(--paper-deep);border:1px solid var(--line-soft)}.transcript-row{display:grid;grid-template-columns:126px 1fr;gap:12px;border-bottom:1px solid var(--line-soft);padding:10px}.transcript-meta{color:var(--accent);font-size:10px;letter-spacing:.07em}.transcript-row p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.empty{color:var(--muted);padding:12px}.technical-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;border-bottom:1px solid var(--line-soft);padding-bottom:13px}.track-bars{display:grid;gap:13px;margin:16px 0}.track-bars div{display:grid;grid-template-columns:86px 1fr;align-items:center;gap:10px;color:var(--muted);font-size:10px;letter-spacing:.1em}.track-bars i{display:block;height:7px;border:1px solid var(--line);background:var(--paper-deep);position:relative}.track-bars i:after{content:"";display:block;width:32%;height:100%;background:var(--accent-deep)}.recordings{display:grid;gap:12px}.recording-item{display:grid;gap:7px;border-bottom:1px solid var(--line-soft);padding-bottom:11px;color:var(--accent);font-size:11px;letter-spacing:.08em}.recording-item audio{width:100%;height:32px}.script{max-height:420px;overflow:auto;border:1px solid var(--line-soft);background:var(--paper-deep);padding:4px 0}.script-seg{display:grid;grid-template-columns:96px 1fr;gap:10px;border-left:3px solid var(--line);padding:7px 10px}.script-seg[data-kind="operator"]{border-left-color:var(--accent);background:var(--panel-hot)}.script-seg[data-kind="voicemail"]{border-left-color:var(--bad)}.script-seg[data-kind="availability"]{border-left-color:var(--good)}.script-kind{color:var(--muted);font-size:10px;letter-spacing:.09em;text-transform:uppercase;padding-top:2px}.script-seg[data-kind="operator"] .script-kind{color:var(--accent)}.script-seg p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.script-seg[data-kind="operator"] p{color:var(--ink)}.script-seg:not([data-kind="operator"]) p{color:var(--muted)}.script-toggle{display:flex;align-items:center;gap:7px;margin:0;color:var(--muted);font-size:10px;letter-spacing:.1em;text-transform:uppercase}.script-toggle input{width:auto;accent-color:var(--accent)}.dictate-state{align-self:center;color:var(--muted);font-size:11px;letter-spacing:.06em}#dictate[data-recording="true"]{border-color:var(--bad);color:var(--bad)}.calllog{max-height:300px;overflow:auto;border:1px solid var(--line-soft);background:var(--paper-deep)}.calllog-row{display:grid;grid-template-columns:1fr;gap:2px;width:100%;border:0;border-bottom:1px solid var(--line-soft);border-left:3px solid var(--line);background:transparent;color:var(--ink);font:inherit;padding:9px 10px;text-align:left}.calllog-row:hover{border-left-color:var(--accent);background:var(--panel-hot)}.calllog-row[data-phase="failed"]{border-left-color:var(--bad)}.calllog-row[data-phase="completed"]{border-left-color:var(--good)}.calllog-when{color:var(--accent);font-size:10px;letter-spacing:.07em}.calllog-subject{color:var(--ink);overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.calllog-who{color:var(--muted);overflow-wrap:anywhere}.calllog-meta{color:var(--muted);font-size:10px;letter-spacing:.08em}.schedule-row{display:grid;gap:4px;border-bottom:1px solid var(--line-soft);padding:9px 10px}.schedule-row .button{width:auto;justify-self:start}.participants{display:grid;gap:0;border:1px solid var(--line-soft);background:var(--paper-deep)}.participant-row{display:grid;grid-template-columns:1fr auto;align-items:center;gap:4px 10px;border-bottom:1px solid var(--line-soft);border-left:3px solid var(--line);padding:9px 10px}.participant-row[data-status="joined"]{border-left-color:var(--good)}.participant-row[data-status="failed"]{border-left-color:var(--bad)}.participant-row[data-status="left"]{opacity:.55}.participant-who{grid-column:1;color:var(--ink);overflow-wrap:anywhere}.participant-meta{grid-column:1;color:var(--muted);font-size:10px;letter-spacing:.08em;text-transform:uppercase}.participant-actions{grid-column:2;grid-row:1/3;display:flex;gap:6px}.participant-actions .button{padding:4px 8px}.transport{display:grid;grid-template-columns:1fr auto;align-items:center;gap:8px 12px;margin-top:6px}.transport-bar{grid-column:1;height:10px;border:1px solid var(--line);background:var(--paper-deep);cursor:pointer;position:relative}.transport-bar:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.transport-bar[data-seekable="no"]{cursor:not-allowed;opacity:.5}.transport-bar i{display:block;height:100%;width:0;background:var(--accent-deep)}.transport-time{grid-column:2;color:var(--muted);font-size:11px;letter-spacing:.06em;white-space:nowrap}.transport-controls{grid-column:1/-1;display:flex;flex-wrap:wrap;align-items:center;gap:6px}.transport-controls .button{padding:4px 8px}.transport-speed{width:auto;padding:3px 6px;font-size:11px}.call-cost,.cost-summary{display:grid;gap:5px;margin-top:14px;border-top:1px solid var(--line-soft);padding-top:12px}.cost-total{display:flex;align-items:baseline;gap:9px;margin-bottom:6px}.cost-total strong{color:var(--accent);font-family:var(--serif);font-size:27px;font-weight:500;letter-spacing:-.01em}.cost-total span{color:var(--muted);font-size:10px;letter-spacing:.1em;text-transform:uppercase}.cost-line{display:flex;justify-content:space-between;gap:12px;color:var(--muted);font-size:11px}.cost-line strong{color:var(--ink);font-weight:400}.cost-forecast{border-top:1px solid var(--line-soft);margin-top:6px;padding-top:7px}.cost-forecast strong{color:var(--accent)}.cost-warn{color:var(--bad)}.cost-series{display:flex;align-items:flex-end;gap:2px;height:72px;margin-top:14px;border-bottom:1px solid var(--line);padding-bottom:1px}.cost-bar{flex:1 1 0;min-width:2px;background:var(--accent-deep);opacity:.75}.cost-bar:hover{opacity:1;background:var(--accent)}.footer-note{border-top:1px solid var(--line);color:var(--muted);font-size:10px;letter-spacing:.1em;margin-top:16px;padding-top:10px;text-transform:uppercase}.login-shell{display:grid;min-height:100vh;place-items:center}.login-panel{width:min(520px,100%);border:1px solid var(--line);background:var(--panel);padding:28px}.login-panel p{color:var(--muted);font-family:var(--serif);font-size:16px}.login-panel .button{width:100%;margin-top:14px}.config-warning{border-left:3px solid var(--bad);padding-left:10px;color:var(--bad)!important;font-family:var(--mono)!important;font-size:12px!important}@media(max-width:850px){.workspace-grid{grid-template-columns:1fr}.status-strip{grid-template-columns:repeat(2,1fr);row-gap:13px}.utility-bar{align-items:start}.transcript{height:300px}}@media(max-width:520px){.utility-bar{grid-template-columns:1fr}.operator-block{justify-content:space-between}.field-row{grid-template-columns:1fr}.transcript-row{grid-template-columns:1fr;gap:2px}}
</style></head><body>${body}<script nonce="${safeNonce}">${CONSOLE_SCRIPT}</script></body></html>`;
}
