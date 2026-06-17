import { describe, expect, it } from 'vitest';
import { parseRelayerFeeEnv } from '../src/prepareConfig.js';

describe('parseRelayerFeeEnv', () => {
  it('parses omitted and decimal fee values', () => {
    expect(parseRelayerFeeEnv(undefined)).toBe(0n);
    expect(parseRelayerFeeEnv('0')).toBe(0n);
    expect(parseRelayerFeeEnv('1000')).toBe(1000n);
  });

  it('rejects non-decimal or negative fee values', () => {
    expect(() => parseRelayerFeeEnv('1e3')).toThrow('expected a non-negative integer string');
    expect(() => parseRelayerFeeEnv('0x10')).toThrow('expected a non-negative integer string');
    expect(() => parseRelayerFeeEnv('-1')).toThrow('expected a non-negative integer string');
  });
});
