import { describe, expect, it } from 'vitest';
import {
  AuthConfigurationError,
  createAuth,
  getOperatorSession,
  operatorEmailAllowed,
} from '../src/auth';
import { testEnv } from './test-env';

const DATABASE = {} as D1Database;
const VALID_SECRET = 'auth-test-secret-with-at-least-32-characters';

describe('operator Google policy', () => {
  it('allows only the exact verified Google OAuth identity', () => {
    expect(operatorEmailAllowed('operator@example.com', true, 'oauth', 'google')).toBe(true);
    expect(operatorEmailAllowed('operator@example.com', false, 'oauth', 'google')).toBe(false);
    expect(operatorEmailAllowed('other@example.com', true, 'oauth', 'google')).toBe(false);
    expect(operatorEmailAllowed('operator@example.com', true, 'password', undefined)).toBe(false);
    expect(operatorEmailAllowed('operator@example.com', true, 'oauth', 'github')).toBe(false);
  });
});

describe('Better Auth configuration boundaries', () => {
  it('fails closed when D1, the secret, or Google credentials are missing', () => {
    expect(() => createAuth(testEnv())).toThrow(AuthConfigurationError);
    expect(() => createAuth(testEnv({ DB: DATABASE }))).toThrow(AuthConfigurationError);
    expect(() => createAuth(testEnv({ DB: DATABASE, BETTER_AUTH_SECRET: 'short' }))).toThrow(
      AuthConfigurationError,
    );
    expect(() => createAuth(testEnv({ DB: DATABASE, BETTER_AUTH_SECRET: VALID_SECRET }))).toThrow(
      AuthConfigurationError,
    );
  });

  it('returns config_error for a presented session when auth is unprovisioned', async () => {
    const request = new Request('https://bridge.example.test/api/me', {
      headers: { Cookie: 'open-grok-voice.session_token=opaque' },
    });
    await expect(getOperatorSession(testEnv(), request)).resolves.toEqual({
      kind: 'config_error',
    });
  });

  it('does not instantiate Better Auth for an anonymous request', async () => {
    const request = new Request('https://bridge.example.test/api/me');
    await expect(getOperatorSession(testEnv(), request)).resolves.toEqual({
      kind: 'unauthorized',
    });
  });
});
