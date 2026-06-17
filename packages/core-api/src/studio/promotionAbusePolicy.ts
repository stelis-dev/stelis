/**
 * Promotion Abuse Policy — abuse/audit event recording for promotion flows.
 *
 * Duplicate claim, sender signature mismatch, disallowed target, repeated
 * failing sponsor actions are subject to audit log and abuse recording.
 *
 * Reuses the existing `AbuseBlockerAdapter` infrastructure. Blocking keys
 * are IP + Studio user subject (verified developer JWT `userId`). The
 * `userId` is the Studio promotion enforcement principal; `senderAddress`
 * remains a mutable execution credential bound by the JWT and is not
 * recorded as a non-IP enforcement subject here.
 *
 * @module promotionAbusePolicy
 */

import type { AbuseBlockerAdapter, AbuseSubject } from '../store/abuseBlockTypes.js';
import { logStructuredEvent } from '../structuredEventLog.js';
import {
  PROMOTION_ABUSE_RECORDED,
  PROMOTION_ABUSE_RECORDER_FAILED,
} from '../observability/events.js';
// Abuse-code classification policy lives in `failures.ts`. This
// module owns only the event-emitter API (`recordPromotionAbuseEvent`)
// Shared promotion abuse-code vocabulary.
import { PROMOTION_ABUSE_CODES, type PromotionAbuseCode } from '../failures.js';

export { PROMOTION_ABUSE_CODES };
export type { PromotionAbuseCode };

// ─────────────────────────────────────────────
// Metadata
// ─────────────────────────────────────────────

/** Structured metadata for promotion abuse events. */
export interface PromotionAbuseMeta {
  promotionId?: string;
  userId?: string;
  /** Extra detail (e.g. disallowed target list, signature verification failure reason). */
  detail?: string;
  /** Command kind that triggered the violation. */
  kind?: string;
}

// ─────────────────────────────────────────────
// Recording
// ─────────────────────────────────────────────

/**
 * Record a promotion-specific abuse event.
 *
 * Parallels `recordSponsorFailureForAbuse()` (recorder failure policy):
 *   1. Emit structured `PROMOTION_ABUSE_RECORDED` before the blocker call —
 *      guaranteed observability regardless of adapter outcome.
 *   2. Delegate to `blocker.recordSponsorFailure()` for IP + Studio user
 *      subject rate-limit tracking.
 *   3. Adapter failures are swallowed and surfaced via
 *      `PROMOTION_ABUSE_RECORDER_FAILED` warn-level structured event so
 *      they never mask the primary classified rejection at the call site.
 *
 * @param blocker  AbuseBlockerAdapter (same instance used by sponsor route paths)
 * @param ip       Client IP address
 * @param subject  Typed non-IP enforcement subject. Studio promotion
 *                 callers pass `{ kind: 'studio_user', userId }`. The
 *                 subject may be `undefined` for pre-proof IP-only paths.
 * @param code     Promotion abuse code (from PROMOTION_ABUSE_CODES)
 * @param meta     Optional promotion context metadata
 */
export async function recordPromotionAbuseEvent(
  blocker: AbuseBlockerAdapter,
  ip: string,
  subject: AbuseSubject | undefined,
  code: PromotionAbuseCode,
  meta?: PromotionAbuseMeta,
): Promise<void> {
  // Structured log — always emitted regardless of blocker outcome.
  // The typed subject defines the principal field: `subjectLogFields`
  // is spread LAST so any `meta.userId` a caller might pass cannot override
  // the subject's `userId` (or, for an address-kind subject, leak a userId
  // into a slot that should carry only `address`). Structured-log consumers
  // therefore never interpret a `userId` as an on-chain `address`, and the
  // recorded principal always matches the principal that drove the abuse
  // counter increment in the adapter call below.
  logStructuredEvent(PROMOTION_ABUSE_RECORDED, {
    ip,
    code,
    ...(meta?.promotionId ? { promotionId: meta.promotionId } : {}),
    ...(meta?.userId ? { userId: meta.userId } : {}),
    ...(meta?.detail ? { detail: meta.detail } : {}),
    ...(meta?.kind ? { kind: meta.kind } : {}),
    ...subjectLogFields(subject),
  });

  try {
    await blocker.recordSponsorFailure(ip, subject, code);
  } catch (err) {
    // Swallow adapter failure. The caller is on a classified-rejection path
    // and needs its primary error preserved. Emit a distinct structured event
    // so recorder degradation is observable independently of
    // PROMOTION_ABUSE_RECORDED. Subject precedence rule is the same as the
    // success path above: subject fields win over any `meta.userId`.
    logStructuredEvent(
      PROMOTION_ABUSE_RECORDER_FAILED,
      {
        ip,
        code,
        ...(meta?.promotionId ? { promotionId: meta.promotionId } : {}),
        ...(meta?.userId ? { userId: meta.userId } : {}),
        ...(meta?.detail ? { detail: meta.detail } : {}),
        ...(meta?.kind ? { kind: meta.kind } : {}),
        ...subjectLogFields(subject),
        error: err instanceof Error ? err.message : String(err),
      },
      'warn',
    );
  }
}

function subjectLogFields(subject: AbuseSubject | undefined): Record<string, string> {
  if (!subject) return {};
  return subject.kind === 'address' ? { address: subject.address } : { userId: subject.userId };
}
