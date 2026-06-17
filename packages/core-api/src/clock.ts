/**
 * Clock — minimal time provider for execution-critical JS-side paths.
 *
 * Scope: this port owns the JS-side `Date.now()` call sites that drive
 * TTL / lease / reservation / rate / abuse window invariants inside
 * `core-api` adapters and handlers. Redis-side authoritative time
 * (`redis.call('TIME')`, `PEXPIRE`, `PTTL`) is untouched — Clock covers
 * JS-side reads only.
 *
 * Exposure: `core-api` internal only. Do not re-export from the
 * package barrel, browser APIs, or SDK. Add consumers by injecting
 * `clock?: Clock` with `systemClock` default into adapter constructors
 * or pure-function options — no broader wiring is part of the current
 * API.
 *
 * Non-goals for this provider:
 *   - `nowIso()`, `nowSeconds()`, or similar convenience variants.
 *     Observability ISO timestamps and JWT-seconds clocks are separate
 *     axes and should not be consolidated here without evidence.
 *   - A fixed/mock-clock factory. Tests construct local stubs
 *     (`{ nowMs: () => frozen }`) or use `vi.useFakeTimers()`, which drives
 *     `systemClock` transparently.
 */

export interface Clock {
  /** Wall-clock time in milliseconds since epoch. */
  nowMs(): number;
}

/**
 * Default `Clock` backed by `Date.now()`.
 *
 * Used as the fallback when a consumer does not inject a clock. Tests
 * that want deterministic time either inject a stub clock or keep using
 * `vi.useFakeTimers()` + `vi.setSystemTime()`, which affects `Date.now()`
 * and therefore `systemClock` uniformly.
 */
export const systemClock: Clock = {
  nowMs: () => Date.now(),
};
