/**
 * Edge Runtime-safe admin authentication helpers.
 *
 * Framework-agnostic: all env values are injected via config parameters,
 * NOT read from process.env (core-api boundary policy).
 *
 * Dependencies: jose only.
 */
import { SignJWT, jwtVerify } from 'jose';

const JWT_ALG = 'HS256';

/** Admin JWT configuration — injected by the host (app-api). */
export interface AdminJwtConfig {
  /** JWT signing secret (at least 32 characters). */
  jwtSecret: string;
  /** Session expiry duration string, e.g. '1h', '30m'. Default: '1h'. */
  sessionExpiry?: string;
  /** JWT issuer claim for blast-radius boundary. */
  issuer: string;
}

/** Parse duration string ('1h', '30m', '120s') → seconds. */
export function parseDuration(s: string): number {
  const m = s.match(/^(\d+)(h|m|s)$/);
  if (!m) throw new Error(`Invalid duration format: "${s}". Use Xh, Xm, or Xs.`);
  const n = Number(m[1]);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`Invalid duration format: "${s}". Duration must be a positive safe integer.`);
  }
  const unit = m[2];
  const multiplier = unit === 'h' ? 3600 : unit === 'm' ? 60 : 1;
  const seconds = n * multiplier;
  if (!Number.isSafeInteger(seconds)) {
    throw new Error(`Invalid duration format: "${s}". Duration overflows safe integer range.`);
  }
  return seconds;
}

// ── JWT ─────────────────────────────────────────────────────────────────────

function resolveSecret(config: AdminJwtConfig): Uint8Array {
  if (!config.jwtSecret || config.jwtSecret.length < 32) {
    throw new Error('[admin] jwtSecret must be at least 32 characters');
  }
  return new TextEncoder().encode(config.jwtSecret);
}

export async function signAdminJwt(address: string, config: AdminJwtConfig): Promise<string> {
  const expiry = config.sessionExpiry?.trim() || '1h';
  const builder = new SignJWT({ address, iatMs: Date.now() })
    .setProtectedHeader({ alg: JWT_ALG })
    .setIssuedAt()
    .setExpirationTime(expiry);
  if (config.issuer) builder.setIssuer(config.issuer);
  return builder.sign(resolveSecret(config));
}

export async function verifyAdminJwt(
  token: string,
  config: AdminJwtConfig,
): Promise<{ address: string; iat: number; exp: number; iatMs: number } | null> {
  try {
    const verifyOpts: { algorithms: string[]; issuer?: string } = { algorithms: [JWT_ALG] };
    if (config.issuer) verifyOpts.issuer = config.issuer;
    const { payload } = await jwtVerify(token, resolveSecret(config), verifyOpts);
    if (typeof payload['address'] !== 'string') return null;
    if (typeof payload.iat !== 'number' || !Number.isSafeInteger(payload.iat)) return null;
    if (typeof payload.exp !== 'number' || !Number.isSafeInteger(payload.exp)) return null;
    if (typeof payload['iatMs'] !== 'number' || !Number.isSafeInteger(payload['iatMs'] as number))
      return null;
    return {
      address: payload['address'] as string,
      iat: payload.iat,
      exp: payload.exp,
      iatMs: payload['iatMs'] as number,
    };
  } catch {
    return null;
  }
}
