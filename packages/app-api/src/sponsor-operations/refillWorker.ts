/**
 * [app-api] Sponsor operations refill worker — Redis-shared state + distributed locks.
 *
 * Lifecycle for a single refill:
 *
 *   requestRefill(addr)
 *     → start a slot lifecycle on this instance. No-op if the slot is
 *       already running here. Cross-instance duplicate dispatch is
 *       prevented by the Redis-scoped refill lock (below), not by the
 *       local in-flight set.
 *
 *   runSlotLifecycle(addr)
 *     1. Try to acquire `stelis:app-api:sponsor-operations:refill-lock:<addr>`
 *        via `SET NX PX`. If another instance holds it, the worker
 *        skips this slot — the still-running instance will drive the
 *        refill to completion.
 *     2. Write `state='refilling'` (caller-owned fields only; Lua
 *        stamps `lastObservedAtMs` / `writeSeq`).
 *     3. Acquire the sponsor-refill-account dispatch lock, then execute
 *        the injected refill TX under the remaining `refillTimeoutMs`
 *        budget. On rejection, write `state='refill_failed'` + the
 *        error message, release the slot lock, return.
 *     4. Refresh sponsor refill account state with one bounded probe, then write the
 *        sponsor refill account HASH. RPC failure here is swallowed: the refill itself
 *        succeeded on chain, and a later sponsor refill account refresh can
 *        rewrite the shared state.
 *     5. Write `state='awaiting_confirmation'`.
 *     6. Confirmation phase — `getSlotBalance(addr)` under
 *        `withTimeout(confirmationTimeoutMs, …)`. Balance ≥ warn
 *        threshold → write `state='healthy'` + fresh balance. Balance
 *        below threshold → write `state='refill_failed'` + empty
 *        `lastError`. Rejection/timeout → write `state='refill_failed'`
 *        + error message.
 *     7. Release the slot lock via a matching-token Lua CAS delete.
 *
 * Slot lock TTL:
 *   Derived from the bounded lifecycle phase timers plus
 *   `SPONSOR_OPERATIONS_REFILL_LOCK_SAFETY_MARGIN_MS`.
 * Covers the phases executed inside the locked window.
 *
 * Observability:
 *   - Slot or sponsor refill account write failures emit `SPONSOR_OPERATIONS_STATE_WRITE_FAILED`
 *     so Redis commit failures are visible instead of being silently
 *     swallowed. Slot-write failure aborts the current lifecycle;
 *     sponsor refill account refresh remains best-effort after a successful refill TX.
 */

import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type { SponsorSlotState } from '@stelis/contracts';
import {
  logStructuredEvent,
  SPONSOR_OPERATIONS_STATE_WRITE_FAILED,
} from '@stelis/core-api/observability';
import type { RedisSponsorOperationsState } from './redisState.js';
import type { RefillLock, SponsorRefillAccountDispatchLock } from './refillLock.js';
import { normalizeSponsorOperationsLastError } from './lastError.js';
import { probeAndWriteSponsorRefillAccountState } from './sponsorRefillAccountProbe.js';
import { SponsorOperationsTimeoutError, withTimeout } from './timeout.js';

export interface SponsorOperationsRefillWorkerDeps {
  readonly state: RedisSponsorOperationsState;
  readonly refillLock: RefillLock;
  readonly sponsorRefillAccountDispatchLock: SponsorRefillAccountDispatchLock;
  readonly sui: SuiGrpcClient;
  readonly sponsorRefillAccountAddress: string;
  readonly warnThresholdMist: bigint;
  readonly refillTargetMist: bigint | null;
  /** Upper bound for a single `executeRefill` dispatch. Required — caller must justify. */
  readonly refillTimeoutMs: number;
  /** Upper bound for the `awaiting_confirmation` phase. Required. */
  readonly confirmationTimeoutMs: number;
  /** Upper bound for the bounded post-refill sponsor refill account probe. Required. */
  readonly sponsorRefillAccountBalanceTimeoutMs: number;
  /** Unbounded refill dispatch. Wrapped in `withTimeout(refillTimeoutMs, …)`. */
  readonly executeRefill: (slotAddress: string) => Promise<void>;
  /** Unbounded slot balance reader. Wrapped in `withTimeout(confirmationTimeoutMs, …)`. */
  readonly getSlotBalance: (slotAddress: string) => Promise<bigint>;
}

export interface SponsorOperationsRefillWorker {
  /**
   * Enqueue a refill request. No-op when the slot is already queued on
   * this instance. Cross-instance coordination happens via the Redis
   * refill lock once dispatch begins.
   */
  requestRefill(slotAddress: string): void;
  /**
   * Drain queued work, dispose resources, and make subsequent
   * `requestRefill` calls no-ops.
   */
  dispose(): void;
}

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `createSponsorOperationsRefillWorker: ${name} must be a positive safe integer, got ${String(value)}`,
    );
  }
}

function classifySlotFromBalance(balance: bigint, warnThresholdMist: bigint): SponsorSlotState {
  return balance >= warnThresholdMist ? 'healthy' : 'low_balance';
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
  });
}

