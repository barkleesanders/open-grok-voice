import type { Env } from '../src/env';
import { createFakeDurableObjectNamespace } from './fake-do-namespace';

type MutableEnv = { -readonly [K in keyof Env]: Env[K] };

export function testEnv(overrides: Partial<Env> = {}): Env {
  const implemented = {
    XAI_API_KEY: 'test-xai-key',
    XAI_WEBHOOK_SECRET: 'test-xai-test-key',
    TELNYX_API_KEY: 'test-telnyx-key',
    TELNYX_PUBLIC_KEY: 'test-telnyx-public-key',
    APP_API_KEY: 'test-app-key',
    TELNYX_CONNECTION_ID: 'test-connection',
    TELNYX_FROM_NUMBER: '+14155550123',
    XAI_PHONE_NUMBER: '+14155550124',
    XAI_SIP_HOST: 'sip.voice.x.ai',
    PUBLIC_BASE_URL: 'https://bridge.example.test',
    DEFAULT_VOICE: 'test-voice',
    CALCOM_BOOKING_URL: 'https://cal.com/test',
    ...overrides,
  };

  // SAFETY: Env requires CALL_SESSION, but createFakeDurableObjectNamespace
  // captures the Env by reference when a session is first created (later),
  // so the namespace cannot exist before the Env object does. Assemble the
  // other bindings first, then fill CALL_SESSION before return. Tests that
  // pass CALL_SESSION in overrides keep that stub. Optional bindings not
  // listed here stay absent and fail loudly if production code reaches them.
  const env: MutableEnv = Object.assign({} as MutableEnv, implemented);

  if (!overrides.CALL_SESSION) {
    env.CALL_SESSION = createFakeDurableObjectNamespace(env);
  }

  return env;
}
