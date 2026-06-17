/**
 * RedisPrepareStore — Redis-backed PrepareStoreAdapter for horizontal scaling.
 *
 * Implements the same semantics as MemoryPrepareStore:
 *   - Single-use consume (atomic via Lua)
 *   - IP concurrency enforcement (max outstanding per IP)
 *   - Verified sender outstanding-prepare quota at nonce reservation
 *   - TTL-based expiry (Lua-side + Redis PX fallback)
 *
 * Key layout:
 *   {prefix}{receiptId}             → JSON(SerializedEntry)
 *                                      PX = ttlMs + PREPARE_STORE_KEY_TTL_GRACE_MS
 *   {prefix}ip:{clientIp}           → JSON([{pid, slotId, issuedAt}])
 *                                      PX = ttlMs * PREPARE_STORE_INDEX_TTL_MULTIPLIER
 *   {prefix}sender:{senderAddress}  → JSON([{pid, slotId, issuedAt, nonce}])
 *                                      PX = ttlMs * PREPARE_STORE_INDEX_TTL_MULTIPLIER
 *   {prefix}user:{userId}           → JSON([{pid, issuedAt}]) for promotion mode
 *                                      PX = ttlMs * PREPARE_STORE_INDEX_TTL_MULTIPLIER
 *
 * TTL expiry slot release policy:
 *   On consume/store, Lua checks issuedAt + ttlMs < server time → 'expired'.
 *   On abandon (no consume call), RedisSponsorPool lease TTL auto-releases the
 *   slot after the prepare TTL plus sponsor-lease grace. See operations.md for
 *   details.
 *
 * References:
 *   prepareTypes.ts — PrepareStoreAdapter interface
 *   memoryPrepareStore.ts — Memory reference implementation
 *   redisSponsorPool.ts — Redis adapter pattern
 */
import type { PreparedTxEntry, PrepareStoreAdapter } from './prepareTypes.js';
import type { RedisClientLike } from './redisClient.js';
import { logSponsorPoolEvent } from '../sponsorPoolEventLog.js';
import { SPONSOR_POOL_SLOT_INFO_UNRECOVERABLE } from '../observability/events.js';
import {
  invokeEvictCallback,
  invokeReleaseCallback,
  type OnEntryEvictCallback,
  type OnReleaseCallback,
} from './prepareStoreCallbacks.js';
import { PREPARE_TTL_MS } from '../preparePolicy.js';
import {
  MAX_CONCURRENT_PER_IP,
  MAX_OUTSTANDING_PER_SENDER,
  MAX_OUTSTANDING_PER_STUDIO_USER,
} from './memoryPrepareStore.js';
import { PrepareSenderQuotaError, PrepareStudioUserQuotaError } from './prepareErrors.js';
import { type Clock, systemClock } from '../clock.js';

/** Extra physical receipt-key TTL after logical prepare expiry. */
const PREPARE_STORE_KEY_TTL_GRACE_MS = 5_000;
/** Physical TTL multiplier for Redis prepare-store index keys. */
const PREPARE_STORE_INDEX_TTL_MULTIPLIER = 2;

// ─────────────────────────────────────────────
// Lua scripts
// ─────────────────────────────────────────────

/**
 * STORE_SCRIPT — atomically stores an entry and enforces IP plus the
 * promotion-only studio-user outstanding-prepare quota. The sender index
 * is live-compacted on every store regardless of mode. Verified sender
 * outstanding-prepare quota is enforced by the reserveNonce script after
 * prepare authorization and before adding a pending reservation.
 *
 * KEYS[1] = entry key, KEYS[2] = ip key, KEYS[3] = sender key,
 * KEYS[4] = user key (promotion-only; pass empty string for generic)
 * ARGV[1] = entry JSON, ARGV[2] = entryPxMs, ARGV[3] = receiptId
 * ARGV[4] = slotId, ARGV[5] = issuedAt, ARGV[6] = maxPerIp
 * ARGV[7] = ipPxMs, ARGV[8] = prefix
 * ARGV[9] = maxPerStudioUser, ARGV[10] = senderPxMs
 * ARGV[11] = nonce, ARGV[12] = entryMode, ARGV[13] = ttlMs
 * ARGV[14] = userPxMs (promotion-only; pass 0 for generic)
 *
 * The sponsor pool commits
 * `HMAC(secret, receiptId || slotId || commitDigest)` to its lease
 * store — reserved at `checkout()` and then replaced with the
 * prepare-commit hash (`txBytesHash`) by the prepare runner's
 * `sponsorPool.commit()` call — so the prepare store does not persist
 * any lease material itself. Release callbacks use
 * `(slotId, receiptId, txBytesHash)` so the pool CAS can verify the
 * committed HMAC proof before deleting the slot; `receiptId` is already
 * tracked as `pid` in each IP/sender entry, and the committed
 * `txBytesHash` is read from the stored entry (or the raw JSON in
 * corrupt-entry recovery) by the TS layer before forwarding.
 *
 * Returns:
 *   '__user_quota__'                  if promotion-mode user quota exceeded (entry NOT stored)
 *   JSON array of evicted [{pid, slotId, entryJson}]  (may be empty '[]') on success
 */
