import { describe, it, expect } from 'vitest';
import { validateNonlossSponsor } from '../src/validate/nonloss.js';
import type { OnchainConfig } from '../src/types.js';
import type { SponsorNonlossContext } from '../src/validate/nonloss.js';

const CONFIG: OnchainConfig = {
  packageId: '0xPACKAGE',
  configId: '0xCONFIG',
  maxClaimMist: 50_000_000n,
  minSettleMist: 100_000n,
  maxRelayerFeeMist: 500_000n,
  protocolFlatFeeMist: 100_000n,
  configVersion: 1n,
  maxSpreadBps: 500n,
};

function makeSponsorCtx(overrides?: Partial<SponsorNonlossContext>): SponsorNonlossContext {
  return {
    simGas: 7_000_000n,
    gasVarianceFixedMist: 100_000n,
    slippageBufferMist: 250_000n,
    relayerClaim: 7_350_000n, // simGas + gasVarianceFixedMist + slippageBufferMist
    gasBudget: 10_000_000n,
    ...overrides,
  };
}

describe('Layer 3: validateNonlossSponsor', () => {
  it('pass — all conditions satisfied', () => {
    expect(validateNonlossSponsor(makeSponsorCtx(), CONFIG)).toEqual({ ok: true });
  });

  // 1. Nonloss guarantee
  it('fail — relayerClaim < simGas + gasVarianceFixedMist + slippageBufferMist', () => {
    const result = validateNonlossSponsor(makeSponsorCtx({ relayerClaim: 7_349_999n }), CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('L3_NONLOSS_VIOLATION');
  });

  it('boundary — relayerClaim == simGas + gasVarianceFixedMist + slippageBufferMist passes', () => {
    const ctx = makeSponsorCtx({
      simGas: 7_000_000n,
      gasVarianceFixedMist: 100_000n,
      slippageBufferMist: 250_000n,
      relayerClaim: 7_350_000n, // exactly the sum
    });
    expect(validateNonlossSponsor(ctx, CONFIG)).toEqual({ ok: true });
  });

  // 2. Gas budget upper bound
  it('fail — gasBudget > maxClaimMist', () => {
    const result = validateNonlossSponsor(makeSponsorCtx({ gasBudget: 50_000_001n }), CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('L3_GAS_BUDGET_EXCEEDED');
  });

  it('boundary — gasBudget == maxClaimMist passes', () => {
    const ctx = makeSponsorCtx({ gasBudget: 50_000_000n });
    expect(validateNonlossSponsor(ctx, CONFIG)).toEqual({ ok: true });
  });

  // 3. SimGas range overflow
  it('fail — simGas > maxClaimMist', () => {
    const result = validateNonlossSponsor(
      makeSponsorCtx({
        simGas: 50_000_001n,
        gasVarianceFixedMist: 100_000n,
        slippageBufferMist: 2_400_000n,
        relayerClaim: 52_500_001n,
      }),
      CONFIG,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('L3_SIM_GAS_OUT_OF_RANGE');
  });

  it('boundary — simGas == maxClaimMist passes', () => {
    const ctx = makeSponsorCtx({
      simGas: 50_000_000n,
      gasVarianceFixedMist: 100_000n,
      slippageBufferMist: 2_400_000n,
      relayerClaim: 52_500_000n,
    });
    expect(validateNonlossSponsor(ctx, CONFIG)).toEqual({ ok: true });
  });

  // Edge case: all zeros (rebate exceeds cost)
  it('pass — all zeros (edge case)', () => {
    const ctx = makeSponsorCtx({
      simGas: 0n,
      gasVarianceFixedMist: 0n,
      slippageBufferMist: 0n,
      relayerClaim: 0n,
      gasBudget: 0n,
    });
    expect(validateNonlossSponsor(ctx, CONFIG)).toEqual({ ok: true });
  });

  // gasBudget is decoupled from relayerClaim — it is the setGasBudget()
  // execution cap, not the relayer revenue. Sui refunds any excess gas.
  // Check 2 bounds the budget at maxClaimMist regardless of the
  // relayerClaim value.
  describe('gasBudget decoupled from relayerClaim', () => {
    it('pass — gasBudget > relayerClaim (excess gas refunded by Sui)', () => {
      const ctx = makeSponsorCtx({
        simGas: 3_000_000n,
        gasVarianceFixedMist: 100_000n,
        slippageBufferMist: 50_000n,
        relayerClaim: 3_150_000n,
        gasBudget: 6_600_000n,
      });
      expect(validateNonlossSponsor(ctx, CONFIG)).toEqual({ ok: true });
    });

    it('pass — gasBudget < relayerClaim (gasBudget is just TX cap)', () => {
      const ctx = makeSponsorCtx({
        simGas: 3_000_000n,
        gasVarianceFixedMist: 100_000n,
        slippageBufferMist: 50_000n,
        relayerClaim: 3_150_000n,
        gasBudget: 3_300_000n,
      });
      expect(validateNonlossSponsor(ctx, CONFIG)).toEqual({ ok: true });
    });

    it('pass — gasBudget at maxClaimMist with small relayerClaim', () => {
      const ctx = makeSponsorCtx({
        simGas: 1_000_000n,
        gasVarianceFixedMist: 100_000n,
        slippageBufferMist: 0n,
        relayerClaim: 1_100_000n,
        gasBudget: 50_000_000n,
      });
      expect(validateNonlossSponsor(ctx, CONFIG)).toEqual({ ok: true });
    });

    it('fail — gasBudget exceeds maxClaimMist even with small relayerClaim', () => {
      const ctx = makeSponsorCtx({
        simGas: 1_000_000n,
        gasVarianceFixedMist: 100_000n,
        slippageBufferMist: 0n,
        relayerClaim: 1_100_000n,
        gasBudget: 50_000_001n,
      });
      const result = validateNonlossSponsor(ctx, CONFIG);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('L3_GAS_BUDGET_EXCEEDED');
    });
  });
});
