/**
 * Sui RPC multi-endpoint module tests.
 *
 * Tests validate:
 *   - URL parser: single, multi, empty, invalid, empty segment, trailing comma
 *   - Failover transport: read failover, write no-retry, non-retryable propagation,
 *     all-exhausted, cooldown recovery, streaming primary delegate
 *   - Client factory: single URL standard path, multi URL failover path
 */
import { describe, it, expect, vi } from 'vitest';
import { writeFileSync, unlinkSync } from 'node:fs';
import { SuiRpcFailoverTransport } from '../src/sui/failoverTransport.js';
import { UnaryCall } from '@protobuf-ts/runtime-rpc';
import type { MethodInfo, RpcOptions, RpcMetadata, RpcStatus } from '@protobuf-ts/runtime-rpc';
import { parseEndpointConfigJson, loadRpcConfig } from '../src/sui/parseEndpointConfig.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Create a minimal MethodInfo for testing. */
function makeMethod(name: string): MethodInfo<object, object> {
  return {
    name,
    localName: name,
    I: {} as never,
    O: {} as never,
    service: { typeName: 'test', methods: [], options: {} },
  } as unknown as MethodInfo<object, object>;
}

/** Create a successful UnaryCall. */
function makeSuccessCall<I extends object, O extends object>(
  method: MethodInfo<I, O>,
  input: I,
  response: O,
): UnaryCall<I, O> {
  const headers: RpcMetadata = {};
  const status: RpcStatus = { code: 'OK', detail: '' };
  const trailers: RpcMetadata = {};
  return new UnaryCall(
    method,
    {},
    input,
    Promise.resolve(headers),
    Promise.resolve(response),
    Promise.resolve(status),
    Promise.resolve(trailers),
  );
}

/** Create a failing UnaryCall that rejects with the given error. */
function makeFailCall<I extends object, O extends object>(
  method: MethodInfo<I, O>,
  input: I,
  error: Error,
): UnaryCall<I, O> {
  // Each promise must be a separate instance to avoid shared-rejection warnings.
  const mkReject = () => {
    const p = Promise.reject(error);
    p.catch(() => {}); // prevent unhandled rejection
    return p;
  };
  return new UnaryCall(method, {}, input, mkReject(), mkReject(), mkReject(), mkReject());
}

// ── loadRpcConfig ───────────────────────────────────────────────────────────

describe('loadRpcConfig', () => {
  it('loads endpoints from a JSON file', () => {
    const path = '/tmp/test-rpc-load.json';
    writeFileSync(path, '[{"url":"https://a.com"},{"url":"https://b.com"}]');
    try {
      const result = loadRpcConfig(path);
      expect(result).toEqual([{ url: 'https://a.com' }, { url: 'https://b.com' }]);
    } finally {
      unlinkSync(path);
    }
  });

  it('throws on missing file with guidance', () => {
    expect(() => loadRpcConfig('/tmp/nonexistent-rpc.json')).toThrow('rpc.json.example');
  });

  it('resolves auth.valueEnv from env lookup', () => {
    const path = '/tmp/test-rpc-auth.json';
    writeFileSync(
      path,
      '[{"url":"https://a.com","auth":{"header":"x-token","valueEnv":"TEST_TOK"}}]',
    );
    try {
      const result = loadRpcConfig(path, (name) => (name === 'TEST_TOK' ? 'secret' : undefined));
      expect(result[0].meta).toEqual({ 'x-token': 'secret' });
    } finally {
      unlinkSync(path);
    }
  });

  it('throws rpc.json error (not env error) on malformed JSON', () => {
    const path = '/tmp/test-rpc-malformed.json';
    writeFileSync(path, '{bad json');
    try {
      expect(() => loadRpcConfig(path)).toThrow('rpc.json');
    } finally {
      unlinkSync(path);
    }
  });

  it('throws rpc.json error on empty array', () => {
    const path = '/tmp/test-rpc-empty.json';
    writeFileSync(path, '[]');
    try {
      expect(() => loadRpcConfig(path)).toThrow('at least one endpoint');
    } finally {
      unlinkSync(path);
    }
  });

  it('throws rpc.json error on non-array JSON', () => {
    const path = '/tmp/test-rpc-nonarray.json';
    writeFileSync(path, '{"url":"https://a.com"}');
    try {
      expect(() => loadRpcConfig(path)).toThrow('JSON array');
    } finally {
      unlinkSync(path);
    }
  });
});

