/**
 * Sponsored execution economics — internal core-api types and derivation
 * helpers shared between generic and Studio sponsor sponsored execution policies.
 * Not exported from the package barrel; the host (app-api) consumes the
 * already-serialized result via `SponsorResultMetadata.economics`.
 *
 * Canonical formulas (see `docs/economics-formal.md`):
 *
 *   recovered    = relayer-side gas recovery (relayerClaim or consumedGasMist)
 *   paid         = relayer-paid net gas on chain, CLAMPED:
 *                  max(0, storage_cost + computation_cost - storage_rebate).
 *                  Identical to `simGas` in `docs/economics-formal.md`.
 *                  The signed raw delta `gross - rebate` is NOT what
 *                  `paid` carries; the recorder clamps so
 *                  `relayerPaidGasMist >= 0` and `relayerNetMist` does not
 *                  inflate by the rebate-overshoot amount on rebate-heavy TXs.
 *   relayerFee   = quotedRelayerFeeMist
 *
 *   relayerNetMist = recovered + relayerFee - paid                 (signed, excludes protocol_fee)
 *
 * `relayerNetMist` is the single sponsored-execution profit/loss value
 * recorded by the host. Negative values are relayer loss.
 */

// ─────────────────────────────────────────────
// Sponsored execution economics shape
// ─────────────────────────────────────────────

/**
 * Known economics — every numeric field is exact MIST. Set when the
 * sponsor result path can prove both the recovered amount and the relayer-paid
 * amount.
 *
 * `protocolFeeMist`, `grossGasMist`, `storageRebateMist` are auxiliary
 * context the recorder may persist but does NOT enter `relayerNetMist`.
 */
export interface SponsoredExecutionEconomicsKnown {
  readonly economicsStatus: 'known';
  readonly recoveredGasMist: bigint;
  readonly relayerPaidGasMist: bigint;
  readonly relayerFeeMist: bigint;
  readonly relayerNetMist: bigint;
  readonly grossGasMist: bigint | null;
  readonly storageRebateMist: bigint | null;
  readonly protocolFeeMist: bigint | null;
  readonly failureReason: string | null;
}

/**
 * Unknown economics — set when the sponsor result path cannot prove the
 * relayer-paid amount (e.g. preflight failure, congestion, post-submit
 * `gasUsed` missing, post-signature submit-infra exception). Whether
 * a row is persisted at all is the host recorder's outcome-filter
 * decision; when the recorder does persist the row, every monetary
 * field is `null` and the row is excluded from aggregate net/loss
 * counters.
 */
export interface SponsoredExecutionEconomicsUnknown {
  readonly economicsStatus: 'unknown';
  readonly failureReason: string | null;
}

export type SponsoredExecutionEconomics =
  | SponsoredExecutionEconomicsKnown
  | SponsoredExecutionEconomicsUnknown;

/** Build an unknown-economics object with an explicit failureReason. */
export function unknownSponsoredExecutionEconomics(
  failureReason: string | null,
): SponsoredExecutionEconomicsUnknown {
  return { economicsStatus: 'unknown', failureReason };
}

/**
 * Derive a `SponsoredExecutionEconomicsKnown` from raw inputs. The
 * derived field `relayerNetMist` is the canonical profit/loss value
 * surfaced to the recorder.
 *
 *   relayerNetMist = recoveredGasMist + relayerFeeMist - relayerPaidGasMist
 *
 * `protocolFeeMist` is intentionally NOT subtracted from
 * `relayerNetMist`. Protocol fee flows from user surplus to the
 * protocol treasury and is not the relayer's revenue (see
 * `docs/economics-formal.md` `Profit and Loss Equations`).
 */
export function deriveSponsoredExecutionEconomics(input: {
  recoveredGasMist: bigint;
  relayerPaidGasMist: bigint;
  relayerFeeMist: bigint;
  grossGasMist?: bigint | null;
  storageRebateMist?: bigint | null;
  protocolFeeMist?: bigint | null;
  failureReason?: string | null;
}): SponsoredExecutionEconomicsKnown {
  const relayerNetMist = input.recoveredGasMist + input.relayerFeeMist - input.relayerPaidGasMist;
  return {
    economicsStatus: 'known',
    recoveredGasMist: input.recoveredGasMist,
    relayerPaidGasMist: input.relayerPaidGasMist,
    relayerFeeMist: input.relayerFeeMist,
    relayerNetMist,
    grossGasMist: input.grossGasMist ?? null,
    storageRebateMist: input.storageRebateMist ?? null,
    protocolFeeMist: input.protocolFeeMist ?? null,
    failureReason: input.failureReason ?? null,
  };
}

// ─────────────────────────────────────────────
// HTTP/log serialization for SponsorResultMetadata.economics
// ─────────────────────────────────────────────

import type { SponsorResultEconomics } from './handlers/sponsorResult.js';

/**
 * Convert internal bigint-valued economics into the string-valued shape
 * carried on `SponsorResultMetadata.economics`. Numeric fields are
 * exact MIST decimal strings; null fields stay null.
 */
export function serializeSponsoredExecutionEconomics(
  econ: SponsoredExecutionEconomics,
): SponsorResultEconomics {
  if (econ.economicsStatus === 'unknown') {
    return { economicsStatus: 'unknown', failureReason: econ.failureReason };
  }
  return {
    economicsStatus: 'known',
    recoveredGasMist: econ.recoveredGasMist.toString(),
    relayerPaidGasMist: econ.relayerPaidGasMist.toString(),
    relayerFeeMist: econ.relayerFeeMist.toString(),
    relayerNetMist: econ.relayerNetMist.toString(),
    grossGasMist: econ.grossGasMist === null ? null : econ.grossGasMist.toString(),
    storageRebateMist: econ.storageRebateMist === null ? null : econ.storageRebateMist.toString(),
    protocolFeeMist: econ.protocolFeeMist === null ? null : econ.protocolFeeMist.toString(),
    failureReason: econ.failureReason,
  };
}

/** Pre-built unknown serialized economics for default callback metadata. */
export const SERIALIZED_UNKNOWN_ECONOMICS: SponsorResultEconomics = Object.freeze({
  economicsStatus: 'unknown' as const,
  failureReason: null,
});
