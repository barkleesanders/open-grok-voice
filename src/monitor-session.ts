// A per-call Durable Object that owns the Telnyx media stream and browser
// monitor sockets. It is intentionally one-way: browser messages are rejected,
// so an operator can listen without injecting audio into a live call.

import type { Env } from './env';
import { errText, log } from './log';
import { type MediaTrack, type ParsedMediaEvent, parseMediaEvent, verifyMediaToken } from './media';

interface BrowserConnectedMessage {
  readonly type: 'connected';
}

interface BrowserStartMessage {
  readonly type: 'start';
  readonly codec: string;
  readonly sampleRate: number;
  readonly channels: number;
}

interface BrowserMediaMessage {
  readonly type: 'media';
  readonly track: MediaTrack;
  readonly chunk: number;
  readonly sequence: number | null;
  readonly timestamp: number | null;
  readonly payload: string;
}

interface BrowserStopMessage {
  readonly type: 'stop';
}

type BrowserMessage =
  | BrowserConnectedMessage
  | BrowserStartMessage
  | BrowserMediaMessage
  | BrowserStopMessage;

type MediaMessage = Extract<ParsedMediaEvent, { readonly kind: 'media' }>;

const MAX_PENDING_CHUNKS = 64;

async function textFromMessage(data: unknown): Promise<string | null> {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data.text();
  return null;
}

function isUpgrade(request: Request): boolean {
  return request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
}

