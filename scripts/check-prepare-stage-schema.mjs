#!/usr/bin/env node
/**
 * check-prepare-stage-schema.mjs — quote-stats payload schema drift check.
 *
 * Enforces alignment for `PREPARE_BUILD_STAGE` emit sites that carry the
 * `quote_rpc_stats_complete` marker:
 *
 *   1. emit site in `packages/core-api/src/prepare/build.ts` calling
 *      `logPrepareBuildStage('STAGE_NAME', { ... quote_rpc_stats_complete: ... })`.
 *   2. row in the schema-completeness table at
 *      `docs/architecture/prepare-sponsor-session.md` (the table under
 *      `### Completeness markers` listing stage × `quote_rpc_stats_complete`).
 *   3. payload completeness — every emit with `quote_rpc_stats_complete`
 *      must also include all 5 RPC-dispatch fields and all 3 logical /
 *      cache-hit fields (8 fields total). This keeps every participating
 *      emit site on the same payload shape.
 *   4. per-stage boolean value match — for each stage that appears on
 *      both sides, the literal `quote_rpc_stats_complete: true|false`
 *      emitted in build.ts must equal the `true|false` recorded in the
 *      docs table row. Without this lock, the docs row could drift from
 *      the runtime emit (e.g., docs say `true` but the emit site emits
 *      `false`) without failing the lint.
 *
 * Inline-only payload convention (load-bearing for this lint):
 *   - This scanner intentionally inspects direct payload keys only via
 *     regex; it does NOT follow `...identifier` spreads, `...funcCall()`
 *     spreads, or any indirection.
 *   - Therefore `quote_rpc_stats_complete` and the 8 quote-stat fields
 *     MUST appear inline in every `logPrepareBuildStage('STAGE', { ... })`
 *     payload that participates in the schema. Hiding any of them behind
 *     `...baseFailurePayload` or a builder-function call is outside this
 *     scanner's supported shape.
 *   - Spread-based payload composition requires identifier/spread resolution
 *     in this scanner before spread-composed quote-stat payloads are used.
 *
 * Scope intentionally narrow: build.ts is the only emit site for
 * PREPARE_BUILD_STAGE quote-stats payload today. If the emit site set
 * grows beyond this file, extend `BUILD_TS_PATHS` below. New emit sources
 * and spread-composed payloads require scanner coverage in the same change.
 *
 * Usage:
 *   node scripts/check-prepare-stage-schema.mjs
 *
 * Exit codes:
 *   0 — three-way alignment OK.
 *   1 — drift detected; report printed to stderr.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const BUILD_TS_PATHS = [resolve(ROOT, 'packages/core-api/src/prepare/build.ts')];
const DOCS_PATH = resolve(ROOT, 'docs/architecture/prepare-sponsor-session.md');

// 8 quote-stats fields that every emit with quote_rpc_stats_complete must carry.
const REQUIRED_FIELDS = [
  // 5 RPC dispatch counts and timing.
  'quote_quantity_in_rpc_calls',
  'quote_quantity_out_verify_rpc_calls',
  'quote_total_rpc_calls',
  'quote_rpc_total_ms',
  'quote_rpc_max_ms',
  // 3 logical solve counts and cache effect.
  'quote_quantity_in_logical_calls',
  'quote_quantity_out_verify_logical_calls',
  'quote_cache_hits',
];

const violations = [];

// ─── Build-ts emit-site scanner ───────────────────────────────────────────

/**
 * Find every `logPrepareBuildStage('STAGE', { ... })` call in `src` and
 * return a list of `{ stage, payload, hasMarker }` records. `payload` is
 * the raw text between the opening `{` and the matching `}` (brace-balanced
 * over the call-site object literal).
 */
function extractEmitSites(src, fileLabel) {
  const sites = [];
  const re = /logPrepareBuildStage\(\s*'([a-z_][a-z_0-9]*)'\s*,\s*\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const stage = m[1];
    const objStart = m.index + m[0].length - 1; // position of opening `{`
    let depth = 1;
    let i = objStart + 1;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      i += 1;
    }
    if (depth !== 0) {
      violations.push({
        kind: 'emit-brace-unbalanced',
        detail: `${fileLabel}: logPrepareBuildStage('${stage}', { ... }) at offset ${m.index} has unbalanced braces`,
      });
      continue;
    }
    const payload = src.slice(objStart + 1, i - 1);
    const markerMatch = /\bquote_rpc_stats_complete\s*:\s*(true|false)\b/.exec(payload);
    const hasMarker = markerMatch !== null;
    const markerValue = markerMatch ? markerMatch[1] === 'true' : null;
    sites.push({ stage, payload, hasMarker, markerValue });
  }
  return sites;
}

const buildTsSites = [];
for (const path of BUILD_TS_PATHS) {
  const src = readFileSync(path, 'utf-8');
  buildTsSites.push(...extractEmitSites(src, path.replace(ROOT + '/', '')));
}

