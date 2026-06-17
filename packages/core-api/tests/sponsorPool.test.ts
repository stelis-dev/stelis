/**
 * SponsorPool (in-memory) — shared conformance + memory-specific tests.
 */
import { describe } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SponsorPool } from '../src/context.js';
import {
  runSponsorPoolConformanceTests,
  type SponsorPoolFactory,
} from './sponsorPool.conformance.js';

const TEST_HMAC_SECRET = 'test-hmac-secret-that-is-long-enough-for-validation';
const SAMPLE_TX_BYTES = new Uint8Array([0x01, 0x02, 0x03, 0x04]);

const memoryFactory: SponsorPoolFactory = () => {
  const kp = Ed25519Keypair.generate();
  const pool = new SponsorPool([kp], { hmacSecret: TEST_HMAC_SECRET });
  return {
    pool,
    sampleTxBytes: SAMPLE_TX_BYTES,
    dispose: () => {},
  };
};

describe('SponsorPool (memory) — shared conformance', () => {
  runSponsorPoolConformanceTests(memoryFactory);
});
