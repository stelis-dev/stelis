import { describe, it, expect } from 'vitest';
import { normalizeSponsorOperationsLastError } from '../../src/sponsor-operations/lastError.js';

describe('normalizeSponsorOperationsLastError', () => {
  it('preserves empty string as the no-error sentinel', () => {
    expect(normalizeSponsorOperationsLastError('')).toBe('');
  });

  it('uses Error.message for Error inputs', () => {
    expect(normalizeSponsorOperationsLastError(new Error('boom'))).toBe('boom');
  });

  it('trims multibyte strings to <= 512 UTF-8 bytes without splitting a code point', () => {
    const raw = '한'.repeat(300);
    const normalized = normalizeSponsorOperationsLastError(raw);

    expect(normalized).toBe('한'.repeat(170));
    expect(new TextEncoder().encode(normalized).length).toBeLessThanOrEqual(512);
  });
});
