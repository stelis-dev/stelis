/** Convert bigint to JSON-safe number, fail-closed if it exceeds MAX_SAFE_INTEGER. */
export function safeBigintToNumber(value: bigint, label: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`${label} exceeds safe integer range: ${value}`);
  }
  return n;
}
