/**
 * SponsoredExecution — prepare runner.
 *
 * Walks the prepare-side states (`Intent` through `AwaitUserSignature`)
 * defined in `states.ts` against an injected `SponsoredExecutionPolicy`. The runner
 * owns reservation acquisition + reverse-order cleanup + the
 * `transferOwnership()` boundary at PrepareStored success; the policy
 * policy's hooks own route-specific verification, build orchestration,
 * and prepared-commit projection.
 *
 * Design: typed transition functions per state, dispatched sequentially by a
 * procedural runner that holds the typed execution context. The runner never
 * delegates the next state to a hook.
 *
 * Cleanup ordering:
 *   route-specific reservations (reverse acquire order)
 *     → sponsor slot checkin
 *       → inflight release
 * Inflight is intentionally non-transferable — it always releases on
 * every path so concurrency caps stay accurate even after PrepareStored
 * succeeds. See `reservations.ts` for the type-level enforcement.
 *
 * Internal module. The public prepare handlers now delegate to
 * `runPrepareStateMachine` while preserving their stable entrypoint
 * signatures.
 */

import type {
  GasBoundBuildResult,
  LedgerReservationHandle,
  NonceReservationHandle,
  PreparedCommitInputs,
  SponsorSlotReservationHandle,
} from './index.js';
import { composePreparedCommit, createGasBoundBuildInput } from './index.js';
import type {
  SponsoredExecutionPolicy,
  PrepareChainSnapshot,
  PreparePolicyHookContext,
} from './index.js';
import {
  InflightReservationImpl,
  LedgerBudgetReservationImpl,
  NonceReservationImpl,
  SponsorSlotReservationImpl,
  type OwnershipTransfer,
  type ReservationLifecycle,
} from './reservations.js';
import type { SponsorPoolAdapter } from '../../context.js';
import type { PreparedTxEntry, PrepareStoreAdapter } from '../../store/prepareTypes.js';
import type { PrepareInflightLimiter } from '../../store/prepareInflightTypes.js';
import type { PromotionExecutionLedger } from '../../studio/executionLedger.js';
import type { ReserveFailureReason } from '../../studio/domain.js';

// ─────────────────────────────────────────────
// Host adapters + request shape
// ─────────────────────────────────────────────

/**
 * Production-side adapters the runner consumes. The runner constructs
 * fresh reservation instances per request from these adapters; the
 * adapters themselves are long-lived (single instance per process).
 *
 * `executionLedger` is required for promotion policies and ignored for
 * generic. The runner consults
 * `policy.handleRequirements.preparedCommit.ledgerReservation`
 * to decide whether to require it; missing-when-required throws
 * `RunnerHostMisconfiguredError` at runtime.
 */
export interface PrepareStateMachineHost {
  readonly inflightLimiter: PrepareInflightLimiter;
  readonly sponsorPool: SponsorPoolAdapter;
  readonly prepareStore: PrepareStoreAdapter;
  readonly executionLedger?: PromotionExecutionLedger;
}

/**
 * Per-request inputs the runner does not derive from the execution policy.
 *
 *   - `hookContext.receiptId` — the single receiptId source for the
 *     runner and every prepare hook. Production adapters generate it
 *     before invoking the runner.
 *   - `ChainSnapshot` output — the policy-owned typed snapshot fields
 *     the runner needs to acquire route reservations. Generic returns
 *     `nonceAcquire.onchainLastNonce`; Studio omits it.
 *   - `ledgerAcquireParams` — the promotion identity + receiptId fields
 *     the runner needs to acquire the ledger reservation. Required
 *     when `handleRequirements.preparedCommit.ledgerReservation === true`.
 *   - `preparedCommitInputs` — projected from the `PrepareStored` hook
 *     output. Prepared-commit construction routes through
 *     `composePreparedCommit`; the runner enforces that boundary by
 *     accepting only the typed `PreparedCommitInputs` shape.
 *
 * The hook context is forwarded to every policy hook; the runner does
 * not mutate it.
 */
