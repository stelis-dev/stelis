import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { createSponsorOperationsRefillWorker } from '../../src/sponsor-operations/refillWorker.js';
import type {
  SponsorRefillAccountWriteFields,
  RedisSponsorOperationsState,
  SlotWriteFields,
} from '../../src/sponsor-operations/redisState.js';
import type {
  RefillLock,
  RefillLockHandle,
  SponsorRefillAccountDispatchLock,
  SponsorRefillAccountDispatchLockHandle,
} from '../../src/sponsor-operations/refillLock.js';
import { SPONSOR_BALANCE_WARN_MIST } from '../../src/sponsor-operations/defaults.js';

function makeStubState(): {
  state: RedisSponsorOperationsState;
  slotWrites: Array<{ address: string; fields: SlotWriteFields }>;
  sponsorRefillAccountWrites: SponsorRefillAccountWriteFields[];
} {
  const slotWrites: Array<{ address: string; fields: SlotWriteFields }> = [];
  const sponsorRefillAccountWrites: SponsorRefillAccountWriteFields[] = [];
  return {
    slotWrites,
    sponsorRefillAccountWrites,
    state: {
      async updateSlot(address, fields) {
        slotWrites.push({ address, fields });
      },
      async updateSponsorRefillAccount(fields) {
        sponsorRefillAccountWrites.push(fields);
      },
      async readSlot() {
        return null;
      },
      async readSponsorRefillAccount() {
        return null;
      },
      async readAll() {
        return { slots: [], sponsorRefillAccount: {} as never };
      },
    },
  };
}

function makeStubLock(opts: { acquireReturns?: Array<RefillLockHandle | null> } = {}): {
  lock: RefillLock;
  acquireCalls: string[];
  releaseCalls: RefillLockHandle[];
} {
  const acquireCalls: string[] = [];
  const releaseCalls: RefillLockHandle[] = [];
  const queue = [...(opts.acquireReturns ?? [])];
  return {
    acquireCalls,
    releaseCalls,
    lock: {
      async acquire(slotAddress) {
        acquireCalls.push(slotAddress);
        if (queue.length > 0) return queue.shift()!;
        return { slotAddress, token: `token:${slotAddress}` };
      },
      async release(handle) {
        releaseCalls.push(handle);
      },
    },
  };
}

function makeStubSponsorRefillAccountDispatchLock(opts: {
  acquireReturns?: Array<SponsorRefillAccountDispatchLockHandle | null>;
} = {}): {
  lock: SponsorRefillAccountDispatchLock;
  acquireCalls: string[];
  releaseCalls: SponsorRefillAccountDispatchLockHandle[];
} {
  const acquireCalls: string[] = [];
  const releaseCalls: SponsorRefillAccountDispatchLockHandle[] = [];
  const queue = [...(opts.acquireReturns ?? [])];
  let current: SponsorRefillAccountDispatchLockHandle | null = null;
  let seq = 0;
  return {
    acquireCalls,
    releaseCalls,
    lock: {
      async acquire(sponsorRefillAccountAddress) {
        acquireCalls.push(sponsorRefillAccountAddress);
        if (queue.length > 0) return queue.shift()!;
        if (current !== null) return null;
        current = {
          sponsorRefillAccountAddress,
          token: `dispatch-token:${sponsorRefillAccountAddress}:${++seq}`,
        };
        return current;
      },
      async release(handle) {
        releaseCalls.push(handle);
        if (current?.token === handle.token) current = null;
      },
    },
  };
}

function makeStubSui(impl: (owner: string) => Promise<string | Error>): SuiGrpcClient {
  const stub = {
    async getBalance({ owner }: { owner: string }): Promise<{ balance: { balance: string } }> {
      const result = await impl(owner);
      if (result instanceof Error) throw result;
      return { balance: { balance: result } };
    },
  };
  return stub as unknown as SuiGrpcClient;
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out');
    await flushMicrotasks();
  }
}

