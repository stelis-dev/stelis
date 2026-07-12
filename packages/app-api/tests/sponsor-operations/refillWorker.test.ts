import { describe, expect, it, vi } from 'vitest';
import type { SponsorRefillAccountSpendCoordinator } from '../../src/sponsor-operations/accountSpend.js';
import type {
  RedisSponsorOperationsState,
  SlotRead,
} from '../../src/sponsor-operations/redisState.js';
import { createSponsorOperationsRefillWorker } from '../../src/sponsor-operations/refillWorker.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function slotRead(writeSeq: number, state: SlotRead['state'] = 'healthy'): SlotRead {
  return {
    address: '0xslot',
    state,
    balanceMist: '10',
    lastError: null,
    lastObservedAtMs: 1,
    writeSeq,
    pendingRefillDigest: null,
    refillAttemptedAmountMist: null,
    refillObservedBalanceMist: null,
    refillReconciliationResult: null,
    refillOperationId: null,
    refillOperationSequence: null,
    refillOperationState: null,
  };
}

function stateStub(reads: readonly SlotRead[] = [slotRead(4)]) {
  let readIndex = 0;
  return {
    readSlot: vi.fn(async () => reads[Math.min(readIndex++, reads.length - 1)]),
    updateSlotIfWriteSeq: vi.fn(async () => true),
  } satisfies Pick<RedisSponsorOperationsState, 'readSlot' | 'updateSlotIfWriteSeq'>;
}

