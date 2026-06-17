/**
 * RedisPromotionStore — unit tests using FakeRedisClient.
 *
 * Proves the Redis adapter contract: Lua-based atomic index maintenance,
 * status transitions with activation guard, and delete policy.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  RedisPromotionStore,
  InvalidStatusTransitionError,
  PromotionFieldImmutableError,
  ConcurrentStatusTransitionError,
  type CreatePromotionInput,
} from '../src/studio/promotionStore.js';
import { FakeRedisClient } from './helpers/fakeRedisClient.js';

// ── Fixtures ────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<CreatePromotionInput> = {}): CreatePromotionInput {
  return {
    type: 'gas_sponsorship',
    displayName: 'Redis Promo',
    description: 'A test promotion for redis adapter',
    maxParticipants: 50,
    perUserGasAllowanceMist: '5000000',
    claimDeadlineAt: null,
    postClaimUseWindowMs: 0,
    startAt: null,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('RedisPromotionStore', () => {
  let redis: FakeRedisClient;
  let store: RedisPromotionStore;

  beforeEach(() => {
    redis = new FakeRedisClient();
    store = new RedisPromotionStore(redis);
  });

  // ── create + get ───────────────────────────────────────────────

  it('creates and retrieves a promotion', async () => {
    const record = await store.create(makeInput());

    expect(record.promotionId).toBeTruthy();
    expect(record.status).toBe('draft');
    expect(record.displayName).toBe('Redis Promo');

    const retrieved = await store.get(record.promotionId);
    expect(retrieved).toEqual(record);
  });

  it('returns null for non-existent promotion', async () => {
    const result = await store.get('nonexistent');
    expect(result).toBeNull();
  });

  // ── list ───────────────────────────────────────────────────────

  it('lists all promotions via index', async () => {
    await store.create(makeInput({ displayName: 'A' }));
    await store.create(makeInput({ displayName: 'B' }));

    const all = await store.list();
    expect(all).toHaveLength(2);
    const names = all.map((r) => r.displayName).sort();
    expect(names).toEqual(['A', 'B']);
  });

  it('lists by status filter', async () => {
    await store.create(makeInput({ displayName: 'Draft' }));
    const p2 = await store.create(makeInput({ displayName: 'Active' }));
    await store.transitionStatus(p2.promotionId, 'active');

    const drafts = await store.list({ status: 'draft' });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].displayName).toBe('Draft');

    const actives = await store.list({ status: 'active' });
    expect(actives).toHaveLength(1);
    expect(actives[0].displayName).toBe('Active');
  });

  it('returns empty array when no promotions exist', async () => {
    const all = await store.list();
    expect(all).toEqual([]);
  });

  // ── update ────────────────────────────────────────────────────

  it('updates mutable fields', async () => {
    const created = await store.create(makeInput());
    const updated = await store.update(created.promotionId, {
      displayName: 'Updated',
      maxParticipants: 200,
    });

    expect(updated).not.toBeNull();
    expect(updated!.displayName).toBe('Updated');
    expect(updated!.maxParticipants).toBe(200);
    expect(updated!.description).toBe('A test promotion for redis adapter');
  });

  it('returns null when updating non-existent', async () => {
    const result = await store.update('nope', { displayName: 'X' });
    expect(result).toBeNull();
  });

  // ── Immutable-after-draft fields ──────────────────────────────

  it('rejects economic-field update on active promotion', async () => {
    const created = await store.create(makeInput());
    await store.transitionStatus(created.promotionId, 'active');
    await expect(store.update(created.promotionId, { maxParticipants: 200 })).rejects.toThrow(
      PromotionFieldImmutableError,
    );
  });

  it('rejects perUserGasAllowanceMist update on paused promotion', async () => {
    const created = await store.create(makeInput());
    await store.transitionStatus(created.promotionId, 'active');
    await store.transitionStatus(created.promotionId, 'paused');
    await expect(
      store.update(created.promotionId, { perUserGasAllowanceMist: '1' }),
    ).rejects.toThrow(PromotionFieldImmutableError);
  });

  it('allows displayName/description update on active promotion', async () => {
    const created = await store.create(makeInput());
    await store.transitionStatus(created.promotionId, 'active');
    const updated = await store.update(created.promotionId, {
      displayName: 'Renamed',
      description: 'new',
    });
    expect(updated!.displayName).toBe('Renamed');
    expect(updated!.description).toBe('new');
    expect(updated!.maxParticipants).toBe(50);
  });

  // ── transitionStatus ──────────────────────────────────────────

  it('transitions draft → active', async () => {
    const created = await store.create(makeInput());
    const result = await store.transitionStatus(created.promotionId, 'active');
    expect(result!.status).toBe('active');
  });

  it('transitions active → paused with reason', async () => {
    const created = await store.create(makeInput());
    await store.transitionStatus(created.promotionId, 'active');
    const result = await store.transitionStatus(created.promotionId, 'paused', 'Budget review');
    expect(result!.status).toBe('paused');
    expect(result!.pauseReason).toBe('Budget review');
  });

  it('transitions active → archived', async () => {
    const created = await store.create(makeInput());
    await store.transitionStatus(created.promotionId, 'active');
    const result = await store.transitionStatus(created.promotionId, 'archived', 'Done');
    expect(result!.status).toBe('archived');
    expect(result!.archiveReason).toBe('Done');
  });

  it('maintains status index consistency across transitions', async () => {
    const p = await store.create(makeInput());

    // draft index has it
    let drafts = await store.list({ status: 'draft' });
    expect(drafts).toHaveLength(1);

    // activate → moves to active index
    await store.transitionStatus(p.promotionId, 'active');
    drafts = await store.list({ status: 'draft' });
    expect(drafts).toHaveLength(0);
    let actives = await store.list({ status: 'active' });
    expect(actives).toHaveLength(1);

    // archive → moves to archived index
    await store.transitionStatus(p.promotionId, 'archived');
    actives = await store.list({ status: 'active' });
    expect(actives).toHaveLength(0);
    const archived = await store.list({ status: 'archived' });
    expect(archived).toHaveLength(1);
  });

  it('throws on invalid transitions', async () => {
    const created = await store.create(makeInput());
    await expect(store.transitionStatus(created.promotionId, 'archived')).rejects.toThrow(
      InvalidStatusTransitionError,
    );
  });

  it('returns null for non-existent promotion', async () => {
    const result = await store.transitionStatus('nope', 'active');
    expect(result).toBeNull();
  });

  // ── TRANSITION_LUA CAS ────────────────────────────────────────

  /**
   * Simulates the admission race: the TS-side `get()` returns a stale
   * `active` view while Redis already holds `archived` from a concurrent
   * writer. Spying on `redis.get` returns stale only on the first call
   * (the store's pre-check); the second call (from the CAS Lua's own GET)
   * sees the real archived state and the CAS rejects the transition.
   */
  async function runStaleReadRaceTo(
    existing: Awaited<ReturnType<typeof store.create>>,
    racedStatus: 'paused' | 'archived',
  ): Promise<unknown> {
    const recordKey = `stelis:promo:${existing.promotionId}`;
    const currentRaw = await redis.get(recordKey);
    const current = JSON.parse(currentRaw!);
    const racedRecord = { ...current, status: racedStatus };
    await redis.set(recordKey, JSON.stringify(racedRecord));

    const originalGet = redis.get.bind(redis);
    let callCount = 0;
    const spy = vi.spyOn(redis, 'get').mockImplementation(async (key: string) => {
      callCount++;
      if (callCount === 1) return JSON.stringify(current);
      return originalGet(key);
    });

    try {
      return await store.transitionStatus(existing.promotionId, 'paused');
    } catch (err) {
      return err;
    } finally {
      spy.mockRestore();
    }
  }

  it('throws ConcurrentStatusTransitionError when Lua sees a raced status', async () => {
    const created = await store.create(makeInput());
    await store.transitionStatus(created.promotionId, 'active');

    const outcome = await runStaleReadRaceTo(created, 'archived');
    expect(outcome).toBeInstanceOf(ConcurrentStatusTransitionError);
    const err = outcome as ConcurrentStatusTransitionError;
    expect(err.expected).toBe('active');
    expect(err.actual).toBe('archived');
  });

  it('CAS-failing transition does not overwrite archived final state', async () => {
    const created = await store.create(makeInput());
    await store.transitionStatus(created.promotionId, 'active');

    await runStaleReadRaceTo(created, 'archived');

    // After the losing transition, the record must still be archived.
    const after = await store.get(created.promotionId);
    expect(after!.status).toBe('archived');
  });

  // ── delete ────────────────────────────────────────────────────

  it('deletes a draft promotion', async () => {
    const created = await store.create(makeInput());
    const result = await store.delete(created.promotionId);
    expect(result).toBe(true);

    const found = await store.get(created.promotionId);
    expect(found).toBeNull();

    // Removed from indexes
    const all = await store.list();
    expect(all).toHaveLength(0);
  });

  it('refuses to delete non-draft promotion', async () => {
    const created = await store.create(makeInput());
    await store.transitionStatus(created.promotionId, 'active');

    const result = await store.delete(created.promotionId);
    expect(result).toBe(false);

    const found = await store.get(created.promotionId);
    expect(found).not.toBeNull();
  });

  it('returns false for non-existent delete', async () => {
    const result = await store.delete('nope');
    expect(result).toBe(false);
  });
});
