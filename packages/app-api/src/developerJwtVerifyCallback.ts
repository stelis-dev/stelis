/**
 * Developer JWT verify URL callback — host/runtime concern.
 *
 * After local JWT verification succeeds (in core-api), this module
 * calls the developer-owned verification API to confirm the token
 * is still valid (e.g., not revoked, session still active).
 *
 * This is intentionally in app-api, not core-api, because:
 * - core-api is framework-agnostic domain logic (no HTTP calls)
 * - app-api is the host/runtime layer (HTTP, env, Redis)
 *
 * Optional, fail-closed.
 *
 * @module developerJwtVerifyCallback
 */

/**
 * Timeout for developer verify API call.
 * Documented in docs/parameters.md#runtime-timing-constants.
 * Fail-closed: if the callback does not respond within this window,
 * the developer JWT is rejected.
 */
export const DEVELOPER_VERIFY_TIMEOUT_MS = 5_000;

/**
 * Call the developer-owned JWT verification API.
 *
 * Request: POST JSON `{ "jwt": "<developerJwt>" }`
 * Expected success: `{ "valid": true }`
 * Expected deny: `{ "valid": false, "reason"?: string }`
 *
 * Fail-closed on:
 * - Network error
 * - Non-2xx response
 * - Invalid response body
 * - Timeout (`DEVELOPER_VERIFY_TIMEOUT_MS`)
 * - `{ "valid": false }`
 *
 * @param jwt - The developer JWT to verify
 * @param verifyUrl - The developer-owned verification URL
 * @throws Error on any failure (fail-closed)
 */
export async function callDeveloperVerifyApi(jwt: string, verifyUrl: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEVELOPER_VERIFY_TIMEOUT_MS);

  try {
    const response = await fetch(verifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jwt }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`developer verify API returned HTTP ${response.status}`);
    }

    let body: { valid?: boolean; reason?: string };
    try {
      body = (await response.json()) as { valid?: boolean; reason?: string };
    } catch {
      throw new Error('developer verify API returned invalid JSON');
    }

    if (body.valid !== true) {
      throw new Error(`developer verify API denied: ${body.reason ?? 'no reason given'}`);
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`developer verify API timed out after ${DEVELOPER_VERIFY_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
