/**
 * schemaAssert — narrow helpers for asserting route response bodies
 * against `docs/schemas/relay-api.schema.json` `$defs`.
 *
 * No AJV or full JSON Schema validator. Only checks:
 *   - Top-level property keys (bidirectional)
 *   - Required fields presence
 *   - 1-level nested object/array-item shapes when requested
 */
import { expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(here, '..', '..', '..', '..');

interface SchemaDef {
  properties?: Record<string, unknown>;
  required?: string[];
}

type SchemaBundle = { $defs: Record<string, SchemaDef> };

let _schema: SchemaBundle | null = null;
function loadSchema(): SchemaBundle {
  if (!_schema) {
    const raw = readFileSync(join(workspaceRoot, 'docs/schemas/relay-api.schema.json'), 'utf8');
    _schema = JSON.parse(raw) as SchemaBundle;
  }
  return _schema;
}

function getDef(defName: string): SchemaDef {
  const def = loadSchema().$defs[defName];
  if (!def) throw new Error(`Schema $defs.${defName} not found`);
  return def;
}

/**
 * Assert that `body` has exactly the same top-level keys as `$defs[defName].properties`,
 * and that all `required` fields are present (non-undefined).
 *
 * Optional schema fields that are absent from `body` are allowed (they may be
 * `undefined` and therefore omitted from JSON serialization).
 */
export function assertResponseKeys(body: Record<string, unknown>, defName: string): void {
  const def = getDef(defName);
  const schemaKeys = def.properties ? Object.keys(def.properties).sort() : [];
  const bodyKeys = Object.keys(body).sort();

  const missingFromBody = schemaKeys.filter((k) => !(k in body) && def.required?.includes(k));
  expect(missingFromBody, `required schema keys missing from body (${defName})`).toEqual([]);

  const extraInBody = bodyKeys.filter((k) => !schemaKeys.includes(k));
  expect(extraInBody, `body keys not in schema (${defName})`).toEqual([]);
}

/**
 * Assert a nested object field's keys against a schema `$defs` entry.
 */
export function assertNestedObjectKeys(
  parent: Record<string, unknown>,
  field: string,
  defName: string,
): void {
  const nested = parent[field];
  expect(nested, `${field} should be an object`).toBeDefined();
  expect(typeof nested, `${field} should be an object`).toBe('object');
  assertResponseKeys(nested as Record<string, unknown>, defName);
}

/**
 * Assert that the first item of an array field matches a schema `$defs` entry.
 */
export function assertArrayItemKeys(
  parent: Record<string, unknown>,
  field: string,
  defName: string,
): void {
  const arr = parent[field];
  expect(Array.isArray(arr), `${field} should be an array`).toBe(true);
  expect((arr as unknown[]).length, `${field} should have at least 1 item`).toBeGreaterThanOrEqual(
    1,
  );
  assertResponseKeys((arr as Record<string, unknown>[])[0], defName);
}
