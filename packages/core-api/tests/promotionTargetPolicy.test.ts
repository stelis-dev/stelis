/**
 * promotionTargetPolicy — unit tests.
 *
 * Tests target hashing (shared canonicalize + sha256 helper).
 * Target enforcement is global via STUDIO_ALLOWED_TARGETS.
 */
import { describe, it, expect } from 'vitest';
import { hashTarget, hashTargets } from '../src/studio/promotionTargetPolicy.js';
import { createHash } from 'node:crypto';

describe('hashTarget', () => {
  it('hashes a fully-qualified target correctly', () => {
    // normalizeSuiAddress('0x2') pads to full 64-char hex
    const fullPkg = '0x0000000000000000000000000000000000000000000000000000000000000002';
    const expected = createHash('sha256').update(`${fullPkg}::coin::transfer`).digest('hex');
    const result = hashTarget('0x2::coin::transfer');
    expect(result).toBe(expected);
  });

  it('normalizes short package addresses', () => {
    const hash1 = hashTarget('0x2::coin::transfer');
    const hash2 = hashTarget(
      '0x0000000000000000000000000000000000000000000000000000000000000002::coin::transfer',
    );
    expect(hash1).toBe(hash2);
  });

  it('throws on invalid target format', () => {
    expect(() => hashTarget('not_a_target')).toThrow('Invalid target format');
    expect(() => hashTarget('0x2::coin')).toThrow('Invalid target format');
    expect(() => hashTarget('')).toThrow('Invalid target format');
  });
});

describe('hashTargets', () => {
  it('hashes all targets in array', () => {
    const targets = ['0x2::coin::transfer', '0x3::token::mint'];
    const result = hashTargets(targets);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(hashTarget('0x2::coin::transfer'));
    expect(result[1]).toBe(hashTarget('0x3::token::mint'));
  });

  it('returns empty array for empty input', () => {
    expect(hashTargets([])).toEqual([]);
  });
});