export class MonitorSession {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;
  private readonly browserSockets = new Set<WebSocket>();
  private telnyxSocket: WebSocket | null = null;
  private closed = false;
  private readonly pending = new Map<MediaTrack, Map<number, MediaMessage>>();
  private readonly expected = new Map<MediaTrack, number>();
  private readonly chains = new Map<MediaTrack, Promise<void>>();
  private callIdValue: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case '/telnyx':
          return await this.acceptTelnyx(
            request,
            url.searchParams.get('token'),
            url.searchParams.get('callId'),
          );
        case '/browser':
          return await this.acceptBrowser(
            request,
            url.searchParams.get('token'),
            url.searchParams.get('callId'),
          );
        case '/close':
          await this.closeAll('call ended');
          return Response.json({ ok: true });
        default:
          return new Response('not found', { status: 404 });
      }
    } catch (err) {
      log('error', 'monitor.fetch.unhandled', { path: url.pathname, error: errText(err) });
      return Response.json({ error: 'internal error' }, { status: 500 });
    }
  }

  private async acceptTelnyx(
    request: Request,
    token: string | null,
    callId: string | null,
  ): Promise<Response> {
    if (!isUpgrade(request)) return new Response('websocket upgrade required', { status: 426 });
    if (
      !callId ||
      !(await verifyMediaToken(this.env.BETTER_AUTH_SECRET, token, callId, 'ingress'))
    ) {
      log('warn', 'monitor.telnyx.bad_token', { callId: callId ?? 'missing' });
      return new Response('unauthorized', { status: 401 });
    }
    this.callIdValue = callId;
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    if (this.telnyxSocket) {
      try {
        this.telnyxSocket.close(1000, 'replaced');
      } catch {
        // The provider may have already closed this stream.
      }
    }
    this.telnyxSocket = server;
    server.addEventListener('message', (event) => {
      void this.handleTelnyxMessage(server, event.data);
    });
    server.addEventListener('close', () => {
      if (this.telnyxSocket === server) this.telnyxSocket = null;
      this.broadcast({ type: 'stop' });
      log('info', 'monitor.telnyx.closed', { callId });
    });
    server.addEventListener('error', () => {
      log('warn', 'monitor.telnyx.error', { callId });
    });
    log('info', 'monitor.telnyx.accepted', { callId });
    return new Response(null, { status: 101, webSocket: client });
  }

  private async acceptBrowser(
    request: Request,
    token: string | null,
    callId: string | null,
  ): Promise<Response> {
    if (!isUpgrade(request)) return new Response('websocket upgrade required', { status: 426 });
    if (
      !callId ||
      !(await verifyMediaToken(this.env.BETTER_AUTH_SECRET, token, callId, 'browser'))
    ) {
      log('warn', 'monitor.browser.bad_token', { callId: callId ?? 'missing' });
      return new Response('unauthorized', { status: 401 });
    }
    this.callIdValue = callId;
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.browserSockets.add(server);
    server.addEventListener('message', (event) => {
      void this.rejectBrowserMessage(server, event.data);
    });
    server.addEventListener('close', () => {
      this.browserSockets.delete(server);
    });
    server.addEventListener('error', () => {
      this.browserSockets.delete(server);
      log('warn', 'monitor.browser.error', { callId });
    });
    log('info', 'monitor.browser.accepted', { callId, listeners: this.browserSockets.size });
    return new Response(null, { status: 101, webSocket: client });
  }

  private async rejectBrowserMessage(socket: WebSocket, data: unknown): Promise<void> {
    const size = (await textFromMessage(data))?.length ?? 0;
    log('warn', 'monitor.browser.ingress_rejected', { callId: this.callId(), size });
    try {
      socket.close(1008, 'monitor is receive-only');
    } catch {
      // The browser may already be gone.
    }
  }

  private async handleTelnyxMessage(socket: WebSocket, data: unknown): Promise<void> {
    if (this.closed || socket !== this.telnyxSocket) return;
    const raw = await textFromMessage(data);
    if (!raw) {
      log('warn', 'monitor.telnyx.non_text', { callId: this.callId() });
      return;
    }
    const event = parseMediaEvent(raw);
    if (!event) {
      log('warn', 'monitor.telnyx.unparseable', { callId: this.callId() });
      return;
    }
    switch (event.kind) {
      case 'connected':
        this.broadcast({ type: 'connected' });
        return;
      case 'start':
        this.broadcast({
          type: 'start',
          codec: event.codec,
          sampleRate: event.sampleRate,
          channels: event.channels,
        });
        return;
      case 'media':
        await this.enqueue(event);
        return;
      case 'stop':
        await this.flushAll();
        this.broadcast({ type: 'stop' });
        return;
      default: {
        const _never: never = event;
        return _never;
      }
    }
  }

  private enqueue(event: MediaMessage): Promise<void> {
    const previous = this.chains.get(event.track) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        const queue = this.pendingFor(event.track);
        queue.set(event.chunk, event);
        // Telnyx documents chunk as the per-track ordering key and starts it
        // at zero. Do not use the first received chunk as the baseline: the
        // provider may deliver chunk 7 before chunk 0.
        if (!this.expected.has(event.track)) this.expected.set(event.track, 0);
        await this.flushTrack(event.track, false);
      })
      .catch((err: unknown) => {
        log('warn', 'monitor.media.queue_failed', { callId: this.callId(), error: errText(err) });
      });
    this.chains.set(event.track, next);
    return next;
  }

  private pendingFor(track: MediaTrack): Map<number, MediaMessage> {
    const existing = this.pending.get(track);
    if (existing) return existing;
    const created = new Map<number, MediaMessage>();
    this.pending.set(track, created);
    return created;
  }

  private async flushTrack(track: MediaTrack, force: boolean): Promise<void> {
    const queue = this.pendingFor(track);
    let expected = this.expected.get(track);
    if (expected === undefined) return;
    while (queue.has(expected)) {
      const event = queue.get(expected);
      queue.delete(expected);
      if (event) this.broadcastMedia(event);
      expected += 1;
    }
    if (force || queue.size > MAX_PENDING_CHUNKS) {
      const chunks = [...queue.keys()].sort((a, b) => a - b);
      for (const chunk of chunks) {
        const event = queue.get(chunk);
        queue.delete(chunk);
        if (event) this.broadcastMedia(event);
        expected = chunk + 1;
      }
    }
    this.expected.set(track, expected);
  }

  private async flushAll(): Promise<void> {
    const chains = [...this.chains.values()];
    await Promise.all(chains);
    await Promise.all(
      (['inbound', 'outbound'] as const).map((track) => this.flushTrack(track, true)),
    );
  }

  private broadcastMedia(event: MediaMessage): void {
    this.broadcast({
      type: 'media',
      track: event.track,
      chunk: event.chunk,
      sequence: event.sequence,
      timestamp: event.timestamp,
      payload: event.payload,
    });
  }

  private broadcast(message: BrowserMessage): void {
    const encoded = JSON.stringify(message);
    for (const socket of this.browserSockets) {
      try {
        socket.send(encoded);
      } catch {
        this.browserSockets.delete(socket);
      }
    }
  }

  private async closeAll(reason: string): Promise<void> {
    this.closed = true;
    for (const socket of this.browserSockets) {
      try {
        socket.close(1000, reason);
      } catch {
        // The browser may already be gone.
      }
    }
    this.browserSockets.clear();
    if (this.telnyxSocket) {
      try {
        this.telnyxSocket.close(1000, reason);
      } catch {
        // The provider may already be gone.
      }
      this.telnyxSocket = null;
    }
    log('info', 'monitor.closed', { callId: this.callId(), reason });
  }

  private callId(): string {
    return this.callIdValue ?? this.ctx.id.toString();
  }
}
