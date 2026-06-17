/**
 * RateLimitAdapter — shared conformance test suite.
 *
 * Both MemoryRateLimiter and RedisRateLimiter must pass this suite.
 * The factory parameter lets each implementation provide its own
 * setup (in-memory map vs injected Redis client).
 *
 * Memory-only cases (bounded-map saturation) live in
 * `memoryRateLimiter.test.ts`. No Redis equivalent exists for that
 * shape because the Redis backend relies on Redis-side TTL keyspace,
 * not a bounded in-process map.
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RateLimitAdapter } from '../src/store/rateLimitTypes.js';

// ─────────────────────────────────────────────
// Factory contract
// ─────────────────────────────────────────────

export interface RateLimiterHandle {
  limiter: RateLimitAdapter;
  /** Idempotent per-test cleanup hook. */
  dispose(): Promise<void> | void;
}

export interface RateLimiterFactoryOpts {
  windowMs: number;
  maxRequests: number;
}

export type RateLimiterFactory = (
  opts: RateLimiterFactoryOpts,
) => Promise<RateLimiterHandle> | RateLimiterHandle;

// ─────────────────────────────────────────────
// Conformance suite
// ─────────────────────────────────────────────

export function runRateLimitConformanceTests(factory: RateLimiterFactory): void {
  let handle: RateLimiterHandle | null = null;

  async function setup(opts: Partial<RateLimiterFactoryOpts> = {}): Promise<RateLimiterHandle> {
    const resolved: RateLimiterFactoryOpts = {
      windowMs: 1_000,
      maxRequests: 2,
      ...opts,
    };
    handle = await factory(resolved);
    return handle;
  }

  beforeEach(() => {
    // Both backends rely on Date.now(), so fake timers apply uniformly.
    // Redis uses Lua PTTL but FakeRedisClient mirrors wall-clock via
    // vi.setSystemTime, so advancing the clock expires Redis keys too.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-15T00:00:00.000Z'));
  });

  afterEach(async () => {
    if (handle) {
      await handle.dispose();
      handle = null;
    }
    vi.useRealTimers();
  });

  it('allows requests under the limit', async () => {
    const { limiter } = await setup({ windowMs: 60_000, maxRequests: 3 });

    const r1 = await limiter.check('k1');
    expect(r1.allowed).toBe(true);
    expect(r1.current).toBe(1);
    expect(r1.limit).toBe(3);

    const r2 = await limiter.check('k1');
    expect(r2.allowed).toBe(true);
    expect(r2.current).toBe(2);
  });

  it('blocks requests over the limit with a positive retryAfterMs', async () => {
    const { limiter } = await setup({ windowMs: 1_000, maxRequests: 2 });

    await expect(limiter.check('k1')).resolves.toMatchObject({
      allowed: true,
      current: 1,
      limit: 2,
    });
    await expect(limiter.check('k1')).resolves.toMatchObject({
      allowed: true,
      current: 2,
      limit: 2,
    });

    const blocked = await limiter.check('k1');
    expect(blocked.allowed).toBe(false);
    expect(blocked.current).toBe(3);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it('resets the window after TTL elapses', async () => {
    const { limiter } = await setup({ windowMs: 1_000, maxRequests: 2 });

    await limiter.check('k1');
    await limiter.check('k1');
    const blocked = await limiter.check('k1');
    expect(blocked.allowed).toBe(false);

    // Advance past the window. Both memory (Date.now-based) and Redis
    // (PTTL-based via FakeRedisClient's synchronized clock) must reset.
    vi.advanceTimersByTime(1_001);

    await expect(limiter.check('k1')).resolves.toMatchObject({
      allowed: true,
      current: 1,
      limit: 2,
    });
  });

  it('tracks distinct keys independently', async () => {
    const { limiter } = await setup({ windowMs: 60_000, maxRequests: 1 });

    await expect(limiter.check('alpha')).resolves.toMatchObject({ allowed: true });
    await expect(limiter.check('beta')).resolves.toMatchObject({ allowed: true });

    // Each key is at its limit; a second hit on either is blocked.
    await expect(limiter.check('alpha')).resolves.toMatchObject({ allowed: false });
    await expect(limiter.check('beta')).resolves.toMatchObject({ allowed: false });
  });
}
