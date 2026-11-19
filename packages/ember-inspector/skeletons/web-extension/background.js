/*global chrome*/

/**
 * Long lived background script running in the browser, works in tandem with the
 * client-script to coordinate messaging between EmberDebug, EmberInspector and the
 * ClientApp. The background.js script serves as a proxy between the EmberInspector
 * and the content-script.
 *
 * It is also responsible for showing the Ember icon and tooltip in the url bar.
 *
 * See:
 *     https://developer.chrome.com/extensions/background_pages
 *     https://developer.chrome.com/extensions/messaging
 */
(function () {
  'use strict';

  var activeTabs = {},
    activeTabId,
    contextMenuAdded = false,
    emberInspectorChromePorts = {};

  /**
   * A tab has no content script on `about:` pages, on browser pages,
   * and in tabs that were open before the extension loaded.
   * A message to such a tab has nobody to receive it, which is expected.
   * Other errors still surface.
   */
  function ignoreMissingReceiver(error) {
    if (!/Receiving end does not exist/.test(error?.message)) {
      throw error;
    }
  }

  /**
   * Creates the tooltip string to show the version of libraries used in the ClientApp
   * @param  {Array} versions - array of library objects
   * @return {String} - string of library names and versions
   */
  function generateVersionsTooltip(versions) {
    return versions
      .map(function (lib) {
        return lib.name + ' ' + lib.version;
      })
      .join('\n');
  }

  /**
   * Creates the title for the action for the current ClientApp
   * @param {Number} tabId - the current tab
   */
  function setActionTitle(tabId) {
    void chrome.action.setTitle({
      tabId: tabId,
      title: generateVersionsTooltip(activeTabs[tabId]),
    });
  }

  /**
   * Update the tab's action: https://developer.chrome.com/extensions/pageAction
   * If the user has choosen to display it, the icon is shown and the title
   * is updated to display the ClientApp's information in the tooltip.
   * @param {Number} tabId - the current tab
   */
  function updateTabAction(tabId) {
    chrome.storage.sync.get('options', async function (data) {
      void chrome.action.enable(tabId);
      void chrome.action.setIcon({
        tabId,
        path: {
          19: '{{PANE_ROOT}}/assets/images/icon19.png',
          38: '{{PANE_ROOT}}/assets/images/icon38.png',
        },
      });
      setActionTitle(tabId);
    });
  }

  /**
   * Remove the curent tab's Ember icon.
   * Typically used to clearout the icon after reload.
   * @param {Number} tabId - the current tab
   */
  function hideAction(tabId) {
    if (!activeTabs[tabId]) {
      return;
    }

    void chrome.action.disable(tabId);
    void chrome.action.setIcon({
      tabId,
      path: {
        19: '{{PANE_ROOT}}/assets/images/icon19_grey.png',
        38: '{{PANE_ROOT}}/assets/images/icon38_grey.png',
      },
    });
  }

  function genericOnClick(info) {
    if (info.menuItemId !== 'inspect-ember-component') return;
    chrome.tabs
      .sendMessage(activeTabId, {
        from: 'devtools',
        type: 'view:contextMenu',
      })
      .catch(ignoreMissingReceiver);
  }

  chrome.contextMenus.onClicked.addListener(genericOnClick);

  /**
   * Update the tab's contextMenu: https://developer.chrome.com/extensions/contextMenus
   * Add a menu item called "Inspect Ember Component" that shows info
   * about the component in the inspector.
   * @param {Boolean} force don't use the activeTabs array to check for an existing context menu
   */
  function updateContextMenu(force) {
    // The Chromium that Electron runs does not have a chrome.contextMenus,
    // so make sure this doesn't throw an error in Electron
    if (!chrome.contextMenus) {
      return;
    }

    // Only add context menu item when an Ember app has been detected
    var isEmberApp = !!activeTabs[activeTabId] || force;
    if (!isEmberApp && contextMenuAdded) {
      chrome.contextMenus.remove('inspect-ember-component');
      contextMenuAdded = false;
    }

    if (isEmberApp && !contextMenuAdded) {
      chrome.contextMenus.create({
        id: 'inspect-ember-component',
        title: 'Inspect Ember Component',
        contexts: ['all'],
      });
      contextMenuAdded = true;
    }
  }

  /**
   * Listen for a connection request from the EmberInspector.
   * When the EmberInspector connects to the extension a messageListener
   * is added for the specific EmberInspector instance, and saved into
   * an array, keyed by appId.
   *
   * @param {Port} emberInspectorChromePort
   */
  chrome.runtime.onConnect.addListener(function (emberInspectorChromePort) {
    var appId;

    /**
     * Listen for messages from the EmberInspector.
     * The first message is used to save the port, all others are forwarded
     * to the content-script.
     * @param {Message} message
     */
    emberInspectorChromePort.onMessage.addListener(function (message) {
      // if the message contains the appId, this is the first
      // message and the appId is used to map the port for this app.
      if (message.appId) {
        appId = message.appId;

        emberInspectorChromePorts[appId] = emberInspectorChromePort;

        emberInspectorChromePort.onDisconnect.addListener(function () {
          delete emberInspectorChromePorts[appId];
        });
      } else if (message.from === 'devtools') {
        // all other messages from EmberInspector are forwarded to the content-script
        // https://developer.chrome.com/extensions/tabs#method-sendMessage
        chrome.tabs
          .sendMessage(message.tabId || appId, message, {
            frameId: message.frameId,
          })
          .catch(ignoreMissingReceiver);
      }
    });
  });

  /**
   * Listen for messages from the content-script.
   * A few events trigger specfic behavior, all others are forwarded to EmberInspector.
   * @param {Object} request
   * @param {MessageSender} sender
   */
  chrome.runtime.onMessage.addListener(function (request, sender) {
    // only listen to messages from the content-script
    if (!sender.tab) {
      // noop
    } else if (request && request.type === 'emberVersion') {
      // set the version info and update title
      activeTabs[sender.tab.id] = request.versions;
      saveActiveTabs();

      updateTabAction(sender.tab.id);
      updateContextMenu();
    } else if (request && request.type === 'resetEmberIcon') {
      // hide the Ember icon
      hideAction(sender.tab.id);
    } else if (request && request.type === 'inspectorLoaded') {
      updateContextMenu(true);
    } else {
      // forward the message to EmberInspector
      var emberInspectorChromePort = emberInspectorChromePorts[sender.tab.id];
      if (emberInspectorChromePort) {
        emberInspectorChromePort.postMessage(request);
      }
    }

    sendToMcp({
      event: 'message',
      tabId: sender.tab.id,
      frameId: sender.frameId,
      message: request,
    });
  });

  /**
   * Keep track of which browser tab is active and update the context menu.
   */
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    activeTabId = tabId;
    if (activeTabs[tabId]) {
      updateTabAction(tabId);
    }
    updateContextMenu();
  });

  /**
   * Only keep track of active tabs
   */
  chrome.tabs.onRemoved.addListener(({ tabId }) => {
    delete activeTabs[tabId];
  });

  /**
   * The service worker can stop at any time and loses `activeTabs` then.
   * The MCP bridge lists the Ember tabs from it, so keep a copy for the
   * browser session.
   */
  var activeTabsRestored = chrome.storage.session
    ? chrome.storage.session
        .get('activeTabs')
        .then(function (data) {
          activeTabs = Object.assign(data.activeTabs || {}, activeTabs);
        })
        .catch(function () {})
    : Promise.resolve();

  function saveActiveTabs() {
    if (chrome.storage.session) {
      void chrome.storage.session
        .set({ activeTabs: activeTabs })
        .catch(function () {});
    }
  }

  /**
   * MCP bridge
   *
   * When the user turns it on in the options, the background script connects
   * to the Ember Inspector MCP server on localhost (`ember-inspector-mcp`).
   * AI agents then debug the Ember apps in the browser through that server.
   *
   * The server sends requests, `{ id, method, params }`:
   * - `listTabs`: the tabs that run an Ember app.
   * - `inject`: injects EmberDebug into a tab, as the inspector panel does.
   * - `send`: sends a message to EmberDebug, as the inspector panel does.
   * Every message from EmberDebug goes to the server as an event,
   * `{ event: 'message', tabId, frameId, message }`.
   */
  var MCP_DEFAULT_PORT = 8743;
  var MCP_ALARM = 'ember-inspector-mcp';
  var mcpSocket = null;
  var mcpRetryTimer = null;
  var mcpRetryDelay = 1000;

  function sendToMcp(payload) {
    if (mcpSocket && mcpSocket.readyState === WebSocket.OPEN) {
      mcpSocket.send(JSON.stringify(payload));
    }
  }

  function getMcpOptions() {
    return chrome.storage.sync.get('options').then(function (data) {
      var options = data.options || {};
      return {
        enabled: options.mcpEnabled === true,
        port: Number(options.mcpPort) || MCP_DEFAULT_PORT,
      };
    });
  }

  function updateMcpConnection() {
    return getMcpOptions().then(function (options) {
      if (chrome.alarms) {
        if (options.enabled) {
          // Wakes the service worker up to reconnect when the server starts later.
          void chrome.alarms.create(MCP_ALARM, { periodInMinutes: 0.5 });
        } else {
          void chrome.alarms.clear(MCP_ALARM);
        }
      }

      if (!options.enabled) {
        disconnectMcp();
      } else if (mcpSocket && mcpSocket.port !== options.port) {
        disconnectMcp();
        connectMcp(options.port);
      } else if (!mcpSocket) {
        connectMcp(options.port);
      }
    });
  }

  function connectMcp(port) {
    clearTimeout(mcpRetryTimer);

    var socket = new WebSocket('ws://127.0.0.1:' + port);
    socket.port = port;
    mcpSocket = socket;

    socket.onopen = function () {
      mcpRetryDelay = 1000;
    };

    socket.onmessage = function (event) {
      var request;
      try {
        request = JSON.parse(event.data);
      } catch {
        return;
      }
      if (request.id === undefined) return;

      handleMcpRequest(request).then(
        function (result) {
          sendToMcp({ id: request.id, result: result === undefined ? null : result });
        },
        function (error) {
          sendToMcp({ id: request.id, error: String((error && error.message) || error) });
        },
      );
    };

    socket.onclose = function () {
      if (mcpSocket !== socket) return;

      mcpSocket = null;
      // Retry while the service worker is awake; the alarm covers the rest.
      mcpRetryTimer = setTimeout(updateMcpConnection, mcpRetryDelay);
      mcpRetryDelay = Math.min(mcpRetryDelay * 2, 30000);
    };
  }

  function disconnectMcp() {
    clearTimeout(mcpRetryTimer);
    if (mcpSocket) {
      var socket = mcpSocket;
      mcpSocket = null;
      socket.close();
    }
  }

  function handleMcpRequest(request) {
    var params = request.params || {};

    switch (request.method) {
      case 'listTabs':
        return listEmberTabs();

      case 'inject':
        return chrome.tabs
          .sendMessage(params.tabId, {
            type: 'inject-ember-debug',
            value: chrome.runtime.getURL('{{PANE_ROOT}}/ember_debug.js'),
          })
          .catch(ignoreMissingReceiver);

      case 'send':
        return chrome.tabs
          .sendMessage(
            params.tabId,
            Object.assign({}, params.message, { from: 'devtools' }),
          )
          .catch(ignoreMissingReceiver);

      default:
        return Promise.reject(new Error('Unknown method ' + request.method));
    }
  }

  function listEmberTabs() {
    var focusedTabId;

    return Promise.all([
      activeTabsRestored,
      chrome.tabs
        .query({ active: true, lastFocusedWindow: true })
        .then(function (tabs) {
          focusedTabId = tabs[0] && tabs[0].id;
        }),
    ]).then(function () {
      return Promise.all(
        Object.keys(activeTabs).map(function (id) {
          var tabId = Number(id);
          return chrome.tabs.get(tabId).then(
            function (tab) {
              return {
                tabId: tabId,
                active: tabId === focusedTabId,
                title: tab.title,
                url: tab.url,
                libraries: activeTabs[id],
                devtoolsOpen: !!emberInspectorChromePorts[tabId],
              };
            },
            function () {
              // The tab is gone.
              delete activeTabs[id];
              saveActiveTabs();
              return null;
            },
          );
        }),
      ).then(function (tabs) {
        return tabs.filter(Boolean);
      });
    });
  }

  if (chrome.alarms) {
    chrome.alarms.onAlarm.addListener(function (alarm) {
      if (alarm.name === MCP_ALARM) {
        void updateMcpConnection();
      }
    });
  }

  chrome.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName === 'sync' && changes.options) {
      void updateMcpConnection();
    }
  });

  void updateMcpConnection();
})();
