import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function readWorkspaceFile(pathFromRoot: string): string {
  return readFileSync(resolve(repoRoot, pathFromRoot), 'utf8');
}

describe('PTB admissibility wiring lock', () => {
  it('keeps SDK and generic prepare on the same user TransactionKind validator', () => {
    const sdk = readWorkspaceFile('packages/sdk/src/sdk.ts');
    const genericPolicy = readWorkspaceFile(
      'packages/core-api/src/session/sponsoredExecution/genericExecutionPolicy.ts',
    );

    expect(sdk).toContain('validateGenericUserTransactionKind');
    expect(genericPolicy).toContain('validateGenericUserTransactionKind');
    expect(sdk).not.toContain('validateUserCommands');
    expect(genericPolicy).not.toContain('validateUserCommands');
    expect(genericPolicy).not.toContain('containsSponsorWithdrawal');
  });

  it('keeps final settlement transaction validation separate from user TransactionKind validation', () => {
    const genericPolicy = readWorkspaceFile(
      'packages/core-api/src/session/sponsoredExecution/genericExecutionPolicy.ts',
    );
    const finalValidationCalls = genericPolicy.match(/validateGenericSettlementTransaction\(/g);

    expect(finalValidationCalls).toHaveLength(2);
    expect(genericPolicy).not.toContain('validatePtbStructure');
  });

  it('keeps address-balance accounting evidence in the prepare build boundary', () => {
    const genericPolicy = readWorkspaceFile(
      'packages/core-api/src/session/sponsoredExecution/genericExecutionPolicy.ts',
    );
    const prepareBuild = readWorkspaceFile('packages/core-api/src/prepare/build.ts');

    expect(genericPolicy).not.toContain('extractPrefixWithdrawals');
    expect(prepareBuild).toContain('extractPrefixWithdrawals(tx, paymentTokenType)');
  });
});
