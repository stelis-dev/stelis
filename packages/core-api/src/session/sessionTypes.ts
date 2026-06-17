/**
 * Session types — shared type definitions for prepare/sponsor session lifecycle.
 *
 * Internal to core-api. Not exported from the package barrel.
 * Persisted boundary type remains `PreparedTxEntry` in store/prepareTypes.ts.
 */
import type { PreparedTxEntry } from '../store/prepareTypes.js';

// ─────────────────────────────────────────────
// Preflight simulation result
// ─────────────────────────────────────────────

/** Parsed gas usage from a Sui transaction simulation or execution. */
export interface GasUsedFields {
  computationCost: string;
  storageCost: string;
  storageRebate: string;
}

/**
 * Normalized result from preflight simulation.
 * Callers inspect `success` to branch on simulation outcome.
 */
export type PreflightResult =
  | { success: true; gasUsed: GasUsedFields }
  | { success: false; reason: string };

// ─────────────────────────────────────────────
// TX execution result
// ─────────────────────────────────────────────

/** Normalized result from on-chain transaction execution. */
export type ExecResult =
  | { success: true; digest: string; effects: unknown; gasUsed: GasUsedFields | null }
  | {
      success: false;
      digest: string;
      reason: string;
      isCongestion: boolean;
      /**
       * Gas paid for the on-chain attempt (extracted from FailedTransaction
       * effects or status-based failure effects when available). Sponsored
       * execution recorder uses this to mark `economicsStatus = "known"`
       * for onchain reverts that consumed gas. `null` when:
       *   - submission was cancelled before any on-chain execution
       *     (network-level error or congestion);
       *   - the failed result lacked retrievable effects.
       */
      gasUsed: GasUsedFields | null;
    };

// ─────────────────────────────────────────────
// Consume result
// ─────────────────────────────────────────────

/** Normalized result from prepareStore.consume(). */
export type ConsumeOutcome =
  | { status: 'ok'; entry: PreparedTxEntry; txHash: string }
  | { status: 'not_found' }
  | { status: 'expired' }
  | { status: 'hash_mismatch' };
