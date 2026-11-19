import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';

export const DEFAULT_PORT = 8743;

const EXTENSION_ORIGIN = /^(chrome|moz|safari-web)-extension:\/\//;
const PING_INTERVAL = 20_000;

/**
 * The Ember Inspector extension connects to this WebSocket server
 * from its background script.
 *
 * Only extension pages can connect. A web page cannot set its own `Origin`,
 * so a site the user visits cannot drive the inspected apps through here.
 *
 * Messages from the server are requests: `{ id, method, params }`,
 * answered with `{ id, result }` or `{ id, error }`.
 * Messages from the extension without an `id` are events, for example
 * `{ event: 'message', tabId, frameId, message }` for everything EmberDebug
 * posts in a tab.
 */
export class ExtensionBridge extends EventEmitter {
  #server = null;
  #socket = null;
  #nextId = 1;
  #pending = new Map();
  #pingTimer = null;

  constructor({ host = '127.0.0.1', port = DEFAULT_PORT } = {}) {
    super();
    this.host = host;
    this.port = port;
  }

  get isConnected() {
    return this.#socket !== null;
  }

  async start() {
    let server = new WebSocketServer({
      host: this.host,
      port: this.port,
      verifyClient: ({ origin }) => EXTENSION_ORIGIN.test(origin ?? ''),
    });

    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });

    this.port = server.address().port;
    this.#server = server;

    server.on('connection', (socket) => this.#accept(socket));

    this.#pingTimer = setInterval(() => {
      // Keeps the extension's service worker awake while connected.
      this.#socket?.send(JSON.stringify({ event: 'ping' }));
    }, PING_INTERVAL);
    this.#pingTimer.unref();
  }

  async stop() {
    clearInterval(this.#pingTimer);
    this.#socket?.close();
    await new Promise((resolve) => this.#server?.close(resolve) ?? resolve());
  }

  /**
   * Resolves once an extension is connected, or rejects after `timeout`.
   */
  async waitForConnection(timeout) {
    if (this.isConnected) return;

    await new Promise((resolve, reject) => {
      let timer = setTimeout(() => {
        this.off('connected', onConnected);
        reject(new NotConnectedError(this.port));
      }, timeout);

      let onConnected = () => {
        clearTimeout(timer);
        resolve();
      };

      this.once('connected', onConnected);
    });
  }

  request(method, params = {}, { timeout = 5000 } = {}) {
    let socket = this.#socket;

    if (!socket) {
      return Promise.reject(new NotConnectedError(this.port));
    }

    let id = this.#nextId++;

    return new Promise((resolve, reject) => {
      let timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`The extension did not answer ${method} in time`));
      }, timeout);

      this.#pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  #accept(socket) {
    // The latest browser wins, for example after the extension reloads.
    this.#socket?.close();
    this.#socket = socket;

    socket.on('message', (data) => {
      let payload;
      try {
        payload = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.#receive(payload);
    });

    socket.on('close', () => {
      if (this.#socket !== socket) return;

      this.#socket = null;
      for (let { reject, timer } of this.#pending.values()) {
        clearTimeout(timer);
        reject(new Error('The extension disconnected'));
      }
      this.#pending.clear();
      this.emit('disconnected');
    });

    this.emit('connected');
  }

  #receive(payload) {
    if (payload.id !== undefined) {
      let pending = this.#pending.get(payload.id);
      if (!pending) return;

      this.#pending.delete(payload.id);
      clearTimeout(pending.timer);

      if (payload.error) {
        pending.reject(new Error(payload.error));
      } else {
        pending.resolve(payload.result);
      }
    } else if (payload.event === 'message') {
      this.emit('message', payload);
    }
  }
}

export class NotConnectedError extends Error {
  constructor(port) {
    super(
      `The Ember Inspector extension is not connected to port ${port}. ` +
        'Open the extension options, turn on "Allow AI agents to connect (MCP)" ' +
        'with the same port, then reload the tab with the Ember app.',
    );
  }
}
