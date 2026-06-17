/**
 * AppConfigContext bootstrap tests — validates the /relay/config
 * fetch path: success, error, and invalid-network paths.
 *
 * Uses source-level validation (no React rendering needed — existing
 * app-web tests use this pattern). Tests verify the contract between
 * AppConfigContext and the /relay/config API.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ctxSrc = fs.readFileSync(path.resolve(__dirname, '../src/AppConfigContext.tsx'), 'utf-8');

describe('AppConfigContext bootstrap contract', () => {
  it('fetches from RELAYER_BASE/config', () => {
    expect(ctxSrc).toContain('`${RELAYER_BASE}/config`');
  });

  it('validates network against testnet and mainnet only', () => {
    expect(ctxSrc).toContain("'testnet'");
    expect(ctxSrc).toContain("'mainnet'");
    expect(ctxSrc).toContain('isValidNetwork');
  });

  it('does NOT reference VITE_NETWORK', () => {
    expect(ctxSrc).not.toContain('VITE_NETWORK');
    expect(ctxSrc).not.toContain('import.meta.env');
  });

  it('exposes loading state', () => {
    expect(ctxSrc).toContain('loading: true');
    expect(ctxSrc).toContain('loading: false');
  });

  it('exposes error state on fetch failure', () => {
    expect(ctxSrc).toContain('.catch(');
    expect(ctxSrc).toContain('error:');
  });

  it('uses 10s timeout for resilience', () => {
    expect(ctxSrc).toContain('AbortSignal.timeout(10_000)');
  });

  it('imports from relayerEndpoint, not runtimeEnv', () => {
    expect(ctxSrc).toContain("from './relayerEndpoint'");
    expect(ctxSrc).not.toContain("from './runtimeEnv'");
  });
});

describe('runtimeEnv must not export APP_WEB_NETWORK', () => {
  const runtimeSrc = fs.readFileSync(path.resolve(__dirname, '../src/runtimeEnv.ts'), 'utf-8');

  it('does NOT export APP_WEB_NETWORK', () => {
    expect(runtimeSrc).not.toContain('APP_WEB_NETWORK');
  });

  it('does NOT reference VITE_NETWORK', () => {
    expect(runtimeSrc).not.toContain('VITE_NETWORK');
  });

  it('still exports APP_WEB_SUI_RPC_URL and APP_WEB_RELAYER_BASE', () => {
    expect(runtimeSrc).toContain('export const APP_WEB_SUI_RPC_URL');
    expect(runtimeSrc).toContain('export const APP_WEB_RELAYER_BASE');
  });
});

describe('NetworkBadge uses AppConfigContext, not independent fetch', () => {
  const badgeSrc = fs.readFileSync(
    path.resolve(__dirname, '../src/components/NetworkBadge.tsx'),
    'utf-8',
  );

  it('imports useAppConfig', () => {
    expect(badgeSrc).toContain('useAppConfig');
  });

  it('does NOT fetch /relay/config independently', () => {
    expect(badgeSrc).not.toContain('fetch(');
    expect(badgeSrc).not.toContain('RELAYER_BASE');
  });
});

describe('useSDK singleton dedup', () => {
  const sdkSrc = fs.readFileSync(
    path.resolve(__dirname, '../src/pages/sandbox/hooks/useSDK.ts'),
    'utf-8',
  );

  it('has module-level sdkCache for dedup', () => {
    expect(sdkSrc).toContain('sdkCache');
  });

  it('reuses existing promise from cache', () => {
    expect(sdkSrc).toContain('sdkCache.get(');
    expect(sdkSrc).toContain('sdkCache.set(');
  });

  it('clears cache entry on failure (allows retry)', () => {
    expect(sdkSrc).toContain('sdkCache.delete(');
  });
});

describe('ConfigGate is narrow (not app-wide)', () => {
  const appSrc = fs.readFileSync(path.resolve(__dirname, '../src/App.tsx'), 'utf-8');

  it('wraps Sandbox with ConfigGate', () => {
    expect(appSrc).toMatch(/<ConfigGate>\s*<Sandbox/);
  });

  it('wraps Promotion with ConfigGate', () => {
    expect(appSrc).toMatch(/<ConfigGate>\s*<Promotion/);
  });

  it('does NOT wrap Home with ConfigGate', () => {
    expect(appSrc).not.toMatch(/<ConfigGate>\s*<Home/);
  });

  it('does NOT wrap Docs with ConfigGate', () => {
    expect(appSrc).not.toMatch(/<ConfigGate>\s*<Docs/);
  });

  it('does NOT wrap Playground with ConfigGate', () => {
    expect(appSrc).not.toMatch(/<ConfigGate>\s*<Playground/);
  });

  it('does NOT wrap Status with ConfigGate', () => {
    expect(appSrc).not.toMatch(/<ConfigGate>\s*<Status/);
  });
});
