/**
 * PTB input object ID extraction utilities.
 *
 * Shared helper for extracting objectId from Transaction input arguments.
 * Supports UnresolvedObject, Object.SharedObject, Object.ImmOrOwnedObject.
 *
 * Used by:
 *   - sdk/integrity.ts (S-16 input verification)
 *   - core-api/prepare/build.ts (R-9 coin classification)
 */

/**
 * Extract objectId from a PTB input, supporting all Object variants.
 * Returns null for Pure or unknown input kinds.
 */
export function extractObjectIdFromInput(input: Record<string, unknown>): string | null {
  const kind = input.$kind as string;

  if (kind === 'UnresolvedObject') {
    const obj = input.UnresolvedObject as { objectId?: string };
    return obj?.objectId ?? null;
  }

  if (kind === 'Object') {
    const obj = input.Object as Record<string, unknown>;
    const sub = obj?.$kind as string;
    if (sub === 'SharedObject') {
      return (obj.SharedObject as { objectId?: string })?.objectId ?? null;
    }
    if (sub === 'ImmOrOwnedObject') {
      return (obj.ImmOrOwnedObject as { objectId?: string })?.objectId ?? null;
    }
  }

  return null;
}
