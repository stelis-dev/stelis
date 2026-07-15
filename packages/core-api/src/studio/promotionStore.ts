/**
 * Promotion Registry Store — CRUD store for promotion definitions.
 *
 * Stores operator-configured promotion records and lifecycle state.
 * Adapter-only module: value types live in `domain.ts`, Admin request shapes
 * come from `@stelis/contracts`, and this file owns persistence plus current
 * lifecycle transitions.
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

import type {
  AdminPromotionCreateRequest,
  AdminPromotionUpdateRequest,
} from '@stelis/contracts';
import {
  parseAdminPromotionCreateRequest,
  parseAdminPromotionUpdateRequest,
} from '@stelis/contracts';
import type { RedisClientLike } from '../store/redisClient.js';
import type { Promotion, PromotionStatus } from './domain.js';
import { parsePromotionLedgerBudget } from './executionLedgerValueGuards.js';

// ─────────────────────────────────────────────
// Store contract
// ─────────────────────────────────────────────

/** Atomic outcome of deleting the current Promotion record. */
export type PromotionDeleteResult =
  | { status: 'deleted' }
  | { status: 'not_found' }
  | { status: 'not_deletable' };

// ─────────────────────────────────────────────
// Store Interface
// ─────────────────────────────────────────────

export interface PromotionStoreAdapter {
  /** Create a new promotion. Returns the created record. */
  create(input: AdminPromotionCreateRequest): Promise<Promotion>;

  /** Get a promotion by ID. Returns null if not found. */
  get(promotionId: string): Promise<Promotion | null>;

  /** List all promotions. Optional status filter. */
  list(filter?: { status?: PromotionStatus }): Promise<Promotion[]>;

  /** Update mutable fields. Returns updated record or null if not found. */
  update(promotionId: string, input: AdminPromotionUpdateRequest): Promise<Promotion | null>;

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

  /** Delete a draft promotion without collapsing absence and lifecycle rejection. */
  delete(promotionId: string): Promise<PromotionDeleteResult>;
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
 * Co-located with the store because transition validation and persistence
 * must apply as one record mutation.
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
] as const satisfies readonly (keyof AdminPromotionUpdateRequest)[];

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

export class PromotionCurrentConflictError extends Error {
  constructor(
    public readonly promotionId: string,
    public readonly operation: 'create' | 'update' | 'status' | 'delete',
  ) {
    super(`Promotion ${promotionId} changed while attempting ${operation}`);
    this.name = 'PromotionCurrentConflictError';
  }
}

/**
 * Enforce immutable-after-draft economic and temporal fields.
 * Throws `PromotionFieldImmutableError` if any immutable field is present in
 * `input` while the existing record is past the `draft` status.
 *
 * The contracts wire parser owns request grammar. The store independently
 * applies the shared ledger-budget invariant after this freeze check.
 */
export function ensureUpdatableFields(
  existing: Promotion,
  input: AdminPromotionUpdateRequest,
): void {
  if (existing.status === 'draft') return;
  const attempted: ImmutableAfterDraftField[] = [];
  for (const field of IMMUTABLE_AFTER_DRAFT_FIELDS) {
    if (input[field] !== undefined) attempted.push(field);
  }
  if (attempted.length > 0) {
    throw new PromotionFieldImmutableError(attempted, existing.status);
  }
}

function createPromotionRecord(
  input: AdminPromotionCreateRequest,
  promotionId: string,
  now: string,
): Promotion {
  const currentInput = parseAdminPromotionCreateRequest(input);
  const record: Promotion = {
    promotionId,
    type: currentInput.type,
    displayName: currentInput.displayName,
    description: currentInput.description ?? '',
    status: 'draft',
    maxParticipants: currentInput.maxParticipants,
    perUserGasAllowanceMist: currentInput.perUserGasAllowanceMist,
    claimDeadlineAt: currentInput.claimDeadlineAt ?? null,
    postClaimUseWindowMs: currentInput.postClaimUseWindowMs ?? 0,
    startAt: currentInput.startAt ?? null,
    pauseReason: null,
    archiveReason: null,
    createdAt: now,
    updatedAt: now,
  };
  parsePromotionLedgerBudget(record.maxParticipants, record.perUserGasAllowanceMist);
  return record;
}

function snapshotUpdatePromotionInput(
  input: AdminPromotionUpdateRequest,
): AdminPromotionUpdateRequest {
  return parseAdminPromotionUpdateRequest(input);
}

function updatePromotionRecord(
  existing: Promotion,
  input: AdminPromotionUpdateRequest,
  now: string,
): Promotion {
  ensureUpdatableFields(existing, input);
  const updated: Promotion = {
    ...existing,
    ...input,
    updatedAt: now,
  };
  parsePromotionLedgerBudget(updated.maxParticipants, updated.perUserGasAllowanceMist);
  return updated;
}

