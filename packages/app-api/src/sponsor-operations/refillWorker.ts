/**
 * Local refill trigger queue.
 *
 * Transaction identity, cross-instance serialization, durable recovery, and
 * slot/account reconciliation are owned by the shared Sponsor Refill Account
 * spend coordinator. This worker only coalesces duplicate local triggers.
 */
import {
  logStructuredEvent,
  SPONSOR_OPERATIONS_STATE_WRITE_FAILED,
} from '@stelis/core-api/observability';
import type { SponsorRefillAccountSpendCoordinator } from './accountSpend.js';
import type { RedisSponsorOperationsState } from './redisState.js';
import { normalizeSponsorOperationsLastError } from './lastError.js';

export interface SponsorOperationsRefillWorkerDeps {
  readonly state: Pick<RedisSponsorOperationsState, 'readSlot' | 'updateSlotIfWriteSeq'>;
  readonly spendCoordinator: SponsorRefillAccountSpendCoordinator;
  readonly retryDelayMs: number;
}

export interface SponsorOperationsRefillWorker {
  requestRefill(slotAddress: string): void;
  dispose(): void;
}

export function createSponsorOperationsRefillWorker(
  deps: SponsorOperationsRefillWorkerDeps,
): SponsorOperationsRefillWorker {
  if (!Number.isSafeInteger(deps.retryDelayMs) || deps.retryDelayMs <= 0) {
    throw new Error('createSponsorOperationsRefillWorker: retryDelayMs must be positive');
  }

  let disposed = false;
  const inFlight = new Set<string>();
  const rerunRequested = new Set<string>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function scheduleRetry(slotAddress: string): void {
    if (disposed || retryTimers.has(slotAddress)) return;
    const timer = setTimeout(() => {
      retryTimers.delete(slotAddress);
      requestRefill(slotAddress);
    }, deps.retryDelayMs);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
    retryTimers.set(slotAddress, timer);
  }

  async function run(slotAddress: string): Promise<void> {
    let before: Awaited<ReturnType<RedisSponsorOperationsState['readSlot']>> = null;
    try {
      before = await deps.state.readSlot(slotAddress);
      const result = await deps.spendCoordinator.refill(slotAddress);
      if (
        result.status === 'pending' ||
        result.status === 'runway_blocked' ||
        result.status === 'busy'
      ) {
        scheduleRetry(slotAddress);
        return;
      }
      const after = await deps.state.readSlot(slotAddress);
      if (after?.state === 'low_balance' || after?.state === 'rpc_unreachable') {
        scheduleRetry(slotAddress);
      }
    } catch (error) {
      scheduleRetry(slotAddress);
      const expectedWriteSeq = before?.writeSeq ?? 0;
      try {
        await deps.state.updateSlotIfWriteSeq(slotAddress, expectedWriteSeq, {
          state: 'refill_failed',
          lastError: normalizeSponsorOperationsLastError(error),
        });
      } catch (writeError) {
        try {
          logStructuredEvent(
            SPONSOR_OPERATIONS_STATE_WRITE_FAILED,
            {
              source: 'refill_worker_slot_update',
              slot_address: slotAddress,
              state: 'refill_failed',
              write_error: normalizeSponsorOperationsLastError(writeError),
            },
            'warn',
          );
        } catch {
          // An observability sink failure must not cancel the durable retry.
        }
      }
    }
  }

  function requestRefill(slotAddress: string): void {
    if (disposed) return;
    if (inFlight.has(slotAddress)) {
      rerunRequested.add(slotAddress);
      return;
    }
    const retryTimer = retryTimers.get(slotAddress);
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimers.delete(slotAddress);
    }
    inFlight.add(slotAddress);
    void run(slotAddress).finally(async () => {
      inFlight.delete(slotAddress);
      if (!rerunRequested.delete(slotAddress) || disposed) return;
      // A trigger accepted while this slot was in flight is work, not an
      // observation hint. Always hand one coalesced trailing pass to the
      // coordinator; it owns the fresh balance and durable-spend decision.
      requestRefill(slotAddress);
    });
  }

  return {
    requestRefill,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const timer of retryTimers.values()) clearTimeout(timer);
      retryTimers.clear();
      rerunRequested.clear();
      inFlight.clear();
    },
  };
}
