#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createStelisMcpServer } from './server.js';

const server = createStelisMcpServer(loadConfig());
const transport = new StdioServerTransport();

try {
  await server.connect(transport);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[stelis-mcp-server] ${message}\n`);
  process.exitCode = 1;
}