const STORE_SCRIPT = `
local entryKey = KEYS[1]
local ipKey = KEYS[2]
local senderKey = KEYS[3]
local userKey = KEYS[4]
local entryJson = ARGV[1]
local entryPx = tonumber(ARGV[2])
local pid = ARGV[3]
local slotId = ARGV[4]
local issuedAt = tonumber(ARGV[5])
local maxPerIp = tonumber(ARGV[6])
local ipPx = tonumber(ARGV[7])
local prefix = ARGV[8]
local maxPerStudioUser = tonumber(ARGV[9])
local senderPx = tonumber(ARGV[10])
local nonce = ARGV[11]
local entryMode = ARGV[12]
local ttlMs = tonumber(ARGV[13])
local userPx = tonumber(ARGV[14])

local timeResult = redis.call('TIME')
local nowMs = tonumber(timeResult[1]) * 1000 + math.floor(tonumber(timeResult[2]) / 1000)

-- Sender index — live-compact regardless of mode. The sender index
-- carries S-14 nonce coordination and replay protection; it is keyed by
-- Sui address and updated for every entry.
local senderRaw = redis.call('GET', senderKey)
local senderList = {}
if senderRaw then
  senderList = cjson.decode(senderRaw)
end
local liveSender = {}
for _, item in ipairs(senderList) do
  if item.pending then
    liveSender[#liveSender + 1] = item
  elseif item.t and (item.t + ttlMs < nowMs) then
    -- Logical TTL expired — drop even if physical key still exists
  elseif redis.call('EXISTS', prefix .. item.pid) == 1 then
    liveSender[#liveSender + 1] = item
  end
end

-- Studio user quota — only enforced for promotion mode. The user index
-- is keyed by verified developer JWT userId and only contains promotion
-- entries. Generic mode never populates this index, so cross-mode
-- contamination is structurally impossible.
local liveUser = {}
if entryMode == 'promotion' and userKey ~= '' then
  local userRaw = redis.call('GET', userKey)
  if userRaw then
    local userList = cjson.decode(userRaw)
    for _, item in ipairs(userList) do
      if item.t and (item.t + ttlMs < nowMs) then
        -- Logical TTL expired — drop
      elseif redis.call('EXISTS', prefix .. item.pid) == 1 then
        liveUser[#liveUser + 1] = item
      end
    end
  end
  if #liveUser >= maxPerStudioUser then
    return '__user_quota__'
  end
end

redis.call('SET', entryKey, entryJson, 'PX', entryPx)

local ipRaw = redis.call('GET', ipKey)
local list = {}
if ipRaw then
  list = cjson.decode(ipRaw)
end

local live = {}
for _, item in ipairs(list) do
  if redis.call('EXISTS', prefix .. item.pid) == 1 then
    live[#live + 1] = item
  end
end

local evicted = {}
while #live >= maxPerIp do
  local oldest = table.remove(live, 1)
  local evictedEntryJson = redis.call('GET', prefix .. oldest.pid)
  redis.call('DEL', prefix .. oldest.pid)
  evicted[#evicted + 1] = { pid = oldest.pid, slotId = oldest.slotId, entryJson = evictedEntryJson or '' }
end

live[#live + 1] = { pid = pid, slotId = slotId, t = issuedAt }
redis.call('SET', ipKey, cjson.encode(live), 'PX', ipPx)

-- Update sender index: remove current pid + any IP-evicted pids, add live entry
local evictedPids = {}
for _, ev in ipairs(evicted) do
  evictedPids[ev.pid] = true
end
local updatedSender = {}
for _, item in ipairs(liveSender) do
  if item.pid ~= pid and not evictedPids[item.pid] then
    updatedSender[#updatedSender + 1] = item
  end
end
updatedSender[#updatedSender + 1] = { pid = pid, slotId = slotId, t = issuedAt, nonce = nonce }
redis.call('SET', senderKey, cjson.encode(updatedSender), 'PX', senderPx)

-- Update user index for promotion entries (Studio outstanding-prepare quota).
if entryMode == 'promotion' and userKey ~= '' then
  local updatedUser = {}
  for _, item in ipairs(liveUser) do
    if item.pid ~= pid and not evictedPids[item.pid] then
      updatedUser[#updatedUser + 1] = item
    end
  end
  updatedUser[#updatedUser + 1] = { pid = pid, t = issuedAt }
  redis.call('SET', userKey, cjson.encode(updatedUser), 'PX', userPx)
end

return cjson.encode(evicted)
`;

/**
 * CHECK_USER_QUOTA_SCRIPT — counts live promotion-mode entries for a
 * userId using the same live-entry semantics as STORE_SCRIPT, so the
 * precheck and the authoritative store-time quota agree on which
 * entries count when reading the same Redis snapshot. Concurrent
 * stores between precheck and `store()` remain possible —
 * STORE_SCRIPT is the only authoritative gate, this script is a
 * best-effort guard before slot/RPC resources are consumed.
 *
 * Live condition (matches STORE_SCRIPT's `liveUser` build):
 *   - `item.t + ttlMs >= nowMs`  (logical TTL not exceeded), AND
 *   - `EXISTS prefix .. item.pid` (entry key still present).
 *
 * Entries whose physical key survives the logical TTL inside the
 * `PREPARE_STORE_KEY_TTL_GRACE_MS` window MUST NOT count toward the
 * quota, otherwise the precheck false-rejects new prepares that
 * STORE_SCRIPT would accept.
 *
 * Cost: returns as soon as `live >= maxPerStudioUser`. Logically
 * expired and missing-entry-key items do not advance `live`, so the
 * worst case (e.g. the entire index is stale) still iterates the full
 * user-index list.
 *
 * KEYS[1] = user key (caller resolves the empty-userKey case in TS)
 * ARGV[1] = prefix, ARGV[2] = ttlMs, ARGV[3] = maxPerStudioUser
 * Returns: integer live count (capped at maxPerStudioUser when exceeded).
 */
const CHECK_USER_QUOTA_SCRIPT = `
local userKey = KEYS[1]
local prefix = ARGV[1]
local ttlMs = tonumber(ARGV[2])
local maxPerStudioUser = tonumber(ARGV[3])

local userRaw = redis.call('GET', userKey)
if not userRaw then return 0 end

local userList = cjson.decode(userRaw)
local timeResult = redis.call('TIME')
local nowMs = tonumber(timeResult[1]) * 1000 + math.floor(tonumber(timeResult[2]) / 1000)

local live = 0
for _, item in ipairs(userList) do
  if item.t and (item.t + ttlMs < nowMs) then
    -- Logical TTL expired — drop even if physical key still exists
  elseif redis.call('EXISTS', prefix .. item.pid) == 1 then
    live = live + 1
    if live >= maxPerStudioUser then
      return live
    end
  end
end

return live
`;

