import { createHash, randomUUID } from 'node:crypto';
import type { SuiClientTypes } from '@mysten/sui/client';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction, TransactionDataBuilder } from '@mysten/sui/transactions';
import { fromBase64, fromHex, normalizeSuiAddress, toBase64 } from '@mysten/sui/utils';
import {
  isPositiveU64DecimalString,
  type SponsorSlotState,
  type SuiNetwork,
} from '@stelis/contracts';
import { parseSuiTransactionResult } from '@stelis/core-api';
import type {
  SponsorRefillAccountDispatchLock,
  SponsorRefillAccountDispatchLockHandle,
} from './refillLock.js';
import type { RedisSponsorOperationsState, SlotRead } from './redisState.js';
import {
  isActiveSponsorRefillAccountSpend,
  type SponsorRefillAccountSpend,
  type SponsorRefillAccountSpendStateStore,
  type SponsorRefillAccountWithdrawalReceipt,
} from './accountSpendState.js';
import { parseChainBalanceMist } from './balanceParsing.js';
import { normalizeSponsorOperationsLastError } from './lastError.js';
import { SponsorOperationsTimeoutError, withTimeout } from './timeout.js';

export interface BuiltSponsorRefillAccountSpend {
  readonly transactionBytes: Uint8Array;
  readonly signature: string;
  readonly digest: string;
  readonly gasBudgetMist: bigint;
}

export interface SponsorRefillAccountChainResult {
  readonly digest: string;
  readonly success: boolean;
  readonly error: string | null;
}

export type SponsorRefillAccountTransactionLookup =
  | { readonly status: 'found'; readonly result: SponsorRefillAccountChainResult }
  | { readonly status: 'not_found' };

export interface SponsorRefillAccountSpendBoundary {
  buildAndSign(
    destinationAddress: string,
    amountMist: bigint,
  ): Promise<BuiltSponsorRefillAccountSpend>;
  validateSignedIdentity(input: {
    readonly sourceAddress: string;
    readonly destinationAddress: string;
    readonly amountMist: bigint;
    readonly gasBudgetMist: bigint;
    readonly transactionBytes: Uint8Array;
    readonly signature: string;
    readonly digest: string;
  }): Promise<void>;
  simulate(transactionBytes: Uint8Array): Promise<{ success: boolean; error: string | null }>;
  lookup(digest: string): Promise<SponsorRefillAccountTransactionLookup>;
  submit(
    transactionBytes: Uint8Array,
    signature: string,
    expectedDigest: string,
  ): Promise<SponsorRefillAccountChainResult>;
  getBalance(address: string): Promise<bigint>;
}

export type SponsorRefillAccountSpendResult =
  | {
      readonly status: 'succeeded';
      readonly operationId: string;
      readonly digest: string;
      readonly amountMist: string;
      readonly remainingBalanceMist: string | null;
    }
  | {
      readonly status: 'failed';
      readonly operationId: string;
      readonly digest: string | null;
      readonly amountMist: string;
      readonly error: string;
    }
  | {
      readonly status: 'runway_blocked';
      readonly operationId: string;
      readonly digest: string | null;
      readonly amountMist: string;
      readonly error: string;
    }
  | {
      readonly status: 'pending';
      readonly operationId: string;
      readonly digest: string | null;
      readonly amountMist: string;
      readonly error: string;
    }
  | {
      readonly status: 'busy';
      readonly operationId: string;
      readonly digest: string | null;
      readonly error: string;
    }
  | { readonly status: 'nonce_missing' }
  | { readonly status: 'not_needed'; readonly slotAddress: string; readonly balanceMist: string };

export interface SponsorRefillAccountSpendCoordinatorDeps {
  readonly state: SponsorRefillAccountSpendStateStore;
  readonly operationsState: RedisSponsorOperationsState;
  readonly dispatchLock: SponsorRefillAccountDispatchLock;
  readonly boundary: SponsorRefillAccountSpendBoundary;
  readonly network: SuiNetwork;
  readonly sourceAddress: string;
  readonly sponsorSlotCount: number;
  readonly refillEnabled: boolean;
  readonly refillTargetMist: bigint | null;
  /** Mandatory runway target, independent from whether the automatic refill worker is enabled. */
  readonly runwayTargetMist: bigint;
  readonly warnThresholdMist: bigint;
  readonly dispatchTimeoutMs: number;
  readonly balanceTimeoutMs: number;
  readonly confirmationTimeoutMs: number;
}

export interface SponsorRefillAccountSpendCoordinator {
  withdraw(input: {
    readonly destinationAddress: string;
    readonly amountMist: string;
    readonly nonceKey: string;
  }): Promise<SponsorRefillAccountSpendResult>;
  refill(slotAddress: string): Promise<SponsorRefillAccountSpendResult>;
  recoverActiveSpend(): Promise<SponsorRefillAccountSpendResult | null>;
}

type RuntimeRecord = Record<string, unknown>;

