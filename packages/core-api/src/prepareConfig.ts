import type { SingleHopSettlementSwapPath } from '@stelis/contracts';
import { SETTLEMENT_SWAP_DIRECTION_VECTORS } from '@stelis/contracts';
import type { AllowedSettlementSwapPath } from '@stelis/core-relay';
import type { StaticPoolDescriptor, StaticPoolDescriptorMap } from '@stelis/core-relay/server';
import type { PrepareHandlerConfig } from './handlers/prepare.js';

/**
 * Parse the RELAYER_FEE_MIST environment variable into a bigint.
 *
 * Centralises env parsing so the host app uses the same
 * logic. Throws a descriptive error at boot time (not request time) if
 * the value is set but invalid.
 *
 * @param envValue  process.env.RELAYER_FEE_MIST (string | undefined)
 * @returns 0n when not set, parsed bigint when set
 * @throws Error with human-readable message when set to a non-integer string
 */
export function parseRelayerFeeEnv(envValue: string | undefined): bigint {
  if (!envValue) return 0n;
  if (!/^(?:0|[1-9]\d*)$/.test(envValue)) {
    throw new Error(
      `[RELAYER_FEE_MIST] Invalid value "${envValue}": expected a non-negative integer string. ` +
        `Set to 0 or remove the env var to disable the relayer fee.`,
    );
  }
  try {
    const parsed = BigInt(envValue);
    if (parsed < 0n) throw new Error('must be non-negative');
    return parsed;
  } catch {
    throw new Error(
      `[RELAYER_FEE_MIST] Invalid value "${envValue}": expected a non-negative integer string. ` +
        `Set to 0 or remove the env var to disable the relayer fee.`,
    );
  }
}

/**
 * Derive AllowedSettlementSwapPath[] from pool configs.
 *
 * Canonical boot-time fail-closed barrier for settlement swap direction integrity:
 *   - settlementSwapDirection ↔ hops.length
 *   - settlementSwapDirection ↔ ordered per-hop swapDirection vector (from SETTLEMENT_SWAP_DIRECTION_VECTORS)
 *
 * Any mismatch aborts boot, so downstream consumers (L2, prepare/build, sponsor)
 * can treat `AllowedSettlementSwapPath[]` and the originating `supportedSettlementSwapPaths[]` as a trusted,
 * invariant-consistent set. L2 only matches PTB-extracted settlement swap paths against this set;
 * it does not re-verify the boot invariants. The SDK runs an equivalent
 * client-side check over the same settlement swap path table.
 */
export function deriveAllowedSettlementSwapPaths(pools: SingleHopSettlementSwapPath[]): AllowedSettlementSwapPath[] {
  assertUniquePaymentTokenTypes(pools);
  return pools.map((pool) => {
    const expectedDeepBookSwapDirections = SETTLEMENT_SWAP_DIRECTION_VECTORS[pool.settlementSwapDirection];
    if (pool.hops.length !== expectedDeepBookSwapDirections.length) {
      throw new Error(
        `Pool ${pool.paymentTokenSymbol}: settlementSwapDirection '${pool.settlementSwapDirection}' requires ` +
          `${expectedDeepBookSwapDirections.length} hop(s), got ${pool.hops.length}`,
      );
    }
    for (let i = 0; i < expectedDeepBookSwapDirections.length; i++) {
      const actual = pool.hops[i].swapDirection;
      const expected = expectedDeepBookSwapDirections[i];
      if (actual !== expected) {
        throw new Error(
          `Pool ${pool.paymentTokenSymbol}: settlementSwapDirection '${pool.settlementSwapDirection}' requires ` +
            `hops[${i}].swapDirection='${expected}', got '${actual}'`,
        );
      }
    }
    return {
      tokenType: pool.paymentTokenType,
      hops: pool.hops.map((h) => h.poolId),
      settlementSwapDirection: pool.settlementSwapDirection,
    };
  });
}

function assertUniquePaymentTokenTypes(pools: readonly SingleHopSettlementSwapPath[]): void {
  const seen = new Set<string>();
  for (const pool of pools) {
    if (seen.has(pool.paymentTokenType)) {
      throw new Error(
        `[PREPARE_CONFIG] Duplicate paymentTokenType in supported settlement swap paths: ${pool.paymentTokenType}`,
      );
    }
    seen.add(pool.paymentTokenType);
  }
}

