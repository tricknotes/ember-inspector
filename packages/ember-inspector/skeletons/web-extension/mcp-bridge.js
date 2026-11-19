/* global chrome */

/**
 * MCP bridge
 *
 * Lets AI agents, such as Claude Code, debug the Ember apps in this browser.
 * When the user turns it on in the options, this script connects to the
 * `ember-inspector-mcp` server on localhost.
 *
 * The server only relays: the tools, what they do, and how their results
 * read all live here, so a new extension version brings new tools without
 * a new server.
 *
 * The server sends requests, `{ id, method, params }`, answered with
 * `{ id, result }` or `{ id, error }`:
 * - `listTools`: `{ version, tools }`, the tools in the MCP format.
 * - `callTool`: `{ name, arguments }`, answered with an MCP tool result.
 *
 * The tools talk to EmberDebug in the tab with the same port messages as the
 * inspector panel (`route:getTree`, `objectInspector:inspectById`, …), and
 * inject EmberDebug the same way, so they work without DevTools open.
 *
 * Chrome loads this file from background.js, Firefox from the manifest.
 */
(function () {
  'use strict';

  const DEFAULT_PORT = 8743;
  const ALARM = 'ember-inspector-mcp';
  const BOOT_TIMEOUT = 10000;
  const REPLY_TIMEOUT = 5000;
  const MAX_VALUE_LENGTH = 120;

  /**
   * Ember tabs
   *
   * The service worker can stop at any time, so the tabs that run Ember
   * are kept in storage.session too.
   */
  let emberTabs = {};
  const devtoolsPorts = new Map();

  const emberTabsRestored = chrome.storage.session
    ? chrome.storage.session
        .get('mcpEmberTabs')
        .then((data) => {
          emberTabs = Object.assign(data.mcpEmberTabs || {}, emberTabs);
        })
        .catch(() => {})
    : Promise.resolve();

  function saveEmberTabs() {
    if (chrome.storage.session) {
      chrome.storage.session
        .set({ mcpEmberTabs: emberTabs })
        .catch(() => {});
    }
  }

  // The inspector panel connects with its tab id as the first message.
  chrome.runtime.onConnect.addListener((port) => {
    port.onMessage.addListener((message) => {
      if (!message || !message.appId) return;

      const tabId = message.appId;
      devtoolsPorts.set(tabId, (devtoolsPorts.get(tabId) || 0) + 1);
      port.onDisconnect.addListener(() => {
        const count = devtoolsPorts.get(tabId) - 1;
        if (count > 0) devtoolsPorts.set(tabId, count);
        else devtoolsPorts.delete(tabId);
      });
    });
  });

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (!sender.tab) return;

    const tabId = sender.tab.id;

    if (message && message.type === 'emberVersion') {
      emberTabs[tabId] = message.versions;
      saveEmberTabs();
    }

    // A new page has a new content script and no EmberDebug yet.
    if (message === 'ember-content-script-ready' && sender.frameId === 0) {
      readyTabs.delete(tabId);
    }

    for (const waiter of [...waiters]) {
      waiter(tabId, message);
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    delete emberTabs[tabId];
    saveEmberTabs();
    readyTabs.delete(tabId);
  });

  async function listEmberTabs() {
    await emberTabsRestored;

    const [focused] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });

    const tabs = await Promise.all(
      Object.keys(emberTabs).map(async (id) => {
        const tabId = Number(id);
        try {
          const tab = await chrome.tabs.get(tabId);
          return {
            tabId,
            active: !!focused && focused.id === tabId,
            title: tab.title,
            url: tab.url,
            libraries: emberTabs[id],
            devtoolsOpen: devtoolsPorts.has(tabId),
          };
        } catch {
          delete emberTabs[id];
          saveEmberTabs();
          return null;
        }
      }),
    );

    return tabs.filter(Boolean);
  }

  /**
   * Picks the tab to inspect: the given one, or else the only Ember tab,
   * or else the focused one.
   */
  async function resolveTab(tabId) {
    const tabs = await listEmberTabs();

    if (tabId !== undefined) {
      const tab = tabs.find((tab) => tab.tabId === tabId);
      if (!tab) {
        throw new Error(
          `Tab ${tabId} is not running an Ember app. ${describeTabs(tabs)}`,
        );
      }
      return tab;
    }

    if (tabs.length === 1) return tabs[0];

    const active = tabs.find((tab) => tab.active);
    if (active) return active;

    throw new Error(
      tabs.length === 0
        ? 'No tab is running an Ember app. Open the app, or reload its tab.'
        : `Several tabs run Ember apps, pass a tabId. ${describeTabs(tabs)}`,
    );
  }

  function describeTabs(tabs) {
    if (tabs.length === 0) return 'No tab is running an Ember app.';

    return (
      'Ember tabs: ' +
      tabs.map((tab) => `${tab.tabId} (${tab.title} — ${tab.url})`).join(', ')
    );
  }

  /**
   * EmberDebug
   */
  const readyTabs = new Set();
  const waiters = new Set();
  const queues = new Map();

  class ReplyTimeoutError extends Error {}

  function ignoreMissingReceiver(error) {
    if (!/Receiving end does not exist/.test(error && error.message)) {
      throw error;
    }
  }

  function sendToEmberDebug(tabId, message) {
    return chrome.tabs
      .sendMessage(tabId, Object.assign({}, message, { from: 'devtools' }))
      .catch(ignoreMissingReceiver);
  }

  function nextMessage(tabId, isReply, timeout, label) {
    let cancel;

    const promise = new Promise((resolve, reject) => {
      const waiter = (fromTabId, message) => {
        if (
          fromTabId === tabId &&
          message &&
          typeof message === 'object' &&
          isReply(message)
        ) {
          cleanup();
          resolve(message);
        }
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(
          new ReplyTimeoutError(`EmberDebug did not answer ${label} in time`),
        );
      }, timeout);

      const cleanup = () => {
        clearTimeout(timer);
        waiters.delete(waiter);
      };

      cancel = cleanup;
      waiters.add(waiter);
    });

    return { promise, cancel };
  }

  async function roundTrip(tabId, message, isReply, timeout) {
    const reply = nextMessage(tabId, isReply, timeout, message.type);
    try {
      await sendToEmberDebug(tabId, message);
    } catch (error) {
      reply.cancel();
      throw error;
    }
    return reply.promise;
  }

  /**
   * Injects EmberDebug if the inspector panel has not already,
   * then waits until it has booted with the app.
   */
  async function ensureEmberDebug(tab) {
    if (readyTabs.has(tab.tabId)) return;

    await chrome.tabs
      .sendMessage(tab.tabId, {
        type: 'inject-ember-debug',
        value: chrome.runtime.getURL('{{PANE_ROOT}}/ember_debug.js'),
      })
      .catch(ignoreMissingReceiver);

    const deadline = Date.now() + BOOT_TIMEOUT;

    while (Date.now() < deadline) {
      try {
        const reply = await roundTrip(
          tab.tabId,
          { type: 'general:applicationBooted' },
          (message) => message.type === 'general:applicationBooted',
          500,
        );
        if (reply.booted) {
          readyTabs.add(tab.tabId);
          return;
        }
      } catch {
        // EmberDebug is still loading; ask again.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error(
      `EmberDebug did not start in tab ${tab.tabId} (${tab.url}). ` +
        'Reload the tab and try again.',
    );
  }

  /**
   * Sends a message to EmberDebug, and resolves with the first reply that
   * `isReply` accepts. Calls for one tab run one at a time, so a reply is
   * never taken by another call that waits for the same message type.
   */
  async function call(tab, message, isReply, { timeout = REPLY_TIMEOUT } = {}) {
    const previous = queues.get(tab.tabId) || Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(async () => {
        await ensureEmberDebug(tab);
        return roundTrip(tab.tabId, message, isReply, timeout);
      });

    queues.set(tab.tabId, current);

    try {
      return await current;
    } finally {
      if (queues.get(tab.tabId) === current) queues.delete(tab.tabId);
    }
  }

  const reply =
    (type, accept = () => true) =>
    (message) =>
      message.type === type && accept(message);

  /**
   * Tools
   *
   * Each tool has an MCP definition and a `run` function that returns text.
   */
  const tabIdSchema = {
    type: 'integer',
    description:
      'The browser tab, from list_ember_tabs. Defaults to the only Ember tab, or the focused one.',
  };

  const READ_ONLY = { readOnlyHint: true, openWorldHint: false };

  const tools = [
    {
      name: 'list_ember_tabs',
      title: 'List Ember tabs',
      description:
        'Lists the browser tabs that run an Ember app, with their URL and Ember version. ' +
        'The other tools take a tabId from here when several tabs run Ember.',
      inputSchema: { type: 'object', properties: {} },
      async run() {
        return formatTabs(await listEmberTabs());
      },
    },
    {
      name: 'get_app_info',
      title: 'Get Ember app info',
      description:
        'Shows the Ember app in a tab: its name, library versions (Ember, Ember Data, …) ' +
        'and current route. Pass includeConfig to also show config/environment.js.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: tabIdSchema,
          includeConfig: {
            type: 'boolean',
            description: 'Also show the app config (config/environment.js).',
          },
        },
      },
      async run({ tabId, includeConfig }) {
        const tab = await resolveTab(tabId);
        const libraries = await call(
          tab,
          { type: 'general:getLibraries' },
          reply('general:libraries'),
        );
        const currentRoute = await call(
          tab,
          { type: 'route:getCurrentRoute' },
          reply('route:currentRoute'),
        );
        const config = includeConfig
          ? await call(
              tab,
              { type: 'general:getEmberCliConfig' },
              reply('general:emberCliConfig'),
            )
          : null;

        return formatAppInfo({ tab, libraries, currentRoute, config });
      },
    },
    {
      name: 'get_current_route',
      title: 'Get current route',
      description: 'Shows the name and URL of the route the app is on.',
      inputSchema: { type: 'object', properties: { tabId: tabIdSchema } },
      async run({ tabId }) {
        const tab = await resolveTab(tabId);
        const currentRoute = await call(
          tab,
          { type: 'route:getCurrentRoute' },
          reply('route:currentRoute'),
        );
        return `${currentRoute.name} (url: ${currentRoute.url || '/'})`;
      },
    },
    {
      name: 'get_route_tree',
      title: 'Get route tree',
      description:
        'Shows every route of the app as a tree, with its URL, route, controller and template, ' +
        'and marks the current route. A "(generated)" controller has no file in the app.',
      inputSchema: { type: 'object', properties: { tabId: tabIdSchema } },
      async run({ tabId }) {
        const tab = await resolveTab(tabId);
        const routes = await call(
          tab,
          { type: 'route:getTree' },
          reply('route:routeTree'),
        );
        const currentRoute = await call(
          tab,
          { type: 'route:getCurrentRoute' },
          reply('route:currentRoute'),
        );
        return formatRouteTree(routes, currentRoute.name);
      },
    },
    {
      name: 'get_component_tree',
      title: 'Get component tree',
      description:
        'Shows the rendered component tree of the page: outlets, route templates and components, ' +
        'with their arguments and template files. `[ember123]` is an object id: pass it to ' +
        'inspect_object to see the component instance or an argument value. ' +
        'On a big page, narrow the tree with filter or maxDepth.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: tabIdSchema,
          filter: {
            type: 'string',
            description:
              'Only show components whose name contains this text (case-insensitive), with their parents and children.',
          },
          maxDepth: {
            type: 'integer',
            minimum: 0,
            description: 'Only show nodes up to this depth.',
          },
          includeArgs: {
            type: 'boolean',
            description: 'Show the arguments of each node. Defaults to true.',
          },
          includeElements: {
            type: 'boolean',
            description:
              'Also show HTML elements and modifiers (such as {{on "click"}}). Defaults to false.',
          },
          maxNodes: {
            type: 'integer',
            minimum: 1,
            description: 'The most nodes to show. Defaults to 400.',
          },
        },
      },
      async run({ tabId, ...options }) {
        const tab = await resolveTab(tabId);
        const { tree } = await call(
          tab,
          { type: 'view:getTree', immediate: true },
          reply('view:renderTree'),
        );

        // Building the tree costs time on every render. Stop unless the
        // inspector panel is open, since it keeps asking for the tree.
        if (!tab.devtoolsOpen) {
          await sendToEmberDebug(tab.tabId, { type: 'view:releaseTree' });
        }

        return formatComponentTree(tree, options);
      },
    },
    {
      name: 'inspect_object',
      title: 'Inspect object',
      description:
        'Shows the properties of an object, grouped by class and mixin, like the object ' +
        'inspector of Ember Inspector. objectId is an id like ember123 from ' +
        'get_component_tree or an earlier inspect_object. Pass path to look into a property, ' +
        'for example ["args", "user"] for the user argument of a component. ' +
        'Inspecting an object shows it in the inspector panel too, if it is open.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: tabIdSchema,
          objectId: {
            type: 'string',
            description: 'The object id, like ember123.',
          },
          path: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Property names to follow from the object, one per level.',
          },
          allMixins: {
            type: 'boolean',
            description:
              'Also list the properties of collapsed groups, such as Ember internals. Defaults to false.',
          },
        },
        required: ['objectId'],
      },
      async run({ tabId, objectId, path = [], allMixins }) {
        const tab = await resolveTab(tabId);

        let object = await call(
          tab,
          { type: 'objectInspector:inspectById', objectId },
          reply('objectInspector:updateObject', (m) => m.objectId === objectId),
          { timeout: 3000 },
        ).catch((error) => {
          if (!(error instanceof ReplyTimeoutError)) throw error;
          throw new Error(
            `No object ${objectId}. Ids from an older component tree are released ` +
              'when the tree changes; get the tree again for fresh ids.',
          );
        });

        for (const [index, property] of path.entries()) {
          const parentId = object.objectId;
          const where = path.slice(0, index + 1).join('.');
          const found = findProperty(object, property);
          const value = found && found.value;

          if (value && PRIMITIVE_TYPES.has(value.type)) {
            throw new Error(
              `${where} is ${value.inspect} (${value.type.replace(/^type-/, '')}), not an object.`,
            );
          }

          object = await call(
            tab,
            { type: 'objectInspector:digDeeper', objectId: parentId, property },
            reply(
              'objectInspector:updateObject',
              (m) => m.parentObject === parentId && m.property === property,
            ),
            { timeout: 3000 },
          ).catch((error) => {
            if (!(error instanceof ReplyTimeoutError)) throw error;
            throw new Error(
              `Cannot look into ${where}: it is not an object, or it does not exist.`,
            );
          });
        }

        return formatObject(object, { path, allMixins });
      },
    },
  ];

  const PRIMITIVE_TYPES = new Set([
    'type-string',
    'type-number',
    'type-boolean',
    'type-null',
    'type-undefined',
    'type-symbol',
    'type-bigint',
  ]);

  function findProperty(object, name) {
    for (const mixin of object.details || []) {
      const property = (mixin.properties || []).find(
        (p) => String(p.name) === name,
      );
      if (property) return property;
    }
  }

  async function callTool({ name, arguments: args }) {
    const tool = tools.find((tool) => tool.name === name);

    if (!tool) {
      return errorResult(`Unknown tool ${name}`);
    }

    try {
      const text = await tool.run(args || {});
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      return errorResult(error.message || String(error));
    }
  }

  function errorResult(text) {
    return { isError: true, content: [{ type: 'text', text }] };
  }

  function listTools() {
    return {
      version: chrome.runtime.getManifest().version,
      tools: tools.map(({ name, title, description, inputSchema }) => ({
        name,
        title,
        description,
        inputSchema,
        annotations: READ_ONLY,
      })),
    };
  }

  /**
   * Formatting: compact text for an AI agent.
   * Object ids show as `[ember123]`; inspect_object takes them.
   */
  function formatTabs(tabs) {
    if (tabs.length === 0) {
      return 'No tab is running an Ember app. Open the app, or reload its tab.';
    }

    return tabs
      .map((tab) =>
        [
          `- tabId ${tab.tabId}${tab.active ? ' (focused)' : ''}: ${tab.title}`,
          `  url: ${tab.url}`,
          `  libraries: ${formatLibraries(tab.libraries)}`,
          `  inspector panel open: ${tab.devtoolsOpen ? 'yes' : 'no'}`,
        ].join('\n'),
      )
      .join('\n');
  }

  function formatLibraries(libraries) {
    if (!libraries || !libraries.length) return '(unknown)';
    return libraries.map((lib) => `${lib.name} ${lib.version}`).join(', ');
  }

  function formatAppInfo({ tab, libraries, currentRoute, config }) {
    const lines = [
      `App: ${libraries.applicationName || '(unknown)'} [${libraries.applicationId}]`,
      `Tab: ${tab.tabId} — ${tab.title}`,
      `Page URL: ${tab.url}`,
      `Current route: ${currentRoute.name} (url: ${currentRoute.url || '/'})`,
      'Libraries:',
      ...(libraries.libraries || []).map(
        (lib) => `- ${lib.name} ${lib.version}`,
      ),
    ];

    if (config) {
      lines.push(
        'Config (config/environment.js):',
        JSON.stringify(config.emberCliConfig || null, null, 2),
      );
    }

    return lines.join('\n');
  }

  function formatRouteTree({ tree, error }, currentRouteName) {
    if (error) return `EmberDebug could not read the routes: ${error}`;

    const lines = [];

    const walk = (node, depth) => {
      const value = node.value;

      if (value) {
        const parts = [`${'  '.repeat(depth)}${value.name}`];
        if (value.type === 'resource') parts.push('(resource)');
        if (value.url !== undefined) parts.push(`url: ${value.url || '/'}`);
        if (value.routeHandler) {
          parts.push(`route: ${value.routeHandler.className}`);
        }
        if (value.controller) {
          parts.push(
            `controller: ${value.controller.className}` +
              (value.controller.exists ? '' : ' (generated)'),
          );
        }
        if (value.template) parts.push(`template: ${value.template.name}`);
        if (value.name === currentRouteName) parts.push('← current');

        lines.push(parts.join('  '));
      }

      for (const child of node.children || []) {
        walk(child, value ? depth + 1 : depth);
      }
    };

    walk(tree, 0);

    return lines.join('\n');
  }

  // Hidden node types still show their children, one level up.
  const ELEMENT_TYPES = new Set(['html-element', 'modifier']);

  function formatComponentTree(
    roots,
    {
      filter,
      maxDepth = Infinity,
      includeArgs = true,
      includeElements = false,
      maxNodes = 400,
    } = {},
  ) {
    const lines = [];
    let omitted = 0;
    const needle = filter && filter.toLowerCase();

    const matches = (node) =>
      String(node.name || '')
        .toLowerCase()
        .includes(needle);

    // Whether a node or a node below it matches the filter.
    const relevant = new Map();
    const markRelevant = (node) => {
      let found = !needle || matches(node);
      for (const child of node.children || []) {
        if (markRelevant(child)) found = true;
      }
      relevant.set(node, found);
      return found;
    };
    roots.forEach(markRelevant);

    const walk = (node, depth, insideMatch) => {
      if (!insideMatch && !relevant.get(node)) return;

      const isMatch = needle && matches(node);
      const shown = includeElements || !ELEMENT_TYPES.has(node.type);
      let childDepth = depth;

      if (shown) {
        if (depth > maxDepth) {
          omitted += countNodes(node);
          return;
        }

        if (lines.length >= maxNodes) {
          omitted += 1;
        } else {
          lines.push(
            '  '.repeat(depth) +
              formatRenderNode(node, includeArgs) +
              (isMatch ? '  ← match' : ''),
          );
        }
        childDepth = depth + 1;
      }

      for (const child of node.children || []) {
        walk(child, childDepth, insideMatch || isMatch);
      }
    };

    roots.forEach((root) => walk(root, 0, false));

    if (lines.length === 0) {
      return needle
        ? `No component matches "${filter}".`
        : 'The render tree is empty.';
    }

    if (omitted > 0) {
      lines.push(
        `… ${omitted} more nodes not shown. Use filter, maxDepth or maxNodes to see them.`,
      );
    }

    return lines.join('\n');
  }

  function formatRenderNode(node, includeArgs) {
    const parts = [
      `${node.type} ${node.type === 'html-element' ? `<${node.name}>` : node.name}`,
    ];

    if (node.instance && typeof node.instance === 'object') {
      parts.push(`[${node.instance.id}]`);
    }

    if (includeArgs) {
      const args = formatArgs(node.args);
      if (args) parts.push(args);
    }

    if (node.template && node.type !== 'html-element') {
      parts.push(`template: ${node.template}`);
    }

    return parts.join('  ');
  }

  function formatArgs(args) {
    if (!args) return '';

    const parts = [];

    for (const value of args.positional || []) {
      parts.push(formatSerializedItem(value));
    }

    for (const [name, value] of Object.entries(args.named || {})) {
      parts.push(`@${name}=${formatSerializedItem(value)}`);
    }

    return parts.join(' ');
  }

  function formatSerializedItem(item) {
    if (item && typeof item === 'object') {
      return `${truncate(item.inspect)} [${item.id}]`;
    }
    if (typeof item === 'string') return truncate(JSON.stringify(item));
    return String(item);
  }

  function countNodes(node) {
    return (node.children || []).reduce(
      (sum, child) => sum + countNodes(child),
      1,
    );
  }

  function formatObject(message, { path = [], allMixins = false } = {}) {
    const title = path.length
      ? `${path.join('.')} → ${message.name} [${message.objectId}]`
      : `${message.name} [${message.objectId}]`;

    const lines = [title];

    for (const mixin of message.details || []) {
      const properties = mixin.properties || [];

      if (!allMixins && !mixin.expand) {
        lines.push(
          '',
          `## ${mixin.name} — ${properties.length} properties (collapsed)`,
        );
        continue;
      }

      lines.push('', `## ${mixin.name}`);

      if (properties.length === 0) lines.push('(no properties)');

      for (const property of properties) {
        lines.push(formatProperty(property));
      }
    }

    if (message.errors && message.errors.length) {
      lines.push(
        '',
        `Reading these properties threw an error: ${message.errors
          .map((error) => error.property)
          .join(', ')}`,
      );
    }

    return lines.join('\n');
  }

  function formatProperty(property) {
    const value = property.value || {};
    const flags = [value.type && value.type.replace(/^type-/, '')];

    if (property.isService) flags.push('service');
    if (property.isComputed) flags.push('computed');
    if (property.isGetter) flags.push('getter');
    if (property.isTracked) flags.push('tracked');
    if (property.readOnly) flags.push('read-only');
    if (
      property.isComputed &&
      !value.isCalculated &&
      value.type === 'type-descriptor'
    ) {
      flags.push('not calculated');
    }
    if (property.dependentKeys && property.dependentKeys.length) {
      const keys = property.dependentKeys.map((key) => key.name || key);
      flags.push(`depends on: ${keys.join(', ')}`);
    }

    return `- ${property.name}: ${truncate(value.inspect)}  (${flags.filter(Boolean).join(', ')})`;
  }

  function truncate(value) {
    const string = String(value);
    return string.length > MAX_VALUE_LENGTH
      ? `${string.slice(0, MAX_VALUE_LENGTH - 1)}…`
      : string;
  }

  /**
   * Connection to the MCP server
   */
  let socket = null;
  let retryTimer = null;
  let retryDelay = 1000;

  function respond(payload) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  }

  async function handleRequest(request) {
    const params = request.params || {};

    switch (request.method) {
      case 'listTools':
        return listTools();
      case 'callTool':
        return callTool(params);
      default:
        throw new Error(`Unknown method ${request.method}`);
    }
  }

  async function getOptions() {
    const data = await chrome.storage.sync.get('options');
    const options = data.options || {};
    return {
      enabled: options.mcpEnabled === true,
      port: Number(options.mcpPort) || DEFAULT_PORT,
    };
  }

  async function updateConnection() {
    const options = await getOptions();

    if (chrome.alarms) {
      if (options.enabled) {
        // Wakes the service worker up to reconnect when the server starts later.
        chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
      } else {
        chrome.alarms.clear(ALARM);
      }
    }

    if (!options.enabled) {
      disconnect();
    } else if (socket && socket.port !== options.port) {
      disconnect();
      connect(options.port);
    } else if (!socket) {
      connect(options.port);
    }
  }

  function connect(port) {
    clearTimeout(retryTimer);

    const current = new WebSocket(`ws://127.0.0.1:${port}`);
    current.port = port;
    socket = current;

    current.onopen = () => {
      retryDelay = 1000;
    };

    current.onmessage = (event) => {
      let request;
      try {
        request = JSON.parse(event.data);
      } catch {
        return;
      }
      if (request.id === undefined) return;

      handleRequest(request).then(
        (result) =>
          respond({ id: request.id, result: result === undefined ? null : result }),
        (error) =>
          respond({ id: request.id, error: String((error && error.message) || error) }),
      );
    };

    current.onclose = () => {
      if (socket !== current) return;

      socket = null;
      // Retry while the service worker is awake; the alarm covers the rest.
      retryTimer = setTimeout(updateConnection, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30000);
    };
  }

  function disconnect() {
    clearTimeout(retryTimer);
    if (socket) {
      const current = socket;
      socket = null;
      current.close();
    }
  }

  if (chrome.alarms) {
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === ALARM) updateConnection();
    });
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync' && changes.options) updateConnection();
  });

  updateConnection();
})();
