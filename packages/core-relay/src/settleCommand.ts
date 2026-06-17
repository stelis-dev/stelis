import { normalizeSuiAddress } from '@mysten/sui/utils';
import { SETTLE_FUNCTIONS, SETTLE_MODULE } from '@stelis/contracts';
import type { MoveCallCommand, PtbCommand } from '@stelis/contracts';

export function findSettleCommand(
  commands: PtbCommand[],
  packageId: string,
): MoveCallCommand | undefined {
  const normalizedPkg = normalizeSuiAddress(packageId);
  for (const cmd of commands) {
    if (cmd.kind !== 'MoveCall') continue;
    const mc = cmd as MoveCallCommand;
    if (
      normalizeSuiAddress(mc.packageId) === normalizedPkg &&
      mc.module === SETTLE_MODULE &&
      SETTLE_FUNCTIONS.has(mc.function)
    ) {
      return mc;
    }
  }
  return undefined;
}
