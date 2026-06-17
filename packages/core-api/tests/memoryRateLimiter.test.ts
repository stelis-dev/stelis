/**
 * MemoryRateLimiter — RateLimitAdapter conformance + memory-only cases.
 *
 * The shared behavioral contract is exercised by
 * `rateLimiter.conformance.ts`. Memory-only cases (MAX_KEYS bounded
 * map saturation) live below. No Redis analog exists for that shape —
 * `RedisRateLimiter` relies on the Redis keyspace + PTTL, not an
 * in-process bounded map.
 */
import { describe, expect, it } from 'vitest';
import { MemoryRateLimiter } from '../src/store/memoryRateLimiter.js';
import {
  runRateLimitConformanceTests,
  type RateLimiterFactory,
  type RateLimiterHandle,
} from './rateLimiter.conformance.js';

const memoryFactory: RateLimiterFactory = ({ windowMs, maxRequests }) => {
  const limiter = new MemoryRateLimiter({ windowMs, maxRequests });
  const handle: RateLimiterHandle = {
    limiter,
    dispose: () => {
      /* no-op — MemoryRateLimiter holds no timers */
    },
  };
  return handle;
};

describe('MemoryRateLimiter — shared conformance', () => {
  runRateLimitConformanceTests(memoryFactory);
});

describe('MemoryRateLimiter — impl-only', () => {
  it('still tracks a fresh key when map is saturated (no fail-open)', async () => {
    // MAX_KEYS = 50_000 inside memoryRateLimiter.ts. Saturate the map
    // and verify that a fresh key is still tracked (i.e. bounded-map
    // eviction does not silently drop admissions).
    const limiter = new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 2 });
    for (let i = 0; i < 50_000; i++) {
      await limiter.check(`key-${i}`);
    }

    const freshKey = 'fresh-attacker';
    await limiter.check(freshKey);
    await limiter.check(freshKey);
    const third = await limiter.check(freshKey);
    expect(third.allowed).toBe(false);
  });
});
