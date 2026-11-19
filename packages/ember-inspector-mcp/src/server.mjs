import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ReplyTimeoutError } from './inspector.mjs';
import {
  formatAppInfo,
  formatComponentTree,
  formatCurrentRoute,
  formatObject,
  formatRouteTree,
  formatTabs,
} from './format.mjs';

const tabId = z
  .number()
  .int()
  .optional()
  .describe(
    'The browser tab, from list_ember_tabs. Defaults to the only Ember tab, or the focused one.',
  );

const READ_ONLY = { readOnlyHint: true, openWorldHint: false };

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
  for (let mixin of object.details ?? []) {
    let property = mixin.properties?.find((p) => String(p.name) === name);
    if (property) return property;
  }
}

export function createServer(inspector, { version = '0.0.0' } = {}) {
  let server = new McpServer({ name: 'ember-inspector', version });

  let tool = (name, config, handler) => {
    server.registerTool(
      name,
      { annotations: READ_ONLY, ...config },
      async (args) => {
        try {
          return { content: [{ type: 'text', text: await handler(args) }] };
        } catch (error) {
          return {
            isError: true,
            content: [{ type: 'text', text: error.message }],
          };
        }
      },
    );
  };

  let reply =
    (type, accept = () => true) =>
    (message) =>
      message.type === type && accept(message);

  tool(
    'list_ember_tabs',
    {
      title: 'List Ember tabs',
      description:
        'Lists the browser tabs that run an Ember app, with their URL and Ember version. ' +
        'The other tools take a tabId from here when several tabs run Ember.',
      inputSchema: {},
    },
    async () => formatTabs(await inspector.listTabs()),
  );

  tool(
    'get_app_info',
    {
      title: 'Get Ember app info',
      description:
        'Shows the Ember app in a tab: its name, library versions (Ember, Ember Data, …) ' +
        'and current route. Pass includeConfig to also show config/environment.js.',
      inputSchema: {
        tabId,
        includeConfig: z
          .boolean()
          .optional()
          .describe('Also show the app config (config/environment.js).'),
      },
    },
    async ({ tabId, includeConfig }) => {
      let tab = await inspector.resolveTab(tabId);
      let libraries = await inspector.call(
        tab,
        { type: 'general:getLibraries' },
        reply('general:libraries'),
      );
      let currentRoute = await inspector.call(
        tab,
        { type: 'route:getCurrentRoute' },
        reply('route:currentRoute'),
      );
      let config = includeConfig
        ? await inspector.call(
            tab,
            { type: 'general:getEmberCliConfig' },
            reply('general:emberCliConfig'),
          )
        : null;

      return formatAppInfo({ tab, libraries, currentRoute, config });
    },
  );

  tool(
    'get_current_route',
    {
      title: 'Get current route',
      description: 'Shows the name and URL of the route the app is on.',
      inputSchema: { tabId },
    },
    async ({ tabId }) => {
      let tab = await inspector.resolveTab(tabId);
      let currentRoute = await inspector.call(
        tab,
        { type: 'route:getCurrentRoute' },
        reply('route:currentRoute'),
      );
      return formatCurrentRoute(currentRoute);
    },
  );

  tool(
    'get_route_tree',
    {
      title: 'Get route tree',
      description:
        'Shows every route of the app as a tree, with its URL, route, controller and template, ' +
        'and marks the current route. A "(generated)" controller has no file in the app.',
      inputSchema: { tabId },
    },
    async ({ tabId }) => {
      let tab = await inspector.resolveTab(tabId);
      let routes = await inspector.call(
        tab,
        { type: 'route:getTree' },
        reply('route:routeTree'),
      );
      let currentRoute = await inspector.call(
        tab,
        { type: 'route:getCurrentRoute' },
        reply('route:currentRoute'),
      );
      return formatRouteTree(routes, currentRoute.name);
    },
  );

  tool(
    'get_component_tree',
    {
      title: 'Get component tree',
      description:
        'Shows the rendered component tree of the page: outlets, route templates and components, ' +
        'with their arguments and template files. `[ember123]` is an object id: pass it to ' +
        'inspect_object to see the component instance or an argument value. ' +
        'On a big page, narrow the tree with filter or maxDepth.',
      inputSchema: {
        tabId,
        filter: z
          .string()
          .optional()
          .describe(
            'Only show components whose name contains this text (case-insensitive), with their parents and children.',
          ),
        maxDepth: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Only show nodes up to this depth.'),
        includeArgs: z
          .boolean()
          .optional()
          .describe('Show the arguments of each node. Defaults to true.'),
        includeElements: z
          .boolean()
          .optional()
          .describe(
            'Also show HTML elements and modifiers (such as {{on "click"}}). Defaults to false.',
          ),
        maxNodes: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('The most nodes to show. Defaults to 400.'),
      },
    },
    async ({ tabId, ...options }) => {
      let tab = await inspector.resolveTab(tabId);
      let { tree } = await inspector.call(
        tab,
        { type: 'view:getTree', immediate: true },
        reply('view:renderTree'),
      );

      // Building the tree costs time on every render. Stop unless the
      // inspector panel is open, since it keeps asking for the tree.
      if (!tab.devtoolsOpen) {
        await inspector.send(tab, { type: 'view:releaseTree' });
      }

      return formatComponentTree(tree, options);
    },
  );

  tool(
    'inspect_object',
    {
      title: 'Inspect object',
      description:
        'Shows the properties of an object, grouped by class and mixin, like the object ' +
        'inspector of Ember Inspector. objectId is an id like ember123 from ' +
        'get_component_tree or an earlier inspect_object. Pass path to look into a property, ' +
        'for example ["args", "user"] for the user argument of a component. ' +
        'Inspecting an object shows it in the inspector panel too, if it is open.',
      inputSchema: {
        tabId,
        objectId: z.string().describe('The object id, like ember123.'),
        path: z
          .array(z.string())
          .optional()
          .describe('Property names to follow from the object, one per level.'),
        allMixins: z
          .boolean()
          .optional()
          .describe(
            'Also list the properties of collapsed groups, such as Ember internals. Defaults to false.',
          ),
      },
    },
    async ({ tabId, objectId, path = [], allMixins }) => {
      let tab = await inspector.resolveTab(tabId);

      let object = await inspector
        .call(
          tab,
          { type: 'objectInspector:inspectById', objectId },
          reply('objectInspector:updateObject', (m) => m.objectId === objectId),
          { timeout: 3000 },
        )
        .catch((error) => {
          if (!(error instanceof ReplyTimeoutError)) throw error;
          throw new Error(
            `No object ${objectId}. Ids from an older component tree are released ` +
              'when the tree changes; get the tree again for fresh ids.',
          );
        });

      for (let [index, property] of path.entries()) {
        let parentId = object.objectId;
        let value = findProperty(object, property)?.value;

        if (value && PRIMITIVE_TYPES.has(value.type)) {
          throw new Error(
            `${path.slice(0, index + 1).join('.')} is ${value.inspect} ` +
              `(${value.type.replace(/^type-/, '')}), not an object.`,
          );
        }

        object = await inspector
          .call(
            tab,
            {
              type: 'objectInspector:digDeeper',
              objectId: parentId,
              property,
            },
            reply(
              'objectInspector:updateObject',
              (m) => m.parentObject === parentId && m.property === property,
            ),
            { timeout: 3000 },
          )
          .catch((error) => {
            if (!(error instanceof ReplyTimeoutError)) throw error;
            throw new Error(
              `Cannot look into ${path.slice(0, index + 1).join('.')}: ` +
                'it is not an object, or it does not exist.',
            );
          });
      }

      return formatObject(object, { path, allMixins });
    },
  );

  return server;
}
