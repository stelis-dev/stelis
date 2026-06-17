/**
 * PrepareInflightLimiter — shared conformance test suite.
 *
 * Both MemoryPrepareInflight and RedisPrepareInflight must pass this
 * suite. The factory parameter lets each implementation provide its
 * own setup (in-process counter vs Redis-backed tokenized ZSET).
 *
 * Backend-specific cases live in their respective entry files:
 *   - Memory: has no Redis-only analog (capacity check is trivial);
 *     entry is pure conformance plus a small impl-only sanity block.
 *   - Redis: TTL crash recovery (expired token prune), cross-instance
 *     cluster state, custom key prefix, and default TTL value stay in
 *     `redisPrepareInflight.test.ts`.
 */

import { afterEach, expect, it } from 'vitest';
import type { PrepareInflightLimiter } from '../src/store/prepareInflightTypes.js';

// ─────────────────────────────────────────────
// Factory contract
// ─────────────────────────────────────────────

export interface PrepareInflightHandle {
  limiter: PrepareInflightLimiter;
  dispose(): Promise<void> | void;
}

export interface PrepareInflightFactoryOpts {
  capacity: number;
}

export type PrepareInflightFactory = (
  opts: PrepareInflightFactoryOpts,
) => Promise<PrepareInflightHandle> | PrepareInflightHandle;

// ─────────────────────────────────────────────
// Conformance suite
// ─────────────────────────────────────────────

export function runPrepareInflightConformanceTests(factory: PrepareInflightFactory): void {
  let handle: PrepareInflightHandle | null = null;

  async function setup(
    opts: Partial<PrepareInflightFactoryOpts> = {},
  ): Promise<PrepareInflightHandle> {
    const resolved: PrepareInflightFactoryOpts = { capacity: 3, ...opts };
    handle = await factory(resolved);
    return handle;
  }

  afterEach(async () => {
    if (handle) {
      await handle.dispose();
      handle = null;
    }
  });

  it('allows acquires up to capacity', async () => {
    const { limiter } = await setup({ capacity: 3 });
    const h1 = await limiter.tryAcquire();
    const h2 = await limiter.tryAcquire();
    const h3 = await limiter.tryAcquire();

    expect(h1).not.toBeNull();
    expect(h2).not.toBeNull();
    expect(h3).not.toBeNull();
    expect(limiter.inflight).toBe(3);
  });

  it('returns null when at capacity', async () => {
    const { limiter } = await setup({ capacity: 2 });
    await limiter.tryAcquire();
    await limiter.tryAcquire();

    const rejected = await limiter.tryAcquire();
    expect(rejected).toBeNull();
    expect(limiter.inflight).toBe(2);
  });

  it('release frees capacity for reacquire', async () => {
    const { limiter } = await setup({ capacity: 1 });
    const h1 = await limiter.tryAcquire();
    expect(h1).not.toBeNull();
    expect(await limiter.tryAcquire()).toBeNull();

    await h1!.release();
    expect(limiter.inflight).toBe(0);

    const h2 = await limiter.tryAcquire();
    expect(h2).not.toBeNull();
    expect(limiter.inflight).toBe(1);
  });

  it('double release is idempotent', async () => {
    const { limiter } = await setup({ capacity: 2 });
    const h1 = await limiter.tryAcquire();
    expect(limiter.inflight).toBe(1);

    await h1!.release();
    expect(limiter.inflight).toBe(0);

    await h1!.release();
    expect(limiter.inflight).toBe(0);
  });

  it('inflight reconciles after mixed acquire / release sequence', async () => {
    const { limiter } = await setup({ capacity: 3 });
    const h1 = await limiter.tryAcquire();
    const h2 = await limiter.tryAcquire();
    expect(limiter.inflight).toBe(2);

    await h1!.release();
    expect(limiter.inflight).toBe(1);

    await h2!.release();
    expect(limiter.inflight).toBe(0);
  });

  it('capacity and inflight getters report expected values on a fresh limiter', async () => {
    const { limiter } = await setup({ capacity: 5 });
    expect(limiter.capacity).toBe(5);
    expect(limiter.inflight).toBe(0);
  });
}
