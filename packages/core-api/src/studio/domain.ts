/**
 * Studio Promotion Domain Types — shared domain/value types.
 *
 * Authoritative source for promotion value types (`Promotion`,
 * `Entitlement`, `UsageEvent`, …), ExecutionLedger operation result types,
 * and pure domain helpers (`computeTotalRequiredBudgetMist`). Handlers and
 * derived read models import from here.
 *
 * The Promotion store consumes the current contracts-owned Admin request
 * shapes and owns only persistence and lifecycle transitions.
 *
 * @module studio/domain
 */

import type {
  PromotionEntitlement,
  PromotionEntitlementStatus,
  PromotionStatus as HostPromotionStatus,
  PromotionType as HostPromotionType,
} from '@stelis/contracts';
import { parsePromotionLedgerBudget } from './executionLedgerValueGuards.js';

// ─────────────────────────────────────────────
// Promotion (operator-configured definition)
// ─────────────────────────────────────────────

/**
 * Promotion type values.
 * - `gas_sponsorship`: claim -> repeatable gas-sponsored actions with budget/allowance.
 */
export type PromotionType = HostPromotionType;

/**
 * Promotion lifecycle status.
 * - `draft`: created but not yet accepting claims.
 * - `active`: accepting claims and sponsored actions.
 * - `paused`: temporarily suspended (no claims or actions).
 * - `archived`: permanently closed (terminal).
 */
export type PromotionStatus = HostPromotionStatus;

// Status-transition rules and errors live with the Promotion store adapter.

/**
 * Promotion — operator-configured definition and lifecycle state.
 *
 * Shared domain values for: identity, type, lifecycle status, participant limits,
 * budget parameters, temporal bounds (claim deadline, use window).
 */
export interface Promotion {
  /** Unique promotion identifier (UUID). */
  promotionId: string;
  /** Promotion type value. */
  type: PromotionType;
  /** Operator-visible display name. */
  displayName: string;
  /** Optional description. */
  description: string;
  /** Lifecycle status. */
  status: PromotionStatus;
  /**
   * Maximum number of users that can claim this promotion.
   * gas_sponsorship requires maxParticipants > 0 at every write boundary.
   */
  maxParticipants: number;
  /** Per-user gas allowance in MIST (string for bigint precision). */
  perUserGasAllowanceMist: string;
  /** ISO 8601. Claims must be made before this time. null = no deadline. */
  claimDeadlineAt: string | null;
  /**
   * Post-claim use window in milliseconds. After claiming, user has this long
   * to use sponsored actions. 0 = unlimited.
   */
  postClaimUseWindowMs: number;
  /** ISO 8601. Promotion becomes active at this time. null = immediately on activation. */
  startAt: string | null;
  /** Operator reason for pausing. null if not paused. */
  pauseReason: string | null;
  /** Operator reason for archiving. null if not archived. */
  archiveReason: string | null;
  /** ISO 8601 when the record was created. */
  createdAt: string;
  /** ISO 8601 when the record was last updated. */
  updatedAt: string;
}

// Promotion store methods consume the contracts-owned Admin requests directly.

// ─────────────────────────────────────────────
// Entitlement (per-user execution state)
// ─────────────────────────────────────────────

/** Entitlement lifecycle status shared with the current claim-response wire contract. */
export type EntitlementStatus = PromotionEntitlementStatus;

/**
 * Entitlement — per-user gas allowance and reservation state.
 *
 * Created atomically by ExecutionLedger.claim(). Budget reservation
 * markers (activeReservation*) are managed by reserve/consume/release.
 */
export type Entitlement = PromotionEntitlement;

// ─────────────────────────────────────────────
// Budget Summary (read model)
// ─────────────────────────────────────────────

/**
 * BudgetSummary — promotion-level budget snapshot for read models.
 *
 * All values in MIST (bigint). Returned by ExecutionLedger.getBudgetSummary().
 */
export interface BudgetSummary {
  /** Available budget (total - reserved - consumed). */
  availableMist: bigint;
  /** Currently reserved (in-flight). */
  reservedMist: bigint;
  /** Already consumed. */
  consumedMist: bigint;
}

// ─────────────────────────────────────────────
// Claimed User Projection (admin read model)
// ─────────────────────────────────────────────

/**
 * ClaimedUserProjection — enriched projection for admin claimed-user list.
 *
 * Single read model returned by `ExecutionLedger.listClaimedUsers()` — it
 * joins the claimed-user index and per-user entitlement state in one call,
 * so callers never need a per-user follow-up read.
 */
