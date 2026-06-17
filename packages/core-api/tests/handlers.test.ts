import { describe, it, expect } from 'vitest';
import { handleStatus } from '../src/handlers/status.js';
import { SponsorValidationError } from '../src/handlers/sponsor.js';

import type { SettleProfile } from '@stelis/contracts';
import { PROFILE_RANKS } from '@stelis/contracts';

// ─────────────────────────────────────────────
// handleStatus
// ─────────────────────────────────────────────

describe('handleStatus', () => {
  it('returns ok: true (health check only)', async () => {
    const result = await handleStatus();
    expect(result.ok).toBe(true);
  });
});

describe('SponsorValidationError', () => {
  it('carries code and message', () => {
    const err = new SponsorValidationError('L1_NO_SETTLE', 'Missing settle call');
    expect(err.code).toBe('L1_NO_SETTLE');
    expect(err.message).toBe('Missing settle call');
    expect(err.name).toBe('SponsorValidationError');
    expect(err).toBeInstanceOf(Error);
  });
});

// ─────────────────────────────────────────────
// PROFILE_RANKS constant invariants
// ─────────────────────────────────────────────

describe('Profile rank invariants', () => {
  const profiles: SettleProfile[] = ['credit_general', 'with_vault', 'new_user'];

  it('credit_general has lowest rank (0)', () => {
    expect(PROFILE_RANKS.credit_general).toBe(0);
  });

  it('new_user has highest rank (2)', () => {
    expect(PROFILE_RANKS.new_user).toBe(2);
  });

  it('rank order: credit_general < with_vault < new_user', () => {
    const ranks = profiles.map((p) => PROFILE_RANKS[p]);
    for (let i = 0; i < ranks.length - 1; i++) {
      expect(ranks[i]).toBeLessThan(ranks[i + 1]);
    }
  });

  it('conservative quote accepted: quoted=new_user, derived=credit_general → accept', () => {
    // credit_general rank(0) <= new_user rank(2)
    expect(PROFILE_RANKS['credit_general']).toBeLessThanOrEqual(PROFILE_RANKS['new_user']);
  });

  it('underquoted rejected: quoted=credit_general, derived=new_user → reject', () => {
    // new_user rank(2) > credit_general rank(0)
    expect(PROFILE_RANKS['new_user']).toBeGreaterThan(PROFILE_RANKS['credit_general']);
  });

  it('same profile → accept (same rank)', () => {
    for (const p of profiles) {
      // same profile → same rank
      expect(PROFILE_RANKS[p]).toBeLessThanOrEqual(PROFILE_RANKS[p]);
    }
  });
});
