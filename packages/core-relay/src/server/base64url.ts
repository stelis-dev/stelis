/**
 * Base64url decoding utility (RFC 4648 §5, no padding).
 *
 * Canonical owner: @stelis/core-relay/server
 *
 * Node-only (uses Buffer). Not included in @stelis/core-relay/browser.
 * Used by:
 *   - @stelis/core-api: developerJwtVerifier (JWT header/payload/signature decode)
 */

/** Decode base64url string to Uint8Array. */
export function base64urlDecode(str: string): Uint8Array {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  return new Uint8Array(Buffer.from(padded, 'base64'));
}
