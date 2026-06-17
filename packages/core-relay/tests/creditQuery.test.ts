import { describe, it, expect, vi } from 'vitest';
import { queryUserCredit, CreditQueryInconsistentStateError } from '../src/creditQuery.js';
import { bcs } from '@mysten/sui/bcs';

// ─────────────────────────────────────────────
// Mock helpers
// ─────────────────────────────────────────────

const ADDR = '0x' + 'aa'.repeat(32);
const VAULT_ID = '0x' + 'bb'.repeat(32);
const TABLE_ID = '0x' + 'cc'.repeat(32);
const REGISTRY_ID = '0x' + 'dd'.repeat(32);

function makeMockClient(
  overrides: {
    getDynamicField?: ReturnType<typeof vi.fn>;
    getObject?: ReturnType<typeof vi.fn>;
  } = {},
) {
  return {
    getObject: overrides.getObject ?? vi.fn(),
    getDynamicField: overrides.getDynamicField ?? vi.fn(),
    getBalance: vi.fn(),
  } as never;
}

function vaultDynamicFieldResult(vaultId: string) {
  return {
    dynamicField: {
      value: {
        bcs: bcs.Address.serialize(vaultId).toBytes(),
      },
    },
  };
}

function vaultObjectResult(credit: string, lastNonce: string) {
  return {
    object: {
      json: { credit, last_nonce: lastNonce },
    },
  };
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe('queryUserCredit', () => {
  // ── Happy path: no vault registered ─────────────────────────────────────

  it('returns needsCreate=true when no dynamic field entry exists', async () => {
    const client = makeMockClient({
      getDynamicField: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('not found'), { code: 'dynamicFieldNotFound' })),
    });

    const result = await queryUserCredit(client, REGISTRY_ID, ADDR, TABLE_ID);
    expect(result).toEqual({
      vaultObjectId: null,
      credit: '0',
      needsCreate: true,
      lastNonce: '0',
    });
  });

  // ── Fail-closed: getDynamicField returns objectNotFound (parent table missing) ──

  it('throws on getDynamicField objectNotFound (does not misclassify as needsCreate)', async () => {
    const client = makeMockClient({
      getDynamicField: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('Object not found'), { code: 'objectNotFound' }),
        ),
    });

    // objectNotFound on getDynamicField with no ID in the message means the
    // parent table is missing/stale. Must throw, not return needsCreate: true.
    await expect(queryUserCredit(client, REGISTRY_ID, ADDR, TABLE_ID)).rejects.toThrow(
      'Object not found',
    );
  });

  // ── gRPC client behavior: child-object id ≠ tableId → no entry ───────────

  it('returns needsCreate=true when getDynamicField throws "Object <childId> not found" (gRPC derived child)', async () => {
    // `@mysten/sui/grpc` resolves getDynamicField by deriving the child-object
    // ID deterministically and calling getObjects(childId). When the entry
    // does not exist, it throws a plain Error("Object <derivedChildId> not found").
    // The childId differs from tableId → semantically the dynamic field entry
    // does not exist (user has no vault).
    const DERIVED_CHILD_ID = '0x' + 'ee'.repeat(32);
    const client = makeMockClient({
      getDynamicField: vi.fn().mockRejectedValue(new Error(`Object ${DERIVED_CHILD_ID} not found`)),
    });

    const result = await queryUserCredit(client, REGISTRY_ID, ADDR, TABLE_ID);
    expect(result).toEqual({
      vaultObjectId: null,
      credit: '0',
      needsCreate: true,
      lastNonce: '0',
    });
  });

  it('throws when getDynamicField throws "Object <tableId> not found" (parent table missing)', async () => {
    const client = makeMockClient({
      getDynamicField: vi.fn().mockRejectedValue(new Error(`Object ${TABLE_ID} not found`)),
    });

    // Missing ID matches the parent tableId → parent is gone, fail-closed.
    await expect(queryUserCredit(client, REGISTRY_ID, ADDR, TABLE_ID)).rejects.toThrow(
      `Object ${TABLE_ID} not found`,
    );
  });

  // ── Happy path: vault exists with credit ────────────────────────────────

  it('returns vault data when vault exists with credit and nonce', async () => {
    const client = makeMockClient({
      getDynamicField: vi.fn().mockResolvedValue(vaultDynamicFieldResult(VAULT_ID)),
      getObject: vi.fn().mockResolvedValue(vaultObjectResult('5000000', '42')),
    });

    const result = await queryUserCredit(client, REGISTRY_ID, ADDR, TABLE_ID);
    expect(result).toEqual({
      vaultObjectId: VAULT_ID,
      credit: '5000000',
      needsCreate: false,
      lastNonce: '42',
    });
  });

  // ── Fail-closed: registry entry exists but vault object missing ─────────

  it('throws CreditQueryInconsistentStateError when vault registered but object not found', async () => {
    const client = makeMockClient({
      getDynamicField: vi.fn().mockResolvedValue(vaultDynamicFieldResult(VAULT_ID)),
      getObject: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('Object not found'), { code: 'objectNotFound' }),
        ),
    });

    await expect(queryUserCredit(client, REGISTRY_ID, ADDR, TABLE_ID)).rejects.toThrow(
      CreditQueryInconsistentStateError,
    );

    try {
      await queryUserCredit(client, REGISTRY_ID, ADDR, TABLE_ID);
    } catch (err) {
      expect(err).toBeInstanceOf(CreditQueryInconsistentStateError);
      const e = err as CreditQueryInconsistentStateError;
      expect(e.vaultId).toBe(VAULT_ID);
      expect(e.userAddress).toBe(ADDR);
      expect(e.message).toContain('new_user path is invalid');
    }
  });

  // ── Fail-closed: vault exists but JSON content missing ──────────────────

  it('throws CreditQueryInconsistentStateError when vault object has no JSON content', async () => {
    const client = makeMockClient({
      getDynamicField: vi.fn().mockResolvedValue(vaultDynamicFieldResult(VAULT_ID)),
      getObject: vi.fn().mockResolvedValue({ object: {} }),
    });

    await expect(queryUserCredit(client, REGISTRY_ID, ADDR, TABLE_ID)).rejects.toThrow(
      CreditQueryInconsistentStateError,
    );
  });

  // ── Fail-closed: vault exists but required field 'credit' missing ───────

  it('throws CreditQueryInconsistentStateError when credit field is missing', async () => {
    const client = makeMockClient({
      getDynamicField: vi.fn().mockResolvedValue(vaultDynamicFieldResult(VAULT_ID)),
      getObject: vi.fn().mockResolvedValue({
        object: { json: { last_nonce: '10' } },
      }),
    });

    await expect(queryUserCredit(client, REGISTRY_ID, ADDR, TABLE_ID)).rejects.toThrow(
      CreditQueryInconsistentStateError,
    );

    try {
      await queryUserCredit(client, REGISTRY_ID, ADDR, TABLE_ID);
    } catch (err) {
      expect(err).toBeInstanceOf(CreditQueryInconsistentStateError);
      expect((err as CreditQueryInconsistentStateError).message).toContain("'credit'");
    }
  });

  // ── Fail-closed: vault exists but required field 'last_nonce' missing ───

  it('throws CreditQueryInconsistentStateError when last_nonce field is missing', async () => {
    const client = makeMockClient({
      getDynamicField: vi.fn().mockResolvedValue(vaultDynamicFieldResult(VAULT_ID)),
      getObject: vi.fn().mockResolvedValue({
        object: { json: { credit: '100' } },
      }),
    });

    await expect(queryUserCredit(client, REGISTRY_ID, ADDR, TABLE_ID)).rejects.toThrow(
      CreditQueryInconsistentStateError,
    );

    try {
      await queryUserCredit(client, REGISTRY_ID, ADDR, TABLE_ID);
    } catch (err) {
      expect(err).toBeInstanceOf(CreditQueryInconsistentStateError);
      expect((err as CreditQueryInconsistentStateError).message).toContain("'last_nonce'");
    }
  });

  it('throws CreditQueryInconsistentStateError when numeric vault fields are not decimal strings', async () => {
    const client = makeMockClient({
      getDynamicField: vi.fn().mockResolvedValue(vaultDynamicFieldResult(VAULT_ID)),
      getObject: vi.fn().mockResolvedValue(vaultObjectResult('0x10', '1')),
    });

    await expect(queryUserCredit(client, REGISTRY_ID, ADDR, TABLE_ID)).rejects.toThrow(
      CreditQueryInconsistentStateError,
    );
    await expect(queryUserCredit(client, REGISTRY_ID, ADDR, TABLE_ID)).rejects.toThrow(
      "invalid decimal field 'credit'",
    );
  });

  // ── Non-infra errors propagate unchanged ────────────────────────────────

  it('propagates non-object-not-found RPC errors unchanged', async () => {
    const client = makeMockClient({
      getDynamicField: vi.fn().mockResolvedValue(vaultDynamicFieldResult(VAULT_ID)),
      getObject: vi.fn().mockRejectedValue(new Error('RPC timeout')),
    });

    await expect(queryUserCredit(client, REGISTRY_ID, ADDR, TABLE_ID)).rejects.toThrow(
      'RPC timeout',
    );
  });

  // ── Vault with nested fields structure ──────────────────────────────────

  it('reads credit from nested fields structure', async () => {
    const client = makeMockClient({
      getDynamicField: vi.fn().mockResolvedValue(vaultDynamicFieldResult(VAULT_ID)),
      getObject: vi.fn().mockResolvedValue({
        object: { json: { fields: { credit: '999', last_nonce: '7' } } },
      }),
    });

    const result = await queryUserCredit(client, REGISTRY_ID, ADDR, TABLE_ID);
    expect(result.credit).toBe('999');
    expect(result.lastNonce).toBe('7');
  });
});