function isRuntimeRecord(value: unknown): value is RuntimeRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCurrentTransactionResult(
  raw: SuiClientTypes.TransactionResult<{ effects: true }>,
  expectedDigest: string,
): SponsorRefillAccountChainResult {
  const transaction = parseSuiTransactionResult(raw);
  if (transaction === null) {
    throw new Error('Sponsor Refill Account transaction returned a malformed terminal result');
  }
  if (transaction.digest !== expectedDigest) {
    throw new Error('Sponsor Refill Account transaction result has an unexpected digest');
  }
  return {
    digest: expectedDigest,
    success: transaction.kind === 'success',
    error: transaction.kind === 'success' ? null : transaction.error.message,
  };
}

function parseSimulationResult(raw: SuiClientTypes.SimulateTransactionResult<{ effects: true }>): {
  success: boolean;
  error: string | null;
} {
  const transaction = parseSuiTransactionResult(raw);
  if (transaction === null) {
    throw new Error('Sponsor Refill Account simulation returned a malformed terminal result');
  }
  return transaction.kind === 'success'
    ? { success: true, error: null }
    : { success: false, error: transaction.error.message };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function u64LittleEndian(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  let remaining = value;
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

function decodedPureBytes(input: unknown): Uint8Array | null {
  if (!isRuntimeRecord(input) || input.$kind !== 'Pure' || !isRuntimeRecord(input.Pure)) {
    return null;
  }
  return typeof input.Pure.bytes === 'string' ? fromBase64(input.Pure.bytes) : null;
}

function assertCompiledSpendIdentity(input: {
  readonly transactionBytes: Uint8Array;
  readonly sourceAddress: string;
  readonly destinationAddress: string;
  readonly amountMist: bigint;
  readonly gasBudgetMist: bigint;
  readonly digest: string;
}): void {
  if (TransactionDataBuilder.getDigestFromBytes(input.transactionBytes) !== input.digest) {
    throw new Error('Stored Sponsor Refill Account transaction bytes do not match their digest');
  }
  const decoded = TransactionDataBuilder.fromBytes(input.transactionBytes).snapshot();
  const sourceAddress = normalizeSuiAddress(input.sourceAddress);
  const destinationAddress = normalizeSuiAddress(input.destinationAddress);
  if (
    normalizeSuiAddress(decoded.sender ?? '') !== sourceAddress ||
    normalizeSuiAddress(decoded.gasData.owner ?? '') !== sourceAddress ||
    String(decoded.gasData.budget ?? '') !== input.gasBudgetMist.toString() ||
    decoded.inputs.length !== 2 ||
    decoded.commands.length !== 2
  ) {
    throw new Error('Sponsor Refill Account transaction identity does not match durable fields');
  }
  const amountBytes = decodedPureBytes(decoded.inputs[0]);
  const destinationBytes = decodedPureBytes(decoded.inputs[1]);
  if (
    amountBytes === null ||
    destinationBytes === null ||
    !sameBytes(amountBytes, u64LittleEndian(input.amountMist)) ||
    !sameBytes(destinationBytes, fromHex(destinationAddress))
  ) {
    throw new Error('Sponsor Refill Account transaction inputs do not match durable fields');
  }

  const split = decoded.commands[0] as unknown;
  const transfer = decoded.commands[1] as unknown;
  if (
    !isRuntimeRecord(split) ||
    split.$kind !== 'SplitCoins' ||
    !isRuntimeRecord(split.SplitCoins)
  ) {
    throw new Error('Sponsor Refill Account transaction has an unexpected split command');
  }
  const coin = split.SplitCoins.coin;
  const amounts = split.SplitCoins.amounts;
  if (
    !isRuntimeRecord(coin) ||
    coin.$kind !== 'GasCoin' ||
    !Array.isArray(amounts) ||
    amounts.length !== 1 ||
    !isRuntimeRecord(amounts[0]) ||
    amounts[0].$kind !== 'Input' ||
    amounts[0].Input !== 0
  ) {
    throw new Error('Sponsor Refill Account transaction does not split the exact gas coin amount');
  }
  if (
    !isRuntimeRecord(transfer) ||
    transfer.$kind !== 'TransferObjects' ||
    !isRuntimeRecord(transfer.TransferObjects)
  ) {
    throw new Error('Sponsor Refill Account transaction has an unexpected transfer command');
  }
  const objects = transfer.TransferObjects.objects;
  const address = transfer.TransferObjects.address;
  if (
    !Array.isArray(objects) ||
    objects.length !== 1 ||
    !isRuntimeRecord(objects[0]) ||
    objects[0].$kind !== 'NestedResult' ||
    !Array.isArray(objects[0].NestedResult) ||
    objects[0].NestedResult[0] !== 0 ||
    objects[0].NestedResult[1] !== 0 ||
    !isRuntimeRecord(address) ||
    address.$kind !== 'Input' ||
    address.Input !== 1
  ) {
    throw new Error('Sponsor Refill Account transaction does not transfer the exact split coin');
  }
}

export function createSuiSponsorRefillAccountSpendBoundary(input: {
  readonly sui: SuiGrpcClient;
  readonly signer: Ed25519Keypair;
  readonly sourceAddress: string;
}): SponsorRefillAccountSpendBoundary {
  async function validateSignedIdentity(identity: {
    readonly sourceAddress: string;
    readonly destinationAddress: string;
    readonly amountMist: bigint;
    readonly gasBudgetMist: bigint;
    readonly transactionBytes: Uint8Array;
    readonly signature: string;
    readonly digest: string;
  }): Promise<void> {
    if (normalizeSuiAddress(identity.sourceAddress) !== normalizeSuiAddress(input.sourceAddress)) {
      throw new Error(
        'Sponsor Refill Account transaction source does not match the current signer',
      );
    }
    assertCompiledSpendIdentity(identity);
    if (
      !(await input.signer
        .getPublicKey()
        .verifyTransaction(identity.transactionBytes, identity.signature))
    ) {
      throw new Error('Sponsor Refill Account transaction signature does not match its bytes');
    }
  }

  return {
    async buildAndSign(destinationAddress, amountMist) {
      const transaction = new Transaction();
      const [coin] = transaction.splitCoins(transaction.gas, [transaction.pure.u64(amountMist)]);
      transaction.transferObjects([coin], destinationAddress);
      transaction.setSender(input.sourceAddress);

      const transactionBytes = await transaction.build({ client: input.sui });
      const decoded = TransactionDataBuilder.fromBytes(transactionBytes).snapshot();
      const gasBudgetRaw = decoded.gasData.budget;
      const gasBudgetMist = gasBudgetRaw == null ? '' : String(gasBudgetRaw);
      if (!isPositiveU64DecimalString(gasBudgetMist)) {
        throw new Error('Sponsor Refill Account transaction resolved an invalid gas budget');
      }
      const digest = TransactionDataBuilder.getDigestFromBytes(transactionBytes);
      const signed = await input.signer.signTransaction(transactionBytes);
      if (!sameBytes(fromBase64(signed.bytes), transactionBytes)) {
        throw new Error('Sponsor Refill Account signer returned different transaction bytes');
      }
      await validateSignedIdentity({
        sourceAddress: input.sourceAddress,
        destinationAddress,
        amountMist,
        gasBudgetMist: BigInt(gasBudgetMist),
        transactionBytes,
        signature: signed.signature,
        digest,
      });
      return {
        transactionBytes,
        signature: signed.signature,
        digest,
        gasBudgetMist: BigInt(gasBudgetMist),
      };
    },

    validateSignedIdentity,

    async simulate(transactionBytes) {
      return parseSimulationResult(
        await input.sui.simulateTransaction({
          transaction: transactionBytes,
          include: { effects: true },
        }),
      );
    },

    async lookup(digest) {
      try {
        const result = await input.sui.getTransaction({ digest, include: { effects: true } });
        return { status: 'found', result: parseCurrentTransactionResult(result, digest) };
      } catch (error) {
        if (error instanceof Error && error.message === `Transaction ${digest} not found`) {
          return { status: 'not_found' };
        }
        throw error;
      }
    },

    async submit(transactionBytes, signature, expectedDigest) {
      if (TransactionDataBuilder.getDigestFromBytes(transactionBytes) !== expectedDigest) {
        throw new Error(
          'Stored Sponsor Refill Account transaction bytes do not match their digest',
        );
      }
      return parseCurrentTransactionResult(
        await input.sui.executeTransaction({
          transaction: transactionBytes,
          signatures: [signature],
          include: { effects: true },
        }),
        expectedDigest,
      );
    },

    async getBalance(address) {
      const result = await input.sui.getBalance({ owner: address });
      return parseChainBalanceMist(result.balance.balance, `Address ${address} balance`);
    },
  };
}

function assertPositiveSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
  });
}

