/**
 * MemoryPrepareInflight — single-process in-flight gate for expensive prepare work.
 *
 * Tracks concurrent prepare operations via an atomic counter.
 * Node.js single-threaded: increment/decrement is race-free.
 *
 * The capacity parameter controls maximum concurrent expensive prepare
 * operations. It is independent of sponsor pool size — the pool may have
 * more or fewer slots than this limiter allows.
 */
import type { PrepareInflightLimiter, InflightHandle } from './prepareInflightTypes.js';
import { logStructuredEvent } from '../structuredEventLog.js';
import {
  PREPARE_INFLIGHT_ACQUIRED,
  PREPARE_INFLIGHT_REJECTED,
  PREPARE_INFLIGHT_RELEASED,
} from '../observability/events.js';

export class MemoryPrepareInflight implements PrepareInflightLimiter {
  private _inflight = 0;
  private readonly _capacity: number;

  /**
   * @param capacity Maximum concurrent expensive prepare operations.
   */
  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error('MemoryPrepareInflight: capacity must be >= 1 and a safe integer');
    }
    this._capacity = capacity;
  }

  get inflight(): number {
    return this._inflight;
  }

  get capacity(): number {
    return this._capacity;
  }

  async tryAcquire(route?: string): Promise<InflightHandle | null> {
    if (this._inflight >= this._capacity) {
      logStructuredEvent(PREPARE_INFLIGHT_REJECTED, {
        adapter: 'memory',
        route: route ?? 'unknown',
        inflight: this._inflight,
        capacity: this._capacity,
      });
      return null;
    }
    this._inflight++;
    logStructuredEvent(PREPARE_INFLIGHT_ACQUIRED, {
      adapter: 'memory',
      route: route ?? 'unknown',
      inflight: this._inflight,
      capacity: this._capacity,
    });

    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        this._inflight--;
        logStructuredEvent(PREPARE_INFLIGHT_RELEASED, {
          adapter: 'memory',
          route: route ?? 'unknown',
          inflight: this._inflight,
          capacity: this._capacity,
        });
      },
    };
  }
}