// CONSUME_SCRIPT is defined at the bottom of the file as CONSUME_SCRIPT_WITH_IP
// because it needs to extract clientIp from the entry JSON to build the ip key.

// ─────────────────────────────────────────────
// Serialization helpers
// ─────────────────────────────────────────────

/**
 * BigInt fields present in the base of every PreparedTxEntry (all modes).
 * Only `nonce` lives in `PreparedTxEntryBase`; mode-specific BigInt fields
 * (currently `reservedGasMist` on promotion) are projected separately.
 */
const BASE_BIGINT_FIELDS = ['nonce'] as const;

/**
 * BigInt field only present in `PromotionPreparedTxEntry`.
 * The ExecutionLedger reservation ceiling written at prepare time and
 * compared against actual execution gas in the Studio sponsor SponsoredExecutionPolicy
 * sponsor result accounting.
 */
const PROMOTION_BIGINT_FIELD = 'reservedGasMist' as const;

/**
 * JSON-safe representation of PreparedTxEntry.
 * BigInt fields are stored as decimal strings.
 *
 * Single canonical entry shape:
 *   Generic:   coordination-only fields + `txBytesHash`. Sponsor reads
 *              every settle value from `parseSettleArgs(txBytes)`; the
 *              entry holds no settle observability copies.
 *   Promotion: coordination fields + `reservedGasMist` BigInt.
 */
type SerializedEntry = {
  _v?: number;
  mode: string;
  // Base fields always present
  nonce: string;
  receiptId: string;
  issuedAt: number;
  senderAddress: string;
  txBytesHash: string;
  slotId: string;
  sponsorAddress: string;
  clientIp: string;
  executionPathKey: string;
  orderId: string | null;
  // Promotion-mode fields (present iff mode === 'promotion')
  reservedGasMist?: string;
  promotionId?: string;
  userId?: string;
};

/**
 * Schema version for serialized PreparedTxEntry.
 *
 * Writer + reader contract:
 *   - Writer stamps `ENTRY_SCHEMA_VERSION` on every entry.
 *   - Reader accepts exactly `ENTRY_SCHEMA_VERSION`. Any other `_v`
 *     (including missing or non-numeric) is rejected at the version
 *     gate and routed through the fail-closed corrupt-entry path:
 *     `RedisPrepareEntryVersionError` → `_releaseSlotFromRawEntry`
 *     releases the slot via `extractSlotInfoFromRawEntry` →
 *     `evictPreparedEntry` deletes the entry → sponsor returns
 *     `PREPARED_TX_NOT_FOUND`. User retries `/prepare`. The slot is
 *     never stranded.
 *   - Past-shape entries at any earlier `_v` are NOT read by this
 *     reader; `deserializeEntry` projects only the current schema
 *     fields into the typed runtime object, so a mismatched shape
 *     cannot smuggle unknown fields into the entry.
 *
 * Two-stage HMAC lease proof. The sponsor pool stores
 * `HMAC(secret, receiptId || slotId || commitDigest)` in its lease
 * key — `commitDigest` is a reserved sentinel at `checkout()` and the
 * prepare-commit hash (`txBytesHash`) after `sponsorPool.commit()`.
 * `onRelease(slotId, receiptId, txBytesHash | null)` is the canonical
 * release path.
 */
const ENTRY_SCHEMA_VERSION = 1;
const DECIMAL_BIGINT_RE = /^(?:0|[1-9]\d*)$/;

export class RedisPrepareEntryVersionError extends Error {
  constructor(public readonly receivedVersion: unknown) {
    super(
      `RedisPrepareStore: refusing to deserialize entry with unsupported schema version ${String(
        receivedVersion,
      )} (current=${ENTRY_SCHEMA_VERSION})`,
    );
    this.name = 'RedisPrepareEntryVersionError';
  }
}

function parseSerializedBigInt(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !DECIMAL_BIGINT_RE.test(value)) {
    throw new Error(`RedisPrepareStore: ${field} must be a decimal bigint string`);
  }
  return BigInt(value);
}

function parseRedisBigIntResult(value: unknown, field: string): bigint {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`RedisPrepareStore: ${field} must be a non-negative safe integer`);
    }
    return BigInt(value);
  }
  return parseSerializedBigInt(value, field);
}

/**
 * Validate a Lua integer return value (e.g. a quota count) from
 * `_client.eval()`. node-redis (v4, v5) and ioredis both return Lua
 * integers as JS `number` today, so the `number` branch is the only
 * one observed in current production wiring. The `bigint` and numeric
 * `string` branches keep callers from coupling to one client's
 * Lua-result encoding.
 *
 * Throws on anything else (null, NaN, fractional, negative, non-numeric
 * string). The precheck path interprets the parsed value against the
 * quota threshold, so silently coercing garbage to `0` would mask a
 * malformed Lua result as 'ok' and let store() be reached on bad state.
 */
function parseRedisIntegerResult(value: unknown, field: string): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`RedisPrepareStore: ${field} must be a non-negative safe integer`);
    }
    return value;
  }
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        `RedisPrepareStore: ${field} bigint must fit in non-negative safe-integer range`,
      );
    }
    return Number(value);
  }
  if (typeof value === 'string' && DECIMAL_BIGINT_RE.test(value)) {
    const n = Number(value);
    if (!Number.isSafeInteger(n)) {
      throw new Error(`RedisPrepareStore: ${field} must be a non-negative safe integer`);
    }
    return n;
  }
  throw new Error(
    `RedisPrepareStore: ${field} must be a non-negative integer Lua result (got ${typeof value})`,
  );
}

