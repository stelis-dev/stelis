/**
 * Shared body error handling for routes using bounded request-body parsing.
 *
 * Maps body parsing errors to proper HTTP status codes:
 * - RequestBodyTooLargeError → 413
 * - RequestBodyParseError → 400
 */
import type { Context } from 'hono';
import { RequestBodyTooLargeError, RequestBodyParseError } from '@stelis/core-api';

/**
 * If `err` is a body-parsing error, returns a Response. Otherwise returns null.
 */
export function tryBodyErrorResponse(c: Context, err: unknown): Response | null {
  if (err instanceof RequestBodyTooLargeError) {
    return c.json({ error: 'Request body too large' }, 413);
  }
  if (err instanceof RequestBodyParseError) {
    return c.json({ error: 'Invalid request body' }, 400);
  }
  return null;
}
