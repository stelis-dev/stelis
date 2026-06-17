/**
 * [app-api] Cross-instance slot-scoped refill dispatch lock.
 *
 * Prevents two app-api instances from dispatching a refill to the same
 * sponsor slot concurrently. Acquired via `SET key value NX PX` with an
 * instance-unique token; released via Lua CAS that deletes only when the
 * stored token matches (mirrors `RedisSponsorPool.LEASE_CHECKIN_CAS_SCRIPT`).
 *
 * The TTL is supplied by the caller (refill worker): it must cover the
 * refill TX dispatch, the post-refill sponsor refill account probe, and the
 * `awaiting_confirmation` phase.
 * Orphaned locks after process death recover at TTL expiry.
 */

import { randomUUID } from 'node:crypto';
import type { RedisClientLike } from '@stelis/core-api';
import { SPONSOR_OPERATIONS_KEY_PREFIX } from './redisState.js';

export const refillLockKey = (slotAddress: string): string =>
  `${SPONSOR_OPERATIONS_KEY_PREFIX}refill-lock:${slotAddress}`;
export const sponsorRefillAccountDispatchLockKey = (
  sponsorRefillAccountAddress: string,
): string =>
  `${SPONSOR_OPERATIONS_KEY_PREFIX}sponsor-refill-account-dispatch-lock:${sponsorRefillAccountAddress}`;

/**
 * Lua CAS used by `release`:
 *   if GET(key) == ARGV[1] (expected token) DEL(key) return 'OK'
 *   else                                                return 'MISMATCH'
 * Mismatch is a silent no-op at the TS layer: TTL safety net covers it.
 */
const RELEASE_LUA = [
  "local current = redis.call('GET', KEYS[1])",
  'if current == ARGV[1] then',
  "  redis.call('DEL', KEYS[1])",
  "  return 'OK'",
  'end',
  "return 'MISMATCH'",
].join('\n');

export interface RefillLockHandle {
  /** Opaque token identifying the owner; required for release CAS. */
  readonly token: string;
  /** Slot address the lock is held for. */
  readonly slotAddress: string;
}

export interface SponsorRefillAccountDispatchLockHandle {
  /** Opaque token identifying the owner; required for release CAS. */
  readonly token: string;
  /** Sponsor refill account address the dispatch lock is held for. */
  readonly sponsorRefillAccountAddress: string;
}

export interface RefillLockDeps {
  readonly client: RedisClientLike;
  /**
   * Lock TTL in ms. Should equal the sum of all bounded phases executed
   * inside the locked window plus a small safety margin. The refill
   * worker derives this from the sponsor operations phase timers plus
   * `SPONSOR_OPERATIONS_REFILL_LOCK_SAFETY_MARGIN_MS`.
   */
  readonly ttlMs: number;
  /**
   * Optional instance-scoped prefix for the lock token. Useful in
   * multi-instance deployments for log correlation. Defaults to a short
   * constant; the token itself is randomised per acquisition.
   */
  readonly instanceId?: string;
}

export interface RefillLock {
  acquire(slotAddress: string): Promise<RefillLockHandle | null>;
  release(handle: RefillLockHandle): Promise<void>;
}

export interface SponsorRefillAccountDispatchLock {
  acquire(
    sponsorRefillAccountAddress: string,
  ): Promise<SponsorRefillAccountDispatchLockHandle | null>;
  release(handle: SponsorRefillAccountDispatchLockHandle): Promise<void>;
}

export function createRefillLock(deps: RefillLockDeps): RefillLock {
  if (!Number.isSafeInteger(deps.ttlMs) || deps.ttlMs <= 0) {
    throw new Error(
      `createRefillLock: ttlMs must be a positive safe integer, got ${String(deps.ttlMs)}`,
    );
  }
  const instanceId = deps.instanceId ?? 'app-api';

  async function acquire(slotAddress: string): Promise<RefillLockHandle | null> {
    const token = `${instanceId}:${randomUUID()}`;
    const key = refillLockKey(slotAddress);
    const result = await deps.client.set(key, token, { nx: true, px: deps.ttlMs });
    if (result !== 'OK') return null;
    return { token, slotAddress };
  }

  async function release(handle: RefillLockHandle): Promise<void> {
    const key = refillLockKey(handle.slotAddress);
    try {
      await deps.client.eval(RELEASE_LUA, [key], [handle.token]);
    } catch {
      // TTL safety net covers residual state; swallowing is intentional.
    }
  }

  return { acquire, release };
}

export function createSponsorRefillAccountDispatchLock(
  deps: RefillLockDeps,
): SponsorRefillAccountDispatchLock {
  if (!Number.isSafeInteger(deps.ttlMs) || deps.ttlMs <= 0) {
    throw new Error(
      `createSponsorRefillAccountDispatchLock: ttlMs must be a positive safe integer, got ${String(deps.ttlMs)}`,
    );
  }
  const instanceId = deps.instanceId ?? 'app-api';

  async function acquire(
    sponsorRefillAccountAddress: string,
  ): Promise<SponsorRefillAccountDispatchLockHandle | null> {
    const token = `${instanceId}:${randomUUID()}`;
    const key = sponsorRefillAccountDispatchLockKey(sponsorRefillAccountAddress);
    const result = await deps.client.set(key, token, { nx: true, px: deps.ttlMs });
    if (result !== 'OK') return null;
    return { token, sponsorRefillAccountAddress };
  }

  async function release(handle: SponsorRefillAccountDispatchLockHandle): Promise<void> {
    const key = sponsorRefillAccountDispatchLockKey(handle.sponsorRefillAccountAddress);
    try {
      await deps.client.eval(RELEASE_LUA, [key], [handle.token]);
    } catch {
      // TTL safety net covers residual state; swallowing is intentional.
    }
  }

  return { acquire, release };
}
