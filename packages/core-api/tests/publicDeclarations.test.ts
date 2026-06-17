/**
 * publicDeclarations.test.ts — public declaration API guard.
 *
 * Proves that the declaration graph emitted from `@stelis/core-api` sources
 * using the package's own `tsconfig.json` does not import `internal/brand`
 * from any declaration reachable via `packages/core-api/package.json`
 * `exports[*].types`. `internal/brand.ts` declares itself package-internal;
 * any leak into a public `.d.ts` breaks that contract.
 *
 * Semantics and boundary:
 *   - the property is defined over emitted `.d.ts`, not over runtime `.ts`
 *     imports. Runtime value imports of `mist` / `parseBps` inside handler
 *     implementations are legitimate and must not trigger this guard;
 *   - emits declarations in memory via the TypeScript compiler API. No read
 *     from or write to `packages/core-api/dist`, so the test works on a
 *     clean checkout where `dist/` is gitignored and absent;
 *   - entrypoints: the `types` field of each `exports` entry in
 *     `package.json`;
 *   - reachability: BFS over emitted declarations following relative
 *     specifiers in static `from '...'`, `import("...")`, and side-effect
 *     `import '...'` positions;
 *   - failure condition: any visited declaration contains a specifier
 *     (relative or bare, in any of the three forms above) whose path
 *     string includes `internal/brand`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

const PACKAGE_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const PACKAGE_JSON_PATH = resolve(PACKAGE_ROOT, 'package.json');
const TSCONFIG_PATH = resolve(PACKAGE_ROOT, 'tsconfig.json');

interface PackageJson {
  exports?: Record<string, { types?: string; import?: string } | string | undefined>;
}

function loadExportsTypesEntries(): string[] {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8')) as PackageJson;
  const out: string[] = [];
  if (!pkg.exports) return out;
  for (const value of Object.values(pkg.exports)) {
    if (value && typeof value === 'object' && typeof value.types === 'string') {
      out.push(resolve(PACKAGE_ROOT, value.types));
    }
  }
  return out;
}

// Match ESM static `import ... from '...'`, `export ... from '...'`,
// type-position `import("...")`, and side-effect `import '...'` specifiers.
// Captures the quoted specifier in group 1 (`from '...'`), group 2
// (`import("...")`), or group 3 (side-effect `import '...'`). The
// side-effect alternative requires whitespace immediately before the
// quote so `import X from '...'` does not match group 3.
const IMPORT_SPECIFIER_RE =
  /(?:from\s*['"]([^'"]+)['"])|(?:import\s*\(\s*['"]([^'"]+)['"]\s*\))|(?:import\s+['"]([^'"]+)['"])/g;

function extractSpecifiers(source: string): string[] {
  const out: string[] = [];
  IMPORT_SPECIFIER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_SPECIFIER_RE.exec(source)) !== null) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec) out.push(spec);
  }
  return out;
}

function resolveRelativeDecl(importerFile: string, specifier: string): string {
  const base = resolve(dirname(importerFile), specifier);
  if (base.endsWith('.d.ts')) return base;
  if (base.endsWith('.js')) return base.replace(/\.js$/, '.d.ts');
  if (base.endsWith('.ts')) return base.replace(/\.ts$/, '.d.ts');
  return base + '.d.ts';
}

function emitDeclarationsInMemory(): Map<string, string> {
  const configRead = ts.readConfigFile(TSCONFIG_PATH, (p) => readFileSync(p, 'utf8'));
  if (configRead.error) {
    const msg = ts.flattenDiagnosticMessageText(configRead.error.messageText, '\n');
    throw new Error(`publicDeclarations guard: tsconfig read failed: ${msg}`);
  }
  const parsed = ts.parseJsonConfigFileContent(configRead.config, ts.sys, PACKAGE_ROOT);
  if (parsed.errors.length > 0) {
    const msgs = parsed.errors
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
      .join('\n');
    throw new Error(`publicDeclarations guard: tsconfig parse errors:\n${msgs}`);
  }
  const compilerOptions: ts.CompilerOptions = {
    ...parsed.options,
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
  };
  const program = ts.createProgram(parsed.fileNames, compilerOptions);
  const decls = new Map<string, string>();
  const emitResult = program.emit(
    undefined,
    (fileName, data) => {
      if (fileName.endsWith('.d.ts')) {
        decls.set(resolve(fileName), data);
      }
    },
    undefined,
    /* emitOnlyDtsFiles */ true,
  );
  const diagnostics = [
    ...program.getOptionsDiagnostics(),
    ...program.getSyntacticDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...program.getSemanticDiagnostics(),
    ...emitResult.diagnostics,
  ].filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (diagnostics.length > 0) {
    const msgs = diagnostics
      .slice(0, 5)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
      .join('\n');
    throw new Error(
      `publicDeclarations guard: declaration emit failed with ${diagnostics.length} error(s):\n${msgs}`,
    );
  }
  return decls;
}

interface Offender {
  file: string;
  specifier: string;
}

function scanPublicDeclarationGraph(
  entrypoints: string[],
  decls: Map<string, string>,
): { visited: Set<string>; offenders: Offender[] } {
  const visited = new Set<string>();
  const queue: string[] = [];
  for (const e of entrypoints) {
    if (!visited.has(e)) {
      visited.add(e);
      queue.push(e);
    }
  }
  const offenders: Offender[] = [];
  while (queue.length > 0) {
    const file = queue.shift()!;
    const source = decls.get(file);
    if (source === undefined) {
      throw new Error(
        `publicDeclarations guard: emitted declarations missing ${file}. ` +
          `Check that the exports[*].types path in package.json matches the ` +
          `tsconfig outDir and rootDir mapping.`,
      );
    }
    for (const spec of extractSpecifiers(source)) {
      if (spec.includes('internal/brand')) {
        offenders.push({ file, specifier: spec });
      }
      if (spec.startsWith('.')) {
        const next = resolveRelativeDecl(file, spec);
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
  }
  return { visited, offenders };
}

describe('public declaration API', () => {
  it('exports[*].types declaration graph does not reference internal/brand', () => {
    const entrypoints = loadExportsTypesEntries();
    expect(entrypoints.length).toBeGreaterThan(0);

    const decls = emitDeclarationsInMemory();
    const { offenders } = scanPublicDeclarationGraph(entrypoints, decls);

    expect(
      offenders,
      `Public declaration graph must not reference internal/brand.\n` +
        offenders.map((o) => `  - ${o.file} → ${o.specifier}`).join('\n'),
    ).toEqual([]);
  });
});
