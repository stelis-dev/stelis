/**
 * Promotion Registry Store — CRUD store for promotion definitions.
 *
 * Stores operator-configured promotion records and lifecycle state.
 * Adapter-only module: value types (`Promotion`, `PromotionType`,
 * `PromotionStatus`, budget helper) live in `domain.ts`. This file owns the
 * adapter interface, its input DTOs, the status-transition constant + guard,
 * activation prerequisite check, and activation/transition errors — all
 * tightly coupled to the store API.
 *
 * Key layout (Redis):
 *   stelis:promo:{promotionId}         → JSON(Promotion)
 *   stelis:promo:index:all             → Redis SET of promotionIds
 *   stelis:promo:index:status:{status} → Redis SET of promotionIds
 *
 * The explicit SET-based index avoids SCAN for listing, which is O(N) on
 * keyspace and unsuitable for page-level reads.
 *
 * @module promotionStore
 */

import type { RedisClientLike } from '../store/redisClient.js';
import type { Promotion, PromotionStatus } from './domain.js';
import { MAX_PROMOTION_LEDGER_VALUE_MIST } from './executionLedger.js';

// ─────────────────────────────────────────────
// Adapter-local input DTOs
// ─────────────────────────────────────────────

/**
 * Input for creating a new promotion. Fields that are auto-generated
 * (promotionId, createdAt, updatedAt, status, pauseReason, archiveReason) are excluded.
 */
export type CreatePromotionInput = Omit<
  Promotion,
  'promotionId' | 'status' | 'createdAt' | 'updatedAt' | 'pauseReason' | 'archiveReason'
>;

/**
 * Input for updating an existing promotion. Only mutable fields.
 * Status transitions are handled separately via dedicated methods.
 */
export interface UpdatePromotionInput {
  displayName?: string;
  description?: string;
  maxParticipants?: number;
  perUserGasAllowanceMist?: string;
  claimDeadlineAt?: string | null;
  postClaimUseWindowMs?: number;
  startAt?: string | null;
}

// ─────────────────────────────────────────────
// Store Interface
// ─────────────────────────────────────────────

export interface PromotionStoreAdapter {
  /** Create a new promotion. Returns the created record. */
  create(input: CreatePromotionInput): Promise<Promotion>;

  /** Get a promotion by ID. Returns null if not found. */
  get(promotionId: string): Promise<Promotion | null>;

  /** List all promotions. Optional status filter. */
  list(filter?: { status?: PromotionStatus }): Promise<Promotion[]>;

  /** Update mutable fields. Returns updated record or null if not found. */
  update(promotionId: string, input: UpdatePromotionInput): Promise<Promotion | null>;

  /**
   * Transition promotion status.
   * Returns updated record or null if promotion not found.
   * Throws if the transition is invalid.
   */
  transitionStatus(
    promotionId: string,
    newStatus: PromotionStatus,
    reason?: string,
  ): Promise<Promotion | null>;

  /** Delete a promotion. Only allowed for draft status. Returns true if deleted. */
  delete(promotionId: string): Promise<boolean>;
}

// ─────────────────────────────────────────────
// Status transition rules
// ─────────────────────────────────────────────

/**
 * Valid status transitions.
 * - draft → active
 * - active → paused
 * - active → archived
 * - paused → active
 * - paused → archived
 *
 * Co-located with the store because transition validation, activation
 * prerequisite checks, and the adapter interface are all tightly bound.
 */
export const VALID_STATUS_TRANSITIONS: Readonly<
  Record<PromotionStatus, readonly PromotionStatus[]>
> = {
  draft: ['active'],
  active: ['paused', 'archived'],
  paused: ['active', 'archived'],
  archived: [], // final state
};

