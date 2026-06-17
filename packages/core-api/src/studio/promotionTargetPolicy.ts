/**
 * Promotion Target Policy — MoveCall target hashing helper.
 *
 * This module defines conversion of
 * raw `package::module::function` strings to sha256 hex hashes.
 *
 * Representation bridge:
 *   - Host env (STUDIO_ALLOWED_TARGETS): raw `package::module::function` strings
 *   - Runtime (context, validateAllowedTargets): sha256 hex hashes
 *
 * Exports:
 *   1. hashTarget() — canonical hash for a single raw target string
 *   2. hashTargets() — batch hash for an array
 *
 * @module promotionTargetPolicy
 */

import { createHash } from 'node:crypto';
import { canonicalizeTarget } from '@stelis/core-relay';

// ─────────────────────────────────────────────
// Hashing
// ─────────────────────────────────────────────

/**
 * Parse a raw `package::module::function` string and return its sha256 hex hash.
 *
 * Uses canonicalizeTarget (normalizeSuiAddress(pkg)::mod::fn) → sha256.
 *
 * @throws if the target string does not match `X::Y::Z` format.
 */
export function hashTarget(rawTarget: string): string {
  const parts = rawTarget.split('::');
  if (parts.length !== 3) {
    throw new Error(`Invalid target format: "${rawTarget}". Expected "package::module::function".`);
  }
  const [pkg, mod, fn] = parts;
  const canonical = canonicalizeTarget(pkg, mod, fn);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Batch hash an array of raw target strings.
 * @see hashTarget
 */
export function hashTargets(rawTargets: string[]): string[] {
  return rawTargets.map(hashTarget);
}
