import { describe, it, expect } from 'vitest';
import {
  deriveSponsoredExecutionEconomics,
  serializeSponsoredExecutionEconomics,
  SERIALIZED_UNKNOWN_ECONOMICS,
  unknownSponsoredExecutionEconomics,
  type SponsoredExecutionEconomics,
} from '../src/sponsoredExecution.js';
import { buildRelayerEconomicsSnapshot } from '../src/economicsLogging.js';

describe('sponsoredExecution — derive known economics', () => {
  it('generic success: positive relayer net', () => {
    const econ = deriveSponsoredExecutionEconomics({
      recoveredGasMist: 12_000n,
      relayerPaidGasMist: 8_000n,
      relayerFeeMist: 1_000n,
      grossGasMist: 9_500n,
      storageRebateMist: 1_500n,
      protocolFeeMist: 50n,
    });
    expect(econ.economicsStatus).toBe('known');
    expect(econ.relayerNetMist).toBe(5_000n);
    expect(econ.protocolFeeMist).toBe(50n);
    expect(econ.failureReason).toBe(null);
  });

  it('generic boundary: zero relayer net is NOT negative', () => {
    const econ = deriveSponsoredExecutionEconomics({
      recoveredGasMist: 5_000n,
      relayerPaidGasMist: 5_000n,
      relayerFeeMist: 0n,
    });
    expect(econ.relayerNetMist).toBe(0n);
  });

  it('generic onchain revert with gas: recovered=0, paid>0 → negative net', () => {
    const econ = deriveSponsoredExecutionEconomics({
      recoveredGasMist: 0n,
      relayerPaidGasMist: 7_000n,
      relayerFeeMist: 0n,
      failureReason: 'onchain_revert: MoveAbort',
    });
    expect(econ.relayerNetMist).toBe(-7_000n);
    expect(econ.failureReason).toBe('onchain_revert: MoveAbort');
  });

  it('promotion success: recovered === paid and no relayer fee → relayer net is exactly 0', () => {
    // Promotion ledger.consume reimburses the relayer for `actualGasMist`,
    // so consumedGasMist === actualGasMist on every successful promotion path.
    const econ = deriveSponsoredExecutionEconomics({
      recoveredGasMist: 4_321n,
      relayerPaidGasMist: 4_321n,
      relayerFeeMist: 0n,
    });
    expect(econ.relayerNetMist).toBe(0n);
  });

  it('promotion ledger consume failure post-submit: recovered=0, paid=actual → loss', () => {
    // Only known-economics promotion failure path that produces a real loss
    // — relayer paid gas onchain but the budget did not reimburse.
    const econ = deriveSponsoredExecutionEconomics({
      recoveredGasMist: 0n,
      relayerPaidGasMist: 12_345n,
      relayerFeeMist: 0n,
      failureReason: 'PROMOTION_LEDGER_CONSUME_FAILED',
    });
    expect(econ.relayerNetMist).toBe(-12_345n);
    expect(econ.failureReason).toBe('PROMOTION_LEDGER_CONSUME_FAILED');
  });

  it('protocol_fee is auxiliary context only — NOT subtracted from relayerNetMist', () => {
    // Trust-root invariant (docs/economics-formal.md): protocol fee flows
    // from user surplus to protocol treasury. It does not enter relayer net.
    const protocolFee = 1_000_000n;
    const econ = deriveSponsoredExecutionEconomics({
      recoveredGasMist: 10_000n,
      relayerPaidGasMist: 6_000n,
      relayerFeeMist: 500n,
      protocolFeeMist: protocolFee,
    });
    // Without protocol_fee: relayerNet = 10000 + 500 - 6000 = 4500
    // With protocol_fee subtracted (WRONG):                       4500 - 1000000 = -995500
    expect(econ.relayerNetMist).toBe(4_500n);
    expect(econ.protocolFeeMist).toBe(protocolFee);
  });

  it('relayerNetMist matches the relayer-side profit/loss value', () => {
    const recovered = 8_000n;
    const paid = 8_500n;
    const fee = 1_000n;

    const econ = deriveSponsoredExecutionEconomics({
      recoveredGasMist: recovered,
      relayerPaidGasMist: paid,
      relayerFeeMist: fee,
    });
    const payoutSnapshot = buildRelayerEconomicsSnapshot({
      gasUsed: { computationCost: '7000', storageCost: '2000', storageRebate: '500' },
      relayerClaim: recovered,
      feeCharged: fee,
      protocolFee: 0n,
    });

    expect(econ.relayerNetMist).toBe(500n); // 8000 + 1000 - 8500
    // payoutSnapshot.payoutNet uses snapshot's own derived netGas (not the
    // sponsoredExecution paid value). The shapes are therefore independent
    // and must not be conflated even when input numbers overlap.
    expect(payoutSnapshot.payoutNet).toBe(
      payoutSnapshot.relayerClaim + payoutSnapshot.feeCharged - payoutSnapshot.netGas,
    );
  });

  it('omits optional auxiliary fields cleanly when not provided', () => {
    const econ = deriveSponsoredExecutionEconomics({
      recoveredGasMist: 100n,
      relayerPaidGasMist: 90n,
      relayerFeeMist: 0n,
    });
    expect(econ.grossGasMist).toBe(null);
    expect(econ.storageRebateMist).toBe(null);
    expect(econ.protocolFeeMist).toBe(null);
    expect(econ.failureReason).toBe(null);
  });
});

