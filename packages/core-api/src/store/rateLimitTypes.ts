/**
 * RateLimitAdapter — interface for rate limiting (strategy pattern).
 *
 * Implementations (see also `docs/security.md` "Store Strategy"):
 *   - `RedisRateLimiter` — required for production hosts; `app-api`
 *     injects this at boot.
 *   - `MemoryRateLimiter` — test-only fixture; not exported from the
 *     `@stelis/core-api` main barrel and not used as a runtime
 *     fallback.
 */

export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Milliseconds until the next allowed request (only when blocked) */
  retryAfterMs?: number;
  /** Current request count in the window */
  current: number;
  /** Maximum allowed requests per window */
  limit: number;
}

export interface RateLimitConfig {
  /** Window duration in milliseconds */
  windowMs: number;
  /** Maximum requests per window */
  maxRequests: number;
}

export interface RateLimitAdapter {
  /** Check if a request is allowed for the given key. Increments the counter. */
  check(key: string): Promise<RateLimitResult>;
}
