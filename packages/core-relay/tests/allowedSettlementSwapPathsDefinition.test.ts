/**
 * AllowedSettlementSwapPaths definition lock — gate-backed AST assertion.
 *
 * `packages/core-relay/tsconfig.json` excludes `**\/*.test.ts` from
 * `tsc --noEmit`, so a pure type-only `keyof` / `Equals` assertion
 * inside a `.test.ts` file would transpile via vitest but be invisible
 * to `npm run typecheck -w @stelis/core-relay`. To give the definition an
 * effective gate, this suite parses `src/types.ts` with the TypeScript
 * compiler API at test time and verifies:
 *
 *   1. `export type AllowedSettlementSwapPaths = readonly AllowedSettlementSwapPath[]` exists and
 *      is exported.
 *   2. The declared type is structurally `readonly AllowedSettlementSwapPath[]`
 *      (a `readonly` type-operator wrapping an `AllowedSettlementSwapPath[]` array
 *      type).
 *
 * If the definition is renamed, deleted, loses `readonly`, or retargets a
 * different element type, this test fails. Fix `src/types.ts` directly.
 *
 * Pattern mirrors `packages/sdk/tests/schemaContractLock.test.ts` — the
 * existing precedent for `.test.ts` AST-based locks in packages whose
 * `typecheck` excludes tests.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const typesFilePath = join(here, '..', 'src', 'types.ts');

function findTypeAlias(filePath: string, name: string): ts.TypeAliasDeclaration | null {
  const src = readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(filePath, src, ts.ScriptTarget.Latest, true);
  let match: ts.TypeAliasDeclaration | null = null;

  function visit(node: ts.Node): void {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === name) {
      match = node;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return match;
}

function hasExportModifier(node: ts.TypeAliasDeclaration): boolean {
  return node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

describe('AllowedSettlementSwapPaths definition lock', () => {
  const declaration = findTypeAlias(typesFilePath, 'AllowedSettlementSwapPaths');

  it('exists as an exported type definition in core-relay/src/types.ts', () => {
    expect(declaration).not.toBeNull();
    if (!declaration) return;
    expect(hasExportModifier(declaration)).toBe(true);
  });

  it('is structurally `readonly AllowedSettlementSwapPath[]`', () => {
    expect(declaration).not.toBeNull();
    if (!declaration) return;

    // Outer shape: TypeOperator(readonly, ArrayType(TypeReference(AllowedSettlementSwapPath)))
    const outer = declaration.type;
    expect(ts.isTypeOperatorNode(outer)).toBe(true);
    if (!ts.isTypeOperatorNode(outer)) return;
    expect(outer.operator).toBe(ts.SyntaxKind.ReadonlyKeyword);

    const inner = outer.type;
    expect(ts.isArrayTypeNode(inner)).toBe(true);
    if (!ts.isArrayTypeNode(inner)) return;

    const element = inner.elementType;
    expect(ts.isTypeReferenceNode(element)).toBe(true);
    if (!ts.isTypeReferenceNode(element)) return;
    expect(ts.isIdentifier(element.typeName)).toBe(true);
    if (!ts.isIdentifier(element.typeName)) return;
    expect(element.typeName.text).toBe('AllowedSettlementSwapPath');
    expect(element.typeArguments).toBeUndefined();
  });
});
