import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';
import { apps, assertBuilt, dists, root } from './helpers/paths.mjs';
import { serve } from './helpers/serve.mjs';

/**
 * Debugs the test apps through the MCP server, the way an AI agent does:
 * the agent talks MCP to `ember-inspector-mcp`, and the extension in Chrome
 * connects to that server.
 *
 * Only Chrome runs this for now.
 */
const browserName = process.env.E2E_BROWSER ?? 'chrome';

const mcpPackage = join(root, 'packages/ember-inspector-mcp');
const sdk = createRequire(join(mcpPackage, 'package.json'));
const { Client } = await import(
  pathToFileURL(sdk.resolve('@modelcontextprotocol/sdk/client/index.js'))
);
const { StdioClientTransport } = await import(
  pathToFileURL(sdk.resolve('@modelcontextprotocol/sdk/client/stdio.js'))
);

const TIMEOUT = 60_000;
const PORT = 28743;

for (let app of apps) {
  describe(
    `${browserName}: MCP: ${app.name}`,
    { skip: browserName !== 'chrome', timeout: 5 * TIMEOUT },
    () => {
      let server;
      let browser;
      let client;
      let page;

      let callTool = async (name, args = {}) => {
        let result = await client.callTool({ name, arguments: args });
        let text = result.content.map((item) => item.text).join('\n');

        if (result.isError) throw new Error(`${name} failed: ${text}`);
        return text;
      };

      before(async () => {
        assertBuilt(app.dist, dists.chrome);

        server = await serve(app.dist);

        client = new Client({ name: 'e2e', version: '0.0.0' });
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [join(mcpPackage, 'bin/ember-inspector-mcp.mjs')],
            env: { ...process.env, EMBER_INSPECTOR_MCP_PORT: String(PORT) },
          }),
        );

        browser = await puppeteer.launch({
          headless: process.env.HEADLESS !== 'false',
          pipe: true,
          enableExtensions: [dists.chrome],
        });

        let worker = await (
          await browser.waitForTarget(
            (target) => target.type() === 'service_worker',
          )
        ).worker();

        await worker.evaluate(
          (port) =>
            chrome.storage.sync.set({
              options: { mcpEnabled: true, mcpPort: port },
            }),
          PORT,
        );

        [page] = await browser.pages();
        await page.goto(server.url);
      });

      after(async () => {
        await browser?.close();
        await client?.close();
        await server?.close();
      });

      test('lists the tab of the app', { timeout: TIMEOUT }, async () => {
        let text = await eventually(() => callTool('list_ember_tabs'), (text) =>
          text.includes(server.url),
        );

        assert.match(text, /Ember \d+\.\d+/);
      });

      test('shows the app info', { timeout: TIMEOUT }, async () => {
        let text = await callTool('get_app_info');

        assert.match(text, new RegExp(`Ember ${app.emberVersion}`));
        assert.match(text, /Current route: index/);
      });

      test('shows the route tree', { timeout: TIMEOUT }, async () => {
        let text = await callTool('get_route_tree');

        assert.match(text, /^application/m);
        assert.match(text, /^ {2}index .*← current$/m);
      });

      test('shows the component tree', { timeout: TIMEOUT }, async () => {
        let text = await callTool('get_component_tree');

        assert.match(text, /component LinkTo {2}\[ember\d+\] {2}@route="about"/);
      });

      test('inspects a component', { timeout: TIMEOUT }, async () => {
        let tree = await callTool('get_component_tree', { filter: 'LinkTo' });
        let [, objectId] = tree.match(/LinkTo {2}\[(ember\d+)\]/);

        let text = await callTool('inspect_object', {
          objectId,
          path: ['args'],
        });

        // LinkTo is a classic component: its args are a { named, positional } pair.
        assert.match(text, /^args → /);
        assert.match(text, /^- named: /m);
      });

      test('follows the current route', { timeout: TIMEOUT }, async () => {
        await page.click('a[href="/about"]');

        let text = await eventually(
          () => callTool('get_current_route'),
          (text) => text.startsWith('about'),
        );

        assert.match(text, /^about \(url: \/about\)/);
      });
    },
  );
}

/**
 * The extension finds the app and connects a moment after the page loads.
 */
async function eventually(fn, isDone, { tries = 20, delay = 250 } = {}) {
  let last;

  for (let attempt = 0; attempt < tries; attempt++) {
    last = await fn();
    if (isDone(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  return last;
}
