/**
 * RedisSponsorPool — shared conformance entry.
 *
 * Uses FakeRedisClient which already emulates the Lua CAS scripts
 * for commit (LEASE_COMMIT_CAS_SCRIPT) and checkin (LEASE_CHECKIN_CAS_SCRIPT).
 *
 * Backend-specific tests (cursor rotation, key TTL recovery, Lua script
 * edge cases) remain in redisAdapters.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { PREPARE_TTL_MS } from '../src/preparePolicy.js';
import { RedisSponsorPool } from '../src/store/redisSponsorPool.js';
import { FakeRedisClient } from './helpers/fakeRedisClient.js';
import {
  runSponsorPoolConformanceTests,
  type SponsorPoolFactory,
} from './sponsorPool.conformance.js';

const TEST_HMAC_SECRET = 'test-hmac-secret-that-is-long-enough-for-validation';
const SAMPLE_TX_BYTES = new Uint8Array([0x01, 0x02, 0x03, 0x04]);

const redisFactory: SponsorPoolFactory = () => {
  const redis = new FakeRedisClient();
  const kp = Ed25519Keypair.generate();
  const pool = new RedisSponsorPool(redis, [kp], {
    hmacSecret: TEST_HMAC_SECRET,
    leaseTtlMs: 10_000,
  });
  return {
    pool,
    sampleTxBytes: SAMPLE_TX_BYTES,
    dispose: () => {},
  };
};

describe('RedisSponsorPool — shared conformance', () => {
  runSponsorPoolConformanceTests(redisFactory);
});

describe('RedisSponsorPool — constructor validation', () => {
  it('derives the default lease TTL from PREPARE_TTL_MS plus sponsor lease grace', async () => {
    const redis = new FakeRedisClient();
    const evalSpy = vi.spyOn(redis, 'eval');
    const kp = Ed25519Keypair.generate();
    const pool = new RedisSponsorPool(redis, [kp], { hmacSecret: TEST_HMAC_SECRET });

    await pool.checkout('receipt-default-ttl');

    expect(evalSpy).toHaveBeenCalledWith(
      expect.stringContaining('RedisSponsorPool LEASE_CHECKOUT_SCRIPT'),
      [expect.stringContaining(kp.toSuiAddress())],
      [String(PREPARE_TTL_MS + 5_000), kp.toSuiAddress(), expect.any(String)],
    );
  });

  it('rejects unsafe lease TTL values', () => {
    const redis = new FakeRedisClient();
    const kp = Ed25519Keypair.generate();
    expect(
      () => new RedisSponsorPool(redis, [kp], { hmacSecret: TEST_HMAC_SECRET, leaseTtlMs: 0 }),
    ).toThrow('leaseTtlMs');
    expect(
      () => new RedisSponsorPool(redis, [kp], { hmacSecret: TEST_HMAC_SECRET, leaseTtlMs: 1.5 }),
    ).toThrow('safe integer');
  });
});