function serializeEntry(entry: PreparedTxEntry): string {
  const obj: Record<string, unknown> = { ...entry };
  obj._v = ENTRY_SCHEMA_VERSION;
  // Base BigInt fields (all modes)
  for (const field of BASE_BIGINT_FIELDS) {
    obj[field] = String(entry[field]);
  }
  if (entry.mode === 'promotion') {
    // Promotion-only BigInt field
    obj[PROMOTION_BIGINT_FIELD] = String(entry[PROMOTION_BIGINT_FIELD]);
  }
  // Generic entries carry no extra BigInt fields beyond the base; the
  // sponsor path re-derives every settle observability value from
  // `parseSettleArgs(txBytes)` and the serializer intentionally emits
  // nothing beyond the coordination shape.
  return JSON.stringify(obj);
}

/**
 * Best-effort recovery of slot identity from a raw JSON entry that we
 * cannot fully deserialize.
 *
 * This is the slot-cleanup safety net. Even if `deserializeEntry()` throws
 * (unsupported schema version, corrupted BigInt strings, mode-discriminator
 * inconsistency, etc.), the consume()/peek() callers must still be able to
 * release the held sponsor slot — otherwise an unparseable entry can lock
 * a slot until its lease TTL expires.
 *
 * Extracts `{slotId, receiptId, txBytesHash}`.
 * `txBytesHash` is returned as a string when present on the raw JSON and
 * as `null` when absent. Callers pass the
 * returned `txBytesHash` straight into `checkin()`; the pool's HMAC CAS
 * will silently no-op for stale values and the Redis lease PX TTL
 * covers the residual state.
 *
 * Returns null only if neither `slotId` nor `receiptId` can be extracted
 * from the raw shape. JSON-level parse failure also yields null.
 */
function extractSlotInfoFromRawEntry(
  json: string,
): { slotId: string; receiptId: string; txBytesHash: string | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const slotId = obj.slotId;
  const receiptId = obj.receiptId;
  if (typeof slotId !== 'string' || typeof receiptId !== 'string') return null;
  if (slotId.length === 0 || receiptId.length === 0) return null;
  const txBytesHash = typeof obj.txBytesHash === 'string' ? obj.txBytesHash : null;
  return { slotId, receiptId, txBytesHash };
}

function deserializeEntry(json: string): PreparedTxEntry {
  const obj = JSON.parse(json) as SerializedEntry;

  // Version gate: accept only `ENTRY_SCHEMA_VERSION`. Any other `_v`
  // (missing, wrong number, non-numeric) fails closed through the
  // corrupt-entry path.
  if (typeof obj._v !== 'number' || obj._v !== ENTRY_SCHEMA_VERSION) {
    throw new RedisPrepareEntryVersionError(obj._v);
  }

  // Strict current-shape projection. Do not spread the parsed object —
  // only the fields named by the current schema enter the typed runtime
  // entry. Anything else on the JSON is ignored.
  if (obj.mode === 'generic') {
    return {
      mode: 'generic',
      nonce: parseSerializedBigInt(obj.nonce, 'nonce'),
      receiptId: obj.receiptId,
      issuedAt: obj.issuedAt,
      senderAddress: obj.senderAddress,
      txBytesHash: obj.txBytesHash,
      slotId: obj.slotId,
      sponsorAddress: obj.sponsorAddress,
      clientIp: obj.clientIp,
      executionPathKey: obj.executionPathKey,
      orderId: obj.orderId,
    };
  }

  return {
    mode: 'promotion',
    nonce: parseSerializedBigInt(obj.nonce, 'nonce'),
    reservedGasMist: parseSerializedBigInt(obj.reservedGasMist, 'reservedGasMist'),
    receiptId: obj.receiptId,
    issuedAt: obj.issuedAt,
    senderAddress: obj.senderAddress,
    txBytesHash: obj.txBytesHash,
    slotId: obj.slotId,
    sponsorAddress: obj.sponsorAddress,
    clientIp: obj.clientIp,
    executionPathKey: obj.executionPathKey,
    orderId: obj.orderId,
    promotionId: obj.promotionId!,
    userId: obj.userId!,
  };
}

// ─────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────

export interface RedisPrepareStoreOptions {
  keyPrefix?: string;
  ttlMs?: number;
  maxPerIp?: number;
  maxPerStudioUser?: number;
  maxOutstandingPerSender?: number;
  /** Optional `Clock` for the JS-side `peek()` TTL read. Defaults to `systemClock`. */
  clock?: Clock;
}

// ─────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────

/**
 * Redis-backed PrepareStoreAdapter for horizontal scaling.
 *
 * Uses Lua scripts via `eval` for atomic operations.
 * Does NOT require ZSET or other commands beyond `RedisClientLike`.
 */
export class RedisPrepareStore implements PrepareStoreAdapter {
  private readonly _client: RedisClientLike;
  private readonly _onRelease: OnReleaseCallback;
  private readonly _onEntryEvict?: OnEntryEvictCallback;
  private readonly _keyPrefix: string;
  private readonly _ttlMs: number;
  private readonly _maxPerIp: number;
  private readonly _maxPerStudioUser: number;
  private readonly _maxOutstandingPerSender: number;
  private readonly _clock: Clock;

