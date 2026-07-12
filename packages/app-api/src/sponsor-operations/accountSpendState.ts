import type { RedisClientLike } from '@stelis/core-api';
import {
  isPositiveU64DecimalString,
  type SponsorSlotState,
  type SuiNetwork,
} from '@stelis/contracts';
import {
  SPONSOR_REFILL_ACCOUNT_KEY,
  slotKey,
  type RefillReconciliationResult,
  type SponsorRefillAccountWriteFields,
} from './redisState.js';

export const SPONSOR_REFILL_ACCOUNT_SPEND_KINDS = ['refill', 'withdrawal'] as const;
export type SponsorRefillAccountSpendKind = (typeof SPONSOR_REFILL_ACCOUNT_SPEND_KINDS)[number];

export const SPONSOR_REFILL_ACCOUNT_SPEND_STATES = [
  'reserved',
  'ready',
  'reconciling',
  'succeeded',
  'failed',
] as const;
export type SponsorRefillAccountSpendState = (typeof SPONSOR_REFILL_ACCOUNT_SPEND_STATES)[number];

export type SponsorRefillAccountSpendTerminalFailureKind = 'runway_blocked' | 'failed';

export type SponsorRefillAccountWithdrawalReceipt =
  | {
      readonly type: 'issued';
      readonly network: SuiNetwork;
    }
  | {
      readonly type: 'accepted';
      readonly network: SuiNetwork;
      readonly operationId: string;
      readonly sourceAddress: string;
      readonly destinationAddress: string;
      readonly amountMist: string;
    }
  | {
      readonly type: 'terminal';
      readonly network: SuiNetwork;
      readonly operationId: string;
      readonly sourceAddress: string;
      readonly destinationAddress: string;
      readonly amountMist: string;
      readonly status: 'succeeded' | SponsorRefillAccountSpendTerminalFailureKind;
      readonly digest: string | null;
      readonly error: string | null;
    };

const WITHDRAWAL_RECEIPT_TAG = 'stelis:sponsor-refill-account-withdrawal-receipt';

function encodeWithdrawalReceipt(receipt: SponsorRefillAccountWithdrawalReceipt): string {
  if (receipt.type === 'issued') {
    return JSON.stringify([WITHDRAWAL_RECEIPT_TAG, 'issued', receipt.network]);
  }
  if (receipt.type === 'accepted') {
    return JSON.stringify([
      WITHDRAWAL_RECEIPT_TAG,
      'accepted',
      receipt.network,
      receipt.operationId,
      receipt.sourceAddress,
      receipt.destinationAddress,
      receipt.amountMist,
    ]);
  }
  return JSON.stringify([
    WITHDRAWAL_RECEIPT_TAG,
    'terminal',
    receipt.network,
    receipt.operationId,
    receipt.sourceAddress,
    receipt.destinationAddress,
    receipt.amountMist,
    receipt.status,
    receipt.digest,
    receipt.error,
  ]);
}

export function encodeSponsorRefillAccountWithdrawalIssuedReceipt(network: SuiNetwork): string {
  return encodeWithdrawalReceipt({ type: 'issued', network });
}

function parseWithdrawalReceipt(
  raw: string,
  expectedNetwork: SuiNetwork,
): SponsorRefillAccountWithdrawalReceipt {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Sponsor Refill Account withdrawal receipt is malformed');
  }
  if (
    !Array.isArray(value) ||
    value[0] !== WITHDRAWAL_RECEIPT_TAG ||
    value[2] !== expectedNetwork
  ) {
    throw new Error('Sponsor Refill Account withdrawal receipt has an invalid network or schema');
  }
  if (value[1] === 'issued' && value.length === 3) {
    return { type: 'issued', network: expectedNetwork };
  }
  const operationId = value[3];
  const sourceAddress = value[4];
  const destinationAddress = value[5];
  const amountMist = value[6];
  if (
    typeof operationId !== 'string' ||
    operationId.length === 0 ||
    typeof sourceAddress !== 'string' ||
    sourceAddress.length === 0 ||
    typeof destinationAddress !== 'string' ||
    destinationAddress.length === 0 ||
    typeof amountMist !== 'string' ||
    !isPositiveU64DecimalString(amountMist)
  ) {
    throw new Error('Sponsor Refill Account withdrawal receipt has an invalid operation identity');
  }
  if (value[1] === 'accepted' && value.length === 7) {
    return {
      type: 'accepted',
      network: expectedNetwork,
      operationId,
      sourceAddress,
      destinationAddress,
      amountMist,
    };
  }
  if (value[1] !== 'terminal' || value.length !== 10) {
    throw new Error('Sponsor Refill Account withdrawal receipt has an invalid state');
  }
  const status = value[7];
  const digest = value[8];
  const error = value[9];
  if (
    (status !== 'succeeded' && status !== 'failed' && status !== 'runway_blocked') ||
    (digest !== null && (typeof digest !== 'string' || digest.length === 0)) ||
    (error !== null && (typeof error !== 'string' || error.length === 0)) ||
    (status === 'succeeded' && (digest === null || error !== null)) ||
    (status === 'runway_blocked' && (digest !== null || error === null)) ||
    (status === 'failed' && error === null)
  ) {
    throw new Error('Sponsor Refill Account withdrawal terminal receipt is inconsistent');
  }
  return {
    type: 'terminal',
    network: expectedNetwork,
    operationId,
    sourceAddress,
    destinationAddress,
    amountMist,
    status,
    digest,
    error,
  };
}

