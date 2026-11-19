import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * The extension defines the tools. This server only relays them, so a new
 * extension version brings new tools without a new server.
 *
 * It keeps one tool of its own, `ember_inspector_status`, so the agent can
 * learn why the other tools are missing when the extension is not connected.
 */
const STATUS_TOOL = {
  name: 'ember_inspector_status',
  title: 'Ember Inspector status',
  description:
    'Shows whether the Ember Inspector browser extension is connected, and how to connect it. ' +
    'Call this when the other Ember Inspector tools are missing or fail to connect.',
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

// How long the first tools/list waits for the extension, so that an agent
// that starts with the browser already open sees every tool at once.
const FIRST_LIST_WAIT = 3_000;
const CONNECT_WAIT = 10_000;
const CALL_TIMEOUT = 60_000;

export function createServer(bridge, { version = '0.0.0' } = {}) {
  let server = new Server(
    { name: 'ember-inspector', version },
    { capabilities: { tools: { listChanged: true } } },
  );

  let extension = { version: null, tools: [] };
  let firstList = true;

  let loadTools = async () => {
    try {
      let result = await bridge.request('listTools');
      let changed =
        JSON.stringify(result.tools) !== JSON.stringify(extension.tools);
      extension = {
        version: result.version ?? null,
        tools: result.tools ?? [],
      };
      return changed;
    } catch {
      return false;
    }
  };

  // Keep the last tools when the extension disconnects: its service worker
  // restarts often, and a call then explains how to reconnect.
  bridge.on('connected', async () => {
    if (await loadTools()) {
      server.sendToolListChanged().catch(() => {});
    }
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (firstList) {
      firstList = false;
      await bridge.waitForConnection(FIRST_LIST_WAIT).catch(() => {});
      if (bridge.isConnected) await loadTools();
    }

    return { tools: [STATUS_TOOL, ...extension.tools] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    let { name } = request.params;

    if (name === STATUS_TOOL.name) {
      return text(status(bridge, extension));
    }

    try {
      await bridge.waitForConnection(CONNECT_WAIT);
      return await bridge.request('callTool', request.params, {
        timeout: CALL_TIMEOUT,
      });
    } catch (error) {
      return { ...text(error.message), isError: true };
    }
  });

  return server;
}

function status(bridge, extension) {
  if (bridge.startError) return bridge.startError;

  if (!bridge.isConnected) {
    return (
      `The Ember Inspector extension is not connected to port ${bridge.port}. ` +
      'Open the extension options, turn on "Allow AI agents to connect (MCP)" ' +
      'with the same port, then reload the tab with the Ember app. ' +
      'The extension retries every 30 seconds.'
    );
  }

  return [
    `Connected to Ember Inspector ${extension.version ?? '(unknown version)'} on port ${bridge.port}.`,
    `Tools from the extension: ${extension.tools.map((tool) => tool.name).join(', ') || '(none)'}`,
  ].join('\n');
}

function text(value) {
  return { content: [{ type: 'text', text: value }] };
}
