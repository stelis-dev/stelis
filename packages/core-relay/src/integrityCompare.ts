/**
 * integrityCompare — deterministic structural comparator for normalized
 * PTB commands produced by `convertSdkCommands()`.
 *
 * The comparator returns a path-localized verdict so callers can report
 * the exact diverging field instead of a whole-blob string diff.
 *
 * Fail-closed semantics:
 *   - `Uint8Array` is byte-compared; `Uint8Array` vs regular array is a
 *     mismatch.
 *   - Class instances (Map / Set / Date / custom classes) are not allowed
 *     inside command payloads — comparator reports mismatch rather than
 *     silently deep-equal.
 *   - Property order does not affect equality: keys are canonicalized by
 *     sort before comparison.
 *
 * Pure TypeScript, no runtime deps, browser-safe.
 *
 * @module integrityCompare
 */
import type { PtbCommand } from '@stelis/contracts';

// ─────────────────────────────────────────────
// Verdict
// ─────────────────────────────────────────────

export type IntegrityVerdict =
  | { ok: true }
  | {
      ok: false;
      /**
       * Dotted / bracketed path from the command root to the diverging
       * field. Empty when the top-level command reference differs in
       * type (e.g. null vs object).
       */
      path: string;
      expected: unknown;
      actual: unknown;
    };

const mismatch = (path: string, expected: unknown, actual: unknown): IntegrityVerdict => ({
  ok: false,
  path,
  expected,
  actual,
});

// ─────────────────────────────────────────────
// Path helpers
// ─────────────────────────────────────────────

function appendKey(base: string, key: string): string {
  return base ? `${base}.${key}` : key;
}

function appendIndex(base: string, index: number): string {
  return `${base}[${index}]`;
}

// ─────────────────────────────────────────────
// Recursive comparators
// ─────────────────────────────────────────────

function compareUint8Array(a: Uint8Array, b: Uint8Array, path: string): IntegrityVerdict {
  if (a.length !== b.length) {
    return mismatch(appendKey(path, 'length'), a.length, b.length);
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return mismatch(appendIndex(path, i), a[i], b[i]);
    }
  }
  return { ok: true };
}

function compareArray(
  a: readonly unknown[],
  b: readonly unknown[],
  path: string,
): IntegrityVerdict {
  if (a.length !== b.length) {
    return mismatch(appendKey(path, 'length'), a.length, b.length);
  }
  for (let i = 0; i < a.length; i++) {
    const verdict = compareValue(a[i], b[i], appendIndex(path, i));
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
}

function comparePlainObject(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  path: string,
): IntegrityVerdict {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length || aKeys.some((k, i) => k !== bKeys[i])) {
    return mismatch(appendKey(path, '__keys'), aKeys, bKeys);
  }
  for (const k of aKeys) {
    const verdict = compareValue(a[k], b[k], appendKey(path, k));
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function compareValue(a: unknown, b: unknown, path: string): IntegrityVerdict {
  // `===` catches matching primitives (including `null`), same-object
  // references, and identical symbol values. NaN is never === NaN, so
  // the primitive-typeof fallthrough handles NaN explicitly below.
  if (a === b) return { ok: true };

  const aType = typeof a;
  const bType = typeof b;
  if (aType !== bType) return mismatch(path, a, b);

  // Primitive types (string, number, boolean, bigint, symbol, undefined)
  // cannot deep-equal beyond `===`. Reaching here means they differ.
  if (aType !== 'object') return mismatch(path, a, b);

  // One side null, the other non-null object.
  if (a === null || b === null) return mismatch(path, a, b);

  const aIsUint8 = a instanceof Uint8Array;
  const bIsUint8 = b instanceof Uint8Array;
  if (aIsUint8 !== bIsUint8) return mismatch(path, a, b);
  if (aIsUint8 && bIsUint8) {
    return compareUint8Array(a as Uint8Array, b as Uint8Array, path);
  }

  const aIsArr = Array.isArray(a);
  const bIsArr = Array.isArray(b);
  if (aIsArr !== bIsArr) return mismatch(path, a, b);
  if (aIsArr && bIsArr) {
    return compareArray(a as unknown[], b as unknown[], path);
  }

  // Fail-closed on non-plain-object references so that Map / Set / Date /
  // class instances report mismatches rather than silently deep-equal.
  if (!isPlainObject(a as object) || !isPlainObject(b as object)) {
    return mismatch(path, a, b);
  }

  return comparePlainObject(a as Record<string, unknown>, b as Record<string, unknown>, path);
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Compare two normalized PTB commands for structural equality.
 *
 * Returns `{ ok: true }` when the commands are structurally identical
 * (property order independent). Returns `{ ok: false, path, expected,
 * actual }` at the first diverging field. Path localization follows
 * `field.subField[index]` convention rooted at the command object.
 *
 * The `kind` discriminator is checked first so that a MoveCall ↔
 * OtherCommand type swap reports `kind` as the divergence path rather
 * than the raw key-set delta.
 *
 * This function does not assume either argument came from the same
 * source: the caller is expected to produce both via
 * `convertSdkCommands()` (or equivalent normalization) before comparing.
 */
export function integrityCompare(a: PtbCommand, b: PtbCommand): IntegrityVerdict {
  if (a.kind !== b.kind) {
    return mismatch('kind', a.kind, b.kind);
  }
  return compareValue(a, b, '');
}
