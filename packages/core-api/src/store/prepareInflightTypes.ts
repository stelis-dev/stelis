/**
 * PrepareInflightLimiter — in-flight gate for expensive prepare work.
 *
 * This limiter bounds the number of concurrent prepare operations that
 * have passed cheap validation and are about to execute expensive on-chain
 * queries + dry-run builds. It is independent of sponsor slot availability.
 *
 * Unlike a rate limiter (requests/window), this tracks currently active
 * operations and releases capacity when each operation completes.
 *
 * Implementations:
 *   - `RedisPrepareInflight` — cluster-global, tokenized ZSET
 *     reservation with TTL safety net. Required for production hosts;
 *     `app-api` injects this at boot.
 *   - `MemoryPrepareInflight` — single-process test-only fixture. Not
 *     exported from the `@stelis/core-api` main barrel and not used as
 *     a runtime fallback.
 */

/**
 * Handle returned on successful acquire. Call release() exactly once
 * when the guarded operation completes (success or failure).
 */
export interface InflightHandle {
  /** Release the in-flight slot. Idempotent — second call is a no-op. */
  release(): Promise<void>;
}

export interface PrepareInflightLimiter {
  /**
   * Attempt to acquire an in-flight slot.
   *
   * Returns an InflightHandle on success, or null when capacity is exhausted.
   * The caller MUST call handle.release() in a finally block.
   *
   * Both acquire and release permit real distributed I/O (e.g. Redis).
   * Fire-and-forget release is not allowed — callers must await release().
   *
   * @param route Optional route tag for observability (e.g. 'generic', 'promotion').
   */
  tryAcquire(route?: string): Promise<InflightHandle | null>;

  /** Current number of in-flight operations (for observability). */
  readonly inflight: number;

  /** Maximum capacity. */
  readonly capacity: number;
}
