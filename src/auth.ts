import { betterAuth } from 'better-auth';
import type { Env } from './env';
import { errText, log } from './log';

export const OPERATOR_EMAIL = 'operator@example.com';

export class AuthConfigurationError extends Error {
  readonly code = 'auth_not_configured';

  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigurationError';
  }
}

export interface OperatorUser {
  readonly name: string;
  readonly image: string | null;
}

export type OperatorSession =
  | { readonly kind: 'authorized'; readonly user: OperatorUser }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'config_error' };

/** Pure policy check kept separate so the exact-email rule is regression-tested. */
export function operatorEmailAllowed(
  email: string | undefined,
  emailVerified: boolean | undefined,
  method: string | undefined,
  providerId: string | undefined,
): boolean {
  return (
    email === OPERATOR_EMAIL &&
    emailVerified === true &&
    method === 'oauth' &&
    providerId === 'google'
  );
}

function canonicalBaseURL(env: Env): string {
  const raw = env.BETTER_AUTH_URL?.trim() || env.PUBLIC_BASE_URL?.trim();
  if (!raw) throw new AuthConfigurationError('auth base URL is not configured');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AuthConfigurationError('auth base URL is invalid');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AuthConfigurationError('auth base URL must not contain credentials or query data');
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new AuthConfigurationError('auth base URL must use HTTPS');
  }
  return url.origin;
}

function trustedOrigins(env: Env, baseURL: string): string[] {
  const configured = (env.BETTER_AUTH_TRUSTED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  for (const origin of configured) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new AuthConfigurationError('trusted origin is invalid');
    }
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      (parsed.protocol !== 'https:' &&
        parsed.hostname !== 'localhost' &&
        parsed.hostname !== '127.0.0.1')
    ) {
      throw new AuthConfigurationError('trusted origin must be an HTTPS origin');
    }
  }
  return [baseURL, ...configured];
}

/** Build a fresh Better Auth instance for this request, never at module load. */
export function createAuth(env: Env) {
  const database = env.DB;
  const secret = env.BETTER_AUTH_SECRET?.trim();
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (!database) throw new AuthConfigurationError('auth D1 binding DB is missing');
  if (!secret || secret.length < 32) {
    throw new AuthConfigurationError('BETTER_AUTH_SECRET is missing or too short');
  }
  if (!clientId || !clientSecret) {
    throw new AuthConfigurationError('Google OAuth credentials are missing');
  }
  const baseURL = canonicalBaseURL(env);
  return betterAuth({
    appName: 'Grok Voice Bridge Operator Console',
    baseURL,
    basePath: '/api/auth',
    database,
    secret,
    trustedOrigins: trustedOrigins(env, baseURL),
    emailAndPassword: { enabled: false },
    socialProviders: {
      google: {
        clientId,
        clientSecret,
      },
    },
    user: {
      changeEmail: { enabled: false },
      deleteUser: { enabled: false },
      validateUserInfo: ({ user, source }) => {
        if (
          !operatorEmailAllowed(
            typeof user.email === 'string' ? user.email : undefined,
            user.emailVerified === true,
            source.method,
            source.oauth?.providerId,
          )
        ) {
          log('warn', 'auth.operator.rejected', {
            method: source.method,
            provider: source.oauth?.providerId ?? null,
          });
          return {
            error: 'operator_not_allowed',
            errorDescription: 'This operator account is not permitted.',
          };
        }
      },
    },
    advanced: {
      cookiePrefix: 'open-grok-voice',
      useSecureCookies: true,
    },
  });
}

function hasSessionCookie(request: Request): boolean {
  const cookie = request.headers.get('Cookie') ?? '';
  return cookie.split(';').some((part) => {
    const name = part.trim().split('=', 1)[0];
    return (
      name === 'open-grok-voice.session_token' ||
      name === 'open-grok-voice-session_token' ||
      name === '__Secure-open-grok-voice.session_token' ||
      name === '__Secure-open-grok-voice-session_token'
    );
  });
}

/** Resolve the single operator session without exposing Better Auth internals. */
export async function getOperatorSession(env: Env, request: Request): Promise<OperatorSession> {
  if (!hasSessionCookie(request)) return { kind: 'unauthorized' };
  let auth: ReturnType<typeof createAuth>;
  try {
    auth = createAuth(env);
  } catch (err) {
    if (err instanceof AuthConfigurationError) {
      log('error', 'auth.configuration.missing', { code: err.code });
      return { kind: 'config_error' };
    }
    log('error', 'auth.configuration.failed', { error: errText(err) });
    return { kind: 'config_error' };
  }
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) {
      log('warn', 'auth.session.rejected', {});
      return { kind: 'unauthorized' };
    }
    // Returning-session requests do not carry a provider source. The persisted
    // row has already passed the Google policy at creation; exact email and
    // verification are rechecked here in case a row was altered externally.
    if (session.user.email !== OPERATOR_EMAIL || session.user.emailVerified !== true) {
      log('warn', 'auth.session.rejected', {});
      return { kind: 'unauthorized' };
    }
    return {
      kind: 'authorized',
      user: {
        name: session.user.name,
        image: session.user.image ?? null,
      },
    };
  } catch (err) {
    log('warn', 'auth.session.failed', { error: errText(err) });
    return { kind: 'unauthorized' };
  }
}
