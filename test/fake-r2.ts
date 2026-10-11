// In-memory R2Bucket stand-in.
//
// Every behaviour here was MEASURED against the real bucket
// (open-grok-voice-call-logs, Workers binding, 2026-08-28) rather than
// assumed, because a fake that is wrong about its subject turns a green test
// into a lie. What the probe established:
//   - list() returns keys in LEXICOGRAPHIC ASCENDING order, whatever order they
//     were written in. That is the whole reason the call-log key inverts time.
//   - customMetadata comes back from list() ONLY when include:['customMetadata']
//     is passed; without it every object's customMetadata is undefined.
//   - a put on an EXISTING key overwrites in place — the object count does not
//     grow. That is what makes the call-log write idempotent.
//   - non-ASCII customMetadata is ACCEPTED and round-trips byte-identical, so
//     this fake must not reject it either.

interface StoredObject {
  readonly key: string;
  readonly body: Uint8Array;
  readonly customMetadata: Record<string, string>;
  readonly contentType: string | undefined;
  readonly etag: string;
  readonly version: string;
}

function encode(
  value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
): Promise<Uint8Array> {
  if (value === null) return Promise.resolve(new Uint8Array());
  if (typeof value === 'string') return Promise.resolve(new TextEncoder().encode(value));
  if (value instanceof Uint8Array) return Promise.resolve(value);
  if (value instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) {
    return Promise.resolve(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  // ReadableStream / Blob: let Response do the buffering.
  return new Response(value as BodyInit).arrayBuffer().then((buf) => new Uint8Array(buf));
}

/** A fake R2 bucket with a recording of every put, for assertions. */
export interface FakeR2 {
  readonly bucket: R2Bucket;
  /** Keys currently stored, in the same lexicographic order list() uses. */
  keys(): string[];
  /** Number of times put() was called, INCLUDING overwrites of the same key. */
  putCount(): number;
  /** Number of times list() was called. One archive scan is one or more of these. */
  listCount(): number;
  /** Objects RETURNED across every list() call -- the actual read volume of a scan. */
  listedObjectCount(): number;
  raw(key: string): StoredObject | undefined;
  text(key: string): string | undefined;
  json<T>(key: string): T | undefined;
  /** Force the next N operations of the named kind to throw. */
  failNext(kind: 'put' | 'get' | 'list' | 'head', times: number): void;
}

/**
 * Resolve an R2Range against a real byte length, the way the service does.
 *
 * R2Range is a three-way union ({offset,length?} | {offset?,length} | {suffix}),
 * so a fake that reads only `offset`/`length` would silently serve the whole
 * object for a suffix request and hide a real bug.
 */
function normalizeRange(size: number, range: R2Range): { offset: number; length: number } {
  if ('suffix' in range) {
    const length = Math.min(range.suffix, size);
    return { offset: size - length, length };
  }
  const offset = range.offset ?? 0;
  const length = range.length ?? size - offset;
  // R2 clamps at the end of the object rather than erroring.
  return { offset, length: Math.max(0, Math.min(length, size - offset)) };
}

function sliceFor(body: Uint8Array, range: R2Range | undefined): Uint8Array {
  if (range === undefined) return body;
  const { offset, length } = normalizeRange(body.byteLength, range);
  return body.subarray(offset, offset + length);
}

export function createFakeR2(): FakeR2 {
  const store = new Map<string, StoredObject>();
  let puts = 0;
  let lists = 0;
  let listedObjects = 0;
  const failures: Record<'put' | 'get' | 'list' | 'head', number> = {
    put: 0,
    get: 0,
    list: 0,
    head: 0,
  };

  function maybeFail(kind: 'put' | 'get' | 'list' | 'head'): void {
    if (failures[kind] > 0) {
      failures[kind] -= 1;
      throw new Error(`fake R2 ${kind} failure`);
    }
  }

  function sortedKeys(): string[] {
    // Lexicographic by code unit, matching what the real bucket returned.
    return [...store.keys()].sort();
  }

  /**
   * Measured Workers contract: put({onlyIf}) returns null (HTTP 412) and
   * does not write when the precondition fails. etagMatches is compared to
   * R2Object.etag (unquoted). Headers-form onlyIf is unused by this Worker.
   */
  function preconditionHolds(
    stored: StoredObject | undefined,
    onlyIf: R2Conditional | Headers,
  ): boolean {
    if (onlyIf instanceof Headers) {
      throw new Error('fake R2: onlyIf Headers is not implemented');
    }
    if (onlyIf.uploadedBefore !== undefined || onlyIf.uploadedAfter !== undefined) {
      throw new Error('fake R2: onlyIf uploadedBefore/uploadedAfter is not implemented');
    }
    if (onlyIf.etagMatches !== undefined) {
      if (!stored || stored.etag !== onlyIf.etagMatches) return false;
    }
    if (onlyIf.etagDoesNotMatch !== undefined) {
      if (stored && stored.etag === onlyIf.etagDoesNotMatch) return false;
    }
    return true;
  }

  function objectView(
    stored: StoredObject,
    includeMetadata: boolean,
    servedRange?: R2Range,
  ): R2Object {
    // Every member of R2Object is spelled out rather than asserted, so that a
    // types bump which ADDS a member breaks this fake at compile time instead
    // of letting the code under test read undefined off a half-built double.
    return {
      key: stored.key,
      version: stored.version,
      // FULL object size, not the length of a served range.
      //
      // NOT MEASURED: the Workers docs define `size` only as "Size of the object
      // in bytes" and never say which it is on a ranged get
      // (developers.cloudflare.com/r2/api/workers/workers-api-reference/, read
      // 2026-08-28). Rather than let a fake settle a question the real service
      // has not answered, src/call-session.ts takes the Content-Range
      // denominator from head() -- which is never ranged -- so production
      // behaviour is correct under EITHER reading and this line cannot make a
      // wrong implementation look right.
      size: stored.body.byteLength,
      etag: stored.etag,
      httpEtag: `"${stored.etag}"`,
      checksums: { toJSON: () => ({}) },
      uploaded: new Date(0),
      // Mirrors the measured behaviour: absent unless include asked for it.
      customMetadata: includeMetadata ? { ...stored.customMetadata } : undefined,
      httpMetadata: { contentType: stored.contentType },
      storageClass: 'Standard',
      ...(servedRange === undefined ? {} : { range: servedRange }),
      writeHttpMetadata(headers: Headers): void {
        if (stored.contentType) headers.set('content-type', stored.contentType);
      },
    };
  }

  // Implementation returns R2Object | null so onlyIf 412 is representable.
  // The R2Bucket overload without onlyIf is Promise<R2Object>; the runtime
  // still returns an object on an unconditional put.
  const bucket = {
    // Multipart is not used by the call-log archive. These throw rather than
    // returning a stub so that a future caller reaching for them fails loudly
    // in the test instead of silently getting undefined.
    createMultipartUpload(): never {
      throw new Error('fake R2: createMultipartUpload is not implemented');
    },
    resumeMultipartUpload(): never {
      throw new Error('fake R2: resumeMultipartUpload is not implemented');
    },

    async put(
      key: string,
      value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
      options?: R2PutOptions,
    ): Promise<R2Object | null> {
      maybeFail('put');
      const existing = store.get(key);
      if (options?.onlyIf !== undefined && !preconditionHolds(existing, options.onlyIf)) {
        return null;
      }
      puts += 1;
      const body = await encode(value);
      const httpMetadata = options?.httpMetadata;
      const contentType =
        httpMetadata instanceof Headers
          ? (httpMetadata.get('content-type') ?? undefined)
          : httpMetadata?.contentType;
      const etag = `etag-${puts}-${key}`;
      const stored: StoredObject = {
        key,
        body,
        customMetadata: { ...(options?.customMetadata ?? {}) },
        contentType,
        etag,
        version: `v-${puts}-${key}`,
      };
      store.set(key, stored);
      return objectView(stored, true);
    },

    async get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null> {
      maybeFail('get');
      const stored = store.get(key);
      if (!stored) return null;
      const requested = options?.range;
      // Only the object form is implemented. `range` may also be a Headers, but
      // this Worker never passes one (it resolves the client's Range itself so
      // it can clamp against a known size), so an unsupported shape throws
      // rather than silently returning the whole object and turning a broken
      // call into a passing test.
      if (requested !== undefined && requested instanceof Headers) {
        throw new Error('fake R2: get(range: Headers) is not implemented');
      }
      const bytes = sliceFor(stored.body, requested);
      const servedRange =
        requested === undefined ? undefined : normalizeRange(stored.body.byteLength, requested);
      const decoded = () => new TextDecoder().decode(bytes);
      const buffer = (): ArrayBuffer =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const body = new Response(bytes as BodyInit).body;
      if (!body) throw new Error('fake R2 could not build a body stream');
      const base = objectView(stored, true, servedRange);
      return {
        ...base,
        // A spread over a class-typed value drops its METHODS in TypeScript's
        // spread type, so writeHttpMetadata has to be re-attached by hand.
        writeHttpMetadata: (headers: Headers) => base.writeHttpMetadata(headers),
        body,
        bodyUsed: false,
        arrayBuffer: async () => buffer(),
        bytes: async () => bytes,
        text: async () => decoded(),
        json: async <T>(): Promise<T> => JSON.parse(decoded()) as T,
        blob: async () => new Blob([buffer()]),
      };
    },

    async head(key: string): Promise<R2Object | null> {
      maybeFail('head');
      const stored = store.get(key);
      return stored ? objectView(stored, true) : null;
    },

    async delete(keys: string | string[]): Promise<void> {
      for (const key of typeof keys === 'string' ? [keys] : keys) store.delete(key);
    },

    async list(options?: R2ListOptions): Promise<R2Objects> {
      maybeFail('list');
      lists += 1;
      const prefix = options?.prefix ?? '';
      const includeMetadata = (options?.include ?? []).includes('customMetadata');
      const limit = options?.limit ?? 1000;
      const all = sortedKeys().filter((key) => key.startsWith(prefix));
      const start = options?.cursor ? all.indexOf(options.cursor) : 0;
      const from = start < 0 ? all.length : start;
      const page = all.slice(from, from + limit);
      const next = all[from + limit];
      const objects = page.map((key) => {
        const stored = store.get(key);
        if (!stored) throw new Error(`fake R2 lost ${key}`);
        return objectView(stored, includeMetadata);
      });
      listedObjects += objects.length;
      return next === undefined
        ? { objects, delimitedPrefixes: [], truncated: false }
        : { objects, delimitedPrefixes: [], truncated: true, cursor: next };
    },
  } as R2Bucket;

  return {
    bucket,
    keys: () => sortedKeys(),
    putCount: () => puts,
    listCount: () => lists,
    listedObjectCount: () => listedObjects,
    raw: (key) => store.get(key),
    text: (key) => {
      const stored = store.get(key);
      return stored ? new TextDecoder().decode(stored.body) : undefined;
    },
    json: <T>(key: string): T | undefined => {
      const stored = store.get(key);
      return stored ? (JSON.parse(new TextDecoder().decode(stored.body)) as T) : undefined;
    },
    failNext: (kind, times) => {
      failures[kind] = times;
    },
  };
}
