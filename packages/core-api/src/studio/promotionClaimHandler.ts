/**
 * Promotion Claim Handler — pure domain logic for claim admission.
 *
 * Handles claim admission checks and delegates atomic claim execution
 * to PromotionExecutionLedger.
 *
 * Atomicity:
 *   ExecutionLedger.claim() guarantees atomic dedupe + capacity guard +
 *   entitlement creation in a single operation. No best-effort rollback needed.
 *
 * Responsibilities:
 *   1. Verify promotion exists and is active (via promotion store `get()`)
 *   2. Check claim deadline has not passed
 *   3. Delegate atomic claim to ExecutionLedger
 *
 * Budget initialization: handled lazily by ExecutionLedger inside
 * mutation paths (`reserve()` / `consume()` / `release()`); the read-only
 * `getBudgetSummary()` path never installs accounting state. claim() is
 * still owns the real total budget.
 *
 * Ownership model: promotionId + userId. No wallet address persisted.
 *
 * @module promotionClaimHandler
 */

import type { PromotionExecutionLedger } from './executionLedger.js';
import type { Promotion, Entitlement } from './domain.js';
import { checkPromotionTemporalGate } from './validation.js';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface ClaimInput {
  promotionId: string;
  userId: string;
}

export type ClaimFailureReason =
  | 'promotion_not_found'
  | 'promotion_not_active'
  | 'promotion_not_started'
  | 'claim_deadline_passed'
  | 'max_participants_reached'
  | 'already_claimed';

export type ClaimResult =
  | { ok: true; entitlement: Entitlement }
  | { ok: false; reason: ClaimFailureReason };

export interface ClaimHandlerDeps {
  /** Only get() is used by claim handler. Any type with a matching `get()` satisfies this. */
  catalog: { get(id: string): Promise<Promotion | null> };
  ledger: PromotionExecutionLedger;
}

// ─────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────

/**
 * Handle a promotion claim request.
 *
 * Fail-closed: only returns { ok: true } when all checks pass
 * and the ledger has atomically created the entitlement.
 *
 * @param input - Claim request (promotionId, userId).
 * @param deps - Dependencies (catalog + ledger).
 * @param now - Current timestamp (injectable for testing).
 */
export async function handlePromotionClaim(
  input: ClaimInput,
  deps: ClaimHandlerDeps,
  now = new Date(),
): Promise<ClaimResult> {
  // 1. Fetch promotion
  const promotion = await deps.catalog.get(input.promotionId);

  // 2. Shared temporal gate: existence + active status + startAt window.
  //    Delegated to `checkPromotionTemporalGate` so claim, prepare, sponsor,
  //    and the derived read models share a single interpretation of
  //    `startAt` and cannot drift.
  const temporal = checkPromotionTemporalGate(promotion, now);
  if (temporal) {
    switch (temporal.code) {
      case 'PROMOTION_NOT_FOUND':
        return { ok: false, reason: 'promotion_not_found' };
      case 'PROMOTION_NOT_ACTIVE':
        return { ok: false, reason: 'promotion_not_active' };
      case 'PROMOTION_NOT_STARTED':
        return { ok: false, reason: 'promotion_not_started' };
    }
  }
  // Post-condition: `promotion` is non-null (temporal gate narrowed it).
  if (!promotion) {
    return { ok: false, reason: 'promotion_not_found' };
  }

  // 3. Check claim deadline (claim-specific; prepare/sponsor use `useUntilAt`).
  if (promotion.claimDeadlineAt) {
    const deadline = new Date(promotion.claimDeadlineAt);
    if (deadline.getTime() <= now.getTime()) {
      return { ok: false, reason: 'claim_deadline_passed' };
    }
  }

  // 4. Atomic claim: dedupe + capacity + entitlement creation
  const useUntilAt = computeUseUntilAt(promotion, now);
  const claimResult = await deps.ledger.claim(input.promotionId, input.userId, {
    maxParticipants: promotion.maxParticipants,
    perUserGasAllowanceMist: promotion.perUserGasAllowanceMist,
    useUntilAt,
  });

  if (!claimResult.ok) {
    if (claimResult.reason === 'duplicate') {
      return { ok: false, reason: 'already_claimed' };
    }
    if (claimResult.reason === 'capacity_exceeded') {
      return { ok: false, reason: 'max_participants_reached' };
    }
    if (claimResult.reason === 'promotion_not_active') {
      // Redis-only race closure: admin paused/archived the promotion
      // between `catalog.get()` above and the atomic Lua claim CAS.
      // Map the internal ledger reason to the existing public claim
      // reason so the public claim contract stays unchanged.
      return { ok: false, reason: 'promotion_not_active' };
    }
    return { ok: false, reason: 'already_claimed' };
  }

  return { ok: true, entitlement: claimResult.entitlement };
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Compute useUntilAt from promotion's postClaimUseWindowMs.
 * 0 = unlimited (null).
 */
function computeUseUntilAt(
  promotion: Pick<Promotion, 'postClaimUseWindowMs'>,
  now: Date,
): string | null {
  if (promotion.postClaimUseWindowMs === 0) {
    return null; // unlimited
  }
  return new Date(now.getTime() + promotion.postClaimUseWindowMs).toISOString();
}
