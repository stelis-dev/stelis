import { describe, expect, it } from 'vitest';
import { parseDuration } from '../src/admin/adminAuthEdge.js';

describe('adminAuthEdge parseDuration', () => {
  it('parses supported positive duration units', () => {
    expect(parseDuration('120s')).toBe(120);
    expect(parseDuration('30m')).toBe(1800);
    expect(parseDuration('1h')).toBe(3600);
  });

  it('rejects zero, exponent, and unsafe durations', () => {
    expect(() => parseDuration('0s')).toThrow('positive safe integer');
    expect(() => parseDuration('1e3s')).toThrow('Invalid duration format');
    expect(() => parseDuration('9007199254740993s')).toThrow('positive safe integer');
    expect(() => parseDuration('9007199254740991h')).toThrow('overflows safe integer');
  });
});