describe('sponsoredExecution — unknown economics', () => {
  it('unknownSponsoredExecutionEconomics carries the explicit failureReason', () => {
    const u = unknownSponsoredExecutionEconomics('SPONSOR_EXEC_GAS_USED_MISSING');
    expect(u.economicsStatus).toBe('unknown');
    expect(u.failureReason).toBe('SPONSOR_EXEC_GAS_USED_MISSING');
  });

  it('unknown economics has no numeric fields — recorder must not coerce to 0', () => {
    const u = unknownSponsoredExecutionEconomics('reason');
    // Type-level: unknown variant has no recoveredGasMist / paid / net fields.
    // Runtime: recorder consumers check economicsStatus before reading numbers.
    expect((u as Record<string, unknown>).recoveredGasMist).toBeUndefined();
    expect((u as Record<string, unknown>).relayerPaidGasMist).toBeUndefined();
    expect((u as Record<string, unknown>).relayerNetMist).toBeUndefined();
  });

  it('SERIALIZED_UNKNOWN_ECONOMICS is a frozen serialized-shape default', () => {
    // Production handlers default `sponsorResultEconomics` to this constant
    // before they prove either branch; lock the shape so downstream
    // recorders only see the frozen unknown-economics serialized shape.
    expect(SERIALIZED_UNKNOWN_ECONOMICS.economicsStatus).toBe('unknown');
    expect(SERIALIZED_UNKNOWN_ECONOMICS.failureReason).toBe(null);
    expect(Object.isFrozen(SERIALIZED_UNKNOWN_ECONOMICS)).toBe(true);
  });
});

describe('sponsoredExecution — serialize response shape', () => {
  it('serializes known economics to exact-MIST decimal strings (no precision loss)', () => {
    const big = 9_223_372_036_854_775_000n;
    const econ = deriveSponsoredExecutionEconomics({
      recoveredGasMist: big,
      relayerPaidGasMist: 1n,
      relayerFeeMist: 2n,
      grossGasMist: 100n,
      storageRebateMist: 50n,
      protocolFeeMist: 7n,
      failureReason: null,
    });
    const serialized = serializeSponsoredExecutionEconomics(econ);
    expect(serialized.economicsStatus).toBe('known');
    if (serialized.economicsStatus !== 'known') return;
    expect(serialized.recoveredGasMist).toBe(big.toString());
    expect(serialized.relayerPaidGasMist).toBe('1');
    expect(serialized.relayerFeeMist).toBe('2');
    expect(serialized.relayerNetMist).toBe((big + 2n - 1n).toString());
    expect(serialized.grossGasMist).toBe('100');
    expect(serialized.storageRebateMist).toBe('50');
    expect(serialized.protocolFeeMist).toBe('7');
    expect(serialized.failureReason).toBe(null);
  });

  it('serializes negative relayerNet with leading minus (signed-decimal)', () => {
    const econ = deriveSponsoredExecutionEconomics({
      recoveredGasMist: 0n,
      relayerPaidGasMist: 7_000n,
      relayerFeeMist: 0n,
    });
    const serialized = serializeSponsoredExecutionEconomics(econ);
    if (serialized.economicsStatus !== 'known') throw new Error('expected known');
    expect(serialized.relayerNetMist).toBe('-7000');
  });

  it('serializes unknown economics without numeric fields', () => {
    const u: SponsoredExecutionEconomics = unknownSponsoredExecutionEconomics(
      'SPONSOR_EXEC_GAS_USED_MISSING',
    );
    const serialized = serializeSponsoredExecutionEconomics(u);
    expect(serialized.economicsStatus).toBe('unknown');
    expect(serialized.failureReason).toBe('SPONSOR_EXEC_GAS_USED_MISSING');
    expect((serialized as Record<string, unknown>).recoveredGasMist).toBeUndefined();
    expect((serialized as Record<string, unknown>).relayerNetMist).toBeUndefined();
  });

  it('preserves null auxiliary fields through serialize (no "0" coercion)', () => {
    const econ = deriveSponsoredExecutionEconomics({
      recoveredGasMist: 100n,
      relayerPaidGasMist: 90n,
      relayerFeeMist: 0n,
    });
    const serialized = serializeSponsoredExecutionEconomics(econ);
    if (serialized.economicsStatus !== 'known') throw new Error('expected known');
    expect(serialized.grossGasMist).toBe(null);
    expect(serialized.storageRebateMist).toBe(null);
    expect(serialized.protocolFeeMist).toBe(null);
  });
});
