import type { RedisClientLike } from './redisClient.js';
import { type Clock, systemClock } from '../clock.js';

export interface PrepareRequestNonceStore {
  claim(senderAddress: string, requestNonce: string, ttlMs: number): Promise<'ok' | 'duplicate'>;
}

export class MemoryPrepareRequestNonceStore implements PrepareRequestNonceStore {
  private readonly _entries = new Map<string, number>();
  private readonly _clock: Clock;

  constructor(clock: Clock = systemClock) {
    this._clock = clock;
  }

  async claim(
    senderAddress: string,
    requestNonce: string,
    ttlMs: number,
  ): Promise<'ok' | 'duplicate'> {
    const now = this._clock.nowMs();
    this.prune(now);
    const key = nonceKey(senderAddress, requestNonce);
    const expiresAt = this._entries.get(key);
    if (expiresAt !== undefined && expiresAt > now) return 'duplicate';
    this._entries.set(key, now + ttlMs);
    return 'ok';
  }

  private prune(now: number): void {
    for (const [key, expiresAt] of this._entries) {
      if (expiresAt <= now) this._entries.delete(key);
    }
  }
}

export interface RedisPrepareRequestNonceStoreOptions {
  keyPrefix?: string;
}

export class RedisPrepareRequestNonceStore implements PrepareRequestNonceStore {
  private readonly _client: RedisClientLike;
  private readonly _keyPrefix: string;

  constructor(client: RedisClientLike, options: RedisPrepareRequestNonceStoreOptions = {}) {
    this._client = client;
    this._keyPrefix = options.keyPrefix ?? 'stelis:prepare-request-nonce:';
  }

  async claim(
    senderAddress: string,
    requestNonce: string,
    ttlMs: number,
  ): Promise<'ok' | 'duplicate'> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error('RedisPrepareRequestNonceStore: ttlMs must be a positive safe integer');
    }
    const result = await this._client.set(this.key(senderAddress, requestNonce), '1', {
      nx: true,
      px: ttlMs,
    });
    return result === 'OK' ? 'ok' : 'duplicate';
  }

  private key(senderAddress: string, requestNonce: string): string {
    return `${this._keyPrefix}${nonceKey(senderAddress, requestNonce)}`;
  }
}

function nonceKey(senderAddress: string, requestNonce: string): string {
  return `${senderAddress}:${requestNonce}`;
}