export interface SponsorRefillAccountSpend {
  readonly network: SuiNetwork;
  readonly operationId: string;
  readonly kind: SponsorRefillAccountSpendKind;
  readonly sourceAddress: string;
  readonly destinationAddress: string;
  readonly slotAddress: string | null;
  readonly nonceKey: string | null;
  readonly amountMist: string;
  readonly gasBudgetMist: string | null;
  readonly transactionBytesBase64: string | null;
  readonly signature: string | null;
  readonly digest: string | null;
  readonly sequence: number;
  readonly state: SponsorRefillAccountSpendState;
  readonly chainResult: 'succeeded' | 'failed' | null;
  readonly terminalFailureKind: SponsorRefillAccountSpendTerminalFailureKind | null;
  readonly lastError: string | null;
}

export type ActiveSponsorRefillAccountSpend = SponsorRefillAccountSpend & {
  readonly state: 'reserved' | 'ready' | 'reconciling';
};

export interface ReserveSponsorRefillAccountSpendInput {
  readonly operationId: string;
  readonly kind: SponsorRefillAccountSpendKind;
  readonly sourceAddress: string;
  readonly destinationAddress: string;
  readonly slotAddress: string | null;
  readonly amountMist: string;
  readonly observedSlotBalanceMist: string | null;
  readonly expectedSlotWriteSequence: number | null;
  readonly nonceKey: string | null;
}

export type ReserveSponsorRefillAccountSpendResult =
  | { readonly status: 'created'; readonly spend: SponsorRefillAccountSpend }
  | { readonly status: 'receipt'; readonly receipt: SponsorRefillAccountWithdrawalReceipt }
  | { readonly status: 'nonce_missing' }
  | { readonly status: 'slot_changed' }
  | { readonly status: 'active'; readonly spend: SponsorRefillAccountSpend };

export interface MarkSponsorRefillAccountSpendReadyInput {
  readonly operationId: string;
  readonly expectedSequence: number;
  readonly expectedAccountWriteSequence: number;
  readonly gasBudgetMist: string;
  readonly transactionBytesBase64: string;
  readonly signature: string;
  readonly digest: string;
  readonly sourceBalanceMist: string;
  readonly refillsRemaining: string;
}

export interface CompleteSponsorRefillAccountSpendInput {
  readonly operationId: string;
  readonly expectedSequence: number;
  readonly expectedAccountWriteSequence: number;
  readonly state: 'succeeded' | 'failed';
  readonly lastError: string;
  readonly account: SponsorRefillAccountWriteFields;
  readonly slot: {
    readonly address: string;
    readonly state: SponsorSlotState;
    readonly balanceMist: string;
    readonly lastError: string;
    readonly reconciliationResult: RefillReconciliationResult;
    readonly expectedWriteSequence: number;
  } | null;
}

export interface ReconcileSponsorRefillAccountSpendInput {
  readonly operationId: string;
  readonly expectedSequence: number;
  readonly chainResult: 'succeeded' | 'failed';
  readonly lastError: string;
}

export interface FailReservedSponsorRefillAccountSpendInput {
  readonly operationId: string;
  readonly expectedSequence: number;
  readonly lastError: string;
  readonly failureKind: SponsorRefillAccountSpendTerminalFailureKind;
  readonly slotAddress: string | null;
}

export interface SponsorRefillAccountObservationCursor {
  readonly operationId: string | null;
  readonly spendSequence: number;
  readonly writeSequence: number;
}

const ACTIVE_SPEND_STATES = new Set<SponsorRefillAccountSpendState>([
  'reserved',
  'ready',
  'reconciling',
]);
function isDecimal(raw: string | undefined): raw is string {
  return raw !== undefined && /^(?:0|[1-9]\d*)$/.test(raw);
}

function isPositiveU64(raw: string | undefined): raw is string {
  return raw !== undefined && isPositiveU64DecimalString(raw);
}

