/**
 * sha256Bytes — browser-safe SHA-256 hash.
 *
 * Uses Web Crypto API (globalThis.crypto.subtle) which is available in:
 *   - Node 18+
 *   - All modern browsers
 *   - Edge runtimes (Cloudflare Workers, Deno, Bun)
 *
 * Returns Uint8Array (32 bytes).
 */
export async function sha256Bytes(input: Uint8Array): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', input as unknown as BufferSource);
  return new Uint8Array(digest);
}