// ── SuiRpcFailoverTransport ─────────────────────────────────────────────────

/**
 * Suppress unhandled rejection on all UnaryCall promises.
 * In tests, we often only await `call.response` — the other 3 promises
 * (headers, status, trailers) would otherwise cause unhandled rejection noise.
 */
function suppressCallRejections(call: UnaryCall<object, object>): void {
  call.headers.catch(() => {});
  call.status.catch(() => {});
  call.trailers.catch(() => {});
}

/** Access internal endpoints for mocking in tests. */
interface InternalEndpoint {
  transport: { unary: ReturnType<typeof vi.fn>; serverStreaming?: ReturnType<typeof vi.fn> };
  url: string;
  cooldownUntil: number;
}

function getEndpoints(transport: SuiRpcFailoverTransport): InternalEndpoint[] {
  return (transport as unknown as { _endpoints: InternalEndpoint[] })._endpoints;
}

describe('SuiRpcFailoverTransport', () => {
  const READ_METHOD = makeMethod('GetObject');
  const WRITE_METHOD = makeMethod('ExecuteTransaction');
  const INPUT = {};
  const RESPONSE_A = { from: 'a' };
  const RESPONSE_B = { from: 'b' };

  it('throws on empty URL list', () => {
    expect(() => new SuiRpcFailoverTransport([] as { url: string }[])).toThrow(
      'at least one endpoint required',
    );
  });

  // ── Read failover ──────────────────────────────────────────────

  it('read: returns response from first healthy endpoint', async () => {
    const transport = new SuiRpcFailoverTransport(
      [{ url: 'https://a.com' }, { url: 'https://b.com' }],
      { onFailover: vi.fn() },
    );
    const eps = getEndpoints(transport);
    eps[0].transport.unary = vi
      .fn()
      .mockReturnValue(makeSuccessCall(READ_METHOD, INPUT, RESPONSE_A));
    eps[1].transport.unary = vi
      .fn()
      .mockReturnValue(makeSuccessCall(READ_METHOD, INPUT, RESPONSE_B));

    const call = transport.unary(READ_METHOD, INPUT, { meta: {} } as RpcOptions);
    const response = await call.response;
    expect(response).toEqual(RESPONSE_A);
    expect(eps[1].transport.unary).not.toHaveBeenCalled();
  });

  it('read: retryable error marks endpoint for cooldown, next call uses different endpoint', async () => {
    const onFailover = vi.fn();
    const transport = new SuiRpcFailoverTransport(
      [{ url: 'https://a.com' }, { url: 'https://b.com' }],
      { onFailover, cooldownMs: 30_000 },
    );
    const eps = getEndpoints(transport);
    const unavailableErr = Object.assign(new Error('unavailable'), { code: 'UNAVAILABLE' });
    eps[0].transport.unary = vi
      .fn()
      .mockReturnValue(makeFailCall(READ_METHOD, INPUT, unavailableErr));
    eps[1].transport.unary = vi
      .fn()
      .mockReturnValue(makeSuccessCall(READ_METHOD, INPUT, RESPONSE_B));

    // First call: goes to a.com, fails (retryable), marks cooldown
    const call1 = transport.unary(READ_METHOD, INPUT, { meta: {} } as RpcOptions);
    suppressCallRejections(call1);
    await expect(call1.response).rejects.toThrow('unavailable');

    // Second call: a.com is in cooldown, goes to b.com
    const call2 = transport.unary(READ_METHOD, INPUT, { meta: {} } as RpcOptions);
    const response2 = await call2.response;
    expect(response2).toEqual(RESPONSE_B);
  });

  it('read: does NOT failover on non-retryable application error', async () => {
    const transport = new SuiRpcFailoverTransport(
      [{ url: 'https://a.com' }, { url: 'https://b.com' }],
      { onFailover: vi.fn() },
    );
    const eps = getEndpoints(transport);
    const appErr = new Error('Move abort: insufficient funds');
    eps[0].transport.unary = vi.fn().mockReturnValue(makeFailCall(READ_METHOD, INPUT, appErr));
    eps[1].transport.unary = vi.fn();

    const call = transport.unary(READ_METHOD, INPUT, { meta: {} } as RpcOptions);
    suppressCallRejections(call);
    await expect(call.response).rejects.toThrow('Move abort');
    expect(eps[1].transport.unary).not.toHaveBeenCalled();
  });

  it('read: all endpoints in cooldown → still tries one (last resort)', async () => {
    const transport = new SuiRpcFailoverTransport(
      [{ url: 'https://a.com' }, { url: 'https://b.com' }],
      { cooldownMs: 30_000, onFailover: vi.fn() },
    );
    const eps = getEndpoints(transport);

    // Put both endpoints in cooldown
    eps[0].cooldownUntil = Date.now() + 30_000;
    eps[1].cooldownUntil = Date.now() + 30_000;

    // Even in cooldown, transport still selects one as last resort
    eps[0].transport.unary = vi
      .fn()
      .mockReturnValue(makeSuccessCall(READ_METHOD, INPUT, RESPONSE_A));
    eps[1].transport.unary = vi
      .fn()
      .mockReturnValue(makeSuccessCall(READ_METHOD, INPUT, RESPONSE_B));

    const call = transport.unary(READ_METHOD, INPUT, { meta: {} } as RpcOptions);
    const response = await call.response;
    expect(response).toBeDefined();
  });

  // ── Write no-retry ─────────────────────────────────────────────

  it('write: ExecuteTransaction uses primary only, no retry', async () => {
    const transport = new SuiRpcFailoverTransport(
      [{ url: 'https://a.com' }, { url: 'https://b.com' }],
      { onFailover: vi.fn() },
    );
    const eps = getEndpoints(transport);
    const writeErr = Object.assign(new Error('unavailable'), { code: 'UNAVAILABLE' });
    eps[0].transport.unary = vi.fn().mockReturnValue(makeFailCall(WRITE_METHOD, INPUT, writeErr));
    eps[1].transport.unary = vi.fn();

    const call = transport.unary(WRITE_METHOD, INPUT, { meta: {} } as RpcOptions);
    suppressCallRejections(call);
    await expect(call.response).rejects.toThrow('unavailable');
    expect(eps[1].transport.unary).not.toHaveBeenCalled();
  });

  // ── Cooldown recovery ──────────────────────────────────────────

  it('read: cooldown endpoint recovers after window', async () => {
    const transport = new SuiRpcFailoverTransport(
      [{ url: 'https://a.com' }, { url: 'https://b.com' }],
      { cooldownMs: 50, onFailover: vi.fn() },
    );
    const eps = getEndpoints(transport);

    // Put a in cooldown manually
    eps[0].cooldownUntil = Date.now() + 50;
    eps[0].transport.unary = vi
      .fn()
      .mockReturnValue(makeSuccessCall(READ_METHOD, INPUT, RESPONSE_A));
    eps[1].transport.unary = vi
      .fn()
      .mockReturnValue(makeSuccessCall(READ_METHOD, INPUT, RESPONSE_B));

    // Call while a is in cooldown → should use b
    const call1 = transport.unary(READ_METHOD, INPUT, { meta: {} } as RpcOptions);
    const resp1 = await call1.response;
    expect(resp1).toEqual(RESPONSE_B);

    // Wait for cooldown to expire
    await new Promise((r) => setTimeout(r, 60));

    // Now a should be back in rotation
    const ep0Unary = vi.fn().mockReturnValue(makeSuccessCall(READ_METHOD, INPUT, RESPONSE_A));
    eps[0].transport.unary = ep0Unary;

    const call2 = transport.unary(READ_METHOD, INPUT, { meta: {} } as RpcOptions);
    const resp2 = await call2.response;
    expect(resp2).toEqual(RESPONSE_A);
    expect(ep0Unary).toHaveBeenCalled();
  });

  // ── Streaming ──────────────────────────────────────────────────

  it('serverStreaming delegates to primary transport', () => {
    const transport = new SuiRpcFailoverTransport([
      { url: 'https://a.com' },
      { url: 'https://b.com' },
    ]);
    const eps = getEndpoints(transport);

    const mockStreamCall = { fake: true };
    eps[0].transport.serverStreaming = vi.fn().mockReturnValue(mockStreamCall);

    const result = transport.serverStreaming(READ_METHOD, INPUT, { meta: {} } as RpcOptions);
    expect(result).toBe(mockStreamCall);
    expect(eps[0].transport.serverStreaming).toHaveBeenCalled();
  });

  it('serverStreaming applies primary endpoint meta', () => {
    const transport = new SuiRpcFailoverTransport([
      { url: 'https://a.com', meta: { 'x-token': 'secret' } },
      { url: 'https://b.com' },
    ]);
    const eps = getEndpoints(transport);

    const mockStreamCall = { fake: true };
    eps[0].transport.serverStreaming = vi.fn().mockReturnValue(mockStreamCall);

    transport.serverStreaming(READ_METHOD, INPUT, { meta: { 'x-other': 'val' } } as RpcOptions);
    // Verify primary meta was merged into call options
    const calledOptions = (eps[0].transport.serverStreaming as ReturnType<typeof vi.fn>).mock
      .calls[0][2] as RpcOptions;
    expect(calledOptions.meta).toEqual({ 'x-token': 'secret', 'x-other': 'val' });
  });
});