const SLOT = '0xslot';
const SLOT_B = '0xslotb';
const SPONSOR_REFILL_ACCOUNT_ADDRESS = '0x' + '55'.repeat(32);
const LONG_MULTIBYTE_ERROR = '한'.repeat(300);
const TRIMMED_MULTIBYTE_ERROR = '한'.repeat(170);

describe('createSponsorOperationsRefillWorker — lifecycle', () => {
  let stub: ReturnType<typeof makeStubState>;
  let dispatchLock: ReturnType<typeof makeStubSponsorRefillAccountDispatchLock>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stub = makeStubState();
    dispatchLock = makeStubSponsorRefillAccountDispatchLock();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  function findWriteFailedLogs(source?: string): Record<string, unknown>[] {
    return warnSpy.mock.calls
      .map((args: unknown[]) => {
        try {
          return JSON.parse(args[0] as string) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter(
        (entry): entry is Record<string, unknown> =>
          entry !== null &&
          entry['event'] === 'SPONSOR_OPERATIONS_STATE_WRITE_FAILED' &&
          (source === undefined || entry['source'] === source),
      );
  }

  it('rejects non-positive timeouts at construction', () => {
    const lock = makeStubLock().lock;
    const baseDeps = {
      state: stub.state,
      refillLock: lock,
      sponsorRefillAccountDispatchLock: dispatchLock.lock,
      sui: makeStubSui(async () => '0'),
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: null,
      refillTimeoutMs: 100,
      confirmationTimeoutMs: 100,
      sponsorRefillAccountBalanceTimeoutMs: 100,
      executeRefill: async () => {},
      getSlotBalance: async () => 0n,
    };
    expect(() => createSponsorOperationsRefillWorker({ ...baseDeps, refillTimeoutMs: 0 })).toThrow(
      /refillTimeoutMs must be a positive safe integer/,
    );
    expect(() =>
      createSponsorOperationsRefillWorker({ ...baseDeps, confirmationTimeoutMs: -1 }),
    ).toThrow(/confirmationTimeoutMs must be a positive safe integer/);
    expect(() =>
      createSponsorOperationsRefillWorker({
        ...baseDeps,
        sponsorRefillAccountBalanceTimeoutMs: Number.NaN,
      }),
    ).toThrow(/sponsorRefillAccountBalanceTimeoutMs must be a positive safe integer/);
  });

  it('happy path: writes refilling → sponsor-refill-account probe → awaiting_confirmation → healthy', async () => {
    const lock = makeStubLock();
    const executeRefill = vi.fn(async () => {});
    const worker = createSponsorOperationsRefillWorker({
      state: stub.state,
      refillLock: lock.lock,
      sponsorRefillAccountDispatchLock: dispatchLock.lock,
      sui: makeStubSui(async () => '20000000000'),
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: 10_000_000_000n,
      refillTimeoutMs: 500,
      confirmationTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      executeRefill,
      getSlotBalance: async () => SPONSOR_BALANCE_WARN_MIST,
    });

    worker.requestRefill(SLOT);
    await waitUntil(() => stub.slotWrites.length >= 3);

    expect(executeRefill).toHaveBeenCalledWith(SLOT);
    const states = stub.slotWrites.map((w) => w.fields.state);
    expect(states).toEqual(['refilling', 'awaiting_confirmation', 'healthy']);
    // Sponsor refill account is refreshed inside the locked window after refill success.
    expect(stub.sponsorRefillAccountWrites).toHaveLength(1);
    expect(stub.sponsorRefillAccountWrites[0].healthy).toBe('1');
    expect(stub.sponsorRefillAccountWrites[0].refillsRemaining).toBe('2');
    // Lock was acquired and released once.
    expect(lock.acquireCalls).toEqual([SLOT]);
    expect(lock.releaseCalls).toHaveLength(1);
    expect(dispatchLock.acquireCalls).toEqual([SPONSOR_REFILL_ACCOUNT_ADDRESS]);
    expect(dispatchLock.releaseCalls).toHaveLength(1);
    worker.dispose();
  });

  it('refill failure writes refill_failed + error and releases the lock', async () => {
    const lock = makeStubLock();
    const worker = createSponsorOperationsRefillWorker({
      state: stub.state,
      refillLock: lock.lock,
      sponsorRefillAccountDispatchLock: dispatchLock.lock,
      sui: makeStubSui(async () => '0'),
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: null,
      refillTimeoutMs: 500,
      confirmationTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      executeRefill: async () => {
        throw new Error('refill tx failed');
      },
      getSlotBalance: async () => 0n,
    });

    worker.requestRefill(SLOT);
    await waitUntil(() => stub.slotWrites.length >= 2);

    const states = stub.slotWrites.map((w) => w.fields.state);
    expect(states).toEqual(['refilling', 'refill_failed']);
    expect(stub.slotWrites[1].fields.lastError).toBe('refill tx failed');
    // Sponsor refill account probe does not run when the refill TX itself rejects.
    expect(stub.sponsorRefillAccountWrites).toHaveLength(0);
    expect(lock.releaseCalls).toHaveLength(1);
    worker.dispose();
  });

  it('trims multibyte refill-failure lastError payloads to 512 UTF-8 bytes', async () => {
    const lock = makeStubLock();
    const worker = createSponsorOperationsRefillWorker({
      state: stub.state,
      refillLock: lock.lock,
      sponsorRefillAccountDispatchLock: dispatchLock.lock,
      sui: makeStubSui(async () => '0'),
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: null,
      refillTimeoutMs: 500,
      confirmationTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      executeRefill: async () => {
        throw new Error(LONG_MULTIBYTE_ERROR);
      },
      getSlotBalance: async () => 0n,
    });

    worker.requestRefill(SLOT);
    await waitUntil(() => stub.slotWrites.length >= 2);

    expect(stub.slotWrites[1].fields.lastError).toBe(TRIMMED_MULTIBYTE_ERROR);
    expect(
      new TextEncoder().encode(stub.slotWrites[1].fields.lastError ?? '').length,
    ).toBeLessThanOrEqual(512);
    worker.dispose();
  });

  it('emits and aborts when a slot-state write cannot be committed', async () => {
    const lock = makeStubLock();
    const executeRefill = vi.fn(async () => {});
    const state: RedisSponsorOperationsState = {
      ...stub.state,
      async updateSlot() {
        throw new Error('redis slot write failed');
      },
    };
    const worker = createSponsorOperationsRefillWorker({
      state,
      refillLock: lock.lock,
      sponsorRefillAccountDispatchLock: dispatchLock.lock,
      sui: makeStubSui(async () => '20000000000'),
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: 10_000_000_000n,
      refillTimeoutMs: 500,
      confirmationTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      executeRefill,
      getSlotBalance: async () => SPONSOR_BALANCE_WARN_MIST,
    });

    worker.requestRefill(SLOT);
    await waitUntil(() => lock.releaseCalls.length === 1);

    expect(executeRefill).not.toHaveBeenCalled();
    expect(stub.slotWrites).toHaveLength(0);
    const logs = findWriteFailedLogs('refill_worker_slot_update');
    expect(logs).toHaveLength(1);
    expect(logs[0]['slot_address']).toBe(SLOT);
    expect(logs[0]['state']).toBe('refilling');
    expect(logs[0]['write_error']).toBe('redis slot write failed');
    worker.dispose();
  });

  it('confirmation below warn threshold writes refill_failed', async () => {
    const lock = makeStubLock();
    const worker = createSponsorOperationsRefillWorker({
      state: stub.state,
      refillLock: lock.lock,
      sponsorRefillAccountDispatchLock: dispatchLock.lock,
      sui: makeStubSui(async () => '10000000000'),
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: null,
      refillTimeoutMs: 500,
      confirmationTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      executeRefill: async () => {},
      getSlotBalance: async () => SPONSOR_BALANCE_WARN_MIST - 1n,
    });

    worker.requestRefill(SLOT);
    await waitUntil(() => stub.slotWrites.length >= 3);
    const states = stub.slotWrites.map((w) => w.fields.state);
    expect(states).toEqual(['refilling', 'awaiting_confirmation', 'refill_failed']);
    worker.dispose();
  });

  it('emits sponsor-refill-account write failure but still completes the slot lifecycle', async () => {
    const lock = makeStubLock();
    const state: RedisSponsorOperationsState = {
      ...stub.state,
      async updateSponsorRefillAccount() {
        throw new Error('sponsor refill account redis write failed');
      },
    };
    const worker = createSponsorOperationsRefillWorker({
      state,
      refillLock: lock.lock,
      sponsorRefillAccountDispatchLock: dispatchLock.lock,
      sui: makeStubSui(async () => '20000000000'),
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: 10_000_000_000n,
      refillTimeoutMs: 500,
      confirmationTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      executeRefill: async () => {},
      getSlotBalance: async () => SPONSOR_BALANCE_WARN_MIST,
    });

    worker.requestRefill(SLOT);
    await waitUntil(() => stub.slotWrites.length >= 3);

    expect(stub.slotWrites.map((write) => write.fields.state)).toEqual([
      'refilling',
      'awaiting_confirmation',
      'healthy',
    ]);
    const logs = findWriteFailedLogs('refill_worker_sponsor_refill_account_update');
    expect(logs).toHaveLength(1);
    expect(logs[0]['sponsor_refill_account_address']).toBe(SPONSOR_REFILL_ACCOUNT_ADDRESS);
    expect(logs[0]['write_error']).toBe('sponsor refill account redis write failed');
    worker.dispose();
  });

  it('skips dispatch when another instance holds the refill lock', async () => {
    const lock = makeStubLock({ acquireReturns: [null] });
    const executeRefill = vi.fn(async () => {});
    const worker = createSponsorOperationsRefillWorker({
      state: stub.state,
      refillLock: lock.lock,
      sponsorRefillAccountDispatchLock: dispatchLock.lock,
      sui: makeStubSui(async () => '0'),
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: null,
      refillTimeoutMs: 500,
      confirmationTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      executeRefill,
      getSlotBalance: async () => 0n,
    });
    worker.requestRefill(SLOT);
    await flushMicrotasks();
    await flushMicrotasks();

    expect(executeRefill).not.toHaveBeenCalled();
    expect(stub.slotWrites).toHaveLength(0);
    expect(lock.releaseCalls).toHaveLength(0);
    worker.dispose();
  });

  it('requestRefill suppresses duplicates while a slot is in-flight on this instance', async () => {
    const lock = makeStubLock();
    // Block `executeRefill` on a gate the test controls so duplicate
    // `requestRefill(SLOT)` calls land while the same slot is still
    // mid-lifecycle. Without local in-flight suppression, the
    // duplicates would re-enqueue and dispatch a second time after
    // the first lifecycle finishes.
    let gate!: () => void;
    const executeRefill = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          gate = resolve;
        }),
    );
    const worker = createSponsorOperationsRefillWorker({
      state: stub.state,
      refillLock: lock.lock,
      sponsorRefillAccountDispatchLock: dispatchLock.lock,
      sui: makeStubSui(async () => '10000000000'),
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: null,
      refillTimeoutMs: 500,
      confirmationTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      executeRefill,
      getSlotBalance: async () => SPONSOR_BALANCE_WARN_MIST,
    });
    worker.requestRefill(SLOT);
    // Let the first requestRefill reach `executeRefill`.
    await waitUntil(() => executeRefill.mock.calls.length === 1);
    // These must be suppressed — SLOT is in-flight on this instance.
    worker.requestRefill(SLOT);
    worker.requestRefill(SLOT);
    // Release the first lifecycle; no second lifecycle should start
    // because the duplicates were suppressed while SLOT was in-flight.
    gate();
    await waitUntil(() => stub.slotWrites.length >= 3);
    expect(executeRefill).toHaveBeenCalledTimes(1);
    worker.dispose();
  });

  it('runs different slot lifecycles concurrently while serializing refill tx dispatch', async () => {
    const lock = makeStubLock();
    let releaseFirstRefill!: () => void;
    let releaseSecondRefill!: () => void;
    let releaseFirstConfirmation!: () => void;
    const executeRefill = vi.fn((slotAddress: string) => {
      if (slotAddress === SLOT) {
        return new Promise<void>((resolve) => {
          releaseFirstRefill = resolve;
        });
      }
      if (slotAddress === SLOT_B) {
        return new Promise<void>((resolve) => {
          releaseSecondRefill = resolve;
        });
      }
      return Promise.resolve();
    });
    const getSlotBalance = vi.fn((slotAddress: string) => {
      if (slotAddress === SLOT) {
        return new Promise<bigint>((resolve) => {
          releaseFirstConfirmation = () => resolve(SPONSOR_BALANCE_WARN_MIST);
        });
      }
      return Promise.resolve(SPONSOR_BALANCE_WARN_MIST);
    });
    const worker = createSponsorOperationsRefillWorker({
      state: stub.state,
      refillLock: lock.lock,
      sponsorRefillAccountDispatchLock: dispatchLock.lock,
      sui: makeStubSui(async () => '20000000000'),
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: 10_000_000_000n,
      refillTimeoutMs: 500,
      confirmationTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      executeRefill,
      getSlotBalance,
    });

    worker.requestRefill(SLOT);
    worker.requestRefill(SLOT_B);

    await waitUntil(
      () =>
        stub.slotWrites.filter((write) => write.fields.state === 'refilling').length === 2,
    );
    expect(lock.acquireCalls).toEqual([SLOT, SLOT_B]);
    expect(executeRefill).toHaveBeenCalledTimes(1);
    expect(executeRefill).toHaveBeenCalledWith(SLOT);

    releaseFirstRefill();
    await waitUntil(() => executeRefill.mock.calls.length === 2);
    expect(executeRefill).toHaveBeenNthCalledWith(2, SLOT_B);

    const firstAwaitingConfirmation = stub.slotWrites.some(
      (write) => write.address === SLOT && write.fields.state === 'awaiting_confirmation',
    );
    expect(firstAwaitingConfirmation).toBe(true);
    expect(
      stub.slotWrites.some((write) => write.address === SLOT && write.fields.state === 'healthy'),
    ).toBe(false);

    releaseSecondRefill();
    await waitUntil(() =>
      stub.slotWrites.some((write) => write.address === SLOT_B && write.fields.state === 'healthy'),
    );
    expect(lock.releaseCalls.map((handle) => handle.slotAddress)).toContain(SLOT_B);

    releaseFirstConfirmation();
    await waitUntil(() =>
      stub.slotWrites.some((write) => write.address === SLOT && write.fields.state === 'healthy'),
    );
    expect(lock.releaseCalls.map((handle) => handle.slotAddress).sort()).toEqual(
      [SLOT, SLOT_B].sort(),
    );
    worker.dispose();
  });

  it('serializes refill tx dispatch across worker instances sharing the sponsor refill account lock', async () => {
    const slotLockA = makeStubLock();
    const slotLockB = makeStubLock();
    const sharedDispatchLock = makeStubSponsorRefillAccountDispatchLock();
    let releaseFirstRefill!: () => void;
    let releaseSecondRefill!: () => void;
    const executeRefill = vi.fn((slotAddress: string) => {
      if (slotAddress === SLOT) {
        return new Promise<void>((resolve) => {
          releaseFirstRefill = resolve;
        });
      }
      if (slotAddress === SLOT_B) {
        return new Promise<void>((resolve) => {
          releaseSecondRefill = resolve;
        });
      }
      return Promise.resolve();
    });
    const makeWorker = (slotLock: RefillLock) =>
      createSponsorOperationsRefillWorker({
        state: stub.state,
        refillLock: slotLock,
        sponsorRefillAccountDispatchLock: sharedDispatchLock.lock,
        sui: makeStubSui(async () => '20000000000'),
        sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
        warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
        refillTargetMist: 10_000_000_000n,
        refillTimeoutMs: 500,
        confirmationTimeoutMs: 500,
        sponsorRefillAccountBalanceTimeoutMs: 500,
        executeRefill,
        getSlotBalance: async () => SPONSOR_BALANCE_WARN_MIST,
      });
    const workerA = makeWorker(slotLockA.lock);
    const workerB = makeWorker(slotLockB.lock);

    workerA.requestRefill(SLOT);
    await waitUntil(() => executeRefill.mock.calls.length === 1);
    workerB.requestRefill(SLOT_B);
    await waitUntil(() => sharedDispatchLock.acquireCalls.length >= 2);

    expect(executeRefill).toHaveBeenCalledTimes(1);
    expect(executeRefill).toHaveBeenCalledWith(SLOT);

    releaseFirstRefill();
    await waitUntil(() => executeRefill.mock.calls.length === 2);
    expect(executeRefill).toHaveBeenNthCalledWith(2, SLOT_B);

    releaseSecondRefill();
    await waitUntil(() => sharedDispatchLock.releaseCalls.length === 2);
    workerA.dispose();
    workerB.dispose();
  });

  it('does not dispatch when the sponsor refill account lock stays unavailable through the dispatch budget', async () => {
    const lock = makeStubLock();
    const unavailableDispatchLock = makeStubSponsorRefillAccountDispatchLock();
    await unavailableDispatchLock.lock.acquire(SPONSOR_REFILL_ACCOUNT_ADDRESS);
    const executeRefill = vi.fn(async () => {});
    const worker = createSponsorOperationsRefillWorker({
      state: stub.state,
      refillLock: lock.lock,
      sponsorRefillAccountDispatchLock: unavailableDispatchLock.lock,
      sui: makeStubSui(async () => '20000000000'),
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: 10_000_000_000n,
      refillTimeoutMs: 30,
      confirmationTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      executeRefill,
      getSlotBalance: async () => SPONSOR_BALANCE_WARN_MIST,
    });

    worker.requestRefill(SLOT);
    await waitUntil(() =>
      stub.slotWrites.some((write) => write.fields.state === 'refill_failed'),
    );

    expect(executeRefill).not.toHaveBeenCalled();
    expect(unavailableDispatchLock.releaseCalls).toHaveLength(0);
    expect(stub.slotWrites.map((write) => write.fields.state)).toEqual([
      'refilling',
      'refill_failed',
    ]);
    expect(stub.slotWrites[1].fields.lastError).toContain(
      'acquireSponsorRefillAccountDispatchLock',
    );
    worker.dispose();
  });

  it('does not release the sponsor refill account lock immediately when dispatch times out', async () => {
    const lock = makeStubLock();
    const executeRefill = vi.fn(
      () =>
        new Promise<void>(() => {
          // Intentionally never settles; account lock recovery is TTL-owned.
        }),
    );
    const worker = createSponsorOperationsRefillWorker({
      state: stub.state,
      refillLock: lock.lock,
      sponsorRefillAccountDispatchLock: dispatchLock.lock,
      sui: makeStubSui(async () => '20000000000'),
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: 10_000_000_000n,
      refillTimeoutMs: 30,
      confirmationTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      executeRefill,
      getSlotBalance: async () => SPONSOR_BALANCE_WARN_MIST,
    });

    worker.requestRefill(SLOT);
    await waitUntil(() =>
      stub.slotWrites.some((write) => write.fields.state === 'refill_failed'),
    );

    expect(executeRefill).toHaveBeenCalledTimes(1);
    expect(dispatchLock.releaseCalls).toHaveLength(0);
    expect(stub.slotWrites[1].fields.lastError).toContain('executeRefill');
    worker.dispose();
  });

  it('dispose makes subsequent requestRefill no-ops', () => {
    const lock = makeStubLock();
    const executeRefill = vi.fn(async () => {});
    const worker = createSponsorOperationsRefillWorker({
      state: stub.state,
      refillLock: lock.lock,
      sponsorRefillAccountDispatchLock: dispatchLock.lock,
      sui: makeStubSui(async () => '0'),
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: null,
      refillTimeoutMs: 500,
      confirmationTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      executeRefill,
      getSlotBalance: async () => 0n,
    });
    worker.dispose();
    worker.requestRefill(SLOT);
    expect(executeRefill).not.toHaveBeenCalled();
  });
});
