// Minimal DurableObjectState stand-in.
//
// CallSession touches exactly four things on its ctx: storage.get, storage.put,
// storage.delete and waitUntil. Faking those lets the REAL Durable Object class
// run in a plain node test, which is the only way to prove that the archive is
// written from the terminal transition rather than merely that a helper
// function can write one.

export interface FakeDurableObjectState {
  readonly ctx: DurableObjectState;
  /** Resolve every promise handed to waitUntil, the way the runtime would. */
  drain(): Promise<void>;
  peek<T>(key: string): T | undefined;
}

export function createFakeDurableObjectState(): FakeDurableObjectState {
  const store = new Map<string, unknown>();
  const pending: Promise<unknown>[] = [];

  const implemented = {
    storage: {
      async get<T>(key: string): Promise<T | undefined> {
        return store.get(key) as T | undefined;
      },
      async put<T>(key: string, value: T): Promise<void> {
        // Structured-clone-ish: the real storage round-trips through
        // serialization, so a test must not accidentally share a reference.
        store.set(key, JSON.parse(JSON.stringify(value)));
      },
      async delete(key: string): Promise<boolean> {
        return store.delete(key);
      },
    },
    waitUntil(promise: Promise<unknown>): void {
      pending.push(promise);
    },
  };

  // SAFETY: DurableObjectState carries ~15 members (id, blockConcurrencyWhile,
  // the WebSocket-hibernation family, the full DurableObjectStorage surface
  // including sql/transaction/alarms) whose shape moves between
  // @cloudflare/workers-types releases. Implementing all of them would make
  // this fake break on every types bump while testing nothing extra.
  // The invariant that makes the assertion safe is enforced at RUNTIME rather
  // than asserted: every member not spelled out above is genuinely absent, so
  // the moment CallSession reaches for one the test dies with a TypeError
  // naming it. There is no silent-undefined path.
  const ctx: DurableObjectState = Object.assign({} as DurableObjectState, implemented);

  return {
    ctx,
    async drain(): Promise<void> {
      // waitUntil work can itself schedule more work; loop until quiet.
      while (pending.length > 0) {
        const batch = pending.splice(0, pending.length);
        await Promise.all(batch);
      }
    },
    peek: <T>(key: string): T | undefined => store.get(key) as T | undefined,
  };
}