  /**
   * @param onRelease Two-stage lease signature:
   *                  `(slotId, receiptId, txBytesHash) =>
   *                     sponsorPool.checkin(slotId, receiptId, txBytesHash)`.
   *                  Store release paths always pass the committed
   *                  `txBytesHash` from the deserialized entry (or
   *                  whatever the raw-entry extractor can recover),
   *                  which is the prepare commit the lease was
   *                  promoted to via `sponsorPool.commit()`. The
   *                  corrupt-entry safety net may pass `null` if the
   *                  raw JSON has no recoverable `txBytesHash`; the
   *                  pool's CAS then silently no-ops and the Redis
   *                  lease PX TTL covers residual state.
   */
  constructor(
    client: RedisClientLike,
    onRelease: OnReleaseCallback,
    options: RedisPrepareStoreOptions = {},
    onEntryEvict?: OnEntryEvictCallback,
  ) {
    const ttlMs = options.ttlMs ?? PREPARE_TTL_MS;
    const maxPerIp = options.maxPerIp ?? MAX_CONCURRENT_PER_IP;
    const maxPerStudioUser = options.maxPerStudioUser ?? MAX_OUTSTANDING_PER_STUDIO_USER;
    const maxOutstandingPerSender =
      options.maxOutstandingPerSender ?? MAX_OUTSTANDING_PER_SENDER;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error('RedisPrepareStore: ttlMs must be > 0 and a safe integer');
    }
    if (ttlMs > Math.floor(Number.MAX_SAFE_INTEGER / PREPARE_STORE_INDEX_TTL_MULTIPLIER)) {
      throw new Error('RedisPrepareStore: ttlMs overflows derived TTL range');
    }
    if (!Number.isSafeInteger(maxPerIp) || maxPerIp < 1) {
      throw new Error('RedisPrepareStore: maxPerIp must be >= 1 and a safe integer');
    }
    if (!Number.isSafeInteger(maxPerStudioUser) || maxPerStudioUser < 1) {
      throw new Error('RedisPrepareStore: maxPerStudioUser must be >= 1 and a safe integer');
    }
    if (!Number.isSafeInteger(maxOutstandingPerSender) || maxOutstandingPerSender < 1) {
      throw new Error(
        'RedisPrepareStore: maxOutstandingPerSender must be >= 1 and a safe integer',
      );
    }