// ── createSuiClient ─────────────────────────────────────────────────────────

describe('createSuiClient', () => {
  // These are integration-level smoke tests — the factory itself is a thin wrapper.
  // Deep transport behavior is tested above.

  it('single URL creates SuiGrpcClient with failover transport (no fast path)', async () => {
    const { createSuiClient } = await import('../src/sui/createSuiClient.js');
    const result = createSuiClient({
      network: 'testnet',
      endpoints: [{ url: 'https://fullnode.testnet.sui.io:443' }],
    });
    expect(result.client).toBeDefined();
    expect(typeof result.client.getObject).toBe('function');
    // Even single endpoint always uses failover transport (no fast path)
    expect(result.failoverTransport).toBeInstanceOf(SuiRpcFailoverTransport);
    expect(result.failoverTransport.size).toBe(1);
  });

  it('multi URL creates SuiGrpcClient with failover transport', async () => {
    const { createSuiClient } = await import('../src/sui/createSuiClient.js');
    const result = createSuiClient({
      network: 'testnet',
      endpoints: [{ url: 'https://a.com' }, { url: 'https://b.com' }],
    });
    expect(result.client).toBeDefined();
    expect(result.failoverTransport).toBeInstanceOf(SuiRpcFailoverTransport);
    expect(result.failoverTransport!.size).toBe(2);
  });

  it('single URL with auth meta uses failover transport', async () => {
    const { createSuiClient } = await import('../src/sui/createSuiClient.js');
    const result = createSuiClient({
      network: 'testnet',
      endpoints: [{ url: 'https://a.com', meta: { 'x-token': 'secret' } }],
    });
    expect(result.failoverTransport).toBeInstanceOf(SuiRpcFailoverTransport);
  });
});