function classifySlot(balance: bigint, warnThresholdMist: bigint): SponsorSlotState {
  return balance >= warnThresholdMist ? 'healthy' : 'low_balance';
}

export function createSponsorRefillAccountSpendCoordinator(
  deps: SponsorRefillAccountSpendCoordinatorDeps,
): SponsorRefillAccountSpendCoordinator {
  assertPositiveSafeInteger('sponsorSlotCount', deps.sponsorSlotCount);
  assertPositiveSafeInteger('dispatchTimeoutMs', deps.dispatchTimeoutMs);
  assertPositiveSafeInteger('balanceTimeoutMs', deps.balanceTimeoutMs);
  assertPositiveSafeInteger('confirmationTimeoutMs', deps.confirmationTimeoutMs);
  if (deps.runwayTargetMist <= 0n) {
    throw new Error('runwayTargetMist must be positive');
  }

  const sourceRunwayMist = deps.runwayTargetMist * BigInt(deps.sponsorSlotCount);

  async function acquireDispatchLock(): Promise<SponsorRefillAccountDispatchLockHandle> {
    const deadlineMs = Date.now() + deps.dispatchTimeoutMs;
    while (true) {
      const handle = await deps.dispatchLock.acquire(deps.sourceAddress);
      if (handle !== null) return handle;
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        throw new SponsorOperationsTimeoutError(
          `sponsorRefillAccountSpend.acquire(${deps.sourceAddress})`,
          deps.dispatchTimeoutMs,
        );
      }
      await delay(Math.min(25, remainingMs));
    }
  }

  function refillsRemaining(balance: bigint): string {
    if (!deps.refillEnabled || deps.refillTargetMist === null) return '';
    return (balance / deps.refillTargetMist).toString();
  }

  function remainingTimeout(deadlineMs: number, operation: string): number {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      throw new SponsorOperationsTimeoutError(operation, deps.dispatchTimeoutMs);
    }
    return remainingMs;
  }

  async function sourceAccountObservation(): Promise<{
    readonly balance: bigint | null;
    readonly fields: {
      readonly balanceMist: string;
      readonly healthy: '1' | '0';
      readonly refillsRemaining: string;
      readonly lastError: string;
    };
  }> {
    try {
      const balance = await withTimeout(
        'sponsorRefillAccountSpend.getSourceBalance',
        deps.balanceTimeoutMs,
        () => deps.boundary.getBalance(deps.sourceAddress),
      );
      return {
        balance,
        fields: {
          balanceMist: balance.toString(),
          healthy: '1',
          refillsRemaining: refillsRemaining(balance),
          lastError: '',
        },
      };
    } catch (error) {
      return {
        balance: null,
        fields: {
          balanceMist: '',
          healthy: '0',
          refillsRemaining: '',
          lastError: normalizeSponsorOperationsLastError(error),
        },
      };
    }
  }

  async function failReserved(
    spend: SponsorRefillAccountSpend,
    error: unknown,
    status: 'failed' | 'runway_blocked',
  ): Promise<SponsorRefillAccountSpendResult> {
    const message = normalizeSponsorOperationsLastError(error);
    const failed = await deps.state.failReserved({
      operationId: spend.operationId,
      expectedSequence: spend.sequence,
      lastError: message,
      failureKind: status,
      slotAddress: spend.slotAddress,
    });
    if (failed === null) {
      const current = await deps.state.read();
      if (current !== null && current.operationId === spend.operationId) {
        return driveSpend(current);
      }
      return {
        status: 'pending',
        operationId: spend.operationId,
        digest: spend.digest,
        amountMist: spend.amountMist,
        error: 'Sponsor Refill Account spend changed while recording preparation failure',
      };
    }
    return {
      status,
      operationId: failed.operationId,
      digest: null,
      amountMist: failed.amountMist,
      error: failed.lastError ?? message,
    };
  }

  function pendingReserved(
    spend: SponsorRefillAccountSpend,
    error: unknown,
  ): SponsorRefillAccountSpendResult {
    return {
      status: 'pending',
      operationId: spend.operationId,
      digest: null,
      amountMist: spend.amountMist,
      error: normalizeSponsorOperationsLastError(error),
    };
  }

  async function requireVisibleChainResult(
    spend: SponsorRefillAccountSpend,
    operation: string,
  ): Promise<SponsorRefillAccountSpendResult | null> {
    if (spend.digest === null || spend.chainResult === null) return null;
    try {
      const lookup = await withTimeout(operation, deps.confirmationTimeoutMs, () =>
        deps.boundary.lookup(spend.digest!),
      );
      if (lookup.status === 'not_found') {
        return {
          status: 'pending',
          operationId: spend.operationId,
          digest: spend.digest,
          amountMist: spend.amountMist,
          error: 'Sponsor Refill Account spend is not yet visible on the account RPC boundary',
        };
      }
      const expectedSuccess = spend.chainResult === 'succeeded';
      if (lookup.result.success !== expectedSuccess) {
        return {
          status: 'pending',
          operationId: spend.operationId,
          digest: spend.digest,
          amountMist: spend.amountMist,
          error: 'Sponsor Refill Account RPC boundaries disagree on the transaction result',
        };
      }
      return null;
    } catch (error) {
      return {
        status: 'pending',
        operationId: spend.operationId,
        digest: spend.digest,
        amountMist: spend.amountMist,
        error: normalizeSponsorOperationsLastError(error),
      };
    }
  }

  async function prepareReservedSpend(
    spend: SponsorRefillAccountSpend,
  ): Promise<SponsorRefillAccountSpendResult | SponsorRefillAccountSpend> {
    let built: BuiltSponsorRefillAccountSpend;
    const preparationDeadlineMs = Date.now() + deps.dispatchTimeoutMs;
    try {
      built = await withTimeout(
        'sponsorRefillAccountSpend.buildAndSign',
        remainingTimeout(preparationDeadlineMs, 'sponsorRefillAccountSpend.buildAndSign'),
        () => deps.boundary.buildAndSign(spend.destinationAddress, BigInt(spend.amountMist)),
      );
    } catch (error) {
      return pendingReserved(spend, error);
    }
    let simulation: { success: boolean; error: string | null };
    try {
      simulation = await withTimeout(
        'sponsorRefillAccountSpend.simulate',
        remainingTimeout(preparationDeadlineMs, 'sponsorRefillAccountSpend.simulate'),
        () => deps.boundary.simulate(built.transactionBytes),
      );
    } catch (error) {
      return pendingReserved(spend, error);
    }
    if (!simulation.success) {
      return failReserved(
        spend,
        simulation.error ?? 'Sponsor Refill Account simulation failed',
        'failed',
      );
    }

    const accountCursor = await deps.state.readAccountObservationCursor();
    if (
      accountCursor.operationId !== spend.operationId ||
      accountCursor.spendSequence !== spend.sequence
    ) {
      return (await deps.state.read()) ?? spend;
    }
    const sourceObservation = await sourceAccountObservation();
    if (sourceObservation.balance === null) {
      return pendingReserved(spend, sourceObservation.fields.lastError);
    }
    const postBalance = sourceObservation.balance - BigInt(spend.amountMist) - built.gasBudgetMist;
    if (postBalance < sourceRunwayMist) {
      return failReserved(
        spend,
        `Sponsor Refill Account spend would leave ${postBalance.toString()} MIST below runway ${sourceRunwayMist.toString()} MIST`,
        'runway_blocked',
      );
    }

    const ready = await deps.state.markReady({
      operationId: spend.operationId,
      expectedSequence: spend.sequence,
      expectedAccountWriteSequence: accountCursor.writeSequence,
      gasBudgetMist: built.gasBudgetMist.toString(),
      transactionBytesBase64: toBase64(built.transactionBytes),
      signature: built.signature,
      digest: built.digest,
      sourceBalanceMist: sourceObservation.balance.toString(),
      refillsRemaining: refillsRemaining(sourceObservation.balance),
    });
    return ready ?? (await deps.state.read()) ?? spend;
  }

  async function observeRefillTerminal(
    spend: SponsorRefillAccountSpend,
    chainResult: SponsorRefillAccountChainResult,
  ): Promise<
    | { readonly status: 'not_applicable' }
    | {
        readonly status: 'observed';
        readonly address: string;
        readonly state: SponsorSlotState;
        readonly balanceMist: string;
        readonly lastError: string;
        readonly reconciliationResult: 'dispatch_succeeded' | 'dispatch_failed';
      }
  > {
    if (spend.slotAddress === null) return { status: 'not_applicable' };
    if (!chainResult.success) {
      try {
        const balance = await withTimeout(
          `sponsorRefillAccountSpend.getFailedSlotBalance(${spend.slotAddress})`,
          deps.balanceTimeoutMs,
          () => deps.boundary.getBalance(spend.slotAddress!),
        );
        return {
          status: 'observed',
          address: spend.slotAddress,
          state: 'refill_failed',
          balanceMist: balance.toString(),
          lastError: normalizeSponsorOperationsLastError(chainResult.error ?? 'refill failed'),
          reconciliationResult: 'dispatch_failed',
        };
      } catch (error) {
        return {
          status: 'observed',
          address: spend.slotAddress,
          state: 'refill_failed',
          balanceMist: '',
          lastError: normalizeSponsorOperationsLastError(error),
          reconciliationResult: 'dispatch_failed',
        };
      }
    }

    try {
      const balance = await withTimeout(
        `sponsorRefillAccountSpend.observeSlot(${spend.slotAddress})`,
        deps.confirmationTimeoutMs,
        () => deps.boundary.getBalance(spend.slotAddress!),
      );
      return {
        status: 'observed',
        address: spend.slotAddress,
        state: classifySlot(balance, deps.warnThresholdMist),
        balanceMist: balance.toString(),
        lastError: '',
        reconciliationResult: 'dispatch_succeeded',
      };
    } catch (error) {
      return {
        status: 'observed',
        address: spend.slotAddress,
        state: 'rpc_unreachable',
        balanceMist: '',
        lastError: normalizeSponsorOperationsLastError(error),
        reconciliationResult: 'dispatch_succeeded',
      };
    }
  }

  async function reconcileSpend(
    spend: SponsorRefillAccountSpend,
  ): Promise<SponsorRefillAccountSpendResult> {
    if (spend.state !== 'reconciling' || spend.chainResult === null || spend.digest === null) {
      throw new Error('Sponsor Refill Account spend is not ready for reconciliation');
    }
    const chainResult: SponsorRefillAccountChainResult = {
      digest: spend.digest,
      success: spend.chainResult === 'succeeded',
      error: spend.lastError,
    };
    const chainVisibility = await requireVisibleChainResult(
      spend,
      `sponsorRefillAccountSpend.confirm(${spend.digest})`,
    );
    if (chainVisibility !== null) return chainVisibility;
    const accountCursor = await deps.state.readAccountObservationCursor();
    if (
      accountCursor.operationId !== spend.operationId ||
      accountCursor.spendSequence !== spend.sequence
    ) {
      return {
        status: 'pending',
        operationId: spend.operationId,
        digest: spend.digest,
        amountMist: spend.amountMist,
        error: 'Sponsor Refill Account changed before reconciliation observation',
      };
    }
    const slotBefore =
      spend.slotAddress === null ? null : await deps.operationsState.readSlot(spend.slotAddress);
    if (
      spend.slotAddress !== null &&
      (slotBefore === null ||
        slotBefore.writeSeq === null ||
        slotBefore.refillOperationId !== spend.operationId ||
        slotBefore.refillOperationSequence !== spend.sequence ||
        slotBefore.refillOperationState !== 'reconciling')
    ) {
      return {
        status: 'pending',
        operationId: spend.operationId,
        digest: spend.digest,
        amountMist: spend.amountMist,
        error: 'Sponsor refill slot projection changed before reconciliation observation',
      };
    }
    const slotObservation = await observeRefillTerminal(spend, chainResult);
    const accountObservation = await sourceAccountObservation();
    const completed = await deps.state.complete({
      operationId: spend.operationId,
      expectedSequence: spend.sequence,
      expectedAccountWriteSequence: accountCursor.writeSequence,
      state: chainResult.success ? 'succeeded' : 'failed',
      lastError: normalizeSponsorOperationsLastError(chainResult.error ?? ''),
      account: accountObservation.fields,
      slot:
        slotObservation.status === 'not_applicable'
          ? null
          : {
              address: slotObservation.address,
              state: slotObservation.state,
              balanceMist: slotObservation.balanceMist,
              lastError: slotObservation.lastError,
              reconciliationResult: slotObservation.reconciliationResult,
              expectedWriteSequence: slotBefore!.writeSeq!,
            },
    });
    if (completed === null) {
      const current = await deps.state.read();
      if (
        current !== null &&
        current.operationId === spend.operationId &&
        !isActiveSponsorRefillAccountSpend(current)
      ) {
        return driveSpend(current);
      }
      return {
        status: 'pending',
        operationId: spend.operationId,
        digest: spend.digest,
        amountMist: spend.amountMist,
        error: 'Sponsor Refill Account changed during reconciliation observation',
      };
    }

    if (chainResult.success) {
      return {
        status: 'succeeded',
        operationId: spend.operationId,
        digest: chainResult.digest,
        amountMist: spend.amountMist,
        remainingBalanceMist: accountObservation.balance?.toString() ?? null,
      };
    }
    return {
      status: 'failed',
      operationId: spend.operationId,
      digest: chainResult.digest,
      amountMist: spend.amountMist,
      error: normalizeSponsorOperationsLastError(chainResult.error ?? 'transaction failed'),
    };
  }

  async function beginReconciliation(
    spend: SponsorRefillAccountSpend,
    chainResult: SponsorRefillAccountChainResult,
  ): Promise<SponsorRefillAccountSpendResult> {
    const next = await deps.state.markReconciling({
      operationId: spend.operationId,
      expectedSequence: spend.sequence,
      chainResult: chainResult.success ? 'succeeded' : 'failed',
      lastError: normalizeSponsorOperationsLastError(chainResult.error ?? ''),
    });
    const current = next ?? (await deps.state.read());
    if (current === null || current.operationId !== spend.operationId) {
      return {
        status: 'pending',
        operationId: spend.operationId,
        digest: spend.digest,
        amountMist: spend.amountMist,
        error: 'Sponsor Refill Account reconciliation was superseded',
      };
    }
    return driveSpend(current);
  }

  async function driveReadySpend(
    spend: SponsorRefillAccountSpend,
  ): Promise<SponsorRefillAccountSpendResult> {
    if (
      spend.transactionBytesBase64 === null ||
      spend.signature === null ||
      spend.digest === null ||
      spend.gasBudgetMist === null
    ) {
      throw new Error('Sponsor Refill Account ready spend is missing transaction identity');
    }
    const transactionBytes = fromBase64(spend.transactionBytesBase64);
    await deps.boundary.validateSignedIdentity({
      sourceAddress: spend.sourceAddress,
      destinationAddress: spend.destinationAddress,
      amountMist: BigInt(spend.amountMist),
      gasBudgetMist: BigInt(spend.gasBudgetMist),
      transactionBytes,
      signature: spend.signature,
      digest: spend.digest,
    });
    let lookup: SponsorRefillAccountTransactionLookup;
    try {
      lookup = await withTimeout(
        `sponsorRefillAccountSpend.lookup(${spend.digest})`,
        deps.confirmationTimeoutMs,
        () => deps.boundary.lookup(spend.digest!),
      );
    } catch (error) {
      return {
        status: 'pending',
        operationId: spend.operationId,
        digest: spend.digest,
        amountMist: spend.amountMist,
        error: normalizeSponsorOperationsLastError(error),
      };
    }
    if (lookup.status === 'found') return beginReconciliation(spend, lookup.result);

    try {
      const result = await withTimeout(
        `sponsorRefillAccountSpend.submit(${spend.digest})`,
        deps.dispatchTimeoutMs,
        () => deps.boundary.submit(transactionBytes, spend.signature!, spend.digest!),
      );
      return beginReconciliation(spend, result);
    } catch (submitError) {
      try {
        const afterSubmit = await withTimeout(
          `sponsorRefillAccountSpend.lookupAfterSubmit(${spend.digest})`,
          deps.confirmationTimeoutMs,
          () => deps.boundary.lookup(spend.digest!),
        );
        if (afterSubmit.status === 'found') {
          return beginReconciliation(spend, afterSubmit.result);
        }
      } catch {
        // Lookup uncertainty must not be converted into proof that the digest is absent.
      }
      return {
        status: 'pending',
        operationId: spend.operationId,
        digest: spend.digest,
        amountMist: spend.amountMist,
        error: normalizeSponsorOperationsLastError(submitError),
      };
    }
  }

  async function driveSpend(
    spend: SponsorRefillAccountSpend,
  ): Promise<SponsorRefillAccountSpendResult> {
    if (spend.network !== deps.network) {
      throw new Error('Sponsor Refill Account active spend belongs to a different network');
    }
    if (spend.sourceAddress !== deps.sourceAddress) {
      throw new Error('Sponsor Refill Account active spend belongs to a different source address');
    }
    if (spend.state === 'reserved') {
      const prepared = await prepareReservedSpend(spend);
      if ('status' in prepared) return prepared;
      if (prepared.operationId !== spend.operationId) {
        return {
          status: 'pending',
          operationId: spend.operationId,
          digest: spend.digest,
          amountMist: spend.amountMist,
          error: 'Sponsor Refill Account spend was superseded during preparation',
        };
      }
      return driveSpend(prepared);
    }
    if (spend.state === 'ready') return driveReadySpend(spend);
    if (spend.state === 'reconciling') return reconcileSpend(spend);
    if (spend.state === 'succeeded') {
      return {
        status: 'succeeded',
        operationId: spend.operationId,
        digest: spend.digest!,
        amountMist: spend.amountMist,
        remainingBalanceMist: null,
      };
    }
    const failureStatus = spend.terminalFailureKind;
    if (failureStatus === null) {
      throw new Error('Sponsor Refill Account failed spend is missing its terminal failure kind');
    }
    return {
      status: failureStatus,
      operationId: spend.operationId,
      digest: spend.digest,
      amountMist: spend.amountMist,
      error: spend.lastError ?? 'Sponsor Refill Account spend failed',
    };
  }

  async function resolveWithdrawalReceipt(
    receipt: SponsorRefillAccountWithdrawalReceipt,
    input: {
      readonly operationId: string;
      readonly destinationAddress: string;
      readonly amountMist: string;
    },
  ): Promise<SponsorRefillAccountSpendResult | null> {
    if (receipt.type === 'issued') return null;
    if (
      receipt.operationId !== input.operationId ||
      receipt.sourceAddress !== deps.sourceAddress ||
      receipt.destinationAddress !== input.destinationAddress ||
      receipt.amountMist !== input.amountMist
    ) {
      return { status: 'nonce_missing' };
    }
    if (receipt.type === 'terminal') {
      if (receipt.status === 'succeeded') {
        return {
          status: 'succeeded',
          operationId: receipt.operationId,
          digest: receipt.digest!,
          amountMist: receipt.amountMist,
          remainingBalanceMist: null,
        };
      }
      return {
        status: receipt.status,
        operationId: receipt.operationId,
        digest: receipt.digest,
        amountMist: receipt.amountMist,
        error: receipt.error!,
      };
    }
    const current = await deps.state.read();
    if (current === null || current.operationId !== receipt.operationId) {
      throw new Error(
        'Sponsor Refill Account accepted withdrawal receipt has no matching durable spend',
      );
    }
    return driveSpend(current);
  }

  async function recoverCurrentSpend(): Promise<SponsorRefillAccountSpendResult | null> {
    const current = await deps.state.read();
    return isActiveSponsorRefillAccountSpend(current) ? driveSpend(current) : null;
  }

  function busyBehindDifferentSpend(
    blockingSpend: SponsorRefillAccountSpend,
    recovered: SponsorRefillAccountSpendResult,
  ): SponsorRefillAccountSpendResult {
    return {
      status: 'busy',
      operationId: blockingSpend.operationId,
      digest: blockingSpend.digest,
      error:
        recovered.status === 'pending'
          ? recovered.error
          : 'A previous Sponsor Refill Account spend was recovered; this request was not accepted',
    };
  }

  async function executeReserved(input: {
    readonly operationId: string;
    readonly kind: 'withdrawal' | 'refill';
    readonly destinationAddress: string;
    readonly amountMist: string;
    readonly observedSlotBalanceMist: string | null;
    readonly expectedSlotWriteSequence: number | null;
    readonly nonceKey: string | null;
  }): Promise<SponsorRefillAccountSpendResult> {
    const reservation = await deps.state.reserve({
      operationId: input.operationId,
      kind: input.kind,
      sourceAddress: deps.sourceAddress,
      destinationAddress: input.destinationAddress,
      slotAddress: input.kind === 'refill' ? input.destinationAddress : null,
      amountMist: input.amountMist,
      observedSlotBalanceMist: input.observedSlotBalanceMist,
      expectedSlotWriteSequence: input.expectedSlotWriteSequence,
      nonceKey: input.nonceKey,
    });
    if (reservation.status === 'receipt') {
      if (input.kind !== 'withdrawal') {
        throw new Error('Sponsor Refill Account refill reservation returned a withdrawal receipt');
      }
      const result = await resolveWithdrawalReceipt(reservation.receipt, input);
      if (result === null) {
        throw new Error('Sponsor Refill Account reservation left an issued receipt unconsumed');
      }
      return result;
    }
    if (reservation.status === 'nonce_missing') return { status: 'nonce_missing' };
    if (reservation.status === 'slot_changed') {
      return {
        status: 'pending',
        operationId: input.operationId,
        digest: null,
        amountMist: input.amountMist,
        error: 'Sponsor refill slot changed before reservation',
      };
    }
    if (reservation.status === 'active') {
      const sameRequest =
        reservation.spend.operationId === input.operationId ||
        (input.kind === 'refill' &&
          reservation.spend.kind === 'refill' &&
          reservation.spend.slotAddress === input.destinationAddress);
      const activeResult = await driveSpend(reservation.spend);
      if (sameRequest) return activeResult;
      return busyBehindDifferentSpend(reservation.spend, activeResult);
    }
    return driveSpend(reservation.spend);
  }

  async function withAccountLock<T>(task: () => Promise<T>): Promise<T> {
    const handle = await acquireDispatchLock();
    try {
      return await task();
    } finally {
      try {
        await deps.dispatchLock.release(handle);
      } catch {
        // The lock is an expiring efficiency mutex. A release transport error must not
        // replace the result already committed by the durable operation CAS.
      }
    }
  }

  async function withdraw(input: {
    readonly destinationAddress: string;
    readonly amountMist: string;
    readonly nonceKey: string;
  }): Promise<SponsorRefillAccountSpendResult> {
    if (!isPositiveU64DecimalString(input.amountMist)) {
      throw new Error('Withdrawal amount must be a positive u64 decimal string');
    }
    const operationId = `withdrawal:${createHash('sha256')
      .update(
        JSON.stringify([
          'withdrawal',
          deps.network,
          input.nonceKey,
          input.destinationAddress,
          input.amountMist,
        ]),
      )
      .digest('hex')}`;
    return withAccountLock(async () => {
      const receipt = await deps.state.readWithdrawalReceipt(input.nonceKey);
      if (receipt !== null) {
        const receiptResult = await resolveWithdrawalReceipt(receipt, {
          operationId,
          destinationAddress: input.destinationAddress,
          amountMist: input.amountMist,
        });
        if (receiptResult !== null) return receiptResult;
      }
      const current = await deps.state.read();
      if (current?.operationId === operationId) return driveSpend(current);
      if (isActiveSponsorRefillAccountSpend(current)) {
        const recovered = await driveSpend(current);
        return busyBehindDifferentSpend(current, recovered);
      }
      if (current !== null) {
        const visibilityPending = await requireVisibleChainResult(
          current,
          `sponsorRefillAccountSpend.previous(${current.digest ?? 'none'})`,
        );
        if (visibilityPending !== null) {
          return busyBehindDifferentSpend(current, visibilityPending);
        }
      }
      return executeReserved({
        operationId,
        kind: 'withdrawal',
        destinationAddress: input.destinationAddress,
        amountMist: input.amountMist,
        observedSlotBalanceMist: null,
        expectedSlotWriteSequence: null,
        nonceKey: input.nonceKey,
      });
    });
  }

  async function refill(slotAddress: string): Promise<SponsorRefillAccountSpendResult> {
    const refillTargetMist = deps.refillTargetMist;
    if (!deps.refillEnabled || refillTargetMist === null) {
      return {
        status: 'failed',
        operationId: randomUUID(),
        digest: null,
        amountMist: '0',
        error: 'refill disabled or target not configured',
      };
    }
    return withAccountLock(async () => {
      const current = await deps.state.read();
      if (isActiveSponsorRefillAccountSpend(current)) {
        const sameSlot = current.kind === 'refill' && current.slotAddress === slotAddress;
        const recovered = await driveSpend(current);
        if (sameSlot) return recovered;
        return busyBehindDifferentSpend(current, recovered);
      }
      if (current !== null) {
        const visibilityPending = await requireVisibleChainResult(
          current,
          `sponsorRefillAccountSpend.previous(${current.digest ?? 'none'})`,
        );
        if (visibilityPending !== null) {
          return busyBehindDifferentSpend(current, visibilityPending);
        }
      }

      const previous: SlotRead | null = await deps.operationsState.readSlot(slotAddress);
      const expectedWriteSeq = previous?.writeSeq ?? 0;
      const balance = await withTimeout(
        `sponsorRefillAccountSpend.getSlotBalance(${slotAddress})`,
        deps.balanceTimeoutMs,
        () => deps.boundary.getBalance(slotAddress),
      );
      const amountMist = balance >= refillTargetMist ? 0n : refillTargetMist - balance;
      if (amountMist === 0n) {
        const updated = await deps.operationsState.updateSlotIfWriteSeq(
          slotAddress,
          expectedWriteSeq,
          {
            state: classifySlot(balance, deps.warnThresholdMist),
            balanceMist: balance.toString(),
            lastError: '',
            pendingRefillDigest: '',
            refillAttemptedAmountMist: '0',
            refillObservedBalanceMist: balance.toString(),
            refillReconciliationResult: 'not_needed',
            refillOperationId: '',
            refillOperationSequence: '',
            refillOperationState: '',
          },
        );
        if (!updated) {
          throw new Error('Sponsor refill slot changed while recording the fresh balance');
        }
        return { status: 'not_needed', slotAddress, balanceMist: balance.toString() };
      }
      return executeReserved({
        operationId: randomUUID(),
        kind: 'refill',
        destinationAddress: slotAddress,
        amountMist: amountMist.toString(),
        observedSlotBalanceMist: balance.toString(),
        expectedSlotWriteSequence: expectedWriteSeq,
        nonceKey: null,
      });
    });
  }

  async function recoverActiveSpend(): Promise<SponsorRefillAccountSpendResult | null> {
    // A process may restart while the efficiency lock from the dead process still has TTL.
    // Durable operation/sequence CAS and the stored transaction identity make recovery safe
    // without waiting for that stale mutex.
    return recoverCurrentSpend();
  }

  return { withdraw, refill, recoverActiveSpend };
}
