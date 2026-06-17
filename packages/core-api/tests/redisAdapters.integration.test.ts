import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisRateLimiter } from '../src/store/redisRateLimiter.js';
import { wrapRedisClient } from '../src/store/redisClient.js';
import type { RawRedisClient } from '../src/store/redisClient.js';

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
  // Optional integration dependency. The suite is skipped until the packages are installed.
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

const canRunRedisMemoryServer = await canBindLocalPort();
const describeIfReady =
  redisModule && redisMemoryServerModule && canRunRedisMemoryServer ? describe : describe.skip;

describeIfReady('Redis-backed adapters — redis-memory-server smoke', () => {
  let server: InstanceType<RedisMemoryServerModule['RedisMemoryServer']> | null = null;
  let client: Awaited<ReturnType<RedisModule['createClient']>> | null = null;
  let initError: unknown = null;

  beforeAll(async () => {
    try {
      server = new redisMemoryServerModule!.RedisMemoryServer();
      const host = await server.getHost();
      const port = await server.getPort();

      client = redisModule!.createClient({ url: `redis://${host}:${port}` });
      await client.connect();
    } catch (error) {
      initError = error;
    }
  });

  afterAll(async () => {
    if (client?.isOpen) {
      await client.quit();
    }
    if (server) {
      await server.stop();
    }
  });

  it('runs the rate-limit happy path against a real Redis process', async (context) => {
    if (initError) {
      context.skip();
      return;
    }

    const limiter = new RedisRateLimiter(wrapRedisClient(client! as unknown as RawRedisClient), {
      windowMs: 1_000,
      maxRequests: 1,
    });

    await expect(limiter.check('ip:1')).resolves.toMatchObject({
      allowed: true,
      current: 1,
      limit: 1,
    });
    await expect(limiter.check('ip:1')).resolves.toMatchObject({
      allowed: false,
      current: 2,
      limit: 1,
    });
  });

  it('RedisPrepareStore — store → consume happy path with BigInt ★', async (context) => {
    if (initError) {
      context.skip();
      return;
    }

    const { RedisPrepareStore } = await import('../src/store/redisPrepareStore.js');
    const released: string[] = [];
    const store = new RedisPrepareStore(
      wrapRedisClient(client! as unknown as RawRedisClient),
      (slotId) => {
        released.push(slotId);
      },
      { keyPrefix: 'test:ps:', ttlMs: 60_000 },
    );

    const entry = {
      issuedAt: Date.now(),
      receiptId: 'integ-pay-001',
      senderAddress: '0xINTEG_SENDER',
      nonce: 1n,
      executionPathKey: 'direct',
      txBytesHash: 'hash-integ',
      slotId: 'slot-integ',
      sponsorAddress: '0xSP',
      clientIp: '10.0.0.99',
      orderId: null,
      mode: 'generic' as const,
    };

    await store.store('integ-pay-001', entry);
    const result = await store.consume('integ-pay-001', 'hash-integ');
    expect(result).not.toBe('not_found');
    expect(result).not.toBe('expired');
    expect(result).not.toBe('hash_mismatch');
    const consumed = result as typeof entry;
    // Coordination-only round-trip: settle observability copies
    // (relayerClaim, simGas, ...) are never persisted.
    expect(consumed.txBytesHash).toBe('hash-integ');
    expect(consumed.nonce).toBe(1n);
    expect(consumed.mode).toBe('generic');
    expect(released).toHaveLength(0);
  });

  it('RedisPrepareStore — hash_mismatch releases slot ★', async (context) => {
    if (initError) {
      context.skip();
      return;
    }

    const { RedisPrepareStore } = await import('../src/store/redisPrepareStore.js');
    const released: string[] = [];
    const store = new RedisPrepareStore(
      wrapRedisClient(client! as unknown as RawRedisClient),
      (slotId) => {
        released.push(slotId);
      },
      { keyPrefix: 'test:ps2:', ttlMs: 60_000 },
    );

    const entry = {
      issuedAt: Date.now(),
      receiptId: 'integ-pay-002',
      senderAddress: '0xINTEG_SENDER_2',
      nonce: 1n,
      executionPathKey: 'direct',
      txBytesHash: 'correct-hash',
      slotId: 'slot-mismatch',
      sponsorAddress: '0xSP',
      clientIp: '10.0.0.88',
      orderId: null,
      mode: 'generic' as const,
    };

    await store.store('integ-pay-002', entry);
    const result = await store.consume('integ-pay-002', 'wrong-hash');
    expect(result).toBe('hash_mismatch');
    expect(released).toContain('slot-mismatch');

    // Entry should be deleted
    const second = await store.consume('integ-pay-002', 'correct-hash');
    expect(second).toBe('not_found');
  });

  it('RedisPrepareStore — reserveNonce derives from live sender metadata ★', async (context) => {
    if (initError) {
      context.skip();
      return;
    }

    const { RedisPrepareStore } = await import('../src/store/redisPrepareStore.js');
    const wrapped = wrapRedisClient(client! as unknown as RawRedisClient);
    const store = new RedisPrepareStore(wrapped, () => {}, {
      keyPrefix: 'test:ps3:',
      ttlMs: 60_000,
    });

    await store.store('integ-pay-003', {
      issuedAt: Date.now(),
      receiptId: 'integ-pay-003',
      nonce: 7n,
      executionPathKey: 'direct',
      txBytesHash: 'hash-integ-3',
      slotId: 'slot-integ-3',
      sponsorAddress: '0xSP',
      clientIp: '10.0.0.77',
      orderId: null,
      senderAddress: '0xRECOVER',
      mode: 'generic',
    });

    await expect(store.reserveNonce('0xRECOVER', 0n, 'res-1')).resolves.toBe(8n);
  });

  it('RedisPrepareStore — releaseReservation preserves a live entry promoted under same receiptId ★', async (context) => {
    // Locks the Lua releaseReservation contract against the real Redis
    // server: after store() promotes a pending reservation to a live
    // sender-metadata entry, a direct releaseReservation under the same
    // receiptId must remove only pending reservations. The live entry's
    // nonce must still raise the next reservation. FakeRedisClient
    // reimplements the Lua, so this case is the authoritative check that
    // the real script (`redis.call('GET' ... cjson.decode ...
    // not (item.pending and item.pid == resId)`) behaves as specified.
    if (initError) {
      context.skip();
      return;
    }

    const { RedisPrepareStore } = await import('../src/store/redisPrepareStore.js');
    const wrapped = wrapRedisClient(client! as unknown as RawRedisClient);
    const store = new RedisPrepareStore(wrapped, () => {}, {
      keyPrefix: 'test:ps4:',
      ttlMs: 60_000,
    });

    const sender = '0xLIVE_PRESERVE';
    const live = await store.reserveNonce(sender, 5n, 'integ-pay-004');
    expect(live).toBe(6n);

    await store.store('integ-pay-004', {
      issuedAt: Date.now(),
      receiptId: 'integ-pay-004',
      nonce: live,
      executionPathKey: 'direct',
      txBytesHash: 'hash-integ-4',
      slotId: 'slot-integ-4',
      sponsorAddress: '0xSP',
      clientIp: '10.0.0.66',
      orderId: null,
      senderAddress: sender,
      mode: 'generic',
    });

    // Direct release after promotion — must be a no-op for the live entry.
    await store.releaseReservation('integ-pay-004', sender);

    // Live nonce must still raise the next reservation.
    await expect(store.reserveNonce(sender, 5n, 'integ-pay-004b')).resolves.toBe(7n);

    // The live entry itself must remain peekable, unchanged.
    const peeked = await store.peek('integ-pay-004');
    expect(peeked).not.toBeNull();
    expect(peeked!.nonce).toBe(live);
    expect(peeked!.txBytesHash).toBe('hash-integ-4');

    await store.releaseReservation('integ-pay-004b', sender);
  });
});
