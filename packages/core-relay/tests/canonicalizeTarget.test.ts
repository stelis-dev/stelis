import { describe, it, expect } from 'vitest';
import { canonicalizeTarget } from '../src/canonicalizeTarget.js';

describe('canonicalizeTarget', () => {
  it('normalizes short addresses to 64-char hex', () => {
    const result = canonicalizeTarget('0x2', 'coin', 'transfer');
    expect(result).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000002::coin::transfer',
    );
  });

  it('preserves already-normalized addresses', () => {
    const fullAddr = '0x0000000000000000000000000000000000000000000000000000000000000002';
    const result = canonicalizeTarget(fullAddr, 'coin', 'transfer');
    expect(result).toBe(`${fullAddr}::coin::transfer`);
  });

  it('produces identical output for equivalent addresses', () => {
    const short = canonicalizeTarget('0x2', 'coin', 'transfer');
    const full = canonicalizeTarget(
      '0x0000000000000000000000000000000000000000000000000000000000000002',
      'coin',
      'transfer',
    );
    expect(short).toBe(full);
  });

  it('includes module and function in output', () => {
    const result = canonicalizeTarget('0xabc', 'my_module', 'do_thing');
    expect(result).toContain('::my_module::do_thing');
  });
});
