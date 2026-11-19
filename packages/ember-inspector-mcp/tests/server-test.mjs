import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import WebSocket from 'ws';
import { ExtensionBridge } from '../src/bridge.mjs';
import { Inspector } from '../src/inspector.mjs';
import { createServer } from '../src/server.mjs';

const TAB = {
  tabId: 7,
  active: true,
  title: 'My App',
  url: 'http://localhost:4200/',
  libraries: [{ name: 'Ember', version: '6.4.0' }],
  devtoolsOpen: false,
};

const ROUTE_TREE = {
  children: [
    {
      value: {
        name: 'application',
        type: 'resource',
        routeHandler: { className: 'application' },
        controller: { className: 'application', exists: true },
        template: { name: 'application' },
      },
      children: [
        {
          value: {
            name: 'posts',
            url: '/posts',
            type: 'route',
            routeHandler: { className: 'posts' },
            controller: { className: 'posts', exists: false },
            template: { name: 'posts' },
          },
        },
      ],
    },
  ],
};

const COUNTER = {
  objectId: 'ember16',
  name: 'Counter',
  details: [
    {
      name: 'Own Properties',
      expand: true,
      properties: [
        {
          name: 'args',
          value: { type: 'type-object', inspect: '{ clicks: 1 }' },
        },
        {
          name: 'count',
          value: { type: 'type-number', inspect: '1' },
          isGetter: true,
          isTracked: true,
        },
      ],
    },
    { name: 'Observable Mixin', isEmberMixin: true, properties: [{}, {}] },
  ],
  errors: [],
};

/**
 * Stands in for the extension: answers the bridge requests, and answers
 * the EmberDebug messages the way EmberDebug does.
 */
async function connectFakeExtension(
  port,
  { origin = 'chrome-extension://abc' } = {},
) {
  let socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
  let sent = [];

  let emit = (message) =>
    socket.send(
      JSON.stringify({
        event: 'message',
        tabId: TAB.tabId,
        frameId: 0,
        message,
      }),
    );

  let answer = (message) => {
    switch (message.type) {
      case 'general:applicationBooted':
        return emit({ type: 'general:applicationBooted', booted: true });
      case 'route:getTree':
        return emit({ type: 'route:routeTree', tree: ROUTE_TREE });
      case 'route:getCurrentRoute':
        return emit({
          type: 'route:currentRoute',
          name: 'posts',
          url: '/posts',
        });
      case 'objectInspector:inspectById':
        if (message.objectId === COUNTER.objectId) {
          return emit({ type: 'objectInspector:updateObject', ...COUNTER });
        }
    }
  };

  socket.on('message', (data) => {
    let request = JSON.parse(data.toString());
    if (request.id === undefined) return;

    if (request.method === 'send') {
      sent.push(request.params.message);
      setTimeout(() => answer(request.params.message), 5);
    }

    let result = request.method === 'listTabs' ? [TAB] : null;
    socket.send(JSON.stringify({ id: request.id, result }));
  });

  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  return { socket, sent };
}

describe('ember-inspector-mcp', () => {
  let bridge;
  let client;
  let extension;

  let callTool = async (name, args = {}) => {
    let result = await client.callTool({ name, arguments: args });
    return { text: result.content[0].text, isError: result.isError === true };
  };

  before(async () => {
    bridge = new ExtensionBridge({ port: 0 });
    await bridge.start();

    let [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await createServer(new Inspector(bridge)).connect(serverTransport);

    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);

    extension = await connectFakeExtension(bridge.port);
  });

  after(async () => {
    extension?.socket.close();
    await client?.close();
    await bridge?.stop();
  });

  test('only extensions can connect', async () => {
    await assert.rejects(
      connectFakeExtension(bridge.port, { origin: 'https://evil.example' }),
      /Unexpected server response: 401/,
    );
  });

  test('lists the Ember tabs', async () => {
    let { text } = await callTool('list_ember_tabs');

    assert.match(text, /tabId 7 \(focused\): My App/);
    assert.match(text, /libraries: Ember 6\.4\.0/);
  });

  test('injects EmberDebug and waits for it before the first message', async () => {
    let { text } = await callTool('get_route_tree');

    assert.equal(
      text,
      [
        'application  (resource)  route: application  controller: application  template: application',
        '  posts  url: /posts  route: posts  controller: posts (generated)  template: posts  ← current',
      ].join('\n'),
    );
    assert.equal(extension.sent[0].type, 'general:applicationBooted');
  });

  test('inspects an object', async () => {
    let { text } = await callTool('inspect_object', { objectId: 'ember16' });

    assert.match(text, /^Counter \[ember16\]/);
    assert.match(text, /- count: 1 {2}\(number, getter, tracked\)/);
    assert.match(text, /## Observable Mixin — 2 properties \(collapsed\)/);
  });

  test('explains that a primitive property has nothing inside', async () => {
    let { text, isError } = await callTool('inspect_object', {
      objectId: 'ember16',
      path: ['count'],
    });

    assert.ok(isError);
    assert.equal(text, 'count is 1 (number), not an object.');
  });

  test('explains an unknown tab', async () => {
    let { text, isError } = await callTool('get_current_route', { tabId: 99 });

    assert.ok(isError);
    assert.match(text, /Tab 99 is not running an Ember app\. Ember tabs: 7 /);
  });
});