function parseSequence(raw: string | undefined): number | null {
  if (!isDecimal(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseSpend(
  hash: Record<string, string>,
  expectedNetwork: SuiNetwork,
): SponsorRefillAccountSpend | null {
  const stateRaw = hash.spendState;
  if (stateRaw === undefined || stateRaw === '') {
    if (hash.spendOperationId || hash.spendNetwork || hash.spendNonceKey) {
      throw new Error('Sponsor Refill Account spend has identity without a state');
    }
    return null;
  }
  if (hash.spendNetwork !== expectedNetwork) {
    throw new Error('Sponsor Refill Account spend belongs to a different or missing network');
  }
  if (!(SPONSOR_REFILL_ACCOUNT_SPEND_STATES as readonly string[]).includes(stateRaw)) {
    throw new Error(`Sponsor Refill Account spend has invalid state '${stateRaw}'`);
  }
  const state = stateRaw as SponsorRefillAccountSpendState;
  const kindRaw = hash.spendKind;
  if (!(SPONSOR_REFILL_ACCOUNT_SPEND_KINDS as readonly string[]).includes(kindRaw ?? '')) {
    throw new Error('Sponsor Refill Account spend has invalid kind');
  }
  const kind = kindRaw as SponsorRefillAccountSpendKind;
  const sequence = parseSequence(hash.spendSequence);
  if (
    !hash.spendOperationId ||
    !hash.spendSourceAddress ||
    !hash.spendDestinationAddress ||
    !isPositiveU64(hash.spendAmountMist) ||
    sequence === null ||
    sequence <= 0
  ) {
    throw new Error('Sponsor Refill Account spend is malformed');
  }
  const slotAddress = hash.spendSlotAddress || null;
  if ((kind === 'refill') !== (slotAddress !== null)) {
    throw new Error('Sponsor Refill Account spend has inconsistent slot identity');
  }
  const nonceKey = hash.spendNonceKey || null;
  if ((kind === 'withdrawal') !== (nonceKey !== null)) {
    throw new Error('Sponsor Refill Account spend has inconsistent withdrawal receipt identity');
  }

  const gasBudgetMist = hash.spendGasBudgetMist || null;
  const transactionBytesBase64 = hash.spendTransactionBytesBase64 || null;
  const signature = hash.spendSignature || null;
  const digest = hash.spendDigest || null;
  const chainResultRaw = hash.spendChainResult || null;
  if (chainResultRaw !== null && chainResultRaw !== 'succeeded' && chainResultRaw !== 'failed') {
    throw new Error('Sponsor Refill Account spend has invalid chain result');
  }
  const chainResult = chainResultRaw as 'succeeded' | 'failed' | null;
  const terminalFailureKindRaw = hash.spendTerminalFailureKind || null;
  if (
    terminalFailureKindRaw !== null &&
    terminalFailureKindRaw !== 'runway_blocked' &&
    terminalFailureKindRaw !== 'failed'
  ) {
    throw new Error('Sponsor Refill Account spend has an invalid terminal failure kind');
  }
  const terminalFailureKind =
    terminalFailureKindRaw as SponsorRefillAccountSpendTerminalFailureKind | null;
  const lastError = hash.spendLastError || null;
  const hasCompleteIdentity =
    isPositiveU64(gasBudgetMist ?? undefined) &&
    transactionBytesBase64 !== null &&
    signature !== null &&
    digest !== null;
  const hasAnyIdentity =
    gasBudgetMist !== null ||
    transactionBytesBase64 !== null ||
    signature !== null ||
    digest !== null;
  if (
    (state === 'ready' || state === 'reconciling' || state === 'succeeded') &&
    !hasCompleteIdentity
  ) {
    throw new Error('Sponsor Refill Account ready/terminal spend has incomplete identity');
  }
  if (
    state === 'reserved' &&
    (hasAnyIdentity || chainResult !== null || terminalFailureKind !== null || lastError !== null)
  ) {
    throw new Error(
      'Sponsor Refill Account reserved spend contains premature transaction identity',
    );
  }
  if (
    state === 'ready' &&
    (chainResult !== null || terminalFailureKind !== null || lastError !== null)
  ) {
    throw new Error('Sponsor Refill Account ready spend contains a terminal chain result');
  }
  if (state === 'reconciling' && (chainResult === null || terminalFailureKind !== null)) {
    throw new Error('Sponsor Refill Account reconciled spend has no chain result');
  }
  if (
    state === 'reconciling' &&
    ((chainResult === 'succeeded' && lastError !== null) ||
      (chainResult === 'failed' && lastError === null))
  ) {
    throw new Error('Sponsor Refill Account reconciled spend has an inconsistent error');
  }
  if (
    state === 'succeeded' &&
    (chainResult !== 'succeeded' || terminalFailureKind !== null || lastError !== null)
  ) {
    throw new Error('Sponsor Refill Account succeeded spend has an inconsistent chain result');
  }
  if (
    state === 'failed' &&
    (!(
      (chainResult === null && !hasAnyIdentity && terminalFailureKind !== null) ||
      (chainResult === 'failed' && hasCompleteIdentity && terminalFailureKind === 'failed')
    ) ||
      lastError === null)
  ) {
    throw new Error('Sponsor Refill Account failed spend has an inconsistent transaction identity');
  }

  return {
    network: expectedNetwork,
    operationId: hash.spendOperationId,
    kind,
    sourceAddress: hash.spendSourceAddress,
    destinationAddress: hash.spendDestinationAddress,
    slotAddress,
    nonceKey,
    amountMist: hash.spendAmountMist,
    gasBudgetMist,
    transactionBytesBase64,
    signature,
    digest,
    sequence,
    state,
    chainResult,
    terminalFailureKind,
    lastError,
  };
}

function assertSequence(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function assertReserveInput(input: ReserveSponsorRefillAccountSpendInput): void {
  if (!input.operationId || !input.sourceAddress || !input.destinationAddress) {
    throw new Error('Sponsor Refill Account spend reservation requires operation identities');
  }
  if (!isPositiveU64(input.amountMist)) {
    throw new Error('Sponsor Refill Account spend amount must be a positive u64 decimal string');
  }
  if ((input.kind === 'refill') !== (input.slotAddress !== null)) {
    throw new Error('Sponsor Refill Account refill reservation requires exactly one slot address');
  }
  if ((input.kind === 'withdrawal') !== (input.nonceKey !== null && input.nonceKey.length > 0)) {
    throw new Error(
      'Sponsor Refill Account withdrawal reservation requires exactly one receipt key',
    );
  }
  if (input.kind === 'refill' && !isDecimal(input.observedSlotBalanceMist ?? undefined)) {
    throw new Error('Sponsor Refill Account refill reservation requires an observed slot balance');
  }
  if (input.kind === 'refill') {
    assertSequence(input.expectedSlotWriteSequence ?? -1, 'expectedSlotWriteSequence');
  } else if (input.expectedSlotWriteSequence !== null) {
    throw new Error('Sponsor Refill Account withdrawal cannot carry a slot write sequence');
  }
}

function accountWriteArgs(fields: SponsorRefillAccountWriteFields): readonly string[] {
  return [
    fields.balanceMist ?? '',
    fields.healthy ?? '0',
    fields.refillsRemaining ?? '',
    fields.lastError ?? '',
  ];
}

const STAMP_ENTITY_LUA = [
  "local time = redis.call('TIME')",
  'local nowMs = tostring(tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000))',
  "local writeSeq = redis.call('HINCRBY', KEYS[1], 'writeSeq', 1)",
  "redis.call('HSET', KEYS[1], 'lastObservedAtMs', nowMs)",
].join('\n');

export const RESERVE_SPONSOR_REFILL_ACCOUNT_SPEND_LUA = [
  "local currentState = redis.call('HGET', KEYS[1], 'spendState') or ''",
  "local currentOperationId = redis.call('HGET', KEYS[1], 'spendOperationId') or ''",
  "if currentState == '' and currentOperationId ~= '' then return { 'MALFORMED' } end",
  "if currentState ~= '' and (redis.call('HGET', KEYS[1], 'spendNetwork') or '') ~= ARGV[11] then",
  "  return { 'NETWORK_MISMATCH' }",
  'end',
  "if ARGV[1] == '1' then",
  "  local receipt = redis.call('GET', KEYS[2])",
  "  if not receipt then return { 'NONCE_MISSING' } end",
  "  if receipt ~= ARGV[12] then return { 'RECEIPT', receipt } end",
  'end',
  "if currentState ~= '' and currentState ~= 'succeeded' and currentState ~= 'failed' then",
  "  return { 'ACTIVE' }",
  'end',
  "if ARGV[8] == '1' then",
  "  local slotWriteSeq = redis.call('HGET', KEYS[3], 'writeSeq') or '0'",
  "  if slotWriteSeq ~= ARGV[10] then return { 'SLOT_CHANGED' } end",
  'end',
  "if ARGV[1] == '1' then redis.call('SET', KEYS[2], ARGV[13], 'PX', ARGV[14]) end",
  "local spendSeq = redis.call('HINCRBY', KEYS[1], 'spendSequence', 1)",
  STAMP_ENTITY_LUA,
  "redis.call('HSET', KEYS[1],",
  "  'spendNetwork', ARGV[11],",
  "  'spendOperationId', ARGV[2],",
  "  'spendKind', ARGV[3],",
  "  'spendSourceAddress', ARGV[4],",
  "  'spendDestinationAddress', ARGV[5],",
  "  'spendSlotAddress', ARGV[6],",
  "  'spendNonceKey', ARGV[1] == '1' and KEYS[2] or '',",
  "  'spendAmountMist', ARGV[7],",
  "  'spendGasBudgetMist', '',",
  "  'spendTransactionBytesBase64', '',",
  "  'spendSignature', '',",
  "  'spendDigest', '',",
  "  'spendChainResult', '',",
  "  'spendTerminalFailureKind', '',",
  "  'spendState', 'reserved',",
  "  'spendLastError', '')",
  "if ARGV[8] == '1' then",
  "  local slotTime = redis.call('TIME')",
  '  local slotNowMs = tostring(tonumber(slotTime[1]) * 1000 + math.floor(tonumber(slotTime[2]) / 1000))',
  "  redis.call('HINCRBY', KEYS[3], 'writeSeq', 1)",
  "  redis.call('HSET', KEYS[3],",
  "    'lastObservedAtMs', slotNowMs,",
  "    'state', 'refilling',",
  "    'balanceMist', ARGV[9],",
  "    'lastError', '',",
  "    'pendingRefillDigest', '',",
  "    'refillAttemptedAmountMist', ARGV[7],",
  "    'refillObservedBalanceMist', ARGV[9],",
  "    'refillReconciliationResult', 'dispatch_started',",
  "    'refillOperationId', ARGV[2],",
  "    'refillOperationSequence', tostring(spendSeq),",
  "    'refillOperationState', 'reserved')",
  'end',
  "return { 'CREATED', tostring(spendSeq) }",
].join('\n');

export const MARK_SPONSOR_REFILL_ACCOUNT_SPEND_READY_LUA = [
  "local operationId = redis.call('HGET', KEYS[1], 'spendOperationId') or ''",
  "local sequence = redis.call('HGET', KEYS[1], 'spendSequence') or ''",
  "local accountWriteSeq = redis.call('HGET', KEYS[1], 'writeSeq') or '0'",
  "local state = redis.call('HGET', KEYS[1], 'spendState') or ''",
  "if operationId ~= ARGV[1] or sequence ~= ARGV[2] or state ~= 'reserved' then",
  "  return { 'STALE' }",
  'end',
  "local nextSeq = redis.call('HINCRBY', KEYS[1], 'spendSequence', 1)",
  STAMP_ENTITY_LUA,
  "redis.call('HSET', KEYS[1],",
  "  'spendGasBudgetMist', ARGV[4],",
  "  'spendTransactionBytesBase64', ARGV[5],",
  "  'spendSignature', ARGV[6],",
  "  'spendDigest', ARGV[7],",
  "  'spendState', 'ready',",
  "  'spendChainResult', '',",
  "  'spendLastError', '')",
  'if accountWriteSeq == ARGV[3] then',
  "  redis.call('HSET', KEYS[1],",
  "    'balanceMist', ARGV[8],",
  "    'healthy', '1',",
  "    'refillsRemaining', ARGV[9],",
  "    'lastError', '')",
  'end',
  "local slotAddress = redis.call('HGET', KEYS[1], 'spendSlotAddress') or ''",
  "if slotAddress ~= '' then",
  "  local slotTime = redis.call('TIME')",
  '  local slotNowMs = tostring(tonumber(slotTime[1]) * 1000 + math.floor(tonumber(slotTime[2]) / 1000))',
  "  redis.call('HINCRBY', KEYS[2], 'writeSeq', 1)",
  "  redis.call('HSET', KEYS[2],",
  "    'lastObservedAtMs', slotNowMs,",
  "    'pendingRefillDigest', ARGV[7],",
  "    'refillReconciliationResult', 'dispatch_ready',",
  "    'refillOperationSequence', tostring(nextSeq),",
  "    'refillOperationState', 'ready')",
  'end',
  "return { 'READY', tostring(nextSeq) }",
].join('\n');

export const COMPLETE_SPONSOR_REFILL_ACCOUNT_SPEND_LUA = [
  "local operationId = redis.call('HGET', KEYS[1], 'spendOperationId') or ''",
  "local sequence = redis.call('HGET', KEYS[1], 'spendSequence') or ''",
  "local accountWriteSeq = redis.call('HGET', KEYS[1], 'writeSeq') or '0'",
  "local state = redis.call('HGET', KEYS[1], 'spendState') or ''",
  "local chainResult = redis.call('HGET', KEYS[1], 'spendChainResult') or ''",
  "if operationId ~= ARGV[1] or sequence ~= ARGV[2] or state ~= 'reconciling' then",
  "  return { 'STALE' }",
  'end',
  "if chainResult ~= ARGV[4] then return { 'CHAIN_RESULT_MISMATCH' } end",
  "local nonceKey = redis.call('HGET', KEYS[1], 'spendNonceKey') or ''",
  "if nonceKey ~= '' and (nonceKey ~= KEYS[3] or ARGV[17] == '') then",
  "  return { 'RECEIPT_MISMATCH' }",
  'end',
  "if ARGV[10] == '1' then",
  "  local slotOperationId = redis.call('HGET', KEYS[2], 'refillOperationId') or ''",
  "  local slotOperationSequence = redis.call('HGET', KEYS[2], 'refillOperationSequence') or ''",
  "  local slotWriteSeq = redis.call('HGET', KEYS[2], 'writeSeq') or '0'",
  '  if slotOperationId ~= ARGV[1] or slotOperationSequence ~= ARGV[2] or slotWriteSeq ~= ARGV[11] then',
  "    return { 'STALE' }",
  '  end',
  'end',
  "local nextSeq = redis.call('HINCRBY', KEYS[1], 'spendSequence', 1)",
  STAMP_ENTITY_LUA,
  "redis.call('HSET', KEYS[1],",
  "  'spendState', ARGV[4],",
  "  'spendTerminalFailureKind', ARGV[16],",
  "  'spendLastError', ARGV[5])",
  'if accountWriteSeq == ARGV[3] then',
  "  redis.call('HSET', KEYS[1],",
  "    'balanceMist', ARGV[6],",
  "    'healthy', ARGV[7],",
  "    'refillsRemaining', ARGV[8],",
  "    'lastError', ARGV[9])",
  'end',
  "if ARGV[10] == '1' then",
  "  local slotTime = redis.call('TIME')",
  '  local slotNowMs = tostring(tonumber(slotTime[1]) * 1000 + math.floor(tonumber(slotTime[2]) / 1000))',
  "  redis.call('HINCRBY', KEYS[2], 'writeSeq', 1)",
  "  redis.call('HSET', KEYS[2],",
  "    'lastObservedAtMs', slotNowMs,",
  "    'state', ARGV[12],",
  "    'balanceMist', ARGV[13],",
  "    'lastError', ARGV[14],",
  "    'refillObservedBalanceMist', ARGV[13],",
  "    'refillReconciliationResult', ARGV[15],",
  "    'refillOperationSequence', tostring(nextSeq),",
  "    'refillOperationState', ARGV[4])",
  "  if ARGV[15] == 'dispatch_succeeded' or ARGV[15] == 'dispatch_failed' then",
  "    redis.call('HSET', KEYS[2], 'pendingRefillDigest', '')",
  '  end',
  'end',
  "if nonceKey ~= '' then redis.call('SET', KEYS[3], ARGV[17], 'PX', ARGV[18]) end",
  "return { 'COMPLETED', tostring(nextSeq) }",
].join('\n');

export const RECONCILE_SPONSOR_REFILL_ACCOUNT_SPEND_LUA = [
  "local operationId = redis.call('HGET', KEYS[1], 'spendOperationId') or ''",
  "local sequence = redis.call('HGET', KEYS[1], 'spendSequence') or ''",
  "local state = redis.call('HGET', KEYS[1], 'spendState') or ''",
  "if operationId ~= ARGV[1] or sequence ~= ARGV[2] or state ~= 'ready' then",
  "  return { 'STALE' }",
  'end',
  "local nextSeq = redis.call('HINCRBY', KEYS[1], 'spendSequence', 1)",
  STAMP_ENTITY_LUA,
  "redis.call('HSET', KEYS[1],",
  "  'spendState', 'reconciling',",
  "  'spendChainResult', ARGV[3],",
  "  'spendLastError', ARGV[4])",
  "local slotAddress = redis.call('HGET', KEYS[1], 'spendSlotAddress') or ''",
  "if slotAddress ~= '' then",
  "  local slotTime = redis.call('TIME')",
  '  local slotNowMs = tostring(tonumber(slotTime[1]) * 1000 + math.floor(tonumber(slotTime[2]) / 1000))',
  "  redis.call('HINCRBY', KEYS[2], 'writeSeq', 1)",
  "  redis.call('HSET', KEYS[2],",
  "    'lastObservedAtMs', slotNowMs,",
  "    'refillReconciliationResult', 'dispatch_submitted',",
  "    'refillOperationSequence', tostring(nextSeq),",
  "    'refillOperationState', 'reconciling')",
  'end',
  "return { 'RECONCILING', tostring(nextSeq) }",
].join('\n');

export const FAIL_RESERVED_SPONSOR_REFILL_ACCOUNT_SPEND_LUA = [
  "local operationId = redis.call('HGET', KEYS[1], 'spendOperationId') or ''",
  "local sequence = redis.call('HGET', KEYS[1], 'spendSequence') or ''",
  "local state = redis.call('HGET', KEYS[1], 'spendState') or ''",
  "if operationId ~= ARGV[1] or sequence ~= ARGV[2] or state ~= 'reserved' then",
  "  return { 'STALE' }",
  'end',
  "local nonceKey = redis.call('HGET', KEYS[1], 'spendNonceKey') or ''",
  "if nonceKey ~= '' and (nonceKey ~= KEYS[3] or ARGV[6] == '') then",
  "  return { 'RECEIPT_MISMATCH' }",
  'end',
  "local nextSeq = redis.call('HINCRBY', KEYS[1], 'spendSequence', 1)",
  STAMP_ENTITY_LUA,
  "redis.call('HSET', KEYS[1],",
  "  'spendState', 'failed',",
  "  'spendTerminalFailureKind', ARGV[5],",
  "  'spendLastError', ARGV[3])",
  "if ARGV[4] == '1' then",
  "  local slotTime = redis.call('TIME')",
  '  local slotNowMs = tostring(tonumber(slotTime[1]) * 1000 + math.floor(tonumber(slotTime[2]) / 1000))',
  "  redis.call('HINCRBY', KEYS[2], 'writeSeq', 1)",
  "  redis.call('HSET', KEYS[2],",
  "    'lastObservedAtMs', slotNowMs,",
  "    'state', 'refill_failed',",
  "    'lastError', ARGV[3],",
  "    'pendingRefillDigest', '',",
  "    'refillReconciliationResult', 'dispatch_failed',",
  "    'refillOperationSequence', tostring(nextSeq),",
  "    'refillOperationState', 'failed')",
  'end',
  "if nonceKey ~= '' then redis.call('SET', KEYS[3], ARGV[6], 'PX', ARGV[7]) end",
  "return { 'FAILED', tostring(nextSeq) }",
].join('\n');

export const UPDATE_SPONSOR_REFILL_ACCOUNT_OBSERVATION_LUA = [
  "local operationId = redis.call('HGET', KEYS[1], 'spendOperationId') or ''",
  "local spendSequence = redis.call('HGET', KEYS[1], 'spendSequence') or '0'",
  "local writeSequence = redis.call('HGET', KEYS[1], 'writeSeq') or '0'",
  "if operationId ~= ARGV[1] or spendSequence ~= ARGV[2] or writeSequence ~= ARGV[3] then return { 'STALE' } end",
  STAMP_ENTITY_LUA,
  "redis.call('HSET', KEYS[1],",
  "  'balanceMist', ARGV[4],",
  "  'healthy', ARGV[5],",
  "  'refillsRemaining', ARGV[6],",
  "  'lastError', ARGV[7])",
  "return { 'UPDATED' }",
].join('\n');

function firstResult(raw: unknown): string | null {
  if (!Array.isArray(raw) || typeof raw[0] !== 'string') return null;
  return raw[0];
}

export interface SponsorRefillAccountSpendStateStore {
  read(): Promise<SponsorRefillAccountSpend | null>;
  readWithdrawalReceipt(nonceKey: string): Promise<SponsorRefillAccountWithdrawalReceipt | null>;
  readAccountObservationCursor(): Promise<SponsorRefillAccountObservationCursor>;
  reserve(
    input: ReserveSponsorRefillAccountSpendInput,
  ): Promise<ReserveSponsorRefillAccountSpendResult>;
  markReady(
    input: MarkSponsorRefillAccountSpendReadyInput,
  ): Promise<SponsorRefillAccountSpend | null>;
  markReconciling(
    input: ReconcileSponsorRefillAccountSpendInput,
  ): Promise<SponsorRefillAccountSpend | null>;
  complete(
    input: CompleteSponsorRefillAccountSpendInput,
  ): Promise<SponsorRefillAccountSpend | null>;
  failReserved(
    input: FailReservedSponsorRefillAccountSpendInput,
  ): Promise<SponsorRefillAccountSpend | null>;
  updateAccountObservation(
    cursor: SponsorRefillAccountObservationCursor,
    fields: SponsorRefillAccountWriteFields,
  ): Promise<boolean>;
}

export interface SponsorRefillAccountSpendStateOptions {
  readonly network: SuiNetwork;
  readonly acceptedReceiptTtlMs: number;
}

export function createSponsorRefillAccountSpendState(
  client: RedisClientLike,
  options: SponsorRefillAccountSpendStateOptions,
): SponsorRefillAccountSpendStateStore {
  if (options.network !== 'testnet' && options.network !== 'mainnet') {
    throw new Error('Sponsor Refill Account spend network is invalid');
  }
  if (!Number.isSafeInteger(options.acceptedReceiptTtlMs) || options.acceptedReceiptTtlMs <= 0) {
    throw new Error('Sponsor Refill Account accepted receipt TTL must be a positive safe integer');
  }

  async function read(): Promise<SponsorRefillAccountSpend | null> {
    return parseSpend(await client.hgetall(SPONSOR_REFILL_ACCOUNT_KEY), options.network);
  }

  async function readWithdrawalReceipt(
    nonceKey: string,
  ): Promise<SponsorRefillAccountWithdrawalReceipt | null> {
    if (!nonceKey) {
      throw new Error('Sponsor Refill Account withdrawal receipt key must be non-empty');
    }
    const raw = await client.get(nonceKey);
    return raw === null ? null : parseWithdrawalReceipt(raw, options.network);
  }

  async function readAccountObservationCursor(): Promise<SponsorRefillAccountObservationCursor> {
    const hash = await client.hgetall(SPONSOR_REFILL_ACCOUNT_KEY);
    if (hash.spendState) {
      parseSpend(hash, options.network);
    } else if (hash.spendOperationId) {
      throw new Error('Sponsor Refill Account observation cursor has an operation without state');
    }
    const spendSequence = parseSequence(hash.spendSequence ?? '0');
    const writeSequence = parseSequence(hash.writeSeq ?? '0');
    if (spendSequence === null || writeSequence === null) {
      throw new Error('Sponsor Refill Account observation cursor is malformed');
    }
    return {
      operationId: hash.spendOperationId || null,
      spendSequence,
      writeSequence,
    };
  }

  async function reserve(
    input: ReserveSponsorRefillAccountSpendInput,
  ): Promise<ReserveSponsorRefillAccountSpendResult> {
    assertReserveInput(input);
    const usesNonce = input.nonceKey !== null;
    const usesSlot = input.slotAddress !== null;
    const issuedReceipt = usesNonce
      ? encodeSponsorRefillAccountWithdrawalIssuedReceipt(options.network)
      : '';
    const acceptedReceipt = usesNonce
      ? encodeWithdrawalReceipt({
          type: 'accepted',
          network: options.network,
          operationId: input.operationId,
          sourceAddress: input.sourceAddress,
          destinationAddress: input.destinationAddress,
          amountMist: input.amountMist,
        })
      : '';
    const raw = await client.eval(
      RESERVE_SPONSOR_REFILL_ACCOUNT_SPEND_LUA,
      [
        SPONSOR_REFILL_ACCOUNT_KEY,
        input.nonceKey ?? SPONSOR_REFILL_ACCOUNT_KEY,
        input.slotAddress === null ? SPONSOR_REFILL_ACCOUNT_KEY : slotKey(input.slotAddress),
      ],
      [
        usesNonce ? '1' : '0',
        input.operationId,
        input.kind,
        input.sourceAddress,
        input.destinationAddress,
        input.slotAddress ?? '',
        input.amountMist,
        usesSlot ? '1' : '0',
        input.observedSlotBalanceMist ?? '',
        input.expectedSlotWriteSequence === null ? '0' : String(input.expectedSlotWriteSequence),
        options.network,
        issuedReceipt,
        acceptedReceipt,
        String(options.acceptedReceiptTtlMs),
      ],
    );
    const status = firstResult(raw);
    if (status === 'NONCE_MISSING') return { status: 'nonce_missing' };
    if (status === 'SLOT_CHANGED') return { status: 'slot_changed' };
    if (status === 'NETWORK_MISMATCH' || status === 'MALFORMED') {
      throw new Error('Sponsor Refill Account durable spend has an invalid network or shape');
    }
    if (status === 'RECEIPT') {
      const receiptRaw = Array.isArray(raw) && typeof raw[1] === 'string' ? raw[1] : null;
      if (receiptRaw === null) {
        throw new Error('Sponsor Refill Account reservation returned a malformed receipt result');
      }
      const receipt = parseWithdrawalReceipt(receiptRaw, options.network);
      if (receipt.type === 'issued') {
        throw new Error('Sponsor Refill Account issued receipt does not use the exact encoding');
      }
      return { status: 'receipt', receipt };
    }
    const spend = await read();
    if (spend === null) {
      throw new Error('Sponsor Refill Account spend reservation returned without state');
    }
    if (status === 'ACTIVE') return { status: 'active', spend };
    if (status !== 'CREATED' || spend.operationId !== input.operationId) {
      throw new Error('Sponsor Refill Account spend reservation returned an invalid result');
    }
    return { status: 'created', spend };
  }

  async function markReady(
    input: MarkSponsorRefillAccountSpendReadyInput,
  ): Promise<SponsorRefillAccountSpend | null> {
    assertSequence(input.expectedSequence, 'expectedSequence');
    assertSequence(input.expectedAccountWriteSequence, 'expectedAccountWriteSequence');
    if (
      !isPositiveU64(input.gasBudgetMist) ||
      !isDecimal(input.sourceBalanceMist) ||
      !input.transactionBytesBase64 ||
      !input.signature ||
      !input.digest ||
      !(input.refillsRemaining === '' || isDecimal(input.refillsRemaining))
    ) {
      throw new Error('Sponsor Refill Account ready transition contains malformed identity fields');
    }
    const before = await read();
    const slotAddress = before?.operationId === input.operationId ? before.slotAddress : null;
    const raw = await client.eval(
      MARK_SPONSOR_REFILL_ACCOUNT_SPEND_READY_LUA,
      [
        SPONSOR_REFILL_ACCOUNT_KEY,
        slotAddress === null ? SPONSOR_REFILL_ACCOUNT_KEY : slotKey(slotAddress),
      ],
      [
        input.operationId,
        String(input.expectedSequence),
        String(input.expectedAccountWriteSequence),
        input.gasBudgetMist,
        input.transactionBytesBase64,
        input.signature,
        input.digest,
        input.sourceBalanceMist,
        input.refillsRemaining,
      ],
    );
    if (firstResult(raw) === 'STALE') return null;
    if (firstResult(raw) !== 'READY') {
      throw new Error('Sponsor Refill Account ready transition returned an invalid result');
    }
    return read();
  }

  async function complete(
    input: CompleteSponsorRefillAccountSpendInput,
  ): Promise<SponsorRefillAccountSpend | null> {
    assertSequence(input.expectedSequence, 'expectedSequence');
    assertSequence(input.expectedAccountWriteSequence, 'expectedAccountWriteSequence');
    if (input.slot !== null) {
      assertSequence(input.slot.expectedWriteSequence, 'slot.expectedWriteSequence');
    }
    if (
      (input.state === 'succeeded' && input.lastError !== '') ||
      (input.state === 'failed' && input.lastError.length === 0)
    ) {
      throw new Error('Sponsor Refill Account terminal transition has an inconsistent error');
    }
    const before = await read();
    if (
      before?.operationId === input.operationId &&
      before.sequence === input.expectedSequence &&
      before.state === 'reconciling' &&
      before.chainResult !== input.state
    ) {
      throw new Error('Sponsor Refill Account terminal state disagrees with its chain result');
    }
    const terminalFailureKind = input.state === 'failed' ? 'failed' : '';
    const terminalReceipt =
      before?.operationId === input.operationId && before.kind === 'withdrawal'
        ? encodeWithdrawalReceipt({
            type: 'terminal',
            network: options.network,
            operationId: before.operationId,
            sourceAddress: before.sourceAddress,
            destinationAddress: before.destinationAddress,
            amountMist: before.amountMist,
            status: input.state === 'succeeded' ? 'succeeded' : 'failed',
            digest: before.digest,
            error: input.state === 'succeeded' ? null : input.lastError,
          })
        : '';
    const raw = await client.eval(
      COMPLETE_SPONSOR_REFILL_ACCOUNT_SPEND_LUA,
      [
        SPONSOR_REFILL_ACCOUNT_KEY,
        input.slot === null ? SPONSOR_REFILL_ACCOUNT_KEY : slotKey(input.slot.address),
        before?.nonceKey ?? SPONSOR_REFILL_ACCOUNT_KEY,
      ],
      [
        input.operationId,
        String(input.expectedSequence),
        String(input.expectedAccountWriteSequence),
        input.state,
        input.lastError,
        ...accountWriteArgs(input.account),
        input.slot === null ? '0' : '1',
        input.slot === null ? '0' : String(input.slot.expectedWriteSequence),
        input.slot?.state ?? '',
        input.slot?.balanceMist ?? '',
        input.slot?.lastError ?? '',
        input.slot?.reconciliationResult ?? '',
        terminalFailureKind,
        terminalReceipt,
        String(options.acceptedReceiptTtlMs),
      ],
    );
    if (firstResult(raw) === 'STALE') return null;
    if (firstResult(raw) === 'CHAIN_RESULT_MISMATCH') {
      throw new Error('Sponsor Refill Account terminal state disagrees with its chain result');
    }
    if (firstResult(raw) === 'RECEIPT_MISMATCH') {
      throw new Error('Sponsor Refill Account terminal receipt identity changed');
    }
    if (firstResult(raw) !== 'COMPLETED') {
      throw new Error('Sponsor Refill Account terminal transition returned an invalid result');
    }
    return read();
  }

  async function markReconciling(
    input: ReconcileSponsorRefillAccountSpendInput,
  ): Promise<SponsorRefillAccountSpend | null> {
    assertSequence(input.expectedSequence, 'expectedSequence');
    if (
      (input.chainResult === 'succeeded' && input.lastError !== '') ||
      (input.chainResult === 'failed' && input.lastError.length === 0)
    ) {
      throw new Error('Sponsor Refill Account reconciliation has an inconsistent error');
    }
    const before = await read();
    const slotAddress = before?.operationId === input.operationId ? before.slotAddress : null;
    const raw = await client.eval(
      RECONCILE_SPONSOR_REFILL_ACCOUNT_SPEND_LUA,
      [
        SPONSOR_REFILL_ACCOUNT_KEY,
        slotAddress === null ? SPONSOR_REFILL_ACCOUNT_KEY : slotKey(slotAddress),
      ],
      [input.operationId, String(input.expectedSequence), input.chainResult, input.lastError],
    );
    if (firstResult(raw) === 'STALE') return null;
    if (firstResult(raw) !== 'RECONCILING') {
      throw new Error(
        'Sponsor Refill Account reconciliation transition returned an invalid result',
      );
    }
    return read();
  }

  async function failReserved(
    input: FailReservedSponsorRefillAccountSpendInput,
  ): Promise<SponsorRefillAccountSpend | null> {
    assertSequence(input.expectedSequence, 'expectedSequence');
    if (!input.lastError) {
      throw new Error('Sponsor Refill Account reserved failure requires a non-empty error');
    }
    if (input.failureKind !== 'failed' && input.failureKind !== 'runway_blocked') {
      throw new Error('Sponsor Refill Account reserved failure kind is invalid');
    }
    const before = await read();
    const terminalReceipt =
      before?.operationId === input.operationId && before.kind === 'withdrawal'
        ? encodeWithdrawalReceipt({
            type: 'terminal',
            network: options.network,
            operationId: before.operationId,
            sourceAddress: before.sourceAddress,
            destinationAddress: before.destinationAddress,
            amountMist: before.amountMist,
            status: input.failureKind,
            digest: null,
            error: input.lastError,
          })
        : '';
    const raw = await client.eval(
      FAIL_RESERVED_SPONSOR_REFILL_ACCOUNT_SPEND_LUA,
      [
        SPONSOR_REFILL_ACCOUNT_KEY,
        input.slotAddress === null ? SPONSOR_REFILL_ACCOUNT_KEY : slotKey(input.slotAddress),
        before?.nonceKey ?? SPONSOR_REFILL_ACCOUNT_KEY,
      ],
      [
        input.operationId,
        String(input.expectedSequence),
        input.lastError,
        input.slotAddress === null ? '0' : '1',
        input.failureKind,
        terminalReceipt,
        String(options.acceptedReceiptTtlMs),
      ],
    );
    if (firstResult(raw) === 'STALE') return null;
    if (firstResult(raw) === 'RECEIPT_MISMATCH') {
      throw new Error('Sponsor Refill Account reserved failure receipt identity changed');
    }
    if (firstResult(raw) !== 'FAILED') {
      throw new Error('Sponsor Refill Account reserved failure returned an invalid result');
    }
    return read();
  }

  async function updateAccountObservation(
    cursor: SponsorRefillAccountObservationCursor,
    fields: SponsorRefillAccountWriteFields,
  ): Promise<boolean> {
    assertSequence(cursor.spendSequence, 'cursor.spendSequence');
    assertSequence(cursor.writeSequence, 'cursor.writeSequence');
    if (cursor.operationId !== null && cursor.operationId.length === 0) {
      throw new Error('cursor.operationId must be null or non-empty');
    }
    const raw = await client.eval(
      UPDATE_SPONSOR_REFILL_ACCOUNT_OBSERVATION_LUA,
      [SPONSOR_REFILL_ACCOUNT_KEY],
      [
        cursor.operationId ?? '',
        String(cursor.spendSequence),
        String(cursor.writeSequence),
        ...accountWriteArgs(fields),
      ],
    );
    const status = firstResult(raw);
    if (status === 'STALE') return false;
    if (status !== 'UPDATED') {
      throw new Error('Sponsor Refill Account observation returned an invalid result');
    }
    return true;
  }

  return {
    read,
    readWithdrawalReceipt,
    readAccountObservationCursor,
    reserve,
    markReady,
    markReconciling,
    complete,
    failReserved,
    updateAccountObservation,
  };
}

export function isActiveSponsorRefillAccountSpend(
  spend: SponsorRefillAccountSpend | null,
): spend is ActiveSponsorRefillAccountSpend {
  return spend !== null && ACTIVE_SPEND_STATES.has(spend.state);
}
