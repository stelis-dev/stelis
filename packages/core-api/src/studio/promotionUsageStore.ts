/**
 * Promotion Usage / Event Store — append-only sponsored action diagnostics.
 *
 * Records each sponsored action event (reserve, consume, release, failure)
 * as an append-only entry keyed by receiptId and linked to promotionId + userId.
 *
 * IMPORTANT: This is NOT the primary store for remaining allowance or status.
 * The `PromotionExecutionLedger` owns current user state and
 * budget/allowance accounting. This store is for operator diagnostics and
 * audit trail.
 *
 * Retention: entries have explicit TTL. Aggregate counters (entitlement
 * remaining/consumed, budget available/reserved/consumed) are maintained
 * atomically in the ExecutionLedger and do not depend on raw event retention.
 *
 * Value types (`UsageEvent`, `UsageEventResult`, `CreateUsageEventInput`)
 * live in `domain.ts`; this module only owns the adapter interface and
 * implementations.
 *
 * @module promotionUsageStore
 */

import type { RedisClientLike } from '../store/redisClient.js';
import type { CreateUsageEventInput, UsageEvent } from './domain.js';

// ─────────────────────────────────────────────
// Store Interface
// ─────────────────────────────────────────────

export interface PromotionUsageStoreAdapter {
  /**
   * Append a usage event. Deduplicated by receiptId + result.
   * Returns the created event with createdAt populated.
   */
  append(input: CreateUsageEventInput): Promise<UsageEvent>;

  /**
   * Get all events for a specific receipt.
   * Returns events in chronological order.
   */
  getByReceipt(receiptId: string): Promise<UsageEvent[]>;

  /**
   * Get events for a specific user in a promotion.
   * Returns events in reverse-chronological order (newest first).
   * Limited to `limit` entries. Default: `DEFAULT_USER_QUERY_LIMIT`.
   */
  getByUser(promotionId: string, userId: string, limit?: number): Promise<UsageEvent[]>;

  /**
   * Get events for a promotion.
   * Returns events in reverse-chronological order (newest first).
   * Limited to `limit` entries. Default: `DEFAULT_PROMO_QUERY_LIMIT`.
   */
  getByPromotion(promotionId: string, limit?: number): Promise<UsageEvent[]>;
}

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

/**
 * Default retention window for usage events.
 * Bounded retention with an explicit runtime parameter.
 * See docs/parameters.md#ttl-constants.
 */
export const DEFAULT_USAGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const DEFAULT_USER_QUERY_LIMIT = 50;
const DEFAULT_PROMO_QUERY_LIMIT = 100;

// ─────────────────────────────────────────────
// Memory Implementation (testing)
// ─────────────────────────────────────────────

export class MemoryPromotionUsageStore implements PromotionUsageStoreAdapter {
  private readonly _events: UsageEvent[] = [];
  private readonly _retentionMs: number;

  constructor(retentionMs = DEFAULT_USAGE_RETENTION_MS) {
    this._retentionMs = retentionMs;
  }

  async append(input: CreateUsageEventInput): Promise<UsageEvent> {
    // Deduplicate by receiptId + result
    const existing = this._events.find(
      (e) => e.receiptId === input.receiptId && e.result === input.result,
    );
    if (existing) return { ...existing };

    const event: UsageEvent = {
      ...input,
      createdAt: new Date().toISOString(),
    };
    this._events.push(event);
    return { ...event };
  }

  async getByReceipt(receiptId: string): Promise<UsageEvent[]> {
    this._sweep();
    return this._events.filter((e) => e.receiptId === receiptId).map((e) => ({ ...e }));
  }

  async getByUser(
    promotionId: string,
    userId: string,
    limit = DEFAULT_USER_QUERY_LIMIT,
  ): Promise<UsageEvent[]> {
    this._sweep();
    return this._events
      .filter((e) => e.promotionId === promotionId && e.userId === userId)
      .reverse()
      .slice(0, limit)
      .map((e) => ({ ...e }));
  }

  async getByPromotion(
    promotionId: string,
    limit = DEFAULT_PROMO_QUERY_LIMIT,
  ): Promise<UsageEvent[]> {
    this._sweep();
    return this._events
      .filter((e) => e.promotionId === promotionId)
      .reverse()
      .slice(0, limit)
      .map((e) => ({ ...e }));
  }

  /** Remove events older than retention window. */
  private _sweep(): void {
    const cutoff = Date.now() - this._retentionMs;
    let i = 0;
    while (i < this._events.length) {
      if (new Date(this._events[i].createdAt).getTime() < cutoff) {
        this._events.splice(i, 1);
      } else {
        i++;
      }
    }
  }
}

// ─────────────────────────────────────────────
// Redis Implementation (production)
// ─────────────────────────────────────────────

/**
 * Redis key layout:
 *   stelis:promo:usage:receipt:{receiptId}          → LIST of JSON entries (dedupe source)
 *   stelis:promo:usage:user:{promotionId}:{userId}  → LIST of event JSONs (capped, newest-first)
 *   stelis:promo:usage:promo:{promotionId}          → LIST of event JSONs (capped, newest-first)
 *
 * Index lists store event JSON directly (not receiptIds) to preserve
 * append-only event semantics. Same receiptId may appear multiple times
 * in indexes (reserved → consumed → released lifecycle).
 *
 * Entries have PX TTL matching retention window.
 * Lists are capped to avoid unbounded growth.
 */
