import { describe, expect, it } from 'vitest';
import { SponsorPool } from '../src/context.js';
import { parseSponsorKeys } from '../src/sponsorKeyParser.js';
import { MAX_SPONSOR_SLOT_COUNT } from '../src/sponsorSlotPolicy.js';
import { RedisSponsorPool } from '../src/store/redisSponsorPool.js';
import { FakeRedisClient } from './helpers/fakeRedisClient.js';

const TEST_HMAC_SECRET = 'sponsor-slot-policy-test-hmac-secret-00000';

function makeKeypair(index: number) {
  const address = `0x${index.toString(16).padStart(64, '0')}`;
  return {
    toSuiAddress: () => address,
    signTransaction: async () => ({ signature: `sig:${address}` }),
  };
}

describe('sponsor slot count policy', () => {
  it('parseSponsorKeys rejects more than the supported sponsor slot count', () => {
    const tooManyKeys = Array.from(
      { length: MAX_SPONSOR_SLOT_COUNT + 1 },
      (_, i) => `not-a-real-key-${i}`,
    );

    expect(() => parseSponsorKeys(tooManyKeys)).toThrow(
      `SPONSOR_SECRET_KEY supports 1..${MAX_SPONSOR_SLOT_COUNT} sponsor slots`,
    );
  });

  it('SponsorPool rejects more than the supported sponsor slot count', () => {
    const tooManyKeypairs = Array.from({ length: MAX_SPONSOR_SLOT_COUNT + 1 }, (_, i) =>
      makeKeypair(i),
    );

    expect(
      () =>
        new SponsorPool(
          tooManyKeypairs as unknown as ConstructorParameters<typeof SponsorPool>[0],
          { hmacSecret: TEST_HMAC_SECRET },
        ),
    ).toThrow(`SponsorPool supports 1..${MAX_SPONSOR_SLOT_COUNT} sponsor slots`);
  });

  it('RedisSponsorPool rejects more than the supported sponsor slot count', () => {
    const tooManyKeypairs = Array.from({ length: MAX_SPONSOR_SLOT_COUNT + 1 }, (_, i) =>
      makeKeypair(i),
    );

    expect(
      () =>
        new RedisSponsorPool(
          new FakeRedisClient(),
          tooManyKeypairs as unknown as ConstructorParameters<typeof RedisSponsorPool>[1],
          { hmacSecret: TEST_HMAC_SECRET },
        ),
    ).toThrow(`RedisSponsorPool supports 1..${MAX_SPONSOR_SLOT_COUNT} sponsor slots`);
  });
});
