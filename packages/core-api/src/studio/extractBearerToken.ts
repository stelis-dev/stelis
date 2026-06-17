/**
 * Extract Bearer token from Authorization header.
 *
 * Framework-agnostic: accepts any object with a headers.get() method
 * (standard Web API Request, Hono request, etc.).
 * NO next/server dependency (core-api boundary policy).
 */

/** Minimal request interface that works with Web API Request, NextRequest, Hono, etc. */
interface HeadersLike {
  headers: { get(name: string): string | null };
}

export type ExtractBearerTokenResult =
  | { status: 'absent' } // No Authorization header → generic path
  | { status: 'present'; token: string } // Valid Bearer token → developer JWT path
  | { status: 'malformed'; reason: string }; // Header present but invalid → reject

/**
 * Extract a Bearer token from the Authorization header.
 *
 * Returns discriminated result:
 *   - 'absent'    → no Authorization header (generic path)
 *   - 'present'   → valid Bearer token extracted
 *   - 'malformed' → header exists but is not valid Bearer format (must reject, NOT fallback)
 */
export function extractBearerToken(request: HeadersLike): ExtractBearerTokenResult {
  const authHeader = request.headers.get('authorization');
  if (!authHeader) return { status: 'absent' };

  // Must be "Bearer <token>" format
  const match = authHeader.match(/^Bearer\s+(\S+)$/i);
  if (!match) {
    return {
      status: 'malformed',
      reason: 'Invalid Authorization header format (expected "Bearer <token>")',
    };
  }

  return { status: 'present', token: match[1] };
}
