/**
 * Shared bounded-map eviction helper for memory defensive adapters.
 *
 * Policy: expired first → oldest live evict.
 * Ensures fresh keys are always trackable under saturation pressure.
 *
 * Used by:
 *   - MemoryAbuseBlocker (counter maps)
 *   - MemoryRateLimiter (window map)
 */

/**
 * Ensure a Map has room for one more entry by evicting if at capacity.
 *
 * Step 1: evict all entries where `isExpired(value)` returns true.
 * Step 2: if still at capacity, evict the entry with the smallest `getAge(value)`
 *          (i.e. the one closest to expiry / oldest window start).
 *
 * Caller should call this BEFORE inserting a new key.
 *
 * @param map       The bounded Map to maintain
 * @param maxSize   Maximum allowed entries
 * @param isExpired Predicate: return true if the entry should be evicted as expired
 * @param getAge    Returns a numeric age/priority value; the entry with the smallest value is evicted first
 */
export function ensureBoundedCapacity<K, V>(
  map: Map<K, V>,
  maxSize: number,
  isExpired: (value: V) => boolean,
  getAge: (value: V) => number,
): void {
  if (!Number.isSafeInteger(maxSize) || maxSize < 1) {
    throw new Error('ensureBoundedCapacity: maxSize must be a positive safe integer');
  }
  if (map.size < maxSize) return;

  // Step 1: evict expired
  for (const [k, v] of map) {
    if (isExpired(v)) map.delete(k);
  }
  if (map.size < maxSize) return;

  // Step 2: evict oldest live (smallest getAge value)
  let oldestKey: K | undefined;
  let oldestAge = Infinity;
  for (const [k, v] of map) {
    const age = getAge(v);
    if (!Number.isSafeInteger(age)) {
      throw new Error('ensureBoundedCapacity: getAge must return a safe integer');
    }
    if (age < oldestAge) {
      oldestAge = age;
      oldestKey = k;
    }
  }
  if (oldestKey !== undefined) map.delete(oldestKey);
}
