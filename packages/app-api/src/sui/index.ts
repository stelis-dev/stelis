/**
 * app-api Sui RPC module — multi-endpoint failover + authenticated provider support.
 *
 * Configuration source: packages/app-api/rpc.json.
 * Auth secrets: env vars referenced via auth.valueEnv.
 */
export { loadRpcConfig } from './parseEndpointConfig.js';
export { createSuiClient } from './createSuiClient.js';