export interface PrepareStateMachineRequest {
  readonly hookContext: PreparePolicyHookContext;
  readonly ledgerAcquireParams?: {
    readonly promotionId: string;
    readonly userId: string;
  };
  /**
   * Build the typed `PreparedCommitInputs` from the runner's collected
   * reservation handles + the policy hook's build result. Called immediately
   * before `prepareStore.store()`. The runner runs `composePreparedCommit`
   * on the returned inputs to produce the durable entry.
   */
  readonly preparedCommitInputs: (input: {
    receiptId: string;
    txBytesHash: string;
    sponsorSlot: SponsorSlotReservationHandle;
    nonce?: NonceReservationHandle;
    ledgerReservation?: LedgerReservationHandle;
    buildResult: GasBoundBuildResult;
  }) => PreparedCommitInputs;
}

/** Successful prepare state-machine result. */
export interface PrepareStateMachineResult {
  readonly receiptId: string;
  readonly txBytes: Uint8Array;
  readonly txBytesHash: string;
  /**
   * The committed entry written to the prepare store. Returned so prepare
   * adapters can project route-specific response fields from the durable entry.
   */
  readonly commit: PreparedTxEntry;
}

// ─────────────────────────────────────────────
// Errors raised by the runner itself
// ─────────────────────────────────────────────

/**
 * Runner-side errors are preserved as named classes so the
 * handler adapters can map them to public failure codes without
 * string-matching. Policy-side errors propagate unchanged.
 */
export class RunnerHostMisconfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerHostMisconfiguredError';
  }
}

export class RunnerSponsorSlotExhaustedError extends Error {
  constructor() {
    super('Sponsor pool returned no slot for the request');
    this.name = 'RunnerSponsorSlotExhaustedError';
  }
}

