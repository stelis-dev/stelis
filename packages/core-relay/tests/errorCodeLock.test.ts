/**
 * ErrorCode / MoveAbort lock test.
 *
 * Locks:
 *   - `SETTLE_ABORT` / `VAULT_ABORT` / `CONFIG_ABORT` in
 *     `packages/core-relay/src/moveAbortCode.ts` ↔
 *     `packages/contracts/move/sources/{settle,vault,config}.move`
 *     `const EName: u64 = N;` declarations.
 *   - `KNOWN_PREPARE_ERROR_CODES` / `KNOWN_SPONSOR_ERROR_CODES` /
 *     `KNOWN_PROMOTION_PREPARE_ERROR_CODES` /
 *     `KNOWN_PROMOTION_SPONSOR_ERROR_CODES` in
 *     `packages/core-relay/src/errorCode.ts` ↔
 *     `docs/schemas/relay-api.schema.json` `knownXxxErrorCode.enum` arrays.
 *
 * Per-entry assertions so drift on either side (add / remove / rename /
 * renumber) appears at the exact failing code or constant.
 *
 * External dependency abort codes (`DEEPBOOK_ABORT`) are NOT locked here
 * because DeepBook source is not in this repo.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SETTLE_ABORT, VAULT_ABORT, CONFIG_ABORT } from '../src/moveAbortCode.js';
import {
  KNOWN_PREPARE_ERROR_CODES,
  KNOWN_SPONSOR_ERROR_CODES,
  KNOWN_PROMOTION_PREPARE_ERROR_CODES,
  KNOWN_PROMOTION_SPONSOR_ERROR_CODES,
} from '../src/errorCode.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/core-relay/tests → workspace root = ../../..
const workspaceRoot = join(here, '..', '..', '..');

function readWorkspaceFile(relPath: string): string {
  return readFileSync(join(workspaceRoot, relPath), 'utf8');
}

// ─────────────────────────────────────────────
// Move source parse helper
// ─────────────────────────────────────────────

/**
 * Extract `const EName: u64 = N;` declarations from a Move source string.
 * Names are returned in declaration order. Trailing line comments are
 * ignored.
 */
function extractMoveAbortConstants(src: string): Array<{ name: string; value: number }> {
  const re = /const\s+([A-Z][A-Za-z0-9_]*)\s*:\s*u64\s*=\s*(\d+)\s*;/g;
  const out: Array<{ name: string; value: number }> = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push({ name: m[1], value: parseInt(m[2], 10) });
  }
  return out;
}

// ─────────────────────────────────────────────
// Schema parse helper
// ─────────────────────────────────────────────

interface SchemaBundle {
  $defs: Record<string, { type?: string; enum?: string[] }>;
}

const schemaBundle: SchemaBundle = JSON.parse(
  readWorkspaceFile('docs/schemas/relay-api.schema.json'),
) as SchemaBundle;

function schemaEnum(defName: string): readonly string[] {
  const def = schemaBundle.$defs[defName];
  if (!def) throw new Error(`schema $defs.${defName} not found`);
  if (def.type !== 'string' || !Array.isArray(def.enum)) {
    throw new Error(`schema $defs.${defName} is not a string-enum definition`);
  }
  return def.enum;
}

// ─────────────────────────────────────────────
// Generic bidirectional enum / map locks
// ─────────────────────────────────────────────

function describeMoveAbortLock(
  label: string,
  moveRelPath: string,
  tsConsts: Record<string, number>,
): void {
  const tsEntries = Object.entries(tsConsts) as Array<[string, number]>;
  const moveSrc = readWorkspaceFile(moveRelPath);
  const moveConsts = extractMoveAbortConstants(moveSrc);
  const moveByName = new Map(moveConsts.map((c) => [c.name, c.value]));
  const tsByName = new Map(tsEntries);

  describe(`Move abort lock — ${label} (${moveRelPath})`, () => {
    it(`TS count matches Move-source count (${tsEntries.length} entries)`, () => {
      expect(tsEntries.length).toBe(moveConsts.length);
    });

    for (const [name, value] of tsEntries) {
      it(`${label}.${name} = ${value} matches Move source`, () => {
        const moveValue = moveByName.get(name);
        expect(moveValue, `${name} not declared in ${moveRelPath}`).toBeDefined();
        expect(moveValue).toBe(value);
      });
    }

    for (const { name, value } of moveConsts) {
      it(`Move constant ${name} = ${value} is mirrored in TS ${label}`, () => {
        const tsValue = tsByName.get(name);
        expect(
          tsValue,
          `Move source declares ${name} = ${value} but TS ${label} has no entry`,
        ).toBeDefined();
        expect(tsValue).toBe(value);
      });
    }
  });
}

function describeSchemaEnumLock(
  label: string,
  schemaDefName: string,
  tsArray: readonly string[],
): void {
  const schemaArr = schemaEnum(schemaDefName);
  const schemaSet = new Set(schemaArr);
  const tsSet = new Set(tsArray);

  describe(`HTTP error-code lock — ${label} (schema $defs.${schemaDefName})`, () => {
    it(`TS count matches schema enum count (${tsArray.length} entries)`, () => {
      expect(tsArray.length).toBe(schemaArr.length);
    });

    for (const code of tsArray) {
      it(`TS ${label} member "${code}" present in schema enum`, () => {
        expect(
          schemaSet.has(code),
          `TS ${label} exports "${code}" but schema $defs.${schemaDefName}.enum does not`,
        ).toBe(true);
      });
    }

    for (const code of schemaArr) {
      it(`schema enum member "${code}" present in TS ${label}`, () => {
        expect(
          tsSet.has(code),
          `schema $defs.${schemaDefName}.enum has "${code}" but TS ${label} does not`,
        ).toBe(true);
      });
    }
  });
}

// ─────────────────────────────────────────────
// Move source lock cases
// ─────────────────────────────────────────────

describeMoveAbortLock('SETTLE_ABORT', 'packages/contracts/move/sources/settle.move', SETTLE_ABORT);
describeMoveAbortLock('VAULT_ABORT', 'packages/contracts/move/sources/vault.move', VAULT_ABORT);
describeMoveAbortLock('CONFIG_ABORT', 'packages/contracts/move/sources/config.move', CONFIG_ABORT);

// ─────────────────────────────────────────────
// Schema enum lock cases
// ─────────────────────────────────────────────

describeSchemaEnumLock(
  'KNOWN_PREPARE_ERROR_CODES',
  'knownPrepareErrorCode',
  KNOWN_PREPARE_ERROR_CODES,
);
describeSchemaEnumLock(
  'KNOWN_SPONSOR_ERROR_CODES',
  'knownSponsorErrorCode',
  KNOWN_SPONSOR_ERROR_CODES,
);
describeSchemaEnumLock(
  'KNOWN_PROMOTION_PREPARE_ERROR_CODES',
  'knownPromotionPrepareErrorCode',
  KNOWN_PROMOTION_PREPARE_ERROR_CODES,
);
describeSchemaEnumLock(
  'KNOWN_PROMOTION_SPONSOR_ERROR_CODES',
  'knownPromotionSponsorErrorCode',
  KNOWN_PROMOTION_SPONSOR_ERROR_CODES,
);
