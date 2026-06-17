/**
 * Auth route contract tests — verifies HTTP contracts.
 *
 * Tests use Hono's app.request() with mocked dependencies.
 * No Redis required — all stores are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ── Mock core-api/admin ─────────────────────────────────────────────────
const { mockRedis } = vi.hoisted(() => ({
  mockRedis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(1),
    lpush: vi.fn().mockResolvedValue(1),
    ltrim: vi.fn().mockResolvedValue(undefined),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('@stelis/core-api/admin', () => ({
  verifyAdminSignature: vi.fn().mockResolvedValue(true),
  getRedisForAdmin: vi.fn().mockResolvedValue(mockRedis),
  checkAndIncrement: vi.fn().mockResolvedValue({ allowed: true, current: 1, retryAfterMs: 0 }),
  resetAttempts: vi.fn().mockResolvedValue(undefined),
}));

// ── Mock adminAuth helpers ──────────────────────────────────────────────
vi.mock('../src/adminAuth.js', () => ({
  signAdminJwt: vi.fn().mockResolvedValue('mock-jwt-token'),
  verifyAdminJwt: vi.fn().mockResolvedValue(null),
  buildAuthCookieHeader: vi.fn().mockReturnValue('stelis_admin=mock-jwt; HttpOnly; Path=/'),
  buildLogoutCookieHeader: vi.fn().mockReturnValue('stelis_admin=; HttpOnly; Path=/; Max-Age=0'),
  ADMIN_COOKIE: 'stelis_admin',
}));

// ── Mock requireAdminSession ────────────────────────────────────────────
vi.mock('../src/requireAdminSession.js', () => ({
  requireAdminSession: vi.fn().mockResolvedValue(null),
}));

// ── Mock clientIp ───────────────────────────────────────────────────────
vi.mock('../src/clientIp.js', () => ({
  getClientIp: vi.fn().mockReturnValue('127.0.0.1'),
}));

// ── Mock env ────────────────────────────────────────────────────────────
vi.mock('../src/env.js', () => ({
  requireEnv: vi.fn().mockImplementation((key: string) => {
    const vals: Record<string, string> = {
      REDIS_URL: 'redis://localhost:6379',
      ADMIN_ADDRESS: '0x' + 'a'.repeat(64),
      ADMIN_JWT_SECRET: 'x'.repeat(32),
    };
    if (vals[key]) return vals[key];
    throw new Error(`Missing: ${key}`);
  }),
}));

import { createAuthRoutes } from '../src/routes/auth.js';
import type { AppApiContext } from '../src/context.js';
import { requireAdminSession } from '../src/requireAdminSession.js';
import { getRedisForAdmin } from '@stelis/core-api/admin';

describe('auth routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    const getCtx = async () => ({}) as AppApiContext;
    const routes = createAuthRoutes(getCtx);
    app = new Hono();
    app.route('/auth', routes);
  });

  describe('GET /auth/nonce', () => {
    it('returns 200 with nonce string', async () => {
      const res = await app.request('/auth/nonce');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.nonce).toBeDefined();
      expect(typeof body.nonce).toBe('string');
      expect(body.nonce).toMatch(/^stelis-admin-login:/);
    });

    it('returns 429 when rate limited', async () => {
      const { checkAndIncrement } = await import('@stelis/core-api/admin');
      (checkAndIncrement as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        allowed: false,
        current: 6,
        retryAfterMs: 900000,
      });
      const res = await app.request('/auth/nonce');
      expect(res.status).toBe(429);
      await expect(res.json()).resolves.toEqual({
        error: 'Too many requests. Try again in 15 minutes.',
      });
    });
  });

  describe('POST /auth/verify', () => {
    it('returns 400 on missing fields', async () => {
      const res = await app.request('/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce: 'test' }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 401 on invalid nonce (consumed)', async () => {
      mockRedis.del.mockResolvedValueOnce(0); // nonce not found
      const res = await app.request('/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nonce: 'invalid-nonce',
          signature: 'sig',
          address: '0x' + 'a'.repeat(64),
        }),
      });
      expect(res.status).toBe(401);
    });

    it('returns 200 with Set-Cookie on valid verify', async () => {
      mockRedis.del.mockResolvedValueOnce(1); // nonce consumed
      const res = await app.request('/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nonce: 'valid-nonce',
          signature: 'valid-sig',
          address: '0x' + 'a'.repeat(64),
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(res.headers.get('Set-Cookie')).toContain('stelis_admin');
    });

    it('returns 429 when rate limited', async () => {
      const { checkAndIncrement } = await import('@stelis/core-api/admin');
      (checkAndIncrement as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        allowed: false,
        current: 6,
        retryAfterMs: 900000,
      });
      const res = await app.request('/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nonce: 'test-nonce',
          signature: 'sig',
          address: '0x' + 'a'.repeat(64),
        }),
      });
      expect(res.status).toBe(429);
      await expect(res.json()).resolves.toEqual({
        error: 'Too many requests. Try again in 15 minutes.',
      });
    });

    it('calls resetAttempts on successful verify', async () => {
      const { resetAttempts } = await import('@stelis/core-api/admin');
      mockRedis.del.mockResolvedValueOnce(1); // nonce consumed
      await app.request('/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nonce: 'valid-nonce',
          signature: 'valid-sig',
          address: '0x' + 'a'.repeat(64),
        }),
      });
      expect(resetAttempts).toHaveBeenCalled();
    });

    it('returns 500 without Set-Cookie when signAdminJwt throws', async () => {
      const { signAdminJwt } = await import('../src/adminAuth.js');
      (signAdminJwt as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('JWT signing failed'),
      );
      mockRedis.del.mockResolvedValueOnce(1); // nonce consumed
      const res = await app.request('/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nonce: 'valid-nonce',
          signature: 'valid-sig',
          address: '0x' + 'a'.repeat(64),
        }),
      });
      expect(res.status).toBe(500);
      // Set-Cookie must NOT be present — cookie is staged only after all fallible work
      expect(res.headers.get('Set-Cookie')).toBeNull();
    });
  });

  describe('POST /auth/logout', () => {
    it('returns 200 with logout cookie', async () => {
      const res = await app.request('/auth/logout', { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0');
    });
  });

  describe('GET /auth/session', () => {
    it('returns 401 when no session (requireAdminSession returns null)', async () => {
      const res = await app.request('/auth/session');
      expect(res.status).toBe(401);
    });

    it('returns 200 with session data when authenticated', async () => {
      vi.mocked(requireAdminSession).mockResolvedValueOnce({
        address: '0xADMIN',
        iat: 1000,
        exp: 2000,
        iatMs: 1000000,
      });
      const res = await app.request('/auth/session');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.address).toBe('0xADMIN');
      expect(body.exp).toBe(2000);
    });
  });

  describe('POST /auth/renew', () => {
    it('returns 429 when rate limited', async () => {
      const { checkAndIncrement } = await import('@stelis/core-api/admin');
      (checkAndIncrement as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        allowed: false,
        current: 6,
        retryAfterMs: 900000,
      });
      const res = await app.request('/auth/renew', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nonce: 'test-nonce',
          signature: 'sig',
          address: '0x' + 'a'.repeat(64),
        }),
      });
      expect(res.status).toBe(429);
      await expect(res.json()).resolves.toEqual({
        error: 'Too many requests. Try again in 15 minutes.',
      });
    });

    it('calls resetAttempts on successful renew', async () => {
      const { resetAttempts } = await import('@stelis/core-api/admin');
      mockRedis.del.mockResolvedValueOnce(1); // nonce consumed
      const res = await app.request('/auth/renew', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nonce: 'valid-nonce',
          signature: 'valid-sig',
          address: '0x' + 'a'.repeat(64),
        }),
      });
      expect(res.status).toBe(200);
      expect(resetAttempts).toHaveBeenCalled();
    });
  });

  describe('Redis acquire failure', () => {
    it('POST /auth/verify returns 500 when getAdminRedis rejects', async () => {
      vi.mocked(getRedisForAdmin).mockRejectedValueOnce(new Error('Redis unavailable'));
      const res = await app.request('/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce: 'n', signature: 's', address: '0x' + 'a'.repeat(64) }),
      });
      expect(res.status).toBe(500);
    });

    it('POST /auth/renew returns 500 when getAdminRedis rejects', async () => {
      vi.mocked(getRedisForAdmin).mockRejectedValueOnce(new Error('Redis unavailable'));
      const res = await app.request('/auth/renew', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce: 'n', signature: 's', address: '0x' + 'a'.repeat(64) }),
      });
      expect(res.status).toBe(500);
    });
  });
});
