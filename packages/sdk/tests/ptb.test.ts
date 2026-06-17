import { describe, it, expect } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import { buildWithdrawPtb } from '../src/ptb.js';

// Valid Sui addresses (64 hex chars after 0x)
const PACKAGE_ID = '0x0000000000000000000000000000000000000000000000000000000000000001';
const VAULT_ID = '0x0000000000000000000000000000000000000000000000000000000000000003';
const SENDER = '0x0000000000000000000000000000000000000000000000000000000000000007';

function getCommands(tx: Transaction) {
  tx.setSender(SENDER);
  return tx.getData().commands;
}

describe('PTB builders', () => {
  describe('buildWithdrawPtb', () => {
    it('adds withdraw + transferObjects to the transaction', () => {
      const tx = new Transaction();
      buildWithdrawPtb(tx, {
        packageId: PACKAGE_ID,
        vaultId: VAULT_ID,
        recipientAddress: SENDER,
      });

      const commands = getCommands(tx);
      expect(commands.length).toBe(2);
      expect(commands[0].$kind).toBe('MoveCall');
      if (commands[0].$kind === 'MoveCall') {
        expect(commands[0].MoveCall.function).toBe('withdraw');
      }
      expect(commands[1].$kind).toBe('TransferObjects');
    });
  });
});
