# ember-inspector-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI agent, such as Claude Code, debug the Ember apps open in your browser. It reads the same data as the Ember Inspector panel: the component tree, the routes, and the properties of objects.

```
AI agent ──MCP (stdio)── ember-inspector-mcp ──WebSocket (127.0.0.1)── Ember Inspector extension ── EmberDebug in the tab
```

The extension already runs EmberDebug in the page for the inspector panel. The server sends EmberDebug the same messages as the panel, so you do not need to open DevTools.

## Setup

1. Build the extension with `pnpm build` at the root, and load `packages/ember-inspector/dist/chrome` as an unpacked extension in `chrome://extensions`.
2. Open the extension options, and turn on **Allow AI agents to connect (MCP)**. The port is `8743` unless you change it.
3. Add the server to your agent. For Claude Code:

   ```sh
   claude mcp add ember-inspector -- node /path/to/ember-inspector/packages/ember-inspector-mcp/bin/ember-inspector-mcp.mjs
   ```

   To use another port, set `EMBER_INSPECTOR_MCP_PORT` for the server, and the same port in the options.

4. Open your Ember app in the browser. If the tab was open before, reload it.

The extension connects within 30 seconds after the server starts.

## Tools

All tools only read. They take an optional `tabId`. Without one, they use the only Ember tab, or else the focused one.

| Tool | What it shows |
| --- | --- |
| `list_ember_tabs` | The tabs that run an Ember app, with their URL and Ember version. |
| `get_app_info` | The app name, library versions, current route, and, with `includeConfig`, `config/environment.js`. |
| `get_current_route` | The current route name and URL. |
| `get_route_tree` | Every route with its URL, route, controller and template. It marks the current route. |
| `get_component_tree` | The rendered components with their arguments and template files. `filter`, `maxDepth` and `maxNodes` keep a big page short. |
| `inspect_object` | The properties of an object by its id, such as `ember123` from the component tree. `path` looks into a property, such as `["args", "user"]`. |

An object id stays valid until the component tree changes. Then get the tree again.

## Security

- The server listens on `127.0.0.1` only.
- It accepts connections from browser extensions only (the `Origin` must be `chrome-extension://`, `moz-extension://` or `safari-web-extension://`). A web page cannot set that header, so a site cannot drive your apps through the server.
- The extension connects only after you turn it on in the options.

Anyone who can run programs on your computer can still connect, as with any local debugging port.

## Known limits

- One server per port. A second agent session needs another port, or it reports that the port is in use.
- Inspecting an object also shows it in the inspector panel, if the panel is open.
- In a page with several Ember apps, the tools see the app that EmberDebug picked, as the panel does.

## Tests

```sh
pnpm --filter ember-inspector-mcp test
```

The end-to-end test in `tests/e2e/mcp-test.mjs` runs the server with the real extension in Chrome.
