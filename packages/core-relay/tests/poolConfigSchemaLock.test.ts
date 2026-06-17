/**
 * Pool config schema coverage — bidirectional field-level assertions between
 * `docs/schemas/relay-api.schema.json` deep `$defs` and the canonical
 * `DeepBookPoolHop` / `SingleHopSettlementSwapPath` interfaces.
 *
 * The canonical interfaces live in `@stelis/contracts/src/types.ts`.
 * This test verifies that the schema stays aligned with that reference.
 *
 * `core-relay/tsconfig.json` excludes `**\/*.test.ts` from typecheck,
 * so this test uses the TypeScript compiler API to extract declared
 * interface members at test time.
 *
 * Note: `SingleHopSettlementSwapPath.lotSize` / `minSize` are `bigint` in the
 * canonical type but `integer` in the schema (HTTP projection via
 * `SingleHopSettlementSwapPathResponse`). This is by design. This test only asserts
 * field presence and required alignment, not type equivalence.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(here, '..', '..', '..');
const typesFilePath = join(workspaceRoot, 'packages/contracts/src/types.ts');

interface SchemaDef {
  properties?: Record<string, unknown>;
  required?: string[];
}

type SchemaBundle = { $defs: Record<string, SchemaDef> };

function loadSchema(): SchemaBundle {
  const raw = readFileSync(join(workspaceRoot, 'docs/schemas/relay-api.schema.json'), 'utf8');
  return JSON.parse(raw) as SchemaBundle;
}

function getSchemaFields(
  schema: SchemaBundle,
  defName: string,
): {
  properties: string[];
  required: string[];
} {
  const def = schema.$defs[defName];
  if (!def) throw new Error(`Schema $defs.${defName} not found`);
  return {
    properties: def.properties ? Object.keys(def.properties).sort() : [],
    required: def.required ? [...def.required].sort() : [],
  };
}

function parseInterfaceMembers(
  filePath: string,
): Map<string, { members: string[]; optional: string[] }> {
  const src = readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(filePath, src, ts.ScriptTarget.Latest, true);
  const result = new Map<string, { members: string[]; optional: string[] }>();

  function visit(node: ts.Node): void {
    if (ts.isInterfaceDeclaration(node)) {
      const name = node.name.text;
      const members: string[] = [];
      const optional: string[] = [];
      for (const member of node.members) {
        if (ts.isPropertySignature(member) && member.name && ts.isIdentifier(member.name)) {
          members.push(member.name.text);
          if (member.questionToken) optional.push(member.name.text);
        }
      }
      result.set(name, { members: members.sort(), optional: optional.sort() });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return result;
}

const schema = loadSchema();
const interfaces = parseInterfaceMembers(typesFilePath);

describe('deepBookPoolHop <-> DeepBookPoolHop', () => {
  const schemaFields = getSchemaFields(schema, 'deepBookPoolHop');
  const sdkIface = interfaces.get('DeepBookPoolHop');

  it('DeepBookPoolHop interface exists', () => {
    expect(sdkIface).toBeDefined();
  });

  it('schema properties are a subset of TS members (schema -> TS)', () => {
    const missing = schemaFields.properties.filter((p) => !sdkIface!.members.includes(p));
    expect(missing).toEqual([]);
  });

  it('TS members are a subset of schema properties (TS -> schema)', () => {
    const extra = sdkIface!.members.filter((m) => !schemaFields.properties.includes(m));
    expect(extra).toEqual([]);
  });

  it('schema required fields match TS non-optional members', () => {
    const tsRequired = sdkIface!.members.filter((m) => !sdkIface!.optional.includes(m)).sort();
    expect(schemaFields.required).toEqual(tsRequired);
  });
});

describe('singleHopSettlementSwapPath <-> SingleHopSettlementSwapPath', () => {
  const schemaFields = getSchemaFields(schema, 'singleHopSettlementSwapPath');
  const sdkIface = interfaces.get('SingleHopSettlementSwapPath');

  it('SingleHopSettlementSwapPath interface exists', () => {
    expect(sdkIface).toBeDefined();
  });

  it('schema properties are a subset of TS members (schema -> TS)', () => {
    const missing = schemaFields.properties.filter((p) => !sdkIface!.members.includes(p));
    expect(missing).toEqual([]);
  });

  it('TS members are a subset of schema properties (TS -> schema)', () => {
    const extra = sdkIface!.members.filter((m) => !schemaFields.properties.includes(m));
    expect(extra).toEqual([]);
  });

  it('schema required fields match TS non-optional members', () => {
    const tsRequired = sdkIface!.members.filter((m) => !sdkIface!.optional.includes(m)).sort();
    expect(schemaFields.required).toEqual(tsRequired);
  });
});
