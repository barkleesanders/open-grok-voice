/**
 * Fake DurableObjectNamespace for testing.
 *
 * Provides idFromName, get, and other methods needed to test code that
 * interacts with Durable Objects through the Worker's env.CALL_SESSION namespace.
 */

import { CallSession } from '../src/call-session';
import type { Env } from '../src/env';
import { createFakeDurableObjectState } from './fake-do';

export interface FakeDurableObjectNamespace extends DurableObjectNamespace {
  /** Get the underlying CallSession for a given name (for test inspection) */
  _getSession(name: string): CallSession | undefined;
}

export function createFakeDurableObjectNamespace(env: Env): FakeDurableObjectNamespace {
  // Store DO instances by their name
  const sessions = new Map<string, CallSession>();

  function getOrCreateSession(name: string): CallSession {
    let session = sessions.get(name);
    if (!session) {
      const state = createFakeDurableObjectState();
      session = new CallSession(state.ctx, env);
      sessions.set(name, session);
    }
    return session;
  }

  const namespace = {
    idFromName(name: string): DurableObjectId {
      // Return a minimal DurableObjectId stub
      return {
        toString: () => name,
        equals: (other: DurableObjectId) => other.toString() === name,
        name,
      } as DurableObjectId;
    },

    get(id: DurableObjectId): DurableObjectStub {
      const name = id.toString();
      const session = getOrCreateSession(name);

      // Return a stub that forwards fetch calls to the real CallSession
      return {
        fetch: (input: RequestInfo | URL, init?: RequestInit) => {
          const request =
            typeof input === 'string' || input instanceof URL ? new Request(input, init) : input;
          return session.fetch(request);
        },
        id,
      } as DurableObjectStub;
    },

    _getSession(name: string): CallSession | undefined {
      return sessions.get(name);
    },
  } as FakeDurableObjectNamespace;

  return namespace;
}
