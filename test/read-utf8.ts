import { readFileSync } from 'node:fs';

/**
 * Read a UTF-8 file relative to a module URL.
 *
 * `readFileSync(new URL(...), 'utf8')` fails typecheck: tsconfig pulls
 * `@cloudflare/workers-types` URL, while `node:fs` overloads expect Node's URL.
 * Passing `.pathname` (a string) selects the PathOrFileDescriptor overload.
 */
export function readUtf8(fromMetaUrl: string, rel: string): string {
  return readFileSync(new URL(rel, fromMetaUrl).pathname, 'utf8');
}