describe('Sponsor operations refill trigger queue', () => {
  it('coalesces duplicate in-flight triggers into one trailing coordinator pass', async () => {
    const gate = deferred<{
      status: 'not_needed';
      slotAddress: string;
      balanceMist: string;
    }>();
    const state = stateStub();
    const refill = vi.fn(() => gate.promise);
    const worker = createSponsorOperationsRefillWorker({
      state,
      spendCoordinator: { refill } as unknown as SponsorRefillAccountSpendCoordinator,
      retryDelayMs: 10,
    });

    worker.requestRefill('0xslot');
    worker.requestRefill('0xslot');
    worker.requestRefill('0xslot');
    await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(1));
    gate.resolve({ status: 'not_needed', slotAddress: '0xslot', balanceMist: '10' });
    await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(state.readSlot).toHaveBeenCalledTimes(4));
    worker.dispose();
  });

  it('does not discard an in-flight trigger when the current spend finishes failed', async () => {
    const gate = deferred<{
      status: 'failed';
      operationId: string;
      digest: string;
      amountMist: string;
      error: string;
    }>();
    const state = stateStub([slotRead(1), slotRead(2, 'refill_failed'), slotRead(3)]);
    const refill = vi
      .fn()
      .mockImplementationOnce(() => gate.promise)
      .mockResolvedValueOnce({ status: 'not_needed', slotAddress: '0xslot', balanceMist: '10' });
    const worker = createSponsorOperationsRefillWorker({
      state,
      spendCoordinator: { refill } as unknown as SponsorRefillAccountSpendCoordinator,
      retryDelayMs: 100,
    });

    worker.requestRefill('0xslot');
    await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(1));
    worker.requestRefill('0xslot');
    gate.resolve({
      status: 'failed',
      operationId: 'operation-a',
      digest: 'digest-a',
      amountMist: '10',
      error: 'on-chain failure',
    });

    await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(state.readSlot).toHaveBeenCalledTimes(4));
    worker.dispose();
  });

  it('does not lose a retry timer that fires while an error projection is still writing', async () => {
    const state = stateStub();
    const writeGate = deferred<boolean>();
    state.updateSlotIfWriteSeq.mockImplementationOnce(() => writeGate.promise);
    const refill = vi
      .fn()
      .mockRejectedValueOnce(new Error('source balance unavailable'))
      .mockResolvedValueOnce({ status: 'not_needed', slotAddress: '0xslot', balanceMist: '10' });
    const worker = createSponsorOperationsRefillWorker({
      state,
      spendCoordinator: { refill } as unknown as SponsorRefillAccountSpendCoordinator,
      retryDelayMs: 10,
    });

    worker.requestRefill('0xslot');
    await vi.waitFor(() => expect(state.updateSlotIfWriteSeq).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeGate.resolve(true);

    await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(state.readSlot).toHaveBeenCalledTimes(3));
    worker.dispose();
  });

  it('records a coordinator boundary error only if the sampled slot is still current, then retries', async () => {
    const state = stateStub();
    const refill = vi
      .fn()
      .mockRejectedValueOnce(new Error('source balance unavailable'))
      .mockResolvedValueOnce({ status: 'not_needed', slotAddress: '0xslot', balanceMist: '10' });
    const worker = createSponsorOperationsRefillWorker({
      state,
      spendCoordinator: { refill } as unknown as SponsorRefillAccountSpendCoordinator,
      retryDelayMs: 10,
    });

    worker.requestRefill('0xslot');
    await vi.waitFor(() => expect(state.updateSlotIfWriteSeq).toHaveBeenCalledTimes(1));
    expect(state.updateSlotIfWriteSeq).toHaveBeenCalledWith(
      '0xslot',
      4,
      expect.objectContaining({ state: 'refill_failed', lastError: 'source balance unavailable' }),
    );
    await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(2));
    worker.dispose();
  });

  it('does not lose a trigger when the initial Redis slot read fails', async () => {
    const state = stateStub();
    vi.mocked(state.readSlot).mockRejectedValueOnce(new Error('redis read unavailable'));
    const refill = vi.fn().mockResolvedValue({
      status: 'not_needed',
      slotAddress: '0xslot',
      balanceMist: '10',
    });
    const worker = createSponsorOperationsRefillWorker({
      state,
      spendCoordinator: { refill } as unknown as SponsorRefillAccountSpendCoordinator,
      retryDelayMs: 10,
    });

    worker.requestRefill('0xslot');
    await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(1));
    expect(state.updateSlotIfWriteSeq).toHaveBeenCalledWith(
      '0xslot',
      0,
      expect.objectContaining({ state: 'refill_failed', lastError: 'redis read unavailable' }),
    );
    worker.dispose();
  });

  it('retries a durable spend whose outcome is still pending', async () => {
    const state = stateStub();
    const refill = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'pending',
        operationId: 'operation-a',
        digest: 'digest-a',
        amountMist: '10',
        error: 'lookup unavailable',
      })
      .mockResolvedValueOnce({ status: 'not_needed', slotAddress: '0xslot', balanceMist: '10' });
    const worker = createSponsorOperationsRefillWorker({
      state,
      spendCoordinator: { refill } as unknown as SponsorRefillAccountSpendCoordinator,
      retryDelayMs: 10,
    });

    worker.requestRefill('0xslot');
    await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(2));
    expect(refill).toHaveBeenNthCalledWith(1, '0xslot');
    expect(refill).toHaveBeenNthCalledWith(2, '0xslot');
    await vi.waitFor(() => expect(state.readSlot).toHaveBeenCalledTimes(3));
    worker.dispose();
  });

  it('retries a refill after the source-account runway blocks it', async () => {
    const state = stateStub();
    const refill = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'runway_blocked',
        operationId: 'operation-runway',
        digest: null,
        amountMist: '10',
        error: 'source runway unavailable',
      })
      .mockResolvedValueOnce({ status: 'not_needed', slotAddress: '0xslot', balanceMist: '10' });
    const worker = createSponsorOperationsRefillWorker({
      state,
      spendCoordinator: { refill } as unknown as SponsorRefillAccountSpendCoordinator,
      retryDelayMs: 10,
    });

    worker.requestRefill('0xslot');
    await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(state.readSlot).toHaveBeenCalledTimes(3));
    worker.dispose();
  });

  it('retries an unaccepted refill even when the slot projection is refill-failed', async () => {
    const state = stateStub([
      slotRead(4, 'refill_failed'),
      slotRead(4, 'refill_failed'),
      slotRead(5),
    ]);
    const refill = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'busy',
        operationId: 'blocking-withdrawal',
        digest: 'blocking-digest',
        error: 'another account spend was recovered',
      })
      .mockResolvedValueOnce({ status: 'not_needed', slotAddress: '0xslot', balanceMist: '10' });
    const worker = createSponsorOperationsRefillWorker({
      state,
      spendCoordinator: { refill } as unknown as SponsorRefillAccountSpendCoordinator,
      retryDelayMs: 10,
    });

    worker.requestRefill('0xslot');

    await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(state.readSlot).toHaveBeenCalledTimes(3));
    worker.dispose();
  });

  it('requeues a successful refill when its terminal slot observation is still low', async () => {
    const state = stateStub([
      slotRead(4, 'low_balance'),
      slotRead(5, 'low_balance'),
      slotRead(5, 'low_balance'),
      slotRead(6),
    ]);
    const refill = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'succeeded',
        operationId: 'operation-a',
        digest: 'digest-a',
        amountMist: '10',
        remainingBalanceMist: '100',
      })
      .mockResolvedValueOnce({ status: 'not_needed', slotAddress: '0xslot', balanceMist: '10' });
    const worker = createSponsorOperationsRefillWorker({
      state,
      spendCoordinator: { refill } as unknown as SponsorRefillAccountSpendCoordinator,
      retryDelayMs: 10,
    });

    worker.requestRefill('0xslot');
    await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(state.readSlot).toHaveBeenCalledTimes(4));
    worker.dispose();
  });

  it('dispose prevents later triggers', async () => {
    const refill = vi.fn();
    const worker = createSponsorOperationsRefillWorker({
      state: stateStub(),
      spendCoordinator: { refill } as unknown as SponsorRefillAccountSpendCoordinator,
      retryDelayMs: 10,
    });
    worker.dispose();
    worker.requestRefill('0xslot');
    await Promise.resolve();
    expect(refill).not.toHaveBeenCalled();
  });
});
