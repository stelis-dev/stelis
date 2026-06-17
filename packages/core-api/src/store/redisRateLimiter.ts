import type { RateLimitAdapter, RateLimitConfig, RateLimitResult } from './rateLimitTypes.js';
import type { RedisClientLike } from './redisClient.js';
import { FIXED_WINDOW_INCR_SCRIPT, parseFixedWindowResult } from './redisFixedWindowCounter.js';

export interface RedisRateLimiterOptions {
  keyPrefix?: string;
}

export class RedisRateLimiter implements RateLimitAdapter {
  private readonly _client: RedisClientLike;
  private readonly _windowMs: number;
  private readonly _maxRequests: number;
  private readonly _keyPrefix: string;

  constructor(
    client: RedisClientLike,
    config: RateLimitConfig,
    options: RedisRateLimiterOptions = {},
  ) {
    if (!Number.isSafeInteger(config.windowMs) || config.windowMs <= 0) {
      throw new Error('RedisRateLimiter: windowMs must be a positive safe integer');
    }
    if (!Number.isSafeInteger(config.maxRequests) || config.maxRequests <= 0) {
      throw new Error('RedisRateLimiter: maxRequests must be a positive safe integer');
    }
    this._client = client;
    this._windowMs = config.windowMs;
    this._maxRequests = config.maxRequests;
    this._keyPrefix = options.keyPrefix ?? 'stelis:rate_limit:';
  }

  async check(key: string): Promise<RateLimitResult> {
    const { current, pttlMs } = parseFixedWindowResult(
      await this._client.eval(
        FIXED_WINDOW_INCR_SCRIPT,
        [this.rateKey(key)],
        [String(this._windowMs)],
      ),
    );

    if (current > this._maxRequests) {
      return {
        allowed: false,
        retryAfterMs: Math.max(pttlMs, 0),
        current,
        limit: this._maxRequests,
      };
    }

    return {
      allowed: true,
      current,
      limit: this._maxRequests,
    };
  }

  private rateKey(key: string): string {
    return `${this._keyPrefix}${key}`;
  }
}
