/**
 * Admin auth rate limiter policy.
 *
 * Policy:
 *   - bounded total auth attempts per IP per fixed window
 *   - counts all auth attempts at route entry (nonce, verify, renew)
 *   - counter resets on successful login/renew
 *   - stored in Redis: stelis:admin:auth_rate:{ip}
 *
 * The counter uses an atomic Lua INCR+PEXPIRE script to prevent
 * read-then-increment races and immortal-key issues.
 */
import type { AdminRedisClient } from './adminRedis.js';
import {
  FIXED_WINDOW_INCR_SCRIPT,
  parseFixedWindowResult,
} from '../store/redisFixedWindowCounter.js';

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const RATE_LIMIT_MAX = 5;
const KEY_PREFIX = 'stelis:admin:auth_rate:';

export function getRateLimitKey(ip: string): string {
  return `${KEY_PREFIX}${ip}`;
}

export interface AdminRateLimitResult {
  allowed: boolean;
  current: number;
  retryAfterMs: number;
}

/**
 * Atomically increments the auth attempt counter and checks against the limit.
 * Returns whether the request is allowed.
 */
export async function checkAndIncrement(
  redis: AdminRedisClient,
  ip: string,
): Promise<AdminRateLimitResult> {
  const key = getRateLimitKey(ip);
  const { current, pttlMs } = parseFixedWindowResult(
    await redis.eval(FIXED_WINDOW_INCR_SCRIPT, [key], [String(RATE_LIMIT_WINDOW_MS)]),
  );
  return {
    allowed: current <= RATE_LIMIT_MAX,
    current,
    retryAfterMs: Math.max(pttlMs, 0),
  };
}

/**
 * Resets attempt counter after a successful login/renew.
 */
export async function resetAttempts(redis: AdminRedisClient, ip: string): Promise<void> {
  const key = getRateLimitKey(ip);
  await redis.del(key);
}
