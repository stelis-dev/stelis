/**
 * MemoryPromotionExecutionLedger — conformance tests.
 *
 * Runs the shared conformance suite against the in-memory implementation.
 */

import { describe, it, expect } from 'vitest';
import {
  PROMOTION_EXECUTION_LEDGER_DEFAULT_REAPER_INTERVAL_MS,
  PROMOTION_EXECUTION_LEDGER_DEFAULT_RESERVATION_TTL_MS,
} from '../src/studio/executionLedger.js';
import { MemoryPromotionExecutionLedger } from '../src/studio/executionLedgerMemory.js';
import { runLedgerConformanceTests } from './executionLedger.conformance.js';

describe('MemoryPromotionExecutionLedger', () => {
  runLedgerConformanceTests(
    // Normal factory: default TTL (60s)
    () => new MemoryPromotionExecutionLedger(),
    // Sweep factory: TTL=0 so reservations expire immediately
    () => new MemoryPromotionExecutionLedger(0),
  );
});

// Runtime/docs drift lock — both values must stay in sync
// with `docs/parameters.md#ttl-constants`. Tightening the reaper to
// 15 s halves max recovery latency without changing the TTL invariant.
describe('Studio execution ledger reaper / TTL constants', () => {
  it('PROMOTION_EXECUTION_LEDGER_DEFAULT_RESERVATION_TTL_MS is 60s', () => {
    expect(PROMOTION_EXECUTION_LEDGER_DEFAULT_RESERVATION_TTL_MS).toBe(60_000);
  });

  it('PROMOTION_EXECUTION_LEDGER_DEFAULT_REAPER_INTERVAL_MS is 15s', () => {
    expect(PROMOTION_EXECUTION_LEDGER_DEFAULT_REAPER_INTERVAL_MS).toBe(15_000);
  });

  it('reaper interval is strictly less than the reservation TTL', () => {
    expect(PROMOTION_EXECUTION_LEDGER_DEFAULT_REAPER_INTERVAL_MS).toBeLessThan(
      PROMOTION_EXECUTION_LEDGER_DEFAULT_RESERVATION_TTL_MS,
    );
  });
});
