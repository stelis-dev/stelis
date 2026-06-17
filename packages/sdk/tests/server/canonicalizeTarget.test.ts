import { describe, it, expect } from 'vitest';
import { canonicalizeTarget } from '../../src/server/index.js';

describe('canonicalizeTarget (sdk/server API)', () => {
  it('is exported from sdk/server API', () => {
    expect(typeof canonicalizeTarget).toBe('function');
  });

  it('produces correct canonical format', () => {
    const result = canonicalizeTarget('0x2', 'coin', 'transfer');
    expect(result).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000002::coin::transfer',
    );
  });

  it('sdk/server binding is the same reference as @stelis/core-relay/browser', async () => {
    const { canonicalizeTarget: fromCoreRelay } = await import('@stelis/core-relay/browser');
    expect(canonicalizeTarget).toBe(fromCoreRelay);
  });
});