// Stages that carry the marker must include ALL 8 required fields. Track the
// emit-side boolean per stage so we can cross-check it against the docs table
// row (a value drift like docs `true` vs emit `false` must fail the lint).
const stagesWithMarker = new Map();
for (const site of buildTsSites) {
  if (!site.hasMarker) continue;
  if (site.markerValue === null) {
    violations.push({
      kind: 'emit-non-literal-marker',
      detail: `build.ts emit '${site.stage}' has quote_rpc_stats_complete but its value is not a literal true/false`,
    });
    continue;
  }
  const existing = stagesWithMarker.get(site.stage);
  if (existing !== undefined && existing !== site.markerValue) {
    violations.push({
      kind: 'emit-marker-conflict',
      detail: `build.ts has multiple emits for stage '${site.stage}' with conflicting quote_rpc_stats_complete values (${existing} vs ${site.markerValue})`,
    });
  }
  stagesWithMarker.set(site.stage, site.markerValue);
  for (const field of REQUIRED_FIELDS) {
    const present = new RegExp(`\\b${field}\\s*:`).test(site.payload);
    if (!present) {
      violations.push({
        kind: 'emit-missing-field',
        detail: `build.ts emit '${site.stage}' carries quote_rpc_stats_complete but is missing field '${field}'`,
      });
    }
  }
}

// ─── Docs schema-completeness table parser ────────────────────────────────

const docsSrc = readFileSync(DOCS_PATH, 'utf-8');

// Table rows have the shape `| `<stage>` | `<true|false>` | <reason> |`.
// Pin to the Completeness markers table specifically by searching from the
// `### Completeness markers` heading to the next `###` heading, so other
// tables in the same doc don't accidentally match.
const sectionStart = docsSrc.indexOf('### Completeness markers');
const sectionEnd = sectionStart >= 0 ? docsSrc.indexOf('###', sectionStart + 1) : -1;

if (sectionStart < 0) {
  violations.push({
    kind: 'docs-section-missing',
    detail: `${DOCS_PATH.replace(ROOT + '/', '')}: '### Completeness markers' section not found`,
  });
}

const sectionSrc =
  sectionStart >= 0 && sectionEnd >= 0
    ? docsSrc.slice(sectionStart, sectionEnd)
    : sectionStart >= 0
      ? docsSrc.slice(sectionStart)
      : '';

const docsRowRe = /^\|\s*`([a-z_][a-z_0-9]*)`\s*\|\s*`(true|false)`\s*\|/gm;
const docsStages = new Map();
let dm;
while ((dm = docsRowRe.exec(sectionSrc)) !== null) {
  const stage = dm[1];
  const value = dm[2] === 'true';
  if (docsStages.has(stage) && docsStages.get(stage) !== value) {
    violations.push({
      kind: 'docs-row-conflict',
      detail: `Completeness markers table at ${DOCS_PATH.replace(ROOT + '/', '')} has multiple rows for stage '${stage}' with conflicting quote_rpc_stats_complete values`,
    });
  }
  docsStages.set(stage, value);
}

// ─── Cross-check stage membership and per-stage boolean alignment ─────────

for (const [stage, emitValue] of stagesWithMarker) {
  if (!docsStages.has(stage)) {
    violations.push({
      kind: 'emit-not-in-docs',
      detail: `build.ts emit '${stage}' carries quote_rpc_stats_complete but is missing from the Completeness markers table at ${DOCS_PATH.replace(ROOT + '/', '')}`,
    });
    continue;
  }
  const docsValue = docsStages.get(stage);
  if (docsValue !== emitValue) {
    violations.push({
      kind: 'value-mismatch',
      detail: `stage '${stage}' has quote_rpc_stats_complete=${emitValue} in build.ts but docs table at ${DOCS_PATH.replace(ROOT + '/', '')} lists ${docsValue}`,
    });
  }
}

for (const stage of docsStages.keys()) {
  if (!stagesWithMarker.has(stage)) {
    violations.push({
      kind: 'docs-not-in-emit',
      detail: `Completeness markers table at ${DOCS_PATH.replace(ROOT + '/', '')} lists stage '${stage}' but no build.ts emit with quote_rpc_stats_complete dispatches it`,
    });
  }
}

// ─── Summary output ───────────────────────────────────────────────────────

if (violations.length === 0) {
  console.log(
    `✅ Prepare-stage schema check passed — ${stagesWithMarker.size} stage(s) emit quote_rpc_stats_complete, ${docsStages.size} docs row(s) listed, per-stage boolean values match, all 8 required fields present, 0 violations`,
  );
  process.exit(0);
}

console.error(`❌ Prepare-stage schema check found ${violations.length} violation(s):\n`);
for (const v of violations) {
  console.error(`  [${v.kind}] ${v.detail}`);
}
process.exit(1);
