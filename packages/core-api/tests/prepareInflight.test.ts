/**
 * MemoryPrepareInflight — PrepareInflightLimiter conformance + impl-only cases.
 *
 * The shared adapter contract is exercised by
 * `prepareInflight.conformance.ts`. Memory-only cases are limited to
 * constructor input validation because the memory backend has no
 * TTL / token-prune / shared-state behavior to assert separately.
 */
import { describe, expect, it } from 'vitest';
import { MemoryPrepareInflight } from '../src/store/memoryPrepareInflight.js';
import {
  runPrepareInflightConformanceTests,
  type PrepareInflightFactory,
  type PrepareInflightHandle,
} from './prepareInflight.conformance.js';

const memoryFactory: PrepareInflightFactory = ({ capacity }) => {
  const limiter = new MemoryPrepareInflight(capacity);
  const handle: PrepareInflightHandle = {
    limiter,
    dispose: () => {
      /* no-op — MemoryPrepareInflight holds no timers or handles */
    },
  };
  return handle;
};

describe('MemoryPrepareInflight — shared conformance', () => {
  runPrepareInflightConformanceTests(memoryFactory);
});

describe('MemoryPrepareInflight — impl-only', () => {
  // Constructor input validation is adapter-specific because Memory
  // and Redis return different error messages.
  it('rejects capacity < 1', () => {
    expect(() => new MemoryPrepareInflight(0)).toThrow('capacity must be >= 1');
    expect(() => new MemoryPrepareInflight(-1)).toThrow('capacity must be >= 1');
    expect(() => new MemoryPrepareInflight(1.5)).toThrow('safe integer');
    expect(() => new MemoryPrepareInflight(Number.MAX_SAFE_INTEGER + 1)).toThrow('safe integer');
  });
});
