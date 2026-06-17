/**
 * Minimal smoke test for app-api boot module.
 *
 * Verifies that the boot validation functions exist and basic env
 * parsing utilities work correctly.
 */
import { describe, it, expect } from 'vitest';
import {
  requireEnv,
  parseOptionalBooleanEnv,
  parseOptionalPositiveBigIntEnv,
  parseOptionalPositiveIntegerEnv,
} from '../src/env.js';

describe('env parsing utilities', () => {
  describe('requireEnv', () => {
    it('throws on missing env var', () => {
      delete process.env.__TEST_MISSING__;
      expect(() => requireEnv('__TEST_MISSING__')).toThrow('[app-api] Missing required');
    });

    it('returns trimmed value for present env var', () => {
      process.env.__TEST_PRESENT__ = '  hello  ';
      expect(requireEnv('__TEST_PRESENT__')).toBe('hello');
      delete process.env.__TEST_PRESENT__;
    });
  });

  describe('parseOptionalBooleanEnv', () => {
    it('returns undefined for undefined/empty', () => {
      expect(parseOptionalBooleanEnv('X', undefined)).toBeUndefined();
      expect(parseOptionalBooleanEnv('X', '')).toBeUndefined();
    });

    it('parses true/false', () => {
      expect(parseOptionalBooleanEnv('X', 'true')).toBe(true);
      expect(parseOptionalBooleanEnv('X', 'TRUE')).toBe(true);
      expect(parseOptionalBooleanEnv('X', 'false')).toBe(false);
    });

    it('throws on invalid value', () => {
      expect(() => parseOptionalBooleanEnv('X', 'yes')).toThrow('[app-api] X must be');
    });
  });

  describe('parseOptionalPositiveBigIntEnv', () => {
    it('returns undefined for undefined/empty', () => {
      expect(parseOptionalPositiveBigIntEnv('X', undefined)).toBeUndefined();
      expect(parseOptionalPositiveBigIntEnv('X', '')).toBeUndefined();
    });

    it('parses valid positive integer', () => {
      expect(parseOptionalPositiveBigIntEnv('X', '1000')).toBe(BigInt(1000));
    });

    it('throws on non-numeric', () => {
      expect(() => parseOptionalPositiveBigIntEnv('X', 'abc')).toThrow(
        'must be a positive integer',
      );
    });

    it('throws on zero', () => {
      expect(() => parseOptionalPositiveBigIntEnv('X', '0')).toThrow('must be greater than zero');
    });
  });

  describe('parseOptionalPositiveIntegerEnv', () => {
    it('returns undefined for undefined/empty', () => {
      expect(parseOptionalPositiveIntegerEnv('X', undefined)).toBeUndefined();
      expect(parseOptionalPositiveIntegerEnv('X', '')).toBeUndefined();
    });

    it('parses valid positive integer', () => {
      expect(parseOptionalPositiveIntegerEnv('X', '7')).toBe(7);
    });

    it('throws on non-numeric', () => {
      expect(() => parseOptionalPositiveIntegerEnv('X', 'abc')).toThrow(
        'must be a positive integer',
      );
    });

    it('throws on zero', () => {
      expect(() => parseOptionalPositiveIntegerEnv('X', '0')).toThrow(
        'must be a positive integer within Number.MAX_SAFE_INTEGER',
      );
    });
  });
});
