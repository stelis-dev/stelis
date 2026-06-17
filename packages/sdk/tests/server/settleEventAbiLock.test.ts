/**
 * SettleEvent ABI lock test.
 *
 * Pins the on-chain SettleEvent Move struct layout (events.move) and the
 * off-chain SettleEventBcs schema (settleEventDecoder.ts) to a golden JSON
 * anchor. A change on either side that is not reflected in
 * settleEventAbi.golden.json fails per-field so the diverging field is
 * localized in the error message.
 *
 * This test is purely static: it reads source files as text, parses the
 * struct / schema declarations with targeted regex, and compares each
 * field index → name / type against the golden. It does not depend on the
 * Sui toolchain or any runtime BCS introspection.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

interface GoldenField {
  index: number;
  name: string;
  moveType: string;
}

interface Golden {
  sources: { move: string; typescript: string };
  struct: {
    moveModule: string;
    moveName: string;
    bcsConstant: string;
    bcsStructName: string;
  };
  fields: GoldenField[];
}

const here = dirname(fileURLToPath(import.meta.url));
// packages/sdk/tests/server → workspace root = ../../../..
const workspaceRoot = join(here, '..', '..', '..', '..');

const golden: Golden = JSON.parse(
  readFileSync(join(here, 'settleEventAbi.golden.json'), 'utf8'),
) as Golden;

const readWorkspaceFile = (relPath: string): string =>
  readFileSync(join(workspaceRoot, relPath), 'utf8');

const moveSrc = readWorkspaceFile(golden.sources.move);
const tsSrc = readWorkspaceFile(golden.sources.typescript);

// Acceptable BCS-expression forms for each Move type. When the canonical
// decoder uses a local name (e.g. `bytesVector` for vector<u8>), both the
// local name and the expanded form are accepted here to avoid forcing a
// stylistic rewrite in settleEventDecoder.ts.
const BCS_EXPR_BY_MOVE_TYPE: Record<string, readonly string[]> = {
  u64: ['bcs.u64()'],
  address: ['bcs.Address'],
  'vector<u8>': ['bytesVector', 'bcs.vector(bcs.u8())'],
};

function extractMoveStructFields(
  src: string,
  structName: string,
): Array<{ name: string; moveType: string }> {
  // Match `public struct StructName has <abilities> { ... }`. Move structs
  // in this source do not contain nested braces, so `[^}]*` is sufficient.
  const re = new RegExp(String.raw`public\s+struct\s+${structName}\s+has[^{]*\{([^}]*)\}`, 'm');
  const match = src.match(re);
  if (!match) {
    throw new Error(`Move struct '${structName}' not found in source`);
  }
  const body = match[1];
  const fields: Array<{ name: string; moveType: string }> = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    // name : type [, or end of line]. Non-greedy on type so it stops at
    // the first field-terminating comma, not at commas that appear later
    // in a trailing line comment (already stripped above).
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.+?)\s*(?:,|$)/);
    if (!m) continue;
    fields.push({ name: m[1], moveType: m[2].trim() });
  }
  return fields;
}

function extractBcsStructFields(
  src: string,
  constantName: string,
  bcsStructName: string,
): Array<{ name: string; expr: string }> {
  // Match `export const <constantName> = bcs.struct('<bcsStructName>', { ... })`.
  const re = new RegExp(
    String.raw`export\s+const\s+${constantName}\s*=\s*bcs\.struct\s*\(\s*['"]${bcsStructName}['"]\s*,\s*\{([^}]*)\}`,
    'm',
  );
  const match = src.match(re);
  if (!match) {
    throw new Error(
      `BCS constant '${constantName}' with struct name '${bcsStructName}' not found in TS source`,
    );
  }
  const body = match[1];
  const fields: Array<{ name: string; expr: string }> = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.+?)\s*(?:,|$)/);
    if (!m) continue;
    fields.push({ name: m[1], expr: m[2].trim() });
  }
  return fields;
}

const moveFields = extractMoveStructFields(moveSrc, golden.struct.moveName);
const bcsFields = extractBcsStructFields(
  tsSrc,
  golden.struct.bcsConstant,
  golden.struct.bcsStructName,
);

describe('SettleEvent ABI lock — count', () => {
  it(`Move struct ${golden.struct.moveName} declares ${golden.fields.length} fields`, () => {
    expect(moveFields.length).toBe(golden.fields.length);
  });

  it(`BCS constant ${golden.struct.bcsConstant} declares ${golden.fields.length} fields`, () => {
    expect(bcsFields.length).toBe(golden.fields.length);
  });
});

describe('SettleEvent ABI lock — per field', () => {
  for (const g of golden.fields) {
    describe(`field[${g.index}] ${g.name} : ${g.moveType}`, () => {
      it('Move declaration matches golden name + moveType', () => {
        const mv = moveFields[g.index];
        expect(mv, `Move field at index ${g.index} missing`).toBeDefined();
        expect(mv.name, `Move field name at index ${g.index}`).toBe(g.name);
        expect(mv.moveType, `Move field type at index ${g.index}`).toBe(g.moveType);
      });

      it('BCS declaration matches golden name + Move-type BCS expr', () => {
        const bc = bcsFields[g.index];
        expect(bc, `BCS field at index ${g.index} missing`).toBeDefined();
        expect(bc.name, `BCS field name at index ${g.index}`).toBe(g.name);
        const allowedExprs = BCS_EXPR_BY_MOVE_TYPE[g.moveType];
        expect(
          allowedExprs,
          `no BCS expression mapping defined for moveType '${g.moveType}'`,
        ).toBeDefined();
        expect(
          allowedExprs,
          `BCS expr '${bc.expr}' does not match allowed forms for '${g.moveType}'`,
        ).toContain(bc.expr);
      });
    });
  }
});