export function isValidTransition(from: PromotionStatus, to: PromotionStatus): boolean {
  return VALID_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

export class InvalidStatusTransitionError extends Error {
  constructor(from: PromotionStatus, to: PromotionStatus) {
    super(`Invalid status transition: ${from} → ${to}`);
    this.name = 'InvalidStatusTransitionError';
  }
}

export class PromotionActivationError extends Error {
  constructor(reason: string) {
    super(`Cannot activate promotion: ${reason}`);
    this.name = 'PromotionActivationError';
  }
}

/**
 * Economic and temporal fields that are frozen once a promotion leaves `draft`.
 * Presentational fields (`displayName`, `description`) remain mutable.
 */
export const IMMUTABLE_AFTER_DRAFT_FIELDS = [
  'maxParticipants',
  'perUserGasAllowanceMist',
  'claimDeadlineAt',
  'postClaimUseWindowMs',
  'startAt',
] as const satisfies readonly (keyof UpdatePromotionInput)[];

export type ImmutableAfterDraftField = (typeof IMMUTABLE_AFTER_DRAFT_FIELDS)[number];

export class PromotionFieldImmutableError extends Error {
  constructor(
    public readonly fields: readonly ImmutableAfterDraftField[],
    public readonly currentStatus: PromotionStatus,
  ) {
    super(
      `Cannot modify ${fields.join(', ')} on ${currentStatus} promotion: ` +
        `economic and temporal fields are frozen once a promotion leaves draft`,
    );
    this.name = 'PromotionFieldImmutableError';
  }
}

export class ConcurrentStatusTransitionError extends Error {
  constructor(
    public readonly expected: PromotionStatus,
    public readonly actual: PromotionStatus,
  ) {
    super(
      `Status transition lost race: expected current status ${expected}, ` +
        `found ${actual}; a concurrent transition modified this promotion`,
    );
    this.name = 'ConcurrentStatusTransitionError';
  }
}

/**
 * Enforce immutable-after-draft economic and temporal fields.
 * Throws `PromotionFieldImmutableError` if any immutable field is present in
 * `input` while the existing record is past the `draft` status.
 *
 * Shape validation (positive integer, valid bigint string) lives at the
 * transport boundary. This helper defines the freeze rule.
 */
export function ensureUpdatableFields(existing: Promotion, input: UpdatePromotionInput): void {
  if (existing.status === 'draft') return;
  const attempted: ImmutableAfterDraftField[] = [];
  for (const field of IMMUTABLE_AFTER_DRAFT_FIELDS) {
    if (input[field] !== undefined) attempted.push(field);
  }
  if (attempted.length > 0) {
    throw new PromotionFieldImmutableError(attempted, existing.status);
  }
}

/**
 * Validates prerequisites for activating a promotion.
 * Called during draft→active and paused→active transitions.
 * Throws PromotionActivationError if prerequisites are not met.
 *
 * Checks:
 * 1. gas_sponsorship: maxParticipants must be > 0 (prevent uncapped commitments)
 * 2. gas_sponsorship: perUserGasAllowanceMist must be > 0 when maxParticipants > 0
 * 3. gas_sponsorship: perUserGasAllowanceMist must be ≤
 *    `MAX_PROMOTION_LEDGER_VALUE_MIST` so the value fits Redis-Lua int64
 *    arithmetic (see `executionLedger.ts` constant comment for why the
 *    bound is `Number.MAX_SAFE_INTEGER` rather than the int64 ceiling).
 * 4. gas_sponsorship: finite total budget
 *    `maxParticipants × perUserGasAllowanceMist` must be ≤
 *    `MAX_PROMOTION_LEDGER_VALUE_MIST` so the budget keys (`budget:avail`,
 *    `budget:res_total`, `budget:con_total`) stay within the safe range.
 *
 * Note: target enforcement is global via STUDIO_ALLOWED_TARGETS (not per-promotion).
 */
export function validateActivationPrerequisites(record: Promotion): void {
  if (record.type === 'gas_sponsorship') {
    if (!Number.isSafeInteger(record.maxParticipants) || record.maxParticipants <= 0) {
      throw new PromotionActivationError(
        'gas_sponsorship promotions must have maxParticipants > 0 to prevent uncapped budget commitments',
      );
    }
    if (!/^(?:0|[1-9]\d*)$/.test(record.perUserGasAllowanceMist)) {
      throw new PromotionActivationError(
        'gas_sponsorship promotions must have perUserGasAllowanceMist as a decimal integer string',
      );
    }
    const perUser = BigInt(record.perUserGasAllowanceMist);
    if (perUser <= 0n) {
      throw new PromotionActivationError(
        'gas_sponsorship promotions must have perUserGasAllowanceMist > 0',
      );
    }
    if (perUser > MAX_PROMOTION_LEDGER_VALUE_MIST) {
      throw new PromotionActivationError(
        `gas_sponsorship perUserGasAllowanceMist (${perUser.toString()}) must be ≤ ${MAX_PROMOTION_LEDGER_VALUE_MIST.toString()} (Number.MAX_SAFE_INTEGER) so Redis-Lua int64 arithmetic stays exact`,
      );
    }
    const totalBudget = BigInt(record.maxParticipants) * perUser;
    if (totalBudget > MAX_PROMOTION_LEDGER_VALUE_MIST) {
      throw new PromotionActivationError(
        `gas_sponsorship total budget (maxParticipants × perUserGasAllowanceMist = ${totalBudget.toString()}) must be ≤ ${MAX_PROMOTION_LEDGER_VALUE_MIST.toString()} (Number.MAX_SAFE_INTEGER) so Redis-Lua int64 arithmetic stays exact`,
      );
    }
  }
}

// ─────────────────────────────────────────────
// Memory Implementation (testing)
// ─────────────────────────────────────────────

export class MemoryPromotionStore implements PromotionStoreAdapter {
  private readonly _records = new Map<string, Promotion>();
  private _counter = 0;

  /** Generate a deterministic test ID. Override for custom IDs. */
  protected generateId(): string {
    this._counter++;
    return `promo-test-${this._counter.toString().padStart(4, '0')}`;
  }

  async create(input: CreatePromotionInput): Promise<Promotion> {
    const now = new Date().toISOString();
    const record: Promotion = {
      ...input,
      promotionId: this.generateId(),
      status: 'draft',
      pauseReason: null,
      archiveReason: null,
      createdAt: now,
      updatedAt: now,
    };
    this._records.set(record.promotionId, record);
    return record;
  }

  async get(promotionId: string): Promise<Promotion | null> {
    return this._records.get(promotionId) ?? null;
  }

  async list(filter?: { status?: PromotionStatus }): Promise<Promotion[]> {
    const all = Array.from(this._records.values());
    if (!filter?.status) return all;
    return all.filter((r) => r.status === filter.status);
  }

  async update(promotionId: string, input: UpdatePromotionInput): Promise<Promotion | null> {
    const existing = this._records.get(promotionId);
    if (!existing) return null;

    ensureUpdatableFields(existing, input);

    const updated: Promotion = {
      ...existing,
      ...stripUndefined(input as Record<string, unknown>),
      updatedAt: new Date().toISOString(),
    };
    this._records.set(promotionId, updated);
    return updated;
  }

  async transitionStatus(
    promotionId: string,
    newStatus: PromotionStatus,
    reason?: string,
  ): Promise<Promotion | null> {
    const existing = this._records.get(promotionId);
    if (!existing) return null;

    if (!isValidTransition(existing.status, newStatus)) {
      throw new InvalidStatusTransitionError(existing.status, newStatus);
    }

    // Activation gate: verify prerequisites before allowing active status
    if (newStatus === 'active') {
      validateActivationPrerequisites(existing);
    }

    const now = new Date().toISOString();
    const updated: Promotion = {
      ...existing,
      status: newStatus,
      updatedAt: now,
      pauseReason: newStatus === 'paused' ? (reason ?? null) : existing.pauseReason,
      archiveReason: newStatus === 'archived' ? (reason ?? null) : existing.archiveReason,
    };
    this._records.set(promotionId, updated);
    return updated;
  }

  async delete(promotionId: string): Promise<boolean> {
    const existing = this._records.get(promotionId);
    if (!existing) return false;
    if (existing.status !== 'draft') return false;
    this._records.delete(promotionId);
    return true;
  }
}

// ─────────────────────────────────────────────
// Redis Implementation (production)
// ─────────────────────────────────────────────

export interface RedisPromotionStoreOptions {
  keyPrefix?: string;
}

/**
 * Redis-backed Promotion Store.
 *
 * Uses explicit SET-based indexes for listing (no SCAN).
 * All writes maintain index consistency atomically via Lua.
 */
export class RedisPromotionStore implements PromotionStoreAdapter {
  private readonly _client: RedisClientLike;
  private readonly _prefix: string;

  constructor(client: RedisClientLike, options: RedisPromotionStoreOptions = {}) {
    this._client = client;
    this._prefix = options.keyPrefix ?? 'stelis:promo:';
  }

  private _recordKey(id: string): string {
    return `${this._prefix}${id}`;
  }

  /**
   * Canonical Redis key for the promotion record, exposed for callers that
   * need to pass the key into an adjacent atomic Lua script (e.g. the
   * execution ledger's claim CAS re-reading `status`). The key shape is
   * owned here — the ledger must not duplicate the prefix logic.
   */
  recordKey(id: string): string {
    return this._recordKey(id);
  }

  private get _allIndexKey(): string {
    return `${this._prefix}index:all`;
  }

  private _statusIndexKey(status: PromotionStatus): string {
    return `${this._prefix}index:status:${status}`;
  }

  async create(input: CreatePromotionInput): Promise<Promotion> {
    const promotionId = crypto.randomUUID();
    const now = new Date().toISOString();
    const record: Promotion = {
      ...input,
      promotionId,
      status: 'draft',
      pauseReason: null,
      archiveReason: null,
      createdAt: now,
      updatedAt: now,
    };

    const json = JSON.stringify(record);

    // Atomic: SET record + SADD to all index + SADD to status index
    await this._client.eval(
      CREATE_LUA,
      [this._recordKey(promotionId), this._allIndexKey, this._statusIndexKey('draft')],
      [json, promotionId],
    );

    return record;
  }

  async get(promotionId: string): Promise<Promotion | null> {
    const raw = await this._client.get(this._recordKey(promotionId));
    if (!raw) return null;
    return JSON.parse(raw) as Promotion;
  }

  async list(filter?: { status?: PromotionStatus }): Promise<Promotion[]> {
    // Read IDs from the appropriate index
    const indexKey = filter?.status ? this._statusIndexKey(filter.status) : this._allIndexKey;

    const result = await this._client.eval(LIST_LUA, [indexKey], [this._prefix]);

    if (!Array.isArray(result)) return [];
    return (result as (string | null)[])
      .filter((raw): raw is string => raw !== null)
      .map((raw) => JSON.parse(raw) as Promotion);
  }

  async update(promotionId: string, input: UpdatePromotionInput): Promise<Promotion | null> {
    const existing = await this.get(promotionId);
    if (!existing) return null;

    ensureUpdatableFields(existing, input);

    const updated: Promotion = {
      ...existing,
      ...stripUndefined(input as Record<string, unknown>),
      updatedAt: new Date().toISOString(),
    };

    await this._client.set(this._recordKey(promotionId), JSON.stringify(updated));
    return updated;
  }

  async transitionStatus(
    promotionId: string,
    newStatus: PromotionStatus,
    reason?: string,
  ): Promise<Promotion | null> {
    const existing = await this.get(promotionId);
    if (!existing) return null;

    if (!isValidTransition(existing.status, newStatus)) {
      throw new InvalidStatusTransitionError(existing.status, newStatus);
    }

    // Activation gate: verify prerequisites before allowing active status
    if (newStatus === 'active') {
      validateActivationPrerequisites(existing);
    }

    const now = new Date().toISOString();
    const updated: Promotion = {
      ...existing,
      status: newStatus,
      updatedAt: now,
      pauseReason: newStatus === 'paused' ? (reason ?? null) : existing.pauseReason,
      archiveReason: newStatus === 'archived' ? (reason ?? null) : existing.archiveReason,
    };

    const json = JSON.stringify(updated);

    // Atomic: CAS-guarded update record + move between status indexes.
    // ARGV[3] is the status the caller observed; a concurrent transition
    // that changed the record's status since that read is rejected here.
    const result = await this._client.eval(
      TRANSITION_LUA,
      [
        this._recordKey(promotionId),
        this._statusIndexKey(existing.status),
        this._statusIndexKey(newStatus),
      ],
      [json, promotionId, existing.status],
    );

    if (result === 'OK') return updated;
    if (result === 'NOT_FOUND') return null;
    if (typeof result === 'string' && result.startsWith('CAS_FAIL:')) {
      const actual = result.substring('CAS_FAIL:'.length) as PromotionStatus;
      throw new ConcurrentStatusTransitionError(existing.status, actual);
    }
    throw new Error(`Unexpected TRANSITION_LUA result: ${String(result)}`);
  }

  async delete(promotionId: string): Promise<boolean> {
    const existing = await this.get(promotionId);
    if (!existing) return false;
    if (existing.status !== 'draft') return false;

    // Atomic: DEL record + SREM from all index + SREM from status index
    await this._client.eval(
      DELETE_LUA,
      [this._recordKey(promotionId), this._allIndexKey, this._statusIndexKey('draft')],
      [promotionId],
    );
    return true;
  }
}

// ─────────────────────────────────────────────
// Lua Scripts
// ─────────────────────────────────────────────

/**
 * CREATE — atomic SET + SADD (all index + status index).
 *
 * KEYS[1] = record key
 * KEYS[2] = all index key
 * KEYS[3] = status index key (draft)
 * ARGV[1] = JSON record
 * ARGV[2] = promotionId
 */
const CREATE_LUA = `
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SADD', KEYS[2], ARGV[2])
redis.call('SADD', KEYS[3], ARGV[2])
return 1
`;

/**
 * LIST — read all IDs from index SET, then MGET records.
 *
 * KEYS[1] = index key (all or status-specific)
 * ARGV[1] = record key prefix
 */
const LIST_LUA = `
local ids = redis.call('SMEMBERS', KEYS[1])
if #ids == 0 then return {} end
local keys = {}
for i, id in ipairs(ids) do
  keys[i] = ARGV[1] .. id
end
return redis.call('MGET', unpack(keys))
`;

/**
 * TRANSITION — CAS-guarded status index move + record update.
 *
 * KEYS[1] = record key
 * KEYS[2] = old status index key (corresponds to expected current status)
 * KEYS[3] = new status index key
 * ARGV[1] = JSON record (the caller-constructed target record)
 * ARGV[2] = promotionId
 * ARGV[3] = expected current status (CAS guard)
 *
 * Returns:
 *   'OK'                        — success
 *   'NOT_FOUND'                 — record no longer exists
 *   'CAS_FAIL:<actual_status>'  — record status changed since caller read
 */
const TRANSITION_LUA = `
local currentRaw = redis.call('GET', KEYS[1])
if not currentRaw then return 'NOT_FOUND' end
local current = cjson.decode(currentRaw)
if current.status ~= ARGV[3] then
  return 'CAS_FAIL:' .. current.status
end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SREM', KEYS[2], ARGV[2])
redis.call('SADD', KEYS[3], ARGV[2])
return 'OK'
`;

/**
 * DELETE — atomic DEL + SREM from both indexes.
 *
 * KEYS[1] = record key
 * KEYS[2] = all index key
 * KEYS[3] = status index key (draft)
 * ARGV[1] = promotionId
 */
const DELETE_LUA = `
redis.call('DEL', KEYS[1])
redis.call('SREM', KEYS[2], ARGV[1])
redis.call('SREM', KEYS[3], ARGV[1])
return 1
`;

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/** Remove undefined values from an object (for partial updates). */
function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) result[k] = v;
  }
  return result;
}
