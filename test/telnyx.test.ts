import { describe, expect, it } from 'vitest';
import { sendDtmf, startRecording, startStreaming, type TelnyxConfig } from '../src/telnyx';

const CONFIG: TelnyxConfig = {
  apiKey: 'telnyx-test-key',
  connectionId: 'connection-1',
  from: '+14155550123',
};

async function captureCommand(
  run: (fetchImpl: typeof fetch) => Promise<void>,
): Promise<{ request: Request; body: Record<string, unknown> }> {
  const requests: Request[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push(new Request(input, init));
    return new Response(null, { status: 200 });
  };
  await run(fetchImpl);
  const request = requests[0];
  if (!request) throw new Error('command did not issue a request');
  const body = (await request.clone().json()) as Record<string, unknown>;
  return { request, body };
}

describe('Telnyx media commands', () => {
  it('starts a receive-only both-track PCMU stream', async () => {
    const { request, body } = await captureCommand((fetchImpl) =>
      startStreaming(
        CONFIG,
        'call-control-a',
        {
          streamUrl: 'wss://bridge.example.test/telnyx-media/call',
          streamTrack: 'both_tracks',
          streamCodec: 'PCMU',
          streamAuthToken: 'short-lived-token',
          clientState: 'state',
          commandId: 'command-stream',
        },
        fetchImpl,
      ),
    );
    expect(request.url).toBe(
      'https://api.telnyx.com/v2/calls/call-control-a/actions/streaming_start',
    );
    expect(body).toEqual({
      stream_url: 'wss://bridge.example.test/telnyx-media/call',
      stream_track: 'both_tracks',
      stream_codec: 'PCMU',
      stream_auth_token: 'short-lived-token',
      client_state: 'state',
      command_id: 'command-stream',
    });
    expect(body).not.toHaveProperty('stream_bidirectional_mode');
    expect(body).not.toHaveProperty('stream_bidirectional_codec');
  });

  it('sends DTMF to the documented endpoint with the documented body', async () => {
    const { request, body } = await captureCommand((fetchImpl) =>
      sendDtmf(
        CONFIG,
        'call-control-a',
        {
          digits: '1w0',
          clientState: 'state',
          commandId: 'command-dtmf',
          durationMillis: 250,
        },
        fetchImpl,
      ).then(() => undefined),
    );
    expect(request.url).toBe('https://api.telnyx.com/v2/calls/call-control-a/actions/send_dtmf');
    expect(request.method).toBe('POST');
    expect(body).toEqual({
      digits: '1w0',
      client_state: 'state',
      command_id: 'command-dtmf',
      duration_millis: 250,
    });
  });

  it('omits duration_millis so Telnyx applies its own default', async () => {
    const { body } = await captureCommand((fetchImpl) =>
      sendDtmf(
        CONFIG,
        'call-control-a',
        { digits: '0', clientState: 'state', commandId: 'command-dtmf' },
        fetchImpl,
      ).then(() => undefined),
    );
    expect(body).not.toHaveProperty('duration_millis');
  });

  it('returns the HTTP status, the only confirmation send_dtmf offers', async () => {
    // This command fires NO webhooks, so if the status is dropped there is no
    // other evidence anywhere that the tones were played.
    const fetchImpl: typeof fetch = async () => new Response(null, { status: 200 });
    await expect(
      sendDtmf(CONFIG, 'leg-a', { digits: '5', clientState: 's', commandId: 'c' }, fetchImpl),
    ).resolves.toBe(200);
  });

  it('throws on a provider rejection instead of reporting a silent success', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ errors: [{ detail: 'Call has already ended' }] }), {
        status: 422,
      });
    await expect(
      sendDtmf(CONFIG, 'leg-a', { digits: '5', clientState: 's', commandId: 'c' }, fetchImpl),
    ).rejects.toThrow('Call has already ended');
  });

  it('starts a documented dual-channel recording', async () => {
    const { request, body } = await captureCommand((fetchImpl) =>
      startRecording(
        CONFIG,
        'call-control-a',
        {
          format: 'wav',
          channels: 'dual',
          clientState: 'state',
          commandId: 'command-recording',
        },
        fetchImpl,
      ),
    );
    expect(request.url).toBe('https://api.telnyx.com/v2/calls/call-control-a/actions/record_start');
    expect(body).toEqual({
      format: 'wav',
      channels: 'dual',
      client_state: 'state',
      command_id: 'command-recording',
    });
  });
});
