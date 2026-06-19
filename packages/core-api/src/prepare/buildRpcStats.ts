import type { QuoteRpcStats } from '@stelis/core-relay/server';

/**
 * Per-pass RPC accounting captured during one `runPreparePass` invocation.
 * `midPriceCalls` is 0 or 1: one batchGetHopMidPrices fetch per pass at most,
 * and pass2 reuses pass1's prefetched prices. `quote` aggregates the
 * quantity-in / quantity-out_verify primitives from the wrapped market quote
 * port; it stays at zero values for credit branches that never reach the
 * solver.
 */
export interface PreparePassRpcStats {
  midPriceCalls: number;
  midPriceTotalMs: number;
  quote: QuoteRpcStats;
}

export function emptyQuoteRpcStats(): QuoteRpcStats {
  return {
    quantityInCalls: 0,
    quantityOutVerifyCalls: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
    quantityInLogicalCalls: 0,
    quantityOutVerifyLogicalCalls: 0,
    cacheHits: 0,
  };
}

export function emptyPreparePassRpcStats(): PreparePassRpcStats {
  return {
    midPriceCalls: 0,
    midPriceTotalMs: 0,
    quote: emptyQuoteRpcStats(),
  };
}

/**
 * Request-scoped RPC accumulator for one /prepare invocation. Tracks
 * mid-price calls separately from per-pass quantity-in / quantity-out_verify
 * counts so the emit at `two_pass_complete` can carry both the per-pass
 * numbers and the aggregate sum.
 */
export interface BuildRpcAccumulator {
  midPriceCalls: number;
  midPriceTotalMs: number;
  pass1Quote: QuoteRpcStats;
  pass1_5Quote: QuoteRpcStats;
  pass2Quote: QuoteRpcStats;
}

export function emptyBuildRpcAccumulator(): BuildRpcAccumulator {
  return {
    midPriceCalls: 0,
    midPriceTotalMs: 0,
    pass1Quote: emptyQuoteRpcStats(),
    pass1_5Quote: emptyQuoteRpcStats(),
    pass2Quote: emptyQuoteRpcStats(),
  };
}

export function absorbPassRpcStats(acc: BuildRpcAccumulator, passStats: PreparePassRpcStats): void {
  acc.midPriceCalls += passStats.midPriceCalls;
  acc.midPriceTotalMs += passStats.midPriceTotalMs;
}

export function summarizeRpcStats(acc: BuildRpcAccumulator): {
  quoteQuantityInCalls: number;
  quoteQuantityOutVerifyCalls: number;
  quoteTotalRpcCalls: number;
  quoteRpcTotalMs: number;
  quoteRpcMaxMs: number;
  quoteQuantityInLogicalCalls: number;
  quoteQuantityOutVerifyLogicalCalls: number;
  quoteCacheHits: number;
} {
  const quoteQuantityInCalls =
    acc.pass1Quote.quantityInCalls +
    acc.pass1_5Quote.quantityInCalls +
    acc.pass2Quote.quantityInCalls;
  const quoteQuantityOutVerifyCalls =
    acc.pass1Quote.quantityOutVerifyCalls +
    acc.pass1_5Quote.quantityOutVerifyCalls +
    acc.pass2Quote.quantityOutVerifyCalls;
  const quoteQuantityInLogicalCalls =
    acc.pass1Quote.quantityInLogicalCalls +
    acc.pass1_5Quote.quantityInLogicalCalls +
    acc.pass2Quote.quantityInLogicalCalls;
  const quoteQuantityOutVerifyLogicalCalls =
    acc.pass1Quote.quantityOutVerifyLogicalCalls +
    acc.pass1_5Quote.quantityOutVerifyLogicalCalls +
    acc.pass2Quote.quantityOutVerifyLogicalCalls;
  const quoteCacheHits =
    acc.pass1Quote.cacheHits + acc.pass1_5Quote.cacheHits + acc.pass2Quote.cacheHits;
  const quoteTotalRpcCalls = acc.midPriceCalls + quoteQuantityInCalls + quoteQuantityOutVerifyCalls;
  const quoteRpcTotalMs =
    acc.midPriceTotalMs +
    acc.pass1Quote.totalDurationMs +
    acc.pass1_5Quote.totalDurationMs +
    acc.pass2Quote.totalDurationMs;
  const quoteRpcMaxMs = Math.max(
    acc.midPriceTotalMs,
    acc.pass1Quote.maxDurationMs,
    acc.pass1_5Quote.maxDurationMs,
    acc.pass2Quote.maxDurationMs,
  );
  return {
    quoteQuantityInCalls,
    quoteQuantityOutVerifyCalls,
    quoteTotalRpcCalls,
    quoteRpcTotalMs,
    quoteRpcMaxMs,
    quoteQuantityInLogicalCalls,
    quoteQuantityOutVerifyLogicalCalls,
    quoteCacheHits,
  };
}
