import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import WebSocket from 'ws';
import { ExtensionBridge } from '../src/bridge.mjs';
import { createServer } from '../src/server.mjs';

const ECHO_TOOL = {
  name: 'echo',
  description: 'Echoes its text.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
  },
};

/**
 * Stands in for the extension, which defines the tools.
 */
async function connectFakeExtension(
  port,
  { origin = 'chrome-extension://abc', tools = [ECHO_TOOL] } = {},
) {
  let socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
  let calls = [];

  socket.on('message', (data) => {
    let request = JSON.parse(data.toString());
    if (request.id === undefined) return;

    let result;
    if (request.method === 'listTools') {
      result = { version: '9.9.9', tools };
    } else if (request.method === 'callTool') {
      calls.push(request.params);
      result = {
        content: [
          { type: 'text', text: `echo: ${request.params.arguments.text}` },
        ],
      };
    }

    socket.send(JSON.stringify({ id: request.id, result }));
  });

  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  return { socket, calls };
}

describe('ember-inspector-mcp', () => {
  let bridge;
  let client;
  let extension;

  let toolNames = async () =>
    (await client.listTools()).tools.map((tool) => tool.name);

  beforeEach(async () => {
    bridge = new ExtensionBridge({ port: 0 });
    await bridge.start();

    let [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await createServer(bridge).connect(serverTransport);

    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    extension?.socket.close();
    extension = null;
    await client?.close();
    await bridge?.stop();
  });

  test('only extensions can connect', async () => {
    await assert.rejects(
      connectFakeExtension(bridge.port, { origin: 'https://evil.example' }),
      /Unexpected server response: 401/,
    );
  });

  test('lists the tools of the extension', async () => {
    extension = await connectFakeExtension(bridge.port);

    assert.deepEqual(await toolNames(), ['ember_inspector_status', 'echo']);
  });

  test('relays a tool call to the extension', async () => {
    extension = await connectFakeExtension(bridge.port);

    let result = await client.callTool({
      name: 'echo',
      arguments: { text: 'hi' },
    });

    assert.deepEqual(result.content, [{ type: 'text', text: 'echo: hi' }]);
    assert.deepEqual(extension.calls, [
      { name: 'echo', arguments: { text: 'hi' } },
    ]);
  });

  test('tells the agent when the extension brings new tools', async () => {
    assert.deepEqual(await toolNames(), ['ember_inspector_status']);

    let changed = new Promise((resolve) =>
      client.setNotificationHandler(ToolListChangedNotificationSchema, resolve),
    );

    extension = await connectFakeExtension(bridge.port);
    await changed;

    assert.deepEqual(await toolNames(), ['ember_inspector_status', 'echo']);
  });

  test('the status tool explains how to connect', async () => {
    let result = await client.callTool({ name: 'ember_inspector_status' });
    assert.match(result.content[0].text, /not connected/);

    extension = await connectFakeExtension(bridge.port);
    await client.listTools();

    result = await client.callTool({ name: 'ember_inspector_status' });
    assert.match(
      result.content[0].text,
      /Connected to Ember Inspector 9\.9\.9 .*\nTools from the extension: echo/,
    );
  });
});
