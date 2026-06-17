/**
 * [app-api] Sponsor-slot refill executor — sponsor refill account-signed PTB that moves
 * `amountMist` from the sponsor refill account's gas coin to a sponsor slot
 * address.
 *
 * Ownership: app-api. Consumed by the sponsor operations refill worker via the
 * `executeRefill` dependency in `context.ts`.
 */
import { Transaction } from '@mysten/sui/transactions';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

export interface ExecuteSponsorSlotRefillInput {
  readonly sui: SuiGrpcClient;
  readonly signer: Ed25519Keypair;
  readonly sponsorAddress: string;
  readonly amountMist: bigint;
}

export interface SponsorSlotRefillResult {
  readonly success: boolean;
  readonly digest: string | null;
  readonly error: string | null;
}

export async function executeSponsorSlotRefill(
  input: ExecuteSponsorSlotRefillInput,
): Promise<SponsorSlotRefillResult> {
  const ptb = new Transaction();
  const [coin] = ptb.splitCoins(ptb.gas, [ptb.pure.u64(input.amountMist)]);
  ptb.transferObjects([coin], input.sponsorAddress);

  const result = await input.signer.signAndExecuteTransaction({
    transaction: ptb,
    client: input.sui,
  });

  interface GrpcFailedTx {
    $kind: 'FailedTransaction';
    FailedTransaction: {
      digest?: string;
      status?: { error?: { message?: string; $kind?: string } };
    };
  }
  interface GrpcEffectsWithStatus {
    status?: { success?: boolean; error?: { message?: string; $kind?: string } };
  }

  const raw = result as unknown as {
    $kind?: string;
    FailedTransaction?: GrpcFailedTx['FailedTransaction'];
    Transaction?: (typeof result)['Transaction'];
  };
  if (raw.$kind === 'FailedTransaction' && raw.FailedTransaction) {
    const failed = raw.FailedTransaction;
    return {
      success: false,
      digest: failed.digest ?? null,
      error: failed.status?.error?.message ?? failed.status?.error?.$kind ?? 'unknown',
    };
  }

  const txResult = result.Transaction;
  if (!txResult) {
    throw new Error('Sponsor refill execution returned no result');
  }

  const status = (txResult.effects as unknown as GrpcEffectsWithStatus | undefined)?.status;
  if (status?.success === false) {
    return {
      success: false,
      digest: txResult.digest ?? null,
      error: status.error?.message ?? status.error?.$kind ?? 'unknown',
    };
  }

  return {
    success: true,
    digest: txResult.digest ?? null,
    error: null,
  };
}
