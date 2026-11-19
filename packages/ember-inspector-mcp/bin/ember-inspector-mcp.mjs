#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DEFAULT_PORT, ExtensionBridge } from '../src/bridge.mjs';
import { Inspector } from '../src/inspector.mjs';
import { createServer } from '../src/server.mjs';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

const port = Number(process.env.EMBER_INSPECTOR_MCP_PORT) || DEFAULT_PORT;
const bridge = new ExtensionBridge({ port });

try {
  await bridge.start();
  console.error(
    `ember-inspector-mcp: waiting for the extension on 127.0.0.1:${bridge.port}`,
  );
} catch (error) {
  // Keep serving MCP, so the agent sees why every tool fails.
  console.error(
    `ember-inspector-mcp: cannot listen on port ${port}: ${error.message}`,
  );
  bridge.request = () =>
    Promise.reject(
      new Error(
        `Port ${port} is in use, maybe by another ember-inspector-mcp. ` +
          'Stop it, or set EMBER_INSPECTOR_MCP_PORT and the port in the extension options to a free port.',
      ),
    );
  bridge.waitForConnection = bridge.request;
}

const server = createServer(new Inspector(bridge), { version });
await server.connect(new StdioServerTransport());

const shutdown = async () => {
  await server.close();
  await bridge.stop();
  process.exit(0);
};

process.stdin.on('close', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
