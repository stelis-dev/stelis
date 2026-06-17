/**
 * [app-api] Client IP resolution — host-layer utility.
 *
 * Adapts Hono's Context to core-api's resolveClientIp interface.
 * Uses resolveClientIp and parseTrustedProxyHops from @stelis/core-api.
 */
import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { resolveClientIp, parseTrustedProxyHops } from '@stelis/core-api';

/**
 * Resolve client IP from Hono request context.
 *
 * Uses the socket-level remote address as directIp (via @hono/node-server conninfo),
 * combined with x-forwarded-for and TRUSTED_PROXY_HOPS config.
 *
 * When TRUSTED_PROXY_HOPS=0 (no proxy), directIp is the actual client.
 * When behind a proxy, XFF chain is trusted up to the configured depth.
 */
export function getClientIp(c: Context): string {
  const trustedProxyHops = parseTrustedProxyHops(process.env.TRUSTED_PROXY_HOPS);

  // Extract socket-level remote address from node-server runtime.
  let directIp: string | null = null;
  try {
    const connInfo = getConnInfo(c);
    directIp = connInfo.remote.address ?? null;
  } catch {
    // getConnInfo may throw in non-node-server environments (e.g. test mocks)
  }

  return resolveClientIp(
    {
      header: (name: string) => c.req.header(name) ?? undefined,
    },
    {
      directIp,
      trustedProxyHops,
    },
  );
}
