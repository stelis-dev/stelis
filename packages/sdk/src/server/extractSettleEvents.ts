/**
 * Batch SettleEvent extraction for reconciliation.
 *
 * This helper fetches transactions, extracts matching SettleEvent entries, and
 * returns decoded summaries. It does not verify payment completion against an
 * application order. Use `verifySettleEventAgainstExpected` for that.
 */

import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { decodeSettleEvent } from './settleEventDecoder.js';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/** Summary of a decoded SettleEvent from a transaction. */
export interface ExtractedSettleEventSummary {
  /** Transaction digest. */
  digest: string;
  /** Receipt ID as lowercase hex without a 0x prefix. */
  receiptId: string;
  /** Order ID hash as lowercase hex, empty string if absent. */
  orderIdHash: string;
  /** User wallet address. */
  user: string;
  /** Execution timestamp in milliseconds. */
  timestampMs: string;
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

/**
 * Extract SettleEvents from a list of transaction digests.
 *
 * Transactions without a SettleEvent are skipped. Transactions that fail to
 * fetch or decode are skipped after an optional logger warning.
 *
 * @param client - SuiGrpcClient instance
 * @param digests - Transaction digests to scan
 * @param options - package ID and optional logger
 * @returns Decoded SettleEvent summaries
 */
export async function extractSettleEvents(
  client: SuiGrpcClient,
  digests: string[],
  options: {
    packageId: string;
    logger?: (msg: string) => void;
  },
): Promise<ExtractedSettleEventSummary[]> {
  const { packageId, logger } = options;
  const settleEventType = `${packageId}::events::SettleEvent`;
  const results: ExtractedSettleEventSummary[] = [];

  for (const digest of digests) {
    try {
      const result = await client.getTransaction({
        digest,
        include: { events: true },
      });

      const tx = result.Transaction ?? result.FailedTransaction;
      if (!tx) {
        logger?.(`[reconciliation] Transaction ${digest}: not found, skipping`);
        continue;
      }

      const events = tx.events ?? [];
      const settleEvent = events.find((e) => e.eventType === settleEventType);

      if (!settleEvent) {
        continue;
      }

      let decoded;
      try {
        decoded = decodeSettleEvent(settleEvent.bcs);
      } catch (decodeErr) {
        logger?.(
          `[reconciliation] Transaction ${digest}: BCS decode error (${decodeErr instanceof Error ? decodeErr.message : String(decodeErr)}). Possible schema drift.`,
        );
        continue;
      }

      results.push({
        digest,
        receiptId: decoded.receiptId,
        orderIdHash: decoded.orderIdHash,
        user: decoded.user,
        timestampMs: decoded.execTimestampMs,
      });
    } catch (err) {
      logger?.(
        `[reconciliation] Transaction ${digest}: fetch failed (${err instanceof Error ? err.message : String(err)}), skipping`,
      );
    }
  }

  return results;
}
