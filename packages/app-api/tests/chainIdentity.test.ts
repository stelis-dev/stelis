/**
 * Boot-time chain identity validation tests.
 *
 * Mocks SuiGrpcClient to control getChainIdentifier responses.
 * Separate file to avoid mock conflicts with transport tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetChainIdentifier = vi.fn();

vi.mock('@mysten/sui/grpc', () => ({
  SuiGrpcClient: vi.fn(function SuiGrpcClient() {
    return {
      core: { getChainIdentifier: mockGetChainIdentifier },
    };
  }),
}));

vi.mock('@protobuf-ts/grpcweb-transport', () => ({
  GrpcWebFetchTransport: vi.fn(),
}));

import { validateChainIdentity } from '../src/sui/validateChainIdentity.js';

const TESTNET_CHAIN_ID = '69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD';

describe('validateChainIdentity', () => {
  beforeEach(() => {
    mockGetChainIdentifier.mockReset();
  });

  it('passes when all endpoints return the correct testnet chainId', async () => {
    mockGetChainIdentifier.mockResolvedValue({ chainIdentifier: TESTNET_CHAIN_ID });

    const result = await validateChainIdentity('testnet', [
      { url: 'https://a.com' },
      { url: 'https://b.com' },
    ]);
    expect(result.chainIdentifier).toBe(TESTNET_CHAIN_ID);
    expect(result.endpointResults).toHaveLength(2);
  });

  it('throws on chainId mismatch between endpoints', async () => {
    let call = 0;
    mockGetChainIdentifier.mockImplementation(() => {
      call++;
      return Promise.resolve({
        chainIdentifier: call === 1 ? TESTNET_CHAIN_ID : 'WRONG',
      });
    });

    await expect(
      validateChainIdentity('testnet', [{ url: 'https://a.com' }, { url: 'https://b.com' }]),
    ).rejects.toThrow('mismatch');
  });

  it('throws when chainId does not match expected network', async () => {
    mockGetChainIdentifier.mockResolvedValue({ chainIdentifier: 'NOT_TESTNET' });

    await expect(validateChainIdentity('testnet', [{ url: 'https://a.com' }])).rejects.toThrow(
      'does not match',
    );
  });

  it('throws when all endpoints fail', async () => {
    mockGetChainIdentifier.mockRejectedValue(new Error('connection refused'));

    await expect(validateChainIdentity('testnet', [{ url: 'https://a.com' }])).rejects.toThrow(
      'no endpoint responded',
    );
  });

  it('passes with warning when some endpoints fail but rest agree', async () => {
    let call = 0;
    mockGetChainIdentifier.mockImplementation(() => {
      call++;
      if (call === 1) return Promise.reject(new Error('down'));
      return Promise.resolve({ chainIdentifier: TESTNET_CHAIN_ID });
    });

    const result = await validateChainIdentity('testnet', [
      { url: 'https://down.com' },
      { url: 'https://ok.com' },
    ]);
    expect(result.chainIdentifier).toBe(TESTNET_CHAIN_ID);
    expect(result.endpointResults[0].error).toBeTruthy();
    expect(result.endpointResults[1].error).toBeNull();
  });
});