function assertDescriptorMatchesPool(
  pool: SingleHopSettlementSwapPath,
  descriptor: StaticPoolDescriptor | undefined,
): void {
  if (!descriptor) {
    throw new Error(`[PREPARE_CONFIG] Missing StaticPoolDescriptor for ${pool.paymentTokenType}`);
  }
  const mismatch = (field: string, expected: unknown, actual: unknown): Error =>
    new Error(
      `[PREPARE_CONFIG] StaticPoolDescriptor mismatch for ${pool.paymentTokenSymbol}: ` +
        `${field} expected ${String(expected)}, got ${String(actual)}`,
    );

  if (descriptor.paymentTokenType !== pool.paymentTokenType) {
    throw mismatch('paymentTokenType', pool.paymentTokenType, descriptor.paymentTokenType);
  }
  if (descriptor.paymentTokenSymbol !== pool.paymentTokenSymbol) {
    throw mismatch('paymentTokenSymbol', pool.paymentTokenSymbol, descriptor.paymentTokenSymbol);
  }
  if (descriptor.paymentTokenDecimals !== pool.paymentTokenDecimals) {
    throw mismatch(
      'paymentTokenDecimals',
      pool.paymentTokenDecimals,
      descriptor.paymentTokenDecimals,
    );
  }
  if (descriptor.effectiveFeeRateBps !== pool.effectiveFeeRateBps) {
    throw mismatch('effectiveFeeRateBps', pool.effectiveFeeRateBps, descriptor.effectiveFeeRateBps);
  }
  if (descriptor.settlementSwapDirection !== pool.settlementSwapDirection) {
    throw mismatch('settlementSwapDirection', pool.settlementSwapDirection, descriptor.settlementSwapDirection);
  }
  if (descriptor.lotSize !== pool.lotSize) {
    throw mismatch('lotSize', pool.lotSize.toString(), descriptor.lotSize.toString());
  }
  if (descriptor.minSize !== pool.minSize) {
    throw mismatch('minSize', pool.minSize.toString(), descriptor.minSize.toString());
  }
  if (descriptor.hops.length !== pool.hops.length) {
    throw mismatch('hops.length', pool.hops.length, descriptor.hops.length);
  }
  for (let i = 0; i < pool.hops.length; i++) {
    const expected = pool.hops[i];
    const actual = descriptor.hops[i];
    if (!actual) throw mismatch(`hops[${i}]`, JSON.stringify(expected), 'missing');
    if (actual.poolId !== expected.poolId) {
      throw mismatch(`hops[${i}].poolId`, expected.poolId, actual.poolId);
    }
    if (actual.baseType !== expected.baseType) {
      throw mismatch(`hops[${i}].baseType`, expected.baseType, actual.baseType);
    }
    if (actual.quoteType !== expected.quoteType) {
      throw mismatch(`hops[${i}].quoteType`, expected.quoteType, actual.quoteType);
    }
    if (actual.swapDirection !== expected.swapDirection) {
      throw mismatch(`hops[${i}].swapDirection`, expected.swapDirection, actual.swapDirection);
    }
    if (actual.feeBps !== expected.feeBps) {
      throw mismatch(`hops[${i}].feeBps`, expected.feeBps, actual.feeBps);
    }
  }
}

function assertPoolDescriptorCoverage(
  pools: readonly SingleHopSettlementSwapPath[],
  descriptors: StaticPoolDescriptorMap,
): void {
  const expectedTokens = new Set(pools.map((pool) => pool.paymentTokenType));
  for (const pool of pools) {
    assertDescriptorMatchesPool(pool, descriptors.get(pool.paymentTokenType));
  }
  for (const tokenType of descriptors.keys()) {
    if (!expectedTokens.has(tokenType)) {
      throw new Error(`[PREPARE_CONFIG] Unexpected StaticPoolDescriptor for ${tokenType}`);
    }
  }
}

/**
 * Build a PrepareHandlerConfig from resolved runtime values.
 *
 * Pool set is provided by the host (app-api) at boot time via the
 * settlement-swap-paths.json settlement swap path file. This function is pool-source-agnostic.
 *
 * @param opts.pools  Resolved pool configs from the host settlement swap path registry file.
 */
export function resolvePrepareConfig(opts: {
  pools: SingleHopSettlementSwapPath[];
  descriptors: StaticPoolDescriptorMap;
  deepbookPackageId: string;
  /**
   * Relayer-quoted fee per TX (MIST) — from RELAYER_FEE_MIST env var.
   * 0n when not set (no relayer fee).
   */
  quotedRelayerFeeMist?: bigint;
}): PrepareHandlerConfig {
  assertPoolDescriptorCoverage(opts.pools, opts.descriptors);

  return {
    deepbookPackageId: opts.deepbookPackageId,
    supportedSettlementSwapPaths: opts.pools,
    poolDescriptors: opts.descriptors,
    allowedSettlementSwapPaths: deriveAllowedSettlementSwapPaths(opts.pools),
    quotedRelayerFeeMist: opts.quotedRelayerFeeMist ?? 0n,
  };
}
