import type { Transaction } from '@mysten/sui/transactions';

/**
 * Asserts that the Transaction has no gas fields preset by the caller.
 *
 * Required for `executeSuiFirst()` — a UX contract, not an executeSponsored
 * security requirement (executeSponsored uses onlyTransactionKind which nullifies
 * all gasData fields server-side via fromKindBytes).
 *
 * Gas fields that must be null:
 *   - gasPayment: SDK sets sponsor coins internally (not overwritten by build.ts)
 *   - gasBudget:  SDK sets from dry-run result
 *   - gasOwner:   SDK sets sponsor address internally
 *   - gasPrice:   SDK sets from network reference gas price
 *
 * Reference: TransactionData.ts constructor — default gasData has all fields null.
 */
export function assertNoGasPreset(tx: Transaction): void {
  const { gasData } = tx.getData();

  // payment: null is the SDK default — even [] signals a preset
  if (gasData.payment !== null)
    throw new Error(
      '[StelisSDK] tx must not have gasPayment preset. Remove tx.setGasPayment() call.',
    );

  if (gasData.budget !== null)
    throw new Error(
      '[StelisSDK] tx must not have gasBudget preset. Remove tx.setGasBudget() call.',
    );

  if (gasData.owner !== null)
    throw new Error('[StelisSDK] tx must not have gasOwner preset. Remove tx.setGasOwner() call.');

  if (gasData.price !== null)
    throw new Error('[StelisSDK] tx must not have gasPrice preset. Remove tx.setGasPrice() call.');
}