export interface ClaimedUserProjection {
  userId: string;
  claimedAt: string;
  remainingGasAllowanceMist: string | null;
  consumedGasAllowanceMist: string | null;
  status: EntitlementStatus | null;
  activeReservationReceiptId: string | null;
}

// ─────────────────────────────────────────────
// Usage Event (append-only audit)
// ─────────────────────────────────────────────

/** Usage event result classification. */
export type UsageEventResult = 'reserved' | 'consumed' | 'released' | 'failed';

/**
 * UsageEvent — append-only audit record for each sponsored action lifecycle event.
 */
export interface UsageEvent {
  promotionId: string;
  userId: string;
  senderAddress: string;
  receiptId: string;
  txDigest: string | null;
  reservedGasMist: string;
  consumedGasMist: string;
  releasedGasMist: string;
  result: UsageEventResult;
  createdAt: string;
  failureReason: string | null;
  policyCheckResult: string | null;
}

/** Input for appending a usage event. createdAt is auto-generated. */
export type CreateUsageEventInput = Omit<UsageEvent, 'createdAt'>;

// ─────────────────────────────────────────────
// Claim types
// ─────────────────────────────────────────────

/** Options for ExecutionLedger.claim(). */
export interface ClaimOpts {
  /** Maximum allowed participants. Must be a positive safe integer. */
  maxParticipants: number;
  /** Per-user gas allowance in MIST. */
  perUserGasAllowanceMist: string;
  /** Post-claim use window end. null = unlimited. */
  useUntilAt: string | null;
}

/** Discriminated union result from ExecutionLedger.claim(). */
export type ClaimResult =
  | { ok: true; entitlement: Entitlement }
  | { ok: false; reason: ClaimFailureReason };

/**
 * Internal ExecutionLedger claim failure reasons.
 *
 * `promotion_not_active` is emitted only by `RedisPromotionExecutionLedger`
 * when the atomic claim script re-reads the canonical promotion record
 * and finds `status !== 'active'`. This closes the race window between
 * `promotionStore.get()` at the claim route and the Lua claim CAS (admin
 * pause/archive can slip in between). Memory ledger does not emit this
 * reason — there is no practical cross-process race at that scale and the
 * shared conformance suite treats reason set as adapter-implementation
 * detail. `packages/core-api/src/studio/promotionClaimHandler.ts` maps
 * this internal reason to the existing public `promotion_not_active`
 * claim reason.
 */
export type ClaimFailureReason = 'duplicate' | 'capacity_exceeded' | 'promotion_not_active';

// ─────────────────────────────────────────────
// Reserve / Consume / Release types
// ─────────────────────────────────────────────

/** Parameters for ExecutionLedger.reserve(). */
export interface ReserveParams {
  promotionId: string;
  userId: string;
  receiptId: string;
  amountMist: bigint;
}

/** Discriminated union result from ExecutionLedger.reserve(). */
export type ReserveResult =
  | { ok: true; entitlement: Entitlement }
  | { ok: false; reason: ReserveFailureReason };

export type ReserveFailureReason =
  | 'budget_insufficient'
  | 'entitlement_not_found'
  | 'entitlement_not_active'
  | 'entitlement_insufficient'
  | 'concurrent_reservation';

/** Discriminated union result from ExecutionLedger.consume(). */
export type ConsumeResult =
  | { ok: true; entitlement: Entitlement }
  | { ok: false; reason: ConsumeFailureReason };

export type ConsumeFailureReason = 'reservation_not_found';

/** Discriminated union result from ExecutionLedger.release(). */
export type ReleaseResult =
  | { ok: true; entitlement: Entitlement }
  | { ok: false; reason: ReleaseFailureReason };

export type ReleaseFailureReason = 'reservation_not_found';

// ─────────────────────────────────────────────
// Pure domain helpers
// ─────────────────────────────────────────────

/**
 * Compute total required budget for a promotion in MIST.
 *
 * Pure derivation: maxParticipants * perUserGasAllowanceMist.
 * Returns string for bigint-safe representation.
 *
 * This read-model uses the same semantic authority as every write and ledger
 * boundary, so it cannot project a value the current ledger cannot represent.
 */
export function computeTotalRequiredBudgetMist(
  promotion: Pick<Promotion, 'maxParticipants' | 'perUserGasAllowanceMist'>,
): string {
  return parsePromotionLedgerBudget(
    promotion.maxParticipants,
    promotion.perUserGasAllowanceMist,
  ).totalBudgetMist.toString();
}
