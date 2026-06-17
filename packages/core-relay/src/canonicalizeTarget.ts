/**
 * canonicalizeTarget — canonical MoveCall target format.
 *
 * Produces a deterministic target string for R-10 allowlist hash matching.
 * Format: normalizeSuiAddress(packageId)::module::function
 *
 * normalizeSuiAddress pads short addresses (e.g. 0x2 → 0x000...002)
 * so that equivalent addresses always produce the same hash.
 *
 * This is the sole implementation owner.
 * Consumers:
 *   - core-api/studio/promotionTargetPolicy.ts — R-10 target canonicalization (server)
 *   - @stelis/sdk (root) — browser re-export via @stelis/core-relay/browser
 *   - @stelis/sdk/server — server re-export via @stelis/core-relay/browser
 */

import { normalizeSuiAddress } from '@mysten/sui/utils';

/**
 * Produce the canonical target string for a MoveCall.
 *
 * @example
 * ```ts
 * canonicalizeTarget('0x2', 'coin', 'transfer')
 * // → '0x0000000000000000000000000000000000000000000000000000000000000002::coin::transfer'
 * ```
 */
export function canonicalizeTarget(packageId: string, module: string, fn: string): string {
  return `${normalizeSuiAddress(packageId)}::${module}::${fn}`;
}