export class RedisPromotionUsageStore implements PromotionUsageStoreAdapter {
  private readonly _redis: RedisClientLike;
  private readonly _retentionMs: number;
  private readonly _prefix: string;

  constructor(
    redis: RedisClientLike,
    retentionMs = DEFAULT_USAGE_RETENTION_MS,
    prefix = 'stelis:promo:usage',
  ) {
    this._redis = redis;
    this._retentionMs = retentionMs;
    this._prefix = prefix;
  }

  private _receiptKey(receiptId: string): string {
    return `${this._prefix}:receipt:${receiptId}`;
  }

  private _userKey(promotionId: string, userId: string): string {
    return `${this._prefix}:user:${promotionId}:${userId}`;
  }

  private _promoKey(promotionId: string): string {
    return `${this._prefix}:promo:${promotionId}`;
  }

  async append(input: CreateUsageEventInput): Promise<UsageEvent> {
    const event: UsageEvent = {
      ...input,
      createdAt: new Date().toISOString(),
    };

    const receiptKey = this._receiptKey(input.receiptId);
    const userKey = this._userKey(input.promotionId, input.userId);
    const promoKey = this._promoKey(input.promotionId);
    const json = JSON.stringify(event);

    // Use Lua to atomically: check dedupe, append to receipt list, add to indexes
    const result = await this._redis.eval(
      LUA_USAGE_APPEND,
      [receiptKey, userKey, promoKey],
      [
        json,
        input.result,
        input.receiptId,
        this._retentionMs.toString(),
        DEFAULT_USER_QUERY_LIMIT.toString(),
        DEFAULT_PROMO_QUERY_LIMIT.toString(),
      ],
    );

    if (result === 0) {
      // Deduplicated — find and return existing
      const events = await this.getByReceipt(input.receiptId);
      const existing = events.find((e) => e.result === input.result);
      return existing ?? event;
    }

    return event;
  }

  async getByReceipt(receiptId: string): Promise<UsageEvent[]> {
    const key = this._receiptKey(receiptId);
    const result = await this._redis.eval(
      `
      local entries = redis.call('LRANGE', KEYS[1], 0, -1)
      return entries
      `,
      [key],
      [],
    );
    if (!result) return [];
    const entries = result as string[];
    return entries.map((raw) => JSON.parse(raw) as UsageEvent);
  }

  async getByUser(
    promotionId: string,
    userId: string,
    limit = DEFAULT_USER_QUERY_LIMIT,
  ): Promise<UsageEvent[]> {
    const userKey = this._userKey(promotionId, userId);
    const result = await this._redis.eval(LUA_USAGE_GET_BY_INDEX, [userKey], [limit.toString()]);
    if (!result) return [];
    return (result as string[]).map((raw) => JSON.parse(raw) as UsageEvent);
  }

  async getByPromotion(
    promotionId: string,
    limit = DEFAULT_PROMO_QUERY_LIMIT,
  ): Promise<UsageEvent[]> {
    const promoKey = this._promoKey(promotionId);
    const result = await this._redis.eval(LUA_USAGE_GET_BY_INDEX, [promoKey], [limit.toString()]);
    if (!result) return [];
    return (result as string[]).map((raw) => JSON.parse(raw) as UsageEvent);
  }
}

// ─────────────────────────────────────────────
// Lua Scripts
// ─────────────────────────────────────────────

/**
 * APPEND — atomic dedupe + append + index update.
 *
 * KEYS: [1] receipt:{receiptId}, [2] user:{pid}:{uid}, [3] promo:{pid}
 * ARGV: [1] json, [2] result, [3] receiptId, [4] retentionMs,
 *        [5] userCap, [6] promoCap
 *
 * Index stores event JSON directly (not receiptId), so queries return
 * full append-only event list without indirection.
 *
 * Returns: 1 = appended, 0 = deduplicated
 */
const LUA_USAGE_APPEND = `
local receiptKey = KEYS[1]
local userKey    = KEYS[2]
local promoKey   = KEYS[3]
local json       = ARGV[1]
local result     = ARGV[2]
local receiptId  = ARGV[3]
local retMs      = tonumber(ARGV[4])
local userCap    = tonumber(ARGV[5])
local promoCap   = tonumber(ARGV[6])

-- Deduplicate by receiptId + result
local existing = redis.call('LRANGE', receiptKey, 0, -1)
for i = 1, #existing do
  local entry = cjson.decode(existing[i])
  if entry.result == result then
    return 0
  end
end

-- Append to receipt list (chronological)
redis.call('RPUSH', receiptKey, json)
redis.call('PEXPIRE', receiptKey, retMs)

-- Append event JSON directly to user index (LPUSH = newest first)
redis.call('LPUSH', userKey, json)
redis.call('LTRIM', userKey, 0, userCap - 1)
redis.call('PEXPIRE', userKey, retMs)

-- Append event JSON directly to promo index (LPUSH = newest first)
redis.call('LPUSH', promoKey, json)
redis.call('LTRIM', promoKey, 0, promoCap - 1)
redis.call('PEXPIRE', promoKey, retMs)

return 1
`;

/**
 * GET_BY_INDEX — read event JSONs directly from index list.
 *
 * KEYS: [1] index key (user or promo)
 * ARGV: [1] limit
 *
 * Returns: array of event JSON strings (newest first)
 */
const LUA_USAGE_GET_BY_INDEX = `
local indexKey = KEYS[1]
local limit    = tonumber(ARGV[1])

return redis.call('LRANGE', indexKey, 0, limit - 1)
`;