    this._client = client;
    this._onRelease = onRelease;
    this._onEntryEvict = onEntryEvict;
    this._keyPrefix = options.keyPrefix ?? 'stelis:prepare:';
    this._ttlMs = ttlMs;
    this._maxPerIp = maxPerIp;
    this._maxPerStudioUser = maxPerStudioUser;
    this._maxOutstandingPerSender = maxOutstandingPerSender;
    this._clock = options.clock ?? systemClock;
  }

  // ── Key helpers ──────────────────────────────────────────────────

  private entryKey(receiptId: string): string {
    return `${this._keyPrefix}${receiptId}`;
  }

  private ipKey(clientIp: string): string {
    return `${this._keyPrefix}ip:${clientIp}`;
  }

  private senderKey(senderAddress: string): string {
    return `${this._keyPrefix}sender:${senderAddress}`;
  }

  private userKey(userId: string): string {
    return `${this._keyPrefix}user:${userId}`;
  }

  // ── PrepareStoreAdapter methods ──────────────────────────────────

  async store(receiptId: string, entry: PreparedTxEntry): Promise<void> {
    const entryJson = serializeEntry(entry);
    const entryPxMs = this._ttlMs + PREPARE_STORE_KEY_TTL_GRACE_MS;
    const ipPxMs = this._ttlMs * PREPARE_STORE_INDEX_TTL_MULTIPLIER;
    const senderPxMs = this._ttlMs * PREPARE_STORE_INDEX_TTL_MULTIPLIER;
    const userPxMs = this._ttlMs * PREPARE_STORE_INDEX_TTL_MULTIPLIER;
    // Empty userKey for non-promotion entries — Lua skips the user-index
    // branches when userKey == ''. The KEYS array length stays uniform so
    // cluster-mode hash-slot routing is consistent regardless of mode.
    const userKey = entry.mode === 'promotion' ? this.userKey(entry.userId) : '';

    const result = await this._client.eval(
      STORE_SCRIPT,
      [
        this.entryKey(receiptId),
        this.ipKey(entry.clientIp),
        this.senderKey(entry.senderAddress),
        userKey,
      ],
      [
        entryJson,
        String(entryPxMs),
        receiptId,
        entry.slotId,
        String(entry.issuedAt),
        String(this._maxPerIp),
        String(ipPxMs),
        this._keyPrefix,
        String(this._maxPerStudioUser),
        String(senderPxMs),
        entry.nonce.toString(),
        entry.mode,
        String(this._ttlMs),
        String(userPxMs),
      ],
    );

    // User quota exceeded — slot NOT released here (outer catch owns cleanup).
    const evictedRaw = result as string;
    if (evictedRaw === '__user_quota__') {
      // Promotion-only path; userId is present.
      const userId = entry.mode === 'promotion' ? entry.userId : entry.senderAddress;
      throw new PrepareStudioUserQuotaError(userId, this._maxPerStudioUser);
    }

    // Release slots for IP-evicted entries
    // Note: Lua cjson.encode({}) returns '{}' (empty object), not '[]' (empty array).
    if (evictedRaw && evictedRaw !== '[]' && evictedRaw !== '{}') {
      const parsed = JSON.parse(evictedRaw);
      const evicted = Array.isArray(parsed)
        ? (parsed as Array<{ pid: string; slotId: string; entryJson?: string }>)
        : [];
      for (const item of evicted) {
        // Slot release — best effort, independent of coordinator cleanup.
        // `item.pid` is the evicted entry's receiptId. We also need the
        // committed `txBytesHash` to satisfy the pool's CAS.
        // The evictedEntry JSON carries it, so parse once and pass.
        let evictedTxBytesHash: string | null = null;
        let evictedEntry: PreparedTxEntry | null = null;
        if (item.entryJson) {
          try {
            evictedEntry = deserializeEntry(item.entryJson);
            evictedTxBytesHash = evictedEntry.txBytesHash;
          } catch {
            // Fall back to raw-JSON extraction — the corrupt-entry path
            // cannot rely on the full deserializer.
            const raw = extractSlotInfoFromRawEntry(item.entryJson);
            evictedTxBytesHash = raw?.txBytesHash ?? null;
          }
        }
        void invokeReleaseCallback({
          onRelease: this._onRelease,
          slotId: item.slotId,
          receiptId: item.pid,
          txBytesHash: evictedTxBytesHash,
          adapter: 'redis-prepare',
          reason: 'ip_concurrent_eviction',
          extraFields: { evicted_receipt_id: item.pid },
        });

        // Coordinator cleanup — runs independently of slot release outcome.
        if (this._onEntryEvict && evictedEntry) {
          invokeEvictCallback({
            onEntryEvict: this._onEntryEvict,
            entry: evictedEntry,
            adapter: 'redis-prepare',
            reason: 'ip_concurrent_eviction',
          });
        }
      }
    }
  }

  /**
   * Best-effort slot release for entries we cannot fully deserialize.
   * Used by consume() and peek() to keep slot cleanup safe even when
   * `deserializeEntry()` throws (corrupted JSON, version mismatch, etc.).
   *
   * The Lua CONSUME script has already removed the entry from Redis at
   * this point, so without this fallback the held sponsor slot would
   * remain locked until its lease TTL expires.
   */
  private _releaseSlotFromRawEntry(
    rawJson: string,
    reason:
      | 'prepare_expired_undeserializable'
      | 'hash_mismatch_undeserializable'
      | 'consume_success_undeserializable'
      | 'undeserializable_eviction',
  ): void {
    const slot = extractSlotInfoFromRawEntry(rawJson);
    if (!slot) {
      // Cannot find slot identity — slot will only be reclaimed by lease TTL.
      // This is semantically distinct from a _LEASE_RELEASE_FAILED event:
      // there was no release attempt to succeed or fail. Keep it on a
      // separate structured event so operators can correlate with
      // lease-TTL reclamation without conflating failure families.
      logSponsorPoolEvent(
        SPONSOR_POOL_SLOT_INFO_UNRECOVERABLE,
        {
          adapter: 'redis-prepare',
          reason,
        },
        'warn',
      );
      return;
    }
    void invokeReleaseCallback({
      onRelease: this._onRelease,
      slotId: slot.slotId,
      receiptId: slot.receiptId,
      txBytesHash: slot.txBytesHash,
      adapter: 'redis-prepare',
      reason,
    });
  }

  async consume(
    receiptId: string,
    txBytesHash: string,
  ): Promise<PreparedTxEntry | 'not_found' | 'expired' | 'hash_mismatch'> {
    const entryKey = this.entryKey(receiptId);
    // We need the clientIp to build the ip key, but we don't have it.
    // The Lua script finds it from the entry JSON.
    // However, KEYS must be known at call time. We read the entry first
    // to get clientIp... but that breaks atomicity.
    //
    // Alternative: store clientIp in a secondary key or derive ip key
    // from entry. Since CONSUME needs the ip key but we don't have
    // clientIp at call time, we use a two-step approach:
    //   1. Lua GETs the entry, extracts clientIp, builds ip key internally
    //
    // BUT: Redis Cluster requires all keys to be passed in KEYS[].
    // For single-node Redis (our target), accessing dynamic keys in Lua is OK.
    // We pass a placeholder KEYS[2] and let Lua compute the real ip key.

    const result = await this._client.eval(
      CONSUME_SCRIPT_WITH_IP,
      [entryKey],
      [txBytesHash, String(this._ttlMs), receiptId, this._keyPrefix],
    );

    if (result === null || result === undefined) {
      return 'not_found';
    }

    const str = result as string;

    if (str.startsWith('__expired_entry__:')) {
      const entryJson = str.slice('__expired_entry__:'.length);
      // Slot cleanup must happen even if deserializeEntry throws.
      try {
        const expiredEntry = deserializeEntry(entryJson);
        void invokeReleaseCallback({
          onRelease: this._onRelease,
          slotId: expiredEntry.slotId,
          receiptId: expiredEntry.receiptId,
          txBytesHash: expiredEntry.txBytesHash,
          adapter: 'redis-prepare',
          reason: 'prepare_expired',
        });
        if (this._onEntryEvict) {
          invokeEvictCallback({
            onEntryEvict: this._onEntryEvict,
            entry: expiredEntry,
            adapter: 'redis-prepare',
            reason: 'prepare_expired',
          });
        }
      } catch {
        this._releaseSlotFromRawEntry(entryJson, 'prepare_expired_undeserializable');
      }
      return 'expired';
    }

    if (str.startsWith('__hash_mismatch_entry__:')) {
      const entryJson = str.slice('__hash_mismatch_entry__:'.length);
      try {
        const mismatchEntry = deserializeEntry(entryJson);
        void invokeReleaseCallback({
          onRelease: this._onRelease,
          slotId: mismatchEntry.slotId,
          receiptId: mismatchEntry.receiptId,
          txBytesHash: mismatchEntry.txBytesHash,
          adapter: 'redis-prepare',
          reason: 'hash_mismatch',
        });
        if (this._onEntryEvict) {
          invokeEvictCallback({
            onEntryEvict: this._onEntryEvict,
            entry: mismatchEntry,
            adapter: 'redis-prepare',
            reason: 'hash_mismatch',
          });
        }
      } catch {
        this._releaseSlotFromRawEntry(entryJson, 'hash_mismatch_undeserializable');
      }
      return 'hash_mismatch';
    }

    // Success branch: Lua already removed the entry, so the slot is owned
    // by the sponsor caller. If deserialization fails here, the
    // slot would be orphaned — release it best-effort and re-throw so the
    // caller still reports the error.
    try {
      return deserializeEntry(str);
    } catch (err) {
      this._releaseSlotFromRawEntry(str, 'consume_success_undeserializable');
      throw err;
    }
  }

  async peek(receiptId: string): Promise<PreparedTxEntry | null> {
    const raw = await this._client.get(this.entryKey(receiptId));
    if (!raw) return null;
    // Deserialization failure must propagate so sponsor processing can
    // release the held slot via evictPreparedEntry(). Silently returning
    // null would route control to a generic "not found" early-return that
    // never touches the slot.
    const entry = deserializeEntry(raw);
    // Logical TTL check (same as Lua)
    if (this._clock.nowMs() - entry.issuedAt > this._ttlMs) return null;
    return entry;
  }

  /**
   * Best-effort invalidation of a stored prepared entry.
   *
   * Reads the raw JSON, pulls slot identity directly without going through
   * `deserializeEntry()`, releases the slot, and atomically removes the
   * entry from Redis. Idempotent and never throws. Covers both corrupt-
   * entry eviction (deserialize failure on peek/consume) and post-`peek`
   * sponsor result rejection invalidation; see the interface docstring.
   */
  async evictPreparedEntry(receiptId: string): Promise<void> {
    const entryKey = this.entryKey(receiptId);
    let raw: string | null = null;
    try {
      raw = await this._client.get(entryKey);
    } catch {
      // Read failure on the failure path is already final.
      return;
    }
    if (!raw) return;

    // Try to recover slot identity from the raw shape. If the JSON itself
    // is unparseable we still attempt the DELETE so the entry stops
    // occupying the receiptId slot.
    this._releaseSlotFromRawEntry(raw, 'undeserializable_eviction');

    try {
      await this._client.del(entryKey);
    } catch {
      // Tolerate DEL failure — the entry will reach physical TTL anyway.
    }
  }

  /**
   * Pre-check Studio user quota before slot checkout (best-effort).
   *
   * Delegates to `CHECK_USER_QUOTA_SCRIPT` so the precheck applies the
   * same live-entry semantics as the authoritative `STORE_SCRIPT`
   * quota check: logical TTL (`item.t + ttlMs`) gates live counting,
   * and physical entry-key existence inside the
   * `PREPARE_STORE_KEY_TTL_GRACE_MS` window alone does NOT keep an
   * entry live. Without the Lua's `redis.call('TIME')` baseline, the
   * precheck could false-reject under conditions where store() would
   * accept.
   *
   * Generic `/relay/prepare` has no analogous precheck because no
   * pre-verified identity exists there; only promotion entries
   * populate the user index.
   */
  async checkUserQuota(userId: string): Promise<'ok' | { exceeded: true; limit: number }> {
    const result = await this._client.eval(
      CHECK_USER_QUOTA_SCRIPT,
      [this.userKey(userId)],
      [this._keyPrefix, String(this._ttlMs), String(this._maxPerStudioUser)],
    );
    const live = parseRedisIntegerResult(result, 'checkUserQuota live count');
    return live >= this._maxPerStudioUser
      ? { exceeded: true, limit: this._maxPerStudioUser }
      : 'ok';
  }

  /**
   * S-14: Reserve the next monotonic nonce for a sender.
   *
   * Derives max nonce from sender-local metadata (live entries + pending reservations)
   * in one atomic Lua operation. No standalone HWM key.
   */
  async reserveNonce(
    senderAddress: string,
    onchainLastNonce: bigint,
    reservationId: string,
  ): Promise<bigint> {
    const script = `
      local function normalizeDec(raw)
        if raw == nil or raw == false then return '0' end
        local s = tostring(raw)
        if s == '' then return '0' end
        local trimmed = string.gsub(s, '^0+', '')
        if trimmed == '' then return '0' end
        if not string.match(trimmed, '^%d+$') then
          error('invalid decimal string: ' .. s)
        end
        return trimmed
      end

      local function compareDecStrings(a, b)
        local na = normalizeDec(a)
        local nb = normalizeDec(b)
        if string.len(na) < string.len(nb) then return -1 end
        if string.len(na) > string.len(nb) then return 1 end
        if na < nb then return -1 end
        if na > nb then return 1 end
        return 0
      end

      local function maxDecStrings(a, b)
        if compareDecStrings(a, b) >= 0 then
          return normalizeDec(a)
        end
        return normalizeDec(b)
      end

      local function addOneDecString(raw)
        local s = normalizeDec(raw)
        local out = {}
        local carry = 1
        for i = string.len(s), 1, -1 do
          local digit = string.byte(s, i) - 48 + carry
          if digit >= 10 then
            digit = digit - 10
            carry = 1
          else
            carry = 0
          end
          out[i] = string.char(48 + digit)
        end
        if carry == 1 then
          table.insert(out, 1, '1')
        end
        return table.concat(out)
      end

      local senderKey = KEYS[1]
      local onchain = ARGV[1]
      local resId = ARGV[2]
      local senderPx = tonumber(ARGV[3])
      local prefix = ARGV[4]
      local ttlMs = tonumber(ARGV[5])
      local maxOutstandingPerSender = tonumber(ARGV[6])

      local timeResult = redis.call('TIME')
      local nowMs = tonumber(timeResult[1]) * 1000 + math.floor(tonumber(timeResult[2]) / 1000)

      -- Compact sender-local metadata: keep pending + logically-live entries only.
      -- Logical TTL (issuedAt + ttlMs) takes precedence over physical key existence.
      local senderMax = '0'
      local senderRaw = redis.call('GET', senderKey)
      local compacted = {}
      if senderRaw then
        local senderList = cjson.decode(senderRaw)
        for _, item in ipairs(senderList) do
          if item.pending then
            compacted[#compacted + 1] = item
            if item.nonce ~= nil then
              senderMax = maxDecStrings(senderMax, item.nonce)
            end
          elseif item.t and (item.t + ttlMs < nowMs) then
            -- Logical TTL expired — drop even if physical key still exists
          elseif item.pid and redis.call('EXISTS', prefix .. item.pid) == 1 then
            compacted[#compacted + 1] = item
            if item.nonce ~= nil then
              senderMax = maxDecStrings(senderMax, item.nonce)
            end
          end
        end
      end

      if #compacted >= maxOutstandingPerSender then
        return '__sender_quota__'
      end

      local base = maxDecStrings(onchain, senderMax)
      local nextNonce = addOneDecString(base)

      -- Add pending reservation to sender-local metadata
      compacted[#compacted + 1] = { pid = resId, nonce = nextNonce, pending = true }
      redis.call('SET', senderKey, cjson.encode(compacted), 'PX', senderPx)

      return nextNonce
    `;
    const senderPxMs = this._ttlMs * PREPARE_STORE_INDEX_TTL_MULTIPLIER;
    const result = (await this._client.eval(
      script,
      [this.senderKey(senderAddress)],
      [
        onchainLastNonce.toString(),
        reservationId,
        String(senderPxMs),
        this._keyPrefix,
        String(this._ttlMs),
        String(this._maxOutstandingPerSender),
      ],
    )) as string;
    if (result === '__sender_quota__') {
      throw new PrepareSenderQuotaError(senderAddress, this._maxOutstandingPerSender);
    }
    return parseRedisBigIntResult(result, 'reserved nonce');
  }

  /**
   * Release a pending nonce reservation from sender-local metadata.
   * Called on pre-store failure path.
   *
   * Removes only pending reservations whose `pid` matches `resId`. Live
   * entries (no `pending` flag) MUST be preserved even when their `pid`
   * matches, because `store()` promotes a pending reservation to a live
   * entry under the same receiptId. The runner's `store()` →
   * `transferOwnership()` boundary normally prevents this method from
   * being called after promotion, but the contract still keeps Memory
   * and Redis aligned: pre-store failure cleans up pending; post-store
   * is a no-op for that receiptId's live entry.
   */
  async releaseReservation(reservationId: string, senderAddress: string): Promise<void> {
    const script = `
      local senderKey = KEYS[1]
      local resId = ARGV[1]
      local senderPx = tonumber(ARGV[2])

      local senderRaw = redis.call('GET', senderKey)
      if not senderRaw then return 0 end

      local senderList = cjson.decode(senderRaw)
      local updated = {}
      for _, item in ipairs(senderList) do
        -- Drop the matching pending reservation only. A live entry with
        -- the same pid (post-store promotion) is preserved.
        if not (item.pending and item.pid == resId) then
          updated[#updated + 1] = item
        end
      end

      if #updated == 0 then
        redis.call('DEL', senderKey)
      else
        redis.call('SET', senderKey, cjson.encode(updated), 'PX', senderPx)
      end
      return 1
    `;
    const senderPxMs = this._ttlMs * PREPARE_STORE_INDEX_TTL_MULTIPLIER;
    await this._client.eval(
      script,
      [this.senderKey(senderAddress)],
      [reservationId, String(senderPxMs)],
    );
  }
}

