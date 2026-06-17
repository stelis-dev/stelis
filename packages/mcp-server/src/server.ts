import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StelisMcpServerConfig } from './config.js';
import { loadConfig } from './config.js';
import { registerStelisTools } from './tools.js';

export function createStelisMcpServer(config: StelisMcpServerConfig = loadConfig()): McpServer {
  const server = new McpServer({
    name: '@stelis/mcp-server',
    version: '0.1.0',
  });
  registerStelisTools(server, config);
  return server;
}
