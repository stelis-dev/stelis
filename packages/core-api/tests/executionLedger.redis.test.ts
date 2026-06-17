/**
 * RedisPromotionExecutionLedger — conformance tests.
 *
 * Runs the shared conformance suite against the Redis implementation.
 * Uses redis-memory-server for isolated test instances.
 * Gracefully skipped if redis/redis-memory-server are not available.
 */

import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { wrapRedisClient } from '../src/store/redisClient.js';
import type { RawRedisClient } from '../src/store/redisClient.js';
import { RedisPromotionExecutionLedger } from '../src/studio/executionLedgerRedis.js';
import { RedisPromotionStore } from '../src/studio/promotionStore.js';
import { runLedgerConformanceTests } from './executionLedger.conformance.js';

const require = createRequire(import.meta.url);

type RedisModule = typeof import('redis');
type RedisMemoryServerModule = {
  RedisMemoryServer: new () => {
    getHost(): Promise<string>;
    getPort(): Promise<number>;
    stop(): Promise<void>;
  };
};

let redisModule: RedisModule | null = null;
let redisMemoryServerModule: RedisMemoryServerModule | null = null;

try {
  redisModule = require('redis') as RedisModule;
  redisMemoryServerModule = require('redis-memory-server') as RedisMemoryServerModule;
} catch {
  // Optional: skipped if not installed
}

async function canBindLocalPort(): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(0, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

const canRun = await canBindLocalPort();
const describeIfReady = redisModule && redisMemoryServerModule && canRun ? describe : describe.skip;

describeIfReady('RedisPromotionExecutionLedger', () => {
  let server: InstanceType<RedisMemoryServerModule['RedisMemoryServer']> | null = null;
  let rawClient: Awaited<ReturnType<RedisModule['createClient']>> | null = null;

  beforeAll(async () => {
    server = new redisMemoryServerModule!.RedisMemoryServer();
    const host = await server.getHost();
    const port = await server.getPort();
    rawClient = redisModule!.createClient({ url: `redis://${host}:${port}` });
    await rawClient.connect();
  });

  afterAll(async () => {
    if (rawClient?.isOpen) {
      await rawClient.quit();
    }
    if (server) {
      await server.stop();
    }
  });

  runLedgerConformanceTests(
    // Normal factory: fresh Redis state per test via FLUSHDB
    async () => {
      await rawClient!.sendCommand(['FLUSHDB']);
      const client = wrapRedisClient(rawClient! as unknown as RawRedisClient);
      // Disable reaper (very long interval) for normal tests
      return new RedisPromotionExecutionLedger(client, 60_000, 999_999_999);
    },
    // Sweep factory: TTL=0 so reservations expire immediately
    async () => {
      await rawClient!.sendCommand(['FLUSHDB']);
      const client = wrapRedisClient(rawClient! as unknown as RawRedisClient);
      return new RedisPromotionExecutionLedger(client, 0, 999_999_999);
    },
  );

  // ─────────────────────────────────────────────
  // Redis claim status re-check
  // ─────────────────────────────────────────────

  describe('claim — promotion_not_active race closure (Redis-only)', () => {
    beforeEach(async () => {
      await rawClient!.sendCommand(['FLUSHDB']);
    });

    it('rejects claim with promotion_not_active when canonical record has status !== "active"', async () => {
      const client = wrapRedisClient(rawClient! as unknown as RawRedisClient);
      const store = new RedisPromotionStore(client);
      const record = await store.create({
        type: 'gas_sponsorship',
        displayName: 'D-test',
        description: 'race closure test',
        maxParticipants: 10,
        perUserGasAllowanceMist: '5000000',
        claimDeadlineAt: null,
        postClaimUseWindowMs: 0,
        startAt: null,
      });
      await store.transitionStatus(record.promotionId, 'active');
      // Admin flip: pause the promotion after activation.
      await store.transitionStatus(record.promotionId, 'paused');

      const ledger = new RedisPromotionExecutionLedger(
        client,
        60_000,
        999_999_999,
        undefined,
        (pid) => store.recordKey(pid),
      );

      const result = await ledger.claim(record.promotionId, 'user-race', {
        maxParticipants: 10,
        perUserGasAllowanceMist: '5000000',
        useUntilAt: null,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('promotion_not_active');

      // Side-effect assertion: claim index must remain empty — the Lua
      // script aborts BEFORE SET/SADD when status is not active.
      const count = await ledger.getClaimedCount(record.promotionId);
      expect(count).toBe(0);
    });

    it('rejects claim with promotion_not_active when canonical record is missing', async () => {
      const client = wrapRedisClient(rawClient! as unknown as RawRedisClient);
      const store = new RedisPromotionStore(client);

      const ledger = new RedisPromotionExecutionLedger(
        client,
        60_000,
        999_999_999,
        undefined,
        (pid) => store.recordKey(pid),
      );

      const result = await ledger.claim('nonexistent-promo', 'user-x', {
        maxParticipants: 10,
        perUserGasAllowanceMist: '5000000',
        useUntilAt: null,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('promotion_not_active');
    });

    it('succeeds when canonical record has status === "active"', async () => {
      const client = wrapRedisClient(rawClient! as unknown as RawRedisClient);
      const store = new RedisPromotionStore(client);
      const record = await store.create({
        type: 'gas_sponsorship',
        displayName: 'D-test-2',
        description: 'active passes',
        maxParticipants: 10,
        perUserGasAllowanceMist: '5000000',
        claimDeadlineAt: null,
        postClaimUseWindowMs: 0,
        startAt: null,
      });
      await store.transitionStatus(record.promotionId, 'active');

      const ledger = new RedisPromotionExecutionLedger(
        client,
        60_000,
        999_999_999,
        undefined,
        (pid) => store.recordKey(pid),
      );

      const result = await ledger.claim(record.promotionId, 'user-ok', {
        maxParticipants: 10,
        perUserGasAllowanceMist: '5000000',
        useUntilAt: null,
      });

      expect(result.ok).toBe(true);
    });
  });
});