// ─────────────────────────────────────────────
// CONSUME variant that extracts clientIp from entry
// ─────────────────────────────────────────────

/**
 * CONSUME_SCRIPT_WITH_IP — variant that reads clientIp from the entry JSON
 * to build the ip key dynamically. Single-node Redis only.
 *
 * KEYS[1] = entry key
 * ARGV[1] = expected txBytesHash, ARGV[2] = ttlMs, ARGV[3] = receiptId, ARGV[4] = prefix
 */
const CONSUME_SCRIPT_WITH_IP = `
local entryKey = KEYS[1]
local expectedHash = ARGV[1]
local ttlMs = tonumber(ARGV[2])
local pid = ARGV[3]
local prefix = ARGV[4]

local raw = redis.call('GET', entryKey)
if not raw then return nil end

local entry = cjson.decode(raw)
local ipKey = prefix .. 'ip:' .. entry.clientIp

local timeResult = redis.call('TIME')
local nowMs = tonumber(timeResult[1]) * 1000 + math.floor(tonumber(timeResult[2]) / 1000)

local function removeFromIp()
  local ipRaw = redis.call('GET', ipKey)
  if not ipRaw then return end
  local list = cjson.decode(ipRaw)
  local updated = {}
  for _, item in ipairs(list) do
    if item.pid ~= pid then
      updated[#updated + 1] = item
    end
  end
  if #updated > 0 then
    redis.call('SET', ipKey, cjson.encode(updated), 'KEEPTTL')
  else
    redis.call('DEL', ipKey)
  end
end

local function removeFromSender()
  if not entry.senderAddress then return end
  local senderKey = prefix .. 'sender:' .. entry.senderAddress
  local senderRaw = redis.call('GET', senderKey)
  if not senderRaw then return end
  local list = cjson.decode(senderRaw)
  local updated = {}
  for _, item in ipairs(list) do
    if item.pid ~= pid then
      updated[#updated + 1] = item
    end
  end
  if #updated > 0 then
    redis.call('SET', senderKey, cjson.encode(updated), 'KEEPTTL')
  else
    redis.call('DEL', senderKey)
  end
end

if entry.issuedAt + ttlMs < nowMs then
  redis.call('DEL', entryKey)
  removeFromIp()
  removeFromSender()
  return '__expired_entry__:' .. raw
end

if entry.txBytesHash ~= expectedHash then
  redis.call('DEL', entryKey)
  removeFromIp()
  removeFromSender()
  return '__hash_mismatch_entry__:' .. raw
end

redis.call('DEL', entryKey)
removeFromIp()
removeFromSender()
return raw
`;