// ── parseEndpointConfigJson ─────────────────────────────────────────────────

describe('parseEndpointConfigJson', () => {
  it('parses plain endpoint array', () => {
    const result = parseEndpointConfigJson('[{"url":"https://a.com"},{"url":"https://b.com"}]');
    expect(result).toEqual([{ url: 'https://a.com' }, { url: 'https://b.com' }]);
  });

  it('resolves auth env indirection', () => {
    const result = parseEndpointConfigJson(
      '[{"url":"https://a.com","auth":{"header":"x-token","valueEnv":"MY_TOKEN"}}]',
      (name) => (name === 'MY_TOKEN' ? 'secret123' : undefined),
    );
    expect(result).toEqual([{ url: 'https://a.com', meta: { 'x-token': 'secret123' } }]);
  });

  it('resolves auth with prefix', () => {
    const result = parseEndpointConfigJson(
      '[{"url":"https://a.com","auth":{"header":"Authorization","valueEnv":"MY_TOKEN","prefix":"Bearer "}}]',
      (name) => (name === 'MY_TOKEN' ? 'abc' : undefined),
    );
    expect(result[0].meta).toEqual({ Authorization: 'Bearer abc' });
  });

  it('merges static meta with auth meta', () => {
    const result = parseEndpointConfigJson(
      '[{"url":"https://a.com","meta":{"x-custom":"val"},"auth":{"header":"x-token","valueEnv":"T"}}]',
      (name) => (name === 'T' ? 'tok' : undefined),
    );
    expect(result[0].meta).toEqual({ 'x-custom': 'val', 'x-token': 'tok' });
  });

  it('throws on missing auth env', () => {
    expect(() =>
      parseEndpointConfigJson(
        '[{"url":"https://a.com","auth":{"header":"x-token","valueEnv":"MISSING"}}]',
        () => undefined,
      ),
    ).toThrow('MISSING');
  });

  it('throws on non-string auth.prefix', () => {
    expect(() =>
      parseEndpointConfigJson(
        '[{"url":"https://a.com","auth":{"header":"x-token","valueEnv":"T","prefix":123}}]',
        (name) => (name === 'T' ? 'tok' : undefined),
      ),
    ).toThrow('auth.prefix');
  });

  it('throws on empty JSON', () => {
    expect(() => parseEndpointConfigJson('')).toThrow('must not be empty');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseEndpointConfigJson('{bad')).toThrow('not valid JSON');
  });

  it('throws on non-array JSON', () => {
    expect(() => parseEndpointConfigJson('{"url":"https://a.com"}')).toThrow('JSON array');
  });

  it('throws on empty array', () => {
    expect(() => parseEndpointConfigJson('[]')).toThrow('at least one endpoint');
  });

  it('throws on missing url', () => {
    expect(() => parseEndpointConfigJson('[{}]')).toThrow('url');
  });

  it('throws on URL with embedded credentials in JSON config', () => {
    expect(() => parseEndpointConfigJson('[{"url":"https://user:secret@provider.com"}]')).toThrow(
      'embedded credentials',
    );
  });

  it('throws on null array element', () => {
    expect(() => parseEndpointConfigJson('[null]')).toThrow('must be a non-null object');
  });

  it('throws on primitive array element', () => {
    expect(() => parseEndpointConfigJson('[42]')).toThrow('must be a non-null object');
  });

  it('throws on string array element', () => {
    expect(() => parseEndpointConfigJson('["https://a.com"]')).toThrow('must be a non-null object');
  });

  it('throws on non-string meta value', () => {
    expect(() => parseEndpointConfigJson('[{"url":"https://a.com","meta":{"x-num":42}}]')).toThrow(
      'meta["x-num"]',
    );
  });

  it('throws on fetchInit with headers (forbidden)', () => {
    expect(() =>
      parseEndpointConfigJson('[{"url":"https://a.com","fetchInit":{"headers":{"x":"y"}}}]'),
    ).toThrow('fetchInit.headers');
  });

  it('throws on fetchInit with body (forbidden)', () => {
    expect(() =>
      parseEndpointConfigJson('[{"url":"https://a.com","fetchInit":{"body":"data"}}]'),
    ).toThrow('fetchInit.body');
  });

  it('accepts valid fetchInit (credentials)', () => {
    const result = parseEndpointConfigJson(
      '[{"url":"https://a.com","fetchInit":{"credentials":"include"}}]',
    );
    expect(result[0].fetchInit).toEqual({ credentials: 'include' });
  });
});
