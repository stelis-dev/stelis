/**
 * [app-api] Admin authentication helpers — host-layer cookie + JWT config.
 *
 * Uses core-api/admin DI functions (signAdminJwt, verifyAdminJwt)
 * with app-api-specific AdminJwtConfig and cookie namespace.
 *
 * issuer = 'app-api' for blast-radius isolation
 * Cookie name = `stelis_admin` across app-api hosts
 * Not-before checks use the `stelis:app-api:admin:not_before` Redis key
 */
import {
  signAdminJwt as coreSignAdminJwt,
  verifyAdminJwt as coreVerifyAdminJwt,
  parseDuration,
  type AdminJwtConfig,
} from '@stelis/core-api/admin';
import { requireEnv } from './env.js';

// Unified cookie name for app-api
export const ADMIN_COOKIE = 'stelis_admin';

function getAdminJwtConfig(): AdminJwtConfig {
  return {
    jwtSecret: requireEnv('ADMIN_JWT_SECRET'),
    sessionExpiry: process.env.ADMIN_SESSION_EXPIRY?.trim() || '1h',
    issuer: 'app-api', // blast-radius boundary
  };
}

export async function signAdminJwt(address: string): Promise<string> {
  return coreSignAdminJwt(address, getAdminJwtConfig());
}

export async function verifyAdminJwt(
  token: string,
): Promise<{ address: string; iat: number; exp: number; iatMs: number } | null> {
  return coreVerifyAdminJwt(token, getAdminJwtConfig());
}

export function buildAuthCookieHeader(token: string): string {
  const expiry = process.env.ADMIN_SESSION_EXPIRY?.trim() || '1h';
  const maxAge = parseDuration(expiry);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const cookieDomain = process.env.COOKIE_DOMAIN?.trim();
  // When COOKIE_DOMAIN is set (e.g. ".sample.com"), use SameSite=Lax + Domain
  // to allow cross-subdomain auth (admin.sample.com ↔ api.sample.com).
  // Otherwise, default to SameSite=Strict (same-origin only).
  const domainAttr = cookieDomain ? `; Domain=${cookieDomain}` : '';
  const sameSite = cookieDomain ? 'Lax' : 'Strict';
  return `${ADMIN_COOKIE}=${token}; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=${maxAge}${secure}${domainAttr}`;
}

export function buildLogoutCookieHeader(): string {
  const cookieDomain = process.env.COOKIE_DOMAIN?.trim();
  const domainAttr = cookieDomain ? `; Domain=${cookieDomain}` : '';
  const sameSite = cookieDomain ? 'Lax' : 'Strict';
  return `${ADMIN_COOKIE}=; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=0${domainAttr}`;
}