function transitionPromotionRecord(
  existing: Promotion,
  newStatus: PromotionStatus,
  reason: string | undefined,
  now: string,
): Promotion {
  if (!isValidTransition(existing.status, newStatus)) {
    throw new InvalidStatusTransitionError(existing.status, newStatus);
  }
  if (newStatus === 'active') {
    parsePromotionLedgerBudget(existing.maxParticipants, existing.perUserGasAllowanceMist);
  }
  return {
    ...existing,
    status: newStatus,
    updatedAt: now,
    pauseReason: newStatus === 'paused' ? (reason ?? null) : existing.pauseReason,
    archiveReason: newStatus === 'archived' ? (reason ?? null) : existing.archiveReason,
  };
}

function clonePromotion(record: Promotion): Promotion {
  return { ...record };
}

function decidePromotionDelete(record: Promotion | null): 'delete' | 'not_deletable' | 'not_found' {
  if (record === null) return 'not_found';
  return record.status === 'draft' ? 'delete' : 'not_deletable';
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

  async create(input: AdminPromotionCreateRequest): Promise<Promotion> {
    const promotionId = this.generateId();
    const now = new Date().toISOString();
    const record = createPromotionRecord(input, promotionId, now);
    if (this._records.has(promotionId)) {
      throw new PromotionCurrentConflictError(promotionId, 'create');
    }
    this._records.set(promotionId, clonePromotion(record));
    return clonePromotion(record);
  }

  async get(promotionId: string): Promise<Promotion | null> {
    const record = this._records.get(promotionId);
    return record === undefined ? null : clonePromotion(record);
  }

  async list(filter?: { status?: PromotionStatus }): Promise<Promotion[]> {
    const all = Array.from(this._records.values());
    const filtered = filter?.status ? all.filter((record) => record.status === filter.status) : all;
    return filtered.map(clonePromotion);
  }

  async update(
    promotionId: string,
    input: AdminPromotionUpdateRequest,
  ): Promise<Promotion | null> {
    const now = new Date().toISOString();
    const patch = snapshotUpdatePromotionInput(input);
    const existing = this._records.get(promotionId);
    if (!existing) return null;
    const updated = updatePromotionRecord(existing, patch, now);
    this._records.set(promotionId, clonePromotion(updated));
    return clonePromotion(updated);
  }

  async transitionStatus(
    promotionId: string,
    newStatus: PromotionStatus,
    reason?: string,
  ): Promise<Promotion | null> {
    const now = new Date().toISOString();
    const existing = this._records.get(promotionId);
    if (!existing) return null;
    const updated = transitionPromotionRecord(existing, newStatus, reason, now);
    this._records.set(promotionId, clonePromotion(updated));
    return clonePromotion(updated);
  }

  async delete(promotionId: string): Promise<PromotionDeleteResult> {
    const decision = decidePromotionDelete(this._records.get(promotionId) ?? null);
    if (decision === 'not_found') return { status: 'not_found' };
    if (decision === 'not_deletable') return { status: 'not_deletable' };
    this._records.delete(promotionId);
    return { status: 'deleted' };
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

  private async _readSerialized(
    promotionId: string,
  ): Promise<{ readonly raw: string; readonly record: Promotion } | null> {
    const raw = await this._client.get(this._recordKey(promotionId));
    return raw === null ? null : { raw, record: JSON.parse(raw) as Promotion };
  }

  async create(input: AdminPromotionCreateRequest): Promise<Promotion> {
    const promotionId = crypto.randomUUID();
    const now = new Date().toISOString();
    const record = createPromotionRecord(input, promotionId, now);

    const json = JSON.stringify(record);
    const result = await this._client.eval(
      CREATE_LUA,
      [this._recordKey(promotionId), this._allIndexKey, this._statusIndexKey('draft')],
      [json, promotionId],
    );
    if (result === 'CURRENT_CONFLICT') {
      throw new PromotionCurrentConflictError(promotionId, 'create');
    }
    if (result !== 'OK') throw new Error(`Unexpected CREATE_LUA result: ${String(result)}`);
    return record;
  }

  async get(promotionId: string): Promise<Promotion | null> {
    return (await this._readSerialized(promotionId))?.record ?? null;
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

  async update(
    promotionId: string,
    input: AdminPromotionUpdateRequest,
  ): Promise<Promotion | null> {
    const now = new Date().toISOString();
    const patch = snapshotUpdatePromotionInput(input);
    const current = await this._readSerialized(promotionId);
    if (current === null) return null;
    const updated = updatePromotionRecord(current.record, patch, now);
    const result = await this._client.eval(
      UPDATE_LUA,
      [this._recordKey(promotionId)],
      [current.raw, JSON.stringify(updated)],
    );
    if (result === 'CURRENT_CONFLICT') {
      throw new PromotionCurrentConflictError(promotionId, 'update');
    }
    if (result !== 'OK') throw new Error(`Unexpected UPDATE_LUA result: ${String(result)}`);
    return updated;
  }

  async transitionStatus(
    promotionId: string,
    newStatus: PromotionStatus,
    reason?: string,
  ): Promise<Promotion | null> {
    const now = new Date().toISOString();
    const current = await this._readSerialized(promotionId);
    if (current === null) return null;
    const updated = transitionPromotionRecord(current.record, newStatus, reason, now);
    const result = await this._client.eval(
      STATUS_LUA,
      [
        this._recordKey(promotionId),
        this._statusIndexKey(current.record.status),
        this._statusIndexKey(newStatus),
      ],
      [current.raw, JSON.stringify(updated), promotionId],
    );
    if (result === 'OK') return updated;
    if (result === 'CURRENT_CONFLICT') {
      throw new PromotionCurrentConflictError(promotionId, 'status');
    }
    throw new Error(`Unexpected STATUS_LUA result: ${String(result)}`);
  }

  async delete(promotionId: string): Promise<PromotionDeleteResult> {
    const expectedRaw = await this._client.get(this._recordKey(promotionId));
    const decision = decidePromotionDelete(
      expectedRaw === null ? null : (JSON.parse(expectedRaw) as Promotion),
    );
    const result = await this._client.eval(
      DELETE_LUA,
      [this._recordKey(promotionId), this._allIndexKey, this._statusIndexKey('draft')],
      [expectedRaw ?? '', promotionId],
    );
    if (result === 'OK') {
      if (decision !== 'delete') throw new Error('DELETE_LUA contradicted the current record');
      return { status: 'deleted' };
    }
    if (result === 'NOT_FOUND') {
      if (decision !== 'not_found') {
        throw new PromotionCurrentConflictError(promotionId, 'delete');
      }
      return { status: 'not_found' };
    }
    if (result === 'NOT_DELETABLE') {
      if (decision !== 'not_deletable') {
        throw new Error('DELETE_LUA contradicted the current record');
      }
      return { status: 'not_deletable' };
    }
    if (result === 'CURRENT_CONFLICT') {
      throw new PromotionCurrentConflictError(promotionId, 'delete');
    }
    throw new Error(`Unexpected DELETE_LUA result: ${String(result)}`);
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
if redis.call('EXISTS', KEYS[1]) == 1 then return 'CURRENT_CONFLICT' end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SADD', KEYS[2], ARGV[2])
redis.call('SADD', KEYS[3], ARGV[2])
return 'OK'
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
 * UPDATE — exact-current-record CAS followed by record replacement.
 *
 * KEYS[1] = record key
 * ARGV[1] = exact serialized record observed by the caller
 * ARGV[2] = serialized target record
 */
const UPDATE_LUA = `
local currentRaw = redis.call('GET', KEYS[1])
if not currentRaw or currentRaw ~= ARGV[1] then return 'CURRENT_CONFLICT' end
redis.call('SET', KEYS[1], ARGV[2])
return 'OK'
`;

/**
 * STATUS — exact-current-record CAS, record update, and status-index move.
 *
 * KEYS[1] = record key
 * KEYS[2] = old status index key
 * KEYS[3] = new status index key
 * ARGV[1] = exact serialized record observed by the caller
 * ARGV[2] = serialized target record
 * ARGV[3] = promotionId
 */
const STATUS_LUA = `
local currentRaw = redis.call('GET', KEYS[1])
if not currentRaw or currentRaw ~= ARGV[1] then return 'CURRENT_CONFLICT' end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('SREM', KEYS[2], ARGV[3])
redis.call('SADD', KEYS[3], ARGV[3])
return 'OK'
`;

/**
 * DELETE — exact-current-record CAS, draft check, and atomic index removal.
 *
 * KEYS[1] = record key
 * KEYS[2] = all index key
 * KEYS[3] = status index key (draft)
 * ARGV[1] = exact serialized record observed by the caller, or empty if absent
 * ARGV[2] = promotionId
 */
const DELETE_LUA = `
local currentRaw = redis.call('GET', KEYS[1])
if not currentRaw then
  if ARGV[1] == '' then return 'NOT_FOUND' end
  return 'CURRENT_CONFLICT'
end
if ARGV[1] == '' or currentRaw ~= ARGV[1] then return 'CURRENT_CONFLICT' end
local current = cjson.decode(currentRaw)
if current.status ~= 'draft' then return 'NOT_DELETABLE' end
redis.call('DEL', KEYS[1])
redis.call('SREM', KEYS[2], ARGV[2])
redis.call('SREM', KEYS[3], ARGV[2])
return 'OK'
`;
