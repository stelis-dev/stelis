/**
 * RPC endpoint config parser — parses JSON array of endpoint descriptors.
 *
 * Used by `loadRpcConfig()` to parse `packages/app-api/rpc.json`.
 *
 * Security model:
 *   - Secret token values are NOT stored in the JSON file — only env var names
 *   - `auth.valueEnv` references a separate ENV var holding the actual secret
 *   - Missing referenced ENV is a boot-time error (fail-fast, no synthetic fallback)
 *   - Resolved secrets are injected into `meta` (RpcMetadata) for grpc-web headers
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import type { RpcMetadata } from '@protobuf-ts/runtime-rpc';
import type { SuiRpcEndpointConfig } from './failoverTransport.js';

// ─────────────────────────────────────────────
// Raw config types (before env resolution)
// ─────────────────────────────────────────────

/**
 * Auth config for an authenticated endpoint.
 * Secret value is resolved from `process.env[valueEnv]` at boot time.
 */
export interface SuiRpcEndpointAuthConfig {
  /** HTTP header name to carry the auth token (e.g. "x-token", "Authorization"). */
  header: string;
  /** ENV variable name holding the secret token value. */
  valueEnv: string;
  /** Optional prefix prepended to the token value (e.g. "Bearer "). */
  prefix?: string;
}

/** Raw endpoint descriptor from rpc.json (before env resolution). */
export interface SuiRpcEndpointRawConfig {
  url: string;
  auth?: SuiRpcEndpointAuthConfig;
  /** Non-secret static headers. */
  meta?: RpcMetadata;
  fetchInit?: Omit<RequestInit, 'body' | 'headers' | 'method' | 'signal'>;
}

// ─────────────────────────────────────────────
// Parser
// ─────────────────────────────────────────────

/**
 * Parse rpc.json content into resolved endpoint configs.
 *
 * @param json     Raw JSON string (rpc.json file content)
 * @param envLookup  Function to resolve env vars (default: process.env lookup).
 *                   Injected for testability.
 * @returns        Non-empty array of resolved endpoint configs
 * @throws         Error on invalid JSON, missing fields, or missing env vars
 */
