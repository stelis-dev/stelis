/**
 * GET /status — relayer health check.
 *
 * Intentionally minimal: only confirms the relayer is reachable.
 * Package IDs, network info, and pool config are served as static JSON
 * via GET /relay/config, which the SDK fetches separately.
 */

export interface StatusResponse {
  ok: boolean;
}

export async function handleStatus(): Promise<StatusResponse> {
  return { ok: true };
}