export function createSponsorOperationsRefillWorker(
  deps: SponsorOperationsRefillWorkerDeps,
): SponsorOperationsRefillWorker {
  assertPositiveFinite('refillTimeoutMs', deps.refillTimeoutMs);
  assertPositiveFinite('confirmationTimeoutMs', deps.confirmationTimeoutMs);
  assertPositiveFinite(
    'sponsorRefillAccountBalanceTimeoutMs',
    deps.sponsorRefillAccountBalanceTimeoutMs,
  );

  let disposed = false;
  // Slots currently running through `runSlotLifecycle` on THIS instance.
  // Prevents a duplicate `requestRefill(addr)` from re-enqueueing while
  // the same slot is mid-lifecycle here. Cross-instance duplicate
  // dispatch is prevented separately by the Redis refill lock.
  const inFlight = new Set<string>();
  async function writeSlot(
    address: string,
    fields: Parameters<RedisSponsorOperationsState['updateSlot']>[1],
  ): Promise<boolean> {
    try {
      await deps.state.updateSlot(address, fields);
      return true;
    } catch (err) {
      logStructuredEvent(
        SPONSOR_OPERATIONS_STATE_WRITE_FAILED,
        {
          source: 'refill_worker_slot_update',
          slot_address: address,
          state: fields.state,
          write_error: getErrorMessage(err),
        },
        'warn',
      );
      return false;
    }
  }

  async function refreshSponsorRefillAccount(): Promise<void> {
    await probeAndWriteSponsorRefillAccountState(
      {
        sui: deps.sui,
        state: deps.state,
        sponsorRefillAccountAddress: deps.sponsorRefillAccountAddress,
        refillTargetMist: deps.refillTargetMist,
        sponsorRefillAccountBalanceTimeoutMs: deps.sponsorRefillAccountBalanceTimeoutMs,
      },
      {
        operation: 'refillWorker.getSponsorRefillAccountBalance',
        source: 'refill_worker_sponsor_refill_account_update',
        writeFailureMode: 'swallow',
      },
    );
  }

  async function runSlotLifecycle(address: string): Promise<void> {
    if (disposed) return;

    const handle = await deps.refillLock.acquire(address);
    if (handle === null) {
      // Another instance is driving this slot. Skip silently; the
      // other instance's completion will propagate via the shared
      // state store.
      return;
    }

    try {
      // Phase 1: mark as refilling.
      if (!(await writeSlot(address, { state: 'refilling', lastError: '' }))) return;

      // Phase 2: dispatch refill TX under the account-scoped distributed lock.
      try {
        await dispatchRefillWithAccountLock(address);
      } catch (err) {
        await writeSlot(address, {
          state: 'refill_failed',
          lastError: normalizeSponsorOperationsLastError(err),
        });
        return;
      }
      if (disposed) return;

      // Phase 3: refresh sponsor refill account state (best-effort; does not fail the lifecycle).
      await refreshSponsorRefillAccount();
      if (disposed) return;

      // Phase 4: mark as awaiting_confirmation.
      if (!(await writeSlot(address, { state: 'awaiting_confirmation', lastError: '' }))) return;

      // Phase 5: confirmation probe.
      try {
        const balance = await withTimeout(
          `refillWorker.confirmation(${address})`,
          deps.confirmationTimeoutMs,
          () => deps.getSlotBalance(address),
        );
        if (disposed) return;
        if (balance >= deps.warnThresholdMist) {
          if (
            !(await writeSlot(address, {
              state: classifySlotFromBalance(balance, deps.warnThresholdMist),
              balanceMist: balance.toString(),
              lastError: '',
            }))
          ) {
            return;
          }
        } else {
          if (
            !(await writeSlot(address, {
              state: 'refill_failed',
              balanceMist: balance.toString(),
              lastError: '',
            }))
          ) {
            return;
          }
        }
      } catch (err) {
        if (disposed) return;
        await writeSlot(address, {
          state: 'refill_failed',
          lastError: normalizeSponsorOperationsLastError(err),
        });
      }
    } finally {
      await deps.refillLock.release(handle);
    }
  }

  async function acquireAccountDispatchLock(deadlineMs: number) {
    const pollMs = 25;
    while (!disposed) {
      const handle = await deps.sponsorRefillAccountDispatchLock.acquire(
        deps.sponsorRefillAccountAddress,
      );
      if (handle !== null) return handle;

      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) break;
      await delay(Math.min(pollMs, remainingMs));
    }

    if (disposed) return null;
    throw new SponsorOperationsTimeoutError(
      `refillWorker.acquireSponsorRefillAccountDispatchLock(${deps.sponsorRefillAccountAddress})`,
      deps.refillTimeoutMs,
    );
  }

  async function dispatchRefillWithAccountLock(address: string): Promise<void> {
    if (disposed) return;

    const deadlineMs = Date.now() + deps.refillTimeoutMs;
    const handle = await acquireAccountDispatchLock(deadlineMs);
    if (handle === null) return;

    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      await deps.sponsorRefillAccountDispatchLock.release(handle);
      throw new SponsorOperationsTimeoutError(
        `refillWorker.executeRefill(${address})`,
        deps.refillTimeoutMs,
      );
    }

    await withTimeout(`refillWorker.executeRefill(${address})`, remainingMs, async () => {
      try {
        if (disposed) return;
        await deps.executeRefill(address);
      } finally {
        await deps.sponsorRefillAccountDispatchLock.release(handle);
      }
    });
  }

  function startSlotLifecycle(slotAddress: string): void {
    inFlight.add(slotAddress);
    void runSlotLifecycle(slotAddress).finally(() => {
      inFlight.delete(slotAddress);
    });
  }

  return {
    requestRefill(slotAddress: string): void {
      if (disposed) return;
      if (inFlight.has(slotAddress)) return;
      startSlotLifecycle(slotAddress);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      inFlight.clear();
    },
  };
}