export function parseEndpointConfigJson(
  json: string,
  envLookup: (name: string) => string | undefined = (name) => process.env[name],
): SuiRpcEndpointConfig[] {
  const trimmed = json.trim();
  if (trimmed === '') {
    throw new Error('rpc.json content must not be empty');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `rpc.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!Array.isArray(raw)) {
    throw new Error('rpc.json must contain a JSON array');
  }
  if (raw.length === 0) {
    throw new Error('rpc.json must contain at least one endpoint');
  }

  const results: SuiRpcEndpointConfig[] = [];

  for (let i = 0; i < raw.length; i++) {
    const pos = `endpoint[${i}]`;

    // Each element must be a non-null object
    if (raw[i] == null || typeof raw[i] !== 'object' || Array.isArray(raw[i])) {
      throw new Error(
        `${pos}: must be a non-null object, got ${raw[i] === null ? 'null' : typeof raw[i]}`,
      );
    }
    const entry = raw[i] as Record<string, unknown>;

    // Validate url
    if (typeof entry.url !== 'string' || entry.url.trim() === '') {
      throw new Error(`${pos}: "url" must be a non-empty string`);
    }
    const url = entry.url.trim();
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error(`Unsupported protocol: ${parsed.protocol}`);
      }
      if (parsed.username || parsed.password) {
        throw new Error(
          'URL contains embedded credentials (user:pass@host). Use auth.valueEnv instead.',
        );
      }
    } catch (err) {
      throw new Error(
        `${pos}: invalid URL "${url}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Resolve meta — start with static meta if provided
    // RpcMetadata values must be string or string[] per protobuf-ts spec.
    const resolvedMeta: RpcMetadata = {};
    if (entry.meta != null) {
      if (typeof entry.meta !== 'object' || Array.isArray(entry.meta)) {
        throw new Error(`${pos}: "meta" must be an object`);
      }
      const metaObj = entry.meta as Record<string, unknown>;
      for (const [key, val] of Object.entries(metaObj)) {
        if (typeof val === 'string') {
          resolvedMeta[key] = val;
        } else if (Array.isArray(val) && val.every((v): v is string => typeof v === 'string')) {
          resolvedMeta[key] = val;
        } else {
          throw new Error(`${pos}: meta["${key}"] must be a string or string[]; got ${typeof val}`);
        }
      }
    }

    // Resolve auth → inject into meta
    if (entry.auth != null) {
      if (typeof entry.auth !== 'object' || Array.isArray(entry.auth)) {
        throw new Error(`${pos}: "auth" must be an object`);
      }
      const auth = entry.auth as Record<string, unknown>;
      if (typeof auth.header !== 'string' || auth.header.trim() === '') {
        throw new Error(`${pos}: "auth.header" must be a non-empty string`);
      }
      if (typeof auth.valueEnv !== 'string' || auth.valueEnv.trim() === '') {
        throw new Error(`${pos}: "auth.valueEnv" must be a non-empty string`);
      }

      if (auth.prefix !== undefined && typeof auth.prefix !== 'string') {
        throw new Error(
          `${pos}: "auth.prefix" must be a string when provided, got ${typeof auth.prefix}`,
        );
      }

      const headerName = auth.header.trim();
      const envName = auth.valueEnv.trim();
      const prefix = typeof auth.prefix === 'string' ? auth.prefix : '';

      const secretValue = envLookup(envName);
      if (secretValue == null || secretValue === '') {
        throw new Error(
          `${pos}: auth.valueEnv "${envName}" is not set or empty. ` +
            `Authenticated endpoints require the referenced ENV variable to contain the secret token.`,
        );
      }

      resolvedMeta[headerName] = `${prefix}${secretValue}`;
    }

    // Validate fetchInit — it must not carry custom headers or transport-owned fields.
    let fetchInit: SuiRpcEndpointConfig['fetchInit'];
    if (entry.fetchInit != null) {
      if (typeof entry.fetchInit !== 'object' || Array.isArray(entry.fetchInit)) {
        throw new Error(`${pos}: "fetchInit" must be an object`);
      }
      const fi = entry.fetchInit as Record<string, unknown>;
      // Reject forbidden fields that GrpcWebFetchTransport excludes
      for (const forbidden of ['body', 'headers', 'method', 'signal']) {
        if (forbidden in fi) {
          throw new Error(
            `${pos}: "fetchInit.${forbidden}" is forbidden — ` +
              (forbidden === 'headers'
                ? 'use "meta" or "auth" for custom headers'
                : `"${forbidden}" is managed by the transport`),
          );
        }
      }
      fetchInit = fi as SuiRpcEndpointConfig['fetchInit'];
    }

    results.push({
      url,
      meta: Object.keys(resolvedMeta).length > 0 ? resolvedMeta : undefined,
      fetchInit,
    });
  }

  return results;
}

/**
 * Load RPC endpoint config from packages/app-api/rpc.json.
 *
 * This parser defines the app-api RPC fleet configuration format.
 * Auth secrets are resolved from env vars referenced by auth.valueEnv.
 *
 * @param filePath   Override file path for testing. Default: package-local rpc.json.
 * @param envLookup  Function to resolve env vars (default: process.env lookup).
 * @returns          Non-empty array of resolved endpoint configs
 */
export function loadRpcConfig(
  filePath?: string,
  envLookup: (name: string) => string | undefined = (name) => process.env[name],
): SuiRpcEndpointConfig[] {
  const resolvedPath = filePath ?? defaultRpcJsonPath();

  let raw: string;
  try {
    raw = readFileSync(resolvedPath, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[app-api] Cannot read rpc.json at "${resolvedPath}": ${msg}. ` +
        `Create it from packages/app-api/rpc.json.example.`,
    );
  }

  return parseEndpointConfigJson(raw, envLookup);
}

/**
 * Default path for rpc.json — package-local, deterministic.
 * Uses import.meta.url relative resolution from compiled output.
 */
function defaultRpcJsonPath(): string {
  // Compiled JS lives in packages/app-api/dist/sui/parseEndpointConfig.js
  // rpc.json lives at packages/app-api/rpc.json
  // At dev time (ts-node/vitest), source is packages/app-api/src/sui/parseEndpointConfig.ts
  // Both cases: walk up to packages/app-api/ and look for rpc.json
  const thisFile = fileURLToPath(import.meta.url);
  const pkgRoot = resolve(dirname(thisFile), '..', '..');
  return resolve(pkgRoot, 'rpc.json');
}
