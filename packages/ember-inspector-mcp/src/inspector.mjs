const CONNECT_TIMEOUT = 10_000;
const BOOT_TIMEOUT = 10_000;
const REPLY_TIMEOUT = 5_000;

/**
 * Talks to EmberDebug in the browser tabs, through the extension.
 *
 * It speaks the same port messages as the inspector UI
 * (`route:getTree`, `objectInspector:inspectById`, …),
 * so EmberDebug needs no changes.
 */
export class Inspector {
  #bridge;
  #readyTabs = new Set();
  #queues = new Map();

  constructor(bridge) {
    this.#bridge = bridge;

    bridge.on('message', ({ tabId, frameId, message }) => {
      // A new page in the tab has a new content script and no EmberDebug yet.
      if (message === 'ember-content-script-ready' && frameId === 0) {
        this.#readyTabs.delete(tabId);
      }
    });

    bridge.on('disconnected', () => this.#readyTabs.clear());
  }

  async listTabs() {
    await this.#bridge.waitForConnection(CONNECT_TIMEOUT);
    return this.#bridge.request('listTabs');
  }

  /**
   * Picks the tab to inspect: the given one, or else the only Ember tab,
   * or else the active Ember tab of the focused window.
   */
  async resolveTab(tabId) {
    let tabs = await this.listTabs();

    if (tabId !== undefined) {
      let tab = tabs.find((tab) => tab.tabId === tabId);
      if (!tab) {
        throw new Error(
          `Tab ${tabId} is not running an Ember app. ${describeTabs(tabs)}`,
        );
      }
      return tab;
    }

    if (tabs.length === 1) return tabs[0];

    let active = tabs.find((tab) => tab.active);
    if (active) return active;

    throw new Error(
      tabs.length === 0
        ? 'No tab is running an Ember app. Open the app, or reload its tab.'
        : `Several tabs run Ember apps, pass a tabId. ${describeTabs(tabs)}`,
    );
  }

  /**
   * Sends a message to EmberDebug, and resolves with the first reply
   * that `isReply` accepts.
   *
   * Calls for one tab run one at a time, so a reply is never taken
   * by another call that waits for the same message type.
   */
  call(tab, message, isReply, { timeout = REPLY_TIMEOUT } = {}) {
    return this.#serialize(tab.tabId, async () => {
      await this.#ensureEmberDebug(tab);
      return this.#roundTrip(tab.tabId, message, isReply, timeout);
    });
  }

  /**
   * Sends a message that has no reply.
   */
  async send(tab, message) {
    await this.#bridge.request('send', { tabId: tab.tabId, message });
  }

  async #serialize(tabId, fn) {
    let previous = this.#queues.get(tabId) ?? Promise.resolve();
    let current = previous.catch(() => {}).then(fn);
    this.#queues.set(tabId, current);

    try {
      return await current;
    } finally {
      if (this.#queues.get(tabId) === current) {
        this.#queues.delete(tabId);
      }
    }
  }

  async #roundTrip(tabId, message, isReply, timeout) {
    let reply = this.#nextMessage(tabId, isReply, timeout, message.type);
    try {
      await this.#bridge.request('send', { tabId, message });
    } catch (error) {
      reply.cancel();
      throw error;
    }
    return reply.promise;
  }

  #nextMessage(tabId, isReply, timeout, label) {
    let cancel;

    let promise = new Promise((resolve, reject) => {
      let onMessage = (event) => {
        if (event.tabId !== tabId) return;

        let message = event.message;
        if (message && typeof message === 'object' && isReply(message)) {
          cleanup();
          resolve(message);
        }
      };

      let timer = setTimeout(() => {
        cleanup();
        reject(new ReplyTimeoutError(label));
      }, timeout);

      let cleanup = () => {
        clearTimeout(timer);
        this.#bridge.off('message', onMessage);
      };

      cancel = cleanup;
      this.#bridge.on('message', onMessage);
    });

    return { promise, cancel };
  }

  /**
   * Injects EmberDebug into the tab if the inspector panel has not already,
   * then waits until it has booted with the app.
   */
  async #ensureEmberDebug(tab) {
    if (this.#readyTabs.has(tab.tabId)) return;

    await this.#bridge.request('inject', { tabId: tab.tabId });

    let deadline = Date.now() + BOOT_TIMEOUT;

    while (Date.now() < deadline) {
      try {
        let reply = await this.#roundTrip(
          tab.tabId,
          { type: 'general:applicationBooted' },
          (message) => message.type === 'general:applicationBooted',
          500,
        );

        if (reply.booted) {
          this.#readyTabs.add(tab.tabId);
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
}

export class ReplyTimeoutError extends Error {
  constructor(label) {
    super(`EmberDebug did not answer ${label} in time`);
  }
}

function describeTabs(tabs) {
  if (tabs.length === 0) return 'No tab is running an Ember app.';

  return (
    'Ember tabs: ' +
    tabs.map((tab) => `${tab.tabId} (${tab.title} — ${tab.url})`).join(', ')
  );
}
