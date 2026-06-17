/**
 * checkPrepareStageSchema.test.ts — durability lock for the
 * `scripts/check-prepare-stage-schema.mjs` lint guard.
 *
 * The script enforces alignment between four views: build.ts emit
 * sites, the docs Completeness markers table, the 8-field payload
 * schema, and the per-stage `quote_rpc_stats_complete` boolean.
 * `npm run lint` invokes the script; this suite locks the script's own
 * drift-detection behavior.
 *
 * This test creates a temp repo-shaped fixture (mirrors the relative
 * paths the script expects), copies the real script + docs + build.ts
 * into it, and runs the fixture script with `node`:
 *
 *   - the unmodified fixture must exit 0
 *   - mutating the docs `quote_rpc_failed` boolean from `false` to
 *     `true` must produce a `[value-mismatch]` violation and a
 *     nonzero exit code
 *
 * Goal: lock the script's drift-detection so the lint script cannot silently
 * regress to set-comparison that misses boolean drift.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/core-api/tests/ → repo root is three levels up
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

const SCRIPT_REL = 'scripts/check-prepare-stage-schema.mjs';
const BUILD_REL = 'packages/core-api/src/prepare/build.ts';
const DOCS_REL = 'docs/architecture/prepare-sponsor-session.md';

interface ExecError extends Error {
  code: number | string;
  stdout: string;
  stderr: string;
}

function isExecError(err: unknown): err is ExecError {
  return err instanceof Error && 'code' in err && 'stdout' in err && 'stderr' in err;
}

describe('check-prepare-stage-schema.mjs durability', () => {
  let fixtureRoot: string;
  let scriptPath: string;
  let docsPath: string;
  let pristineDocs: string;

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'stelis-schema-lint-'));

    await mkdir(join(fixtureRoot, 'scripts'), { recursive: true });
    await mkdir(join(fixtureRoot, 'packages/core-api/src/prepare'), {
      recursive: true,
    });
    await mkdir(join(fixtureRoot, 'docs/architecture'), { recursive: true });

    scriptPath = join(fixtureRoot, SCRIPT_REL);
    docsPath = join(fixtureRoot, DOCS_REL);

    await copyFile(join(REPO_ROOT, SCRIPT_REL), scriptPath);
    await copyFile(join(REPO_ROOT, BUILD_REL), join(fixtureRoot, BUILD_REL));
    await copyFile(join(REPO_ROOT, DOCS_REL), docsPath);

    pristineDocs = await readFile(docsPath, 'utf-8');
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('exits 0 on the unmutated fixture (clean alignment)', async () => {
    // Restore docs in case the mismatch test ran first.
    await writeFile(docsPath, pristineDocs);

    const { stdout } = await execFileAsync(process.execPath, [scriptPath]);
    expect(stdout).toContain('Prepare-stage schema check passed');
    expect(stdout).toContain('per-stage boolean values match');
  });

  it('exits nonzero with [value-mismatch] when docs boolean drifts from emit', async () => {
    // Column widths in this markdown table follow Prettier's column-alignment
    // output and may shift when surrounding rows change; use a regex so the
    // mutation tracks the row regardless of padding.
    const mutated = pristineDocs.replace(
      /(\|\s*`quote_rpc_failed`\s*\|\s*)`false`(\s*\|)/,
      '$1`true` $2',
    );
    expect(mutated).not.toBe(pristineDocs);
    await writeFile(docsPath, mutated);

    let caught: ExecError | null = null;
    try {
      await execFileAsync(process.execPath, [scriptPath]);
    } catch (err) {
      if (!isExecError(err)) throw err;
      caught = err;
    }

    expect(caught).not.toBeNull();
    expect(caught!.code).toBe(1);
    expect(caught!.stderr).toContain('[value-mismatch]');
    expect(caught!.stderr).toContain('quote_rpc_failed');
    expect(caught!.stderr).toContain('build.ts but docs table');

    await writeFile(docsPath, pristineDocs);
  });
});