export class RunnerLedgerReservationRejectedError extends Error {
  constructor(public readonly reason: ReserveFailureReason | 'unknown' = 'unknown') {
    super(`Promotion ledger rejected the reservation request: ${reason}`);
    this.name = 'RunnerLedgerReservationRejectedError';
  }
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function isTransferable(
  reservation: ReservationLifecycle,
): reservation is ReservationLifecycle & OwnershipTransfer {
  return typeof (reservation as Partial<OwnershipTransfer>).transferOwnership === 'function';
}

/**
 * Hook-call helper that:
 *   1. preserves the runner's awaiting contract regardless of whether
 *      the hook returns `void` or `Promise<void>`,
 *   2. accepts an optional hook (for the two route-reservation states
 *      that may be omitted by policies that do not need them).
 */
async function callHook<Args extends unknown[]>(
  hook: ((...args: Args) => Promise<unknown> | unknown) | undefined,
  ...args: Args
): Promise<void> {
  if (!hook) return;
  await hook(...args);
}

// ─────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────

/**
 * Run the prepare state machine. Walks every state in
 * `PREPARE_STATE_ORDER`, acquiring reservations the policy declares
 * via `handleRequirements`, dispatching the execution policy's hook at
 * each state, and finally transferring ownership of transferable
 * reservations at the success boundary.
 *
 * Cleanup contract: on any failure path, the runner releases acquired
 * reservations in REVERSE acquired order. Reservations whose ownership
 * has already been transferred (sponsor slot, nonce, ledger after the
 * success boundary) skip release — the durable store owns those
 * resources after PrepareStored. Inflight is non-transferable and
 * ALWAYS releases.
 */
export async function runPrepareStateMachine(
  host: PrepareStateMachineHost,
  request: PrepareStateMachineRequest,
  policy: SponsoredExecutionPolicy,
): Promise<PrepareStateMachineResult> {
  // The runner's tracked reservation list. Order matches acquire order; reverse
  // iteration on cleanup yields the required cleanup ordering automatically.
  const acquired: ReservationLifecycle[] = [];

  // Per-request typed reservation handle accumulators. Filled as the state
  // machine progresses; consumed by later states that need to thread
  // the reservation handles into hook arguments or store-entry construction.
  let receiptId = '';
  let chainSnapshot: PrepareChainSnapshot = {};
  let sponsorSlotHandle: SponsorSlotReservationHandle | null = null;
  let nonceHandle: NonceReservationHandle | undefined;
  let ledgerReservationHandle: LedgerReservationHandle | undefined;
  let buildResult: GasBoundBuildResult | null = null;
  let commit: PreparedTxEntry | null = null;

  try {
    // ── State 1: Intent ───────────────────────────────────────────────
    await callHook(policy.hooks.Intent, request.hookContext);

    // ── State 2: RequestValidation ────────────────────────────────────
    await callHook(policy.hooks.RequestValidation, request.hookContext);

    // ── State 3: InflightAdmission ─────────────────────────────────────
    // Runner acquires inflight first so capacity-exhausted requests
    // never reach slot checkout / build work. Inflight release is LAST
    // in the cleanup chain; the corresponding
    // acquire is FIRST so reverse-order release yields the right shape.
    const inflight = new InflightReservationImpl(host.inflightLimiter);
    await inflight.acquire(policy.discriminator);
    acquired.push(inflight);
    await callHook(policy.hooks.InflightAdmission, request.hookContext);

    // ── State 4: ChainSnapshot ─────────────────────────────────────────
    // Policy hooks own route-specific read-model fetching; the runner
    // owns later reservation acquisition. The hook therefore returns
    // only typed snapshot fields needed by runner-owned reservations.
    chainSnapshot = await policy.hooks.ChainSnapshot(request.hookContext);

    // ── State 5: ExecutionPolicySelected ───────────────────────────────────
    // Policy is already selected (it's the input). Hook fires for any
    // route-specific selection-time observability.
    await callHook(policy.hooks.ExecutionPolicySelected, request.hookContext);

    // ── State 6: SlotFreePlan ──────────────────────────────────────────
    await callHook(policy.hooks.SlotFreePlan, request.hookContext);

    // ── State 7: ReceiptIdGenerated ───────────────────────────────────
    receiptId = request.hookContext.receiptId;
    await callHook(policy.hooks.ReceiptIdGenerated, request.hookContext);

    // ── State 8: SponsorSlotReservationAcquired ───────────────────────
    const slotReservation = new SponsorSlotReservationImpl(host.sponsorPool);
    sponsorSlotHandle = await slotReservation.acquire(receiptId);
    if (!sponsorSlotHandle) {
      throw new RunnerSponsorSlotExhaustedError();
    }
    acquired.push(slotReservation);
    await callHook(
      policy.hooks.SponsorSlotReservationAcquired,
      request.hookContext,
      sponsorSlotHandle,
    );

    // ── State 9: RouteReservationBeforeBuild (optional, generic) ──────
    if (policy.handleRequirements.gasBoundBuild.nonce) {
      if (!chainSnapshot.nonceAcquire) {
        throw new RunnerHostMisconfiguredError(
          'policy requires nonce reservation handle but ChainSnapshot did not return nonceAcquire',
        );
      }
      const nonceReservation = new NonceReservationImpl(host.prepareStore);
      nonceHandle = await nonceReservation.acquire(
        request.hookContext.senderAddress,
        chainSnapshot.nonceAcquire.onchainLastNonce,
        receiptId,
      );
      acquired.push(nonceReservation);
      await callHook(
        policy.hooks.RouteReservationBeforeBuild,
        request.hookContext,
        sponsorSlotHandle,
        nonceHandle,
      );
    }

    // ── State 10: GasBoundBuild ───────────────────────────────────────
    const gasBoundInput = createGasBoundBuildInput({
      sponsorSlot: sponsorSlotHandle,
      nonce: nonceHandle,
    });
    buildResult = await policy.hooks.GasBoundBuild(request.hookContext, gasBoundInput);

    // ── State 11: RouteReservationAfterBuild (optional, Studio) ───────
    if (policy.handleRequirements.preparedCommit.ledgerReservation) {
      if (!host.executionLedger) {
        throw new RunnerHostMisconfiguredError(
          'policy requires ledger reservation handle but host.executionLedger is missing',
        );
      }
      if (!request.ledgerAcquireParams) {
        throw new RunnerHostMisconfiguredError(
          'policy requires ledger reservation handle but request.ledgerAcquireParams is missing',
        );
      }
      const ledgerReservation = new LedgerBudgetReservationImpl(host.executionLedger);
      const ledgerAcquireResult = await ledgerReservation.acquire({
        receiptId,
        promotionId: request.ledgerAcquireParams.promotionId,
        userId: request.ledgerAcquireParams.userId,
        amountMist: buildResult.measuredGasMist,
      });
      if (!ledgerAcquireResult) {
        throw new RunnerLedgerReservationRejectedError(
          ledgerReservation.getLastRejectionReason() ?? 'unknown',
        );
      }
      ledgerReservationHandle = ledgerAcquireResult;
      acquired.push(ledgerReservation);
      await callHook(
        policy.hooks.RouteReservationAfterBuild,
        request.hookContext,
        sponsorSlotHandle,
        ledgerReservationHandle,
      );
    }

    // ── State 12: SelfCheck ────────────────────────────────────────────
    await callHook(policy.hooks.SelfCheck, request.hookContext);

    // ── State 13: SponsorLeaseCommitted ───────────────────────────────
    // Promote the slot's HMAC lease from reserved → committed against
    // the prepare commit hash. SponsorLeaseCommitError propagates to
    // the public handler adapter for SPONSOR_LEASE_COMMIT_FAILED
    // translation.
    await slotReservation.commitToTxBytesHash(buildResult.txBytesHash);
    await callHook(policy.hooks.SponsorLeaseCommitted, request.hookContext);

    // ── State 14: PrepareStored ────────────────────────────────────────
    // Lifecycle boundary: durable visibility and resource ownership must
    // not diverge. The runner therefore couples three operations as a
    // single atomic boundary:
    //   1. compose + store the durable prepared-commit entry,
    //   2. transfer ownership of every transferable reservation,
    //   3. fire the `PrepareStored` hook.
    // Step 2 runs immediately after step 1 and BEFORE step 3 so that any
    // post-store hook failure leaves the durable entry coherent with the
    // resources it references. After transfer, the `finally`
    // reverse-cleanup is a no-op for transferable reservations (slot,
    // nonce, ledger) and only the non-transferable inflight handle is
    // released.
    //
    // Current ownership rule:
    //   - `/prepare` transfers prepared resource ownership to the store
    //     and sponsor-time cleanup path as part of returning, not via a
    //     post-store hook.
    //   - The handler runs `store()` → `scope.finalize()` with no fallible
    //     work between them; this
    //     runner preserves that shape.
    //
    // Post-store hooks (`PrepareStored`, `AwaitUserSignature`) are
    // observability-only by contract. If a hook throws after the
    // transfer, the runner still propagates the error to the caller, but
    // the durable entry is left in place (it is coherent — the resources
    // it references are owned by it, not by the runner). The orphan
    // entry TTLs out the same way an unsigned prepare does.
    const commitInputs = request.preparedCommitInputs({
      receiptId,
      txBytesHash: buildResult.txBytesHash,
      sponsorSlot: sponsorSlotHandle,
      nonce: nonceHandle,
      ledgerReservation: ledgerReservationHandle,
      buildResult,
    });
    commit = composePreparedCommit(commitInputs);
    await host.prepareStore.store(receiptId, commit);

    // Transfer ownership BEFORE any post-store hook so the durable
    // visibility ↔ resource ownership invariant is atomic across hook
    // failure. `transferOwnership()` only throws when called outside the
    // `acquired` state, which is unreachable here because every entry in
    // `acquired` has a successful `acquire()` behind it.
    for (const r of acquired) {
      if (isTransferable(r)) r.transferOwnership();
    }

    await callHook(policy.hooks.PrepareStored, request.hookContext);

    // ── State 15: AwaitUserSignature ──────────────────────────────────
    // Observability-only by contract; a throw here propagates but does
    // not corrupt the durable boundary. Ownership has already moved to
    // the prepared-store entry above.
    await callHook(policy.hooks.AwaitUserSignature, request.hookContext);

    return {
      receiptId,
      txBytes: buildResult.txBytes,
      txBytesHash: buildResult.txBytesHash,
      commit,
    };
  } finally {
    // Reverse-order cleanup. Transferable reservations whose ownership
    // was transferred immediately after `prepareStore.store()` skip
    // release — their resources now live on the durable prepared-store
    // entry. Inflight is non-transferable and ALWAYS releases here.
    //
    // If a failure path runs the cleanup BEFORE store() (i.e. before
    // transfer), every transferable reservation is still in the
    // `acquired` state and `release()` performs the real reverse-order
    // cleanup. If the failure path runs AFTER store() (e.g. a thrown
    // post-store hook), every transferable reservation is in the
    // `transferred` state and `release()` is a no-op — the durable
    // entry now owns the resource — so the runner does not double-free
    // resources owned by `/sponsor`.
    for (let i = acquired.length - 1; i >= 0; i--) {
      await acquired[i]!.release();
    }
  }
}
