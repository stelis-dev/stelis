/**
 * Admin operations rate limiter policy.
 *
 * Policy:
 *   - Counts POST admin operation attempts only (GET nonce excluded)
 *   - No reset on success (unlike auth limiter)
 *   - bounded attempts per fixed window per IP
 *   - Stored in Redis: admin:operations_rate:{ip}
 *
 * Separate bucket from auth rate limiter — withdrawal attempts
 * do not consume auth rate limit, and vice versa.
 *
 * The counter uses an atomic Lua INCR+PEXPIRE script to prevent
 * read-then-increment races and immortal-key issues.
 */
import type { AdminRedisClient } from './adminRedis.js';
import {
  FIXED_WINDOW_INCR_SCRIPT,
  parseFixedWindowResult,
} from '../store/redisFixedWindowCounter.js';
import type { AdminRateLimitResult } from './adminRateLimit.js';

const ADMIN_OPERATIONS_RATE_WINDOW_MS = 15 * 60 * 1000;
export const ADMIN_OPERATIONS_RATE_LIMIT_MAX = 5;
const ADMIN_OPERATIONS_RATE_KEY_PREFIX = 'admin:operations_rate:';

export function getAdminOperationsRateLimitKey(ip: string): string {
  return `${ADMIN_OPERATIONS_RATE_KEY_PREFIX}${ip}`;
}

/**
 * Atomically increments the admin operation attempt counter and checks against the limit.
 * No reset on success — counter persists for the full window.
 */
export async function checkAndIncrementAdminOperationAttempt(
  redis: AdminRedisClient,
  ip: string,
): Promise<AdminRateLimitResult> {
  const key = getAdminOperationsRateLimitKey(ip);
  const { current, pttlMs } = parseFixedWindowResult(
    await redis.eval(FIXED_WINDOW_INCR_SCRIPT, [key], [String(ADMIN_OPERATIONS_RATE_WINDOW_MS)]),
  );
  return {
    allowed: current <= ADMIN_OPERATIONS_RATE_LIMIT_MAX,
    current,
    retryAfterMs: Math.max(pttlMs, 0),
  };
}
