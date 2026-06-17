/**
 * promotionAbusePolicy — unit tests.
 *
 * Tests abuse event recording and code structure.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  recordPromotionAbuseEvent,
  PROMOTION_ABUSE_CODES,
} from '../src/studio/promotionAbusePolicy.js';
import type { AbuseBlockerAdapter } from '../src/store/abuseBlockTypes.js';

function createMockBlocker(): AbuseBlockerAdapter {
  return {
    checkIp: vi.fn().mockResolvedValue({ blocked: false }),
    checkSubject: vi.fn().mockResolvedValue({ blocked: false }),
    recordSponsorFailure: vi.fn().mockResolvedValue(undefined),
  };
}

function parseStructuredCalls(calls: unknown[][]): Record<string, unknown>[] {
  return calls
    .map((call) => {
      try {
        return JSON.parse(String(call[0])) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is Record<string, unknown> => entry !== null);
}

describe('PROMOTION_ABUSE_CODES', () => {
  it('has expected code entries', () => {
    expect(PROMOTION_ABUSE_CODES.SENDER_SIGNATURE_INVALID).toBe('PROMO_SENDER_SIGNATURE_INVALID');
    expect(PROMOTION_ABUSE_CODES.DUPLICATE_CLAIM).toBe('PROMO_DUPLICATE_CLAIM');
    expect(PROMOTION_ABUSE_CODES.DISALLOWED_TARGET).toBe('PROMO_DISALLOWED_TARGET');
    expect(PROMOTION_ABUSE_CODES.DEADLINE_PASSED).toBe('PROMO_DEADLINE_PASSED');
    expect(PROMOTION_ABUSE_CODES.CAPACITY_EXCEEDED).toBe('PROMO_CAPACITY_EXCEEDED');
    expect(PROMOTION_ABUSE_CODES.NOT_CLAIMED).toBe('PROMO_NOT_CLAIMED');
    expect(PROMOTION_ABUSE_CODES.NOT_ACTIVE).toBe('PROMO_NOT_ACTIVE');
  });
});

describe('recordPromotionAbuseEvent', () => {
  it('calls blocker.recordSponsorFailure with ip, studio_user subject, and code', async () => {
    const blocker = createMockBlocker();
    await recordPromotionAbuseEvent(
      blocker,
      '1.2.3.4',
      { kind: 'studio_user', userId: 'user-1' },
      PROMOTION_ABUSE_CODES.SENDER_SIGNATURE_INVALID,
      { promotionId: 'promo-1', userId: 'user-1' },
    );

    expect(blocker.recordSponsorFailure).toHaveBeenCalledWith(
      '1.2.3.4',
      { kind: 'studio_user', userId: 'user-1' },
      'PROMO_SENDER_SIGNATURE_INVALID',
    );
  });

  it('handles undefined subject', async () => {
    const blocker = createMockBlocker();
    await recordPromotionAbuseEvent(
      blocker,
      '1.2.3.4',
      undefined,
      PROMOTION_ABUSE_CODES.DUPLICATE_CLAIM,
    );

    expect(blocker.recordSponsorFailure).toHaveBeenCalledWith(
      '1.2.3.4',
      undefined,
      'PROMO_DUPLICATE_CLAIM',
    );
  });

  // Matches `recordSponsorFailureForAbuse()` contract: recorder adapter
  // failure must not replace the caller's primary classified rejection.
  // Instead emit PROMOTION_ABUSE_RECORDER_FAILED at warn level.
  it('swallows adapter failure and emits PROMOTION_ABUSE_RECORDER_FAILED warn', async () => {
    const blocker = createMockBlocker();
    vi.mocked(blocker.recordSponsorFailure).mockRejectedValueOnce(new Error('redis down'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(
        recordPromotionAbuseEvent(
          blocker,
          '1.2.3.4',
          { kind: 'studio_user', userId: 'user-1' },
          PROMOTION_ABUSE_CODES.NOT_ACTIVE,
          {
            promotionId: 'promo-1',
            userId: 'user-1',
            detail: 'why',
            kind: 'MoveCall',
          },
        ),
      ).resolves.toBeUndefined();

      const warnEntry = parseStructuredCalls(warnSpy.mock.calls).find(
        (entry) => entry['event'] === 'PROMOTION_ABUSE_RECORDER_FAILED',
      );
      expect(warnEntry).toBeDefined();
      expect(warnEntry!['ip']).toBe('1.2.3.4');
      expect(warnEntry!['userId']).toBe('user-1');
      expect(warnEntry!['address']).toBeUndefined();
      expect(warnEntry!['code']).toBe('PROMO_NOT_ACTIVE');
      expect(warnEntry!['promotionId']).toBe('promo-1');
      expect(warnEntry!['detail']).toBe('why');
      expect(warnEntry!['kind']).toBe('MoveCall');
      expect(warnEntry!['error']).toBe('redis down');
    } finally {
      warnSpy.mockRestore();
    }
  });

  // Typed subject: the typed `AbuseSubject` defines
  // of truth for the structured-log principal field. A `meta.userId` that
  // disagrees with the subject's `userId` MUST NOT override the subject in
  // the emitted log, on either the success or recorder-failure path.
  // Without this, a buggy or malicious caller could record an abuse event
  // against `userId=A` (driving the adapter counter increment for A) while
  // logging `userId=B`, breaking the invariant that the recorded principal
  // matches the principal that drove the counter.
  it('subject userId always wins over meta.userId on PROMOTION_ABUSE_RECORDED', async () => {
    const blocker = createMockBlocker();
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    try {
      await recordPromotionAbuseEvent(
        blocker,
        '1.2.3.4',
        { kind: 'studio_user', userId: 'subject-user' },
        PROMOTION_ABUSE_CODES.SENDER_SIGNATURE_INVALID,
        { promotionId: 'promo-1', userId: 'meta-user-mismatch' },
      );

      const recordedEntry = parseStructuredCalls(infoSpy.mock.calls).find(
        (entry) => entry['event'] === 'PROMOTION_ABUSE_RECORDED',
      );
      expect(recordedEntry).toBeDefined();
      expect(recordedEntry!['userId']).toBe('subject-user');
      expect(blocker.recordSponsorFailure).toHaveBeenCalledWith(
        '1.2.3.4',
        { kind: 'studio_user', userId: 'subject-user' },
        'PROMO_SENDER_SIGNATURE_INVALID',
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('subject userId always wins over meta.userId on PROMOTION_ABUSE_RECORDER_FAILED', async () => {
    const blocker = createMockBlocker();
    vi.mocked(blocker.recordSponsorFailure).mockRejectedValueOnce(new Error('boom'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await recordPromotionAbuseEvent(
        blocker,
        '1.2.3.4',
        { kind: 'studio_user', userId: 'subject-user' },
        PROMOTION_ABUSE_CODES.SENDER_SIGNATURE_INVALID,
        { promotionId: 'promo-1', userId: 'meta-user-mismatch' },
      );

      const warnEntry = parseStructuredCalls(warnSpy.mock.calls).find(
        (entry) => entry['event'] === 'PROMOTION_ABUSE_RECORDER_FAILED',
      );
      expect(warnEntry).toBeDefined();
      expect(warnEntry!['userId']).toBe('subject-user');
    } finally {
      warnSpy.mockRestore();
    }
  });

  // Address-kind subject: meta.userId still appears in the meta-driven
  // fields but must not leak into the typed `address` slot.
  it('address-kind subject preserves address; meta.userId does not collide with address slot', async () => {
    const blocker = createMockBlocker();
    const ADDRESS = '0x' + 'ab'.repeat(32);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    try {
      await recordPromotionAbuseEvent(
        blocker,
        '1.2.3.4',
        { kind: 'address', address: ADDRESS },
        PROMOTION_ABUSE_CODES.SENDER_SIGNATURE_INVALID,
        { promotionId: 'promo-1', userId: 'meta-user' },
      );

      const recordedEntry = parseStructuredCalls(infoSpy.mock.calls).find(
        (entry) => entry['event'] === 'PROMOTION_ABUSE_RECORDED',
      );
      expect(recordedEntry).toBeDefined();
      expect(recordedEntry!['address']).toBe(ADDRESS);
      // meta.userId is allowed to flow through as auxiliary context — only
      // the typed subject's primary field is protected from override.
      expect(recordedEntry!['userId']).toBe('meta-user');
    } finally {
      infoSpy.mockRestore();
    }
  });

  // Observability invariant: PROMOTION_ABUSE_RECORDED must be emitted before
  // the blocker call so an adapter fault cannot silence the primary abuse
  // log. The blocker call must stay outside any wrapper that could suppress
  // this event.
  it('emits PROMOTION_ABUSE_RECORDED before the blocker call, even when blocker throws', async () => {
    const blocker = createMockBlocker();
    vi.mocked(blocker.recordSponsorFailure).mockRejectedValueOnce(new Error('redis down'));
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await recordPromotionAbuseEvent(
        blocker,
        '1.2.3.4',
        { kind: 'studio_user', userId: 'user-1' },
        PROMOTION_ABUSE_CODES.DISALLOWED_TARGET,
        { promotionId: 'promo-1', userId: 'user-1' },
      );

      const recordedEntry = parseStructuredCalls(infoSpy.mock.calls).find(
        (entry) => entry['event'] === 'PROMOTION_ABUSE_RECORDED',
      );
      expect(recordedEntry).toBeDefined();
      expect(recordedEntry!['code']).toBe('PROMO_DISALLOWED_TARGET');

      expect(blocker.recordSponsorFailure).toHaveBeenCalledTimes(1);

      const warnEntry = parseStructuredCalls(warnSpy.mock.calls).find(
        (entry) => entry['event'] === 'PROMOTION_ABUSE_RECORDER_FAILED',
      );
      expect(warnEntry).toBeDefined();
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
