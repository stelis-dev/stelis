export interface HeaderValueReader {
  header(name: string): string | undefined;
}

export interface ClientIpResolutionOptions {
  directIp?: string | null;
  trustedProxyHops?: number;
}

function normalizeIp(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Resolve the effective client IP from direct socket information or XFF.
 *
 * Security model:
 * - `trustedProxyHops=0` means "do not trust X-Forwarded-For".
 * - `trustedProxyHops>0` means "trust exactly N proxy hops" and take the
 *   client IP from the XFF chain by counting from the right.
 * - If the chain is shorter than expected, return `unknown` (fail closed).
 */
export function resolveClientIp(
  headers: HeaderValueReader,
  options: ClientIpResolutionOptions = {},
): string {
  const trustedProxyHops = options.trustedProxyHops ?? 0;

  if (trustedProxyHops === 0) {
    return normalizeIp(options.directIp) ?? 'unknown';
  }

  const xff = headers.header('x-forwarded-for');
  if (!xff) return 'unknown';

  const chain = xff
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  const clientIndex = chain.length - (trustedProxyHops + 1);
  if (clientIndex < 0) return 'unknown';

  return chain[clientIndex] ?? 'unknown';
}

/**
 * Parse trusted proxy hops from runtime configuration.
 *
 * Canonical form:
 * - `TRUSTED_PROXY_HOPS=<N>`
 */
export function parseTrustedProxyHops(trustedProxyHops: string | null | undefined): number {
  const raw = trustedProxyHops?.trim();
  if (raw) {
    if (!/^\d+$/.test(raw)) {
      throw new Error(
        `TRUSTED_PROXY_HOPS must be a non-negative integer, got '${trustedProxyHops}'`,
      );
    }
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) {
      throw new Error(
        `TRUSTED_PROXY_HOPS must be a non-negative integer, got '${trustedProxyHops}'`,
      );
    }
    return parsed;
  }

  return 0;
}

/**
 * Normalize trust-proxy hop count input.
 */
export function normalizeTrustedProxyHops(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`trustedProxyHops must be a non-negative integer, got '${value}'`);
  }
  return value;
}
