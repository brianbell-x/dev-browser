var background = (function () {
  "use strict";
  function defineBackground(arg) {
    if (arg == null || typeof arg === "function") return { main: arg };
    return arg;
  }
  const RELAY_URL = "ws://localhost:9222/extension";
  const tabs = /* @__PURE__ */ new Map();
  const childSessions = /* @__PURE__ */ new Map();
  let ws$1 = null;
  let nextSessionId = 1;
  const definition = defineBackground(() => {
    function sendLog(level, args) {
      sendMessage({
        method: "log",
        params: {
          level,
          args: args.map((arg) => {
            if (arg === void 0) return "undefined";
            if (arg === null) return "null";
            if (typeof arg === "object") {
              try {
                return JSON.stringify(arg);
              } catch {
                return String(arg);
              }
            }
            return String(arg);
          }),
        },
      });
    }
    const logger2 = {
      log: (...args) => {
        console.log("[dev-browser]", ...args);
        sendLog("log", args);
      },
      debug: (...args) => {
        console.debug("[dev-browser]", ...args);
        sendLog("debug", args);
      },
      error: (...args) => {
        console.error("[dev-browser]", ...args);
        sendLog("error", args);
      },
    };
    function sendMessage(message) {
      if (ws$1?.readyState === WebSocket.OPEN) {
        try {
          ws$1.send(JSON.stringify(message));
        } catch (error) {
          console.debug("Error sending message:", error);
        }
      }
    }
    function getTabBySessionId(sessionId) {
      for (const [tabId, tab] of tabs) {
        if (tab.sessionId === sessionId) {
          return { tabId, tab };
        }
      }
      return void 0;
    }
    function getTabByTargetId(targetId) {
      for (const [tabId, tab] of tabs) {
        if (tab.targetId === targetId) {
          return { tabId, tab };
        }
      }
      return void 0;
    }
    async function handleCommand(msg) {
      if (msg.method !== "forwardCDPCommand") return;
      let targetTabId;
      let targetTab;
      if (msg.params.sessionId) {
        const found = getTabBySessionId(msg.params.sessionId);
        if (found) {
          targetTabId = found.tabId;
          targetTab = found.tab;
        }
      }
      if (!targetTab && msg.params.sessionId) {
        const parentTabId = childSessions.get(msg.params.sessionId);
        if (parentTabId) {
          targetTabId = parentTabId;
          targetTab = tabs.get(parentTabId);
          logger2.debug(
            "Found parent tab for child session:",
            msg.params.sessionId,
            "tabId:",
            parentTabId
          );
        }
      }
      if (
        !targetTab &&
        msg.params.params &&
        typeof msg.params.params === "object" &&
        "targetId" in msg.params.params
      ) {
        const found = getTabByTargetId(msg.params.params.targetId);
        if (found) {
          targetTabId = found.tabId;
          targetTab = found.tab;
        }
      }
      const debuggee = targetTabId ? { tabId: targetTabId } : void 0;
      switch (msg.params.method) {
        case "Runtime.enable": {
          if (!debuggee) {
            throw new Error(
              `No debuggee found for Runtime.enable (sessionId: ${msg.params.sessionId})`
            );
          }
          try {
            await chrome.debugger.sendCommand(debuggee, "Runtime.disable");
            await new Promise((resolve) => setTimeout(resolve, 200));
          } catch {}
          return await chrome.debugger.sendCommand(debuggee, "Runtime.enable", msg.params.params);
        }
        case "Target.createTarget": {
          const url = msg.params.params?.url || "about:blank";
          logger2.debug("Creating new tab with URL:", url);
          const tab = await chrome.tabs.create({ url, active: false });
          if (!tab.id) throw new Error("Failed to create tab");
          await new Promise((resolve) => setTimeout(resolve, 100));
          const targetInfo = await attachTab(tab.id);
          return { targetId: targetInfo.targetId };
        }
        case "Target.closeTarget": {
          if (!targetTabId) {
            logger2.log(`Target not found: ${msg.params.params?.targetId}`);
            return { success: false };
          }
          await chrome.tabs.remove(targetTabId);
          return { success: true };
        }
      }
      if (!debuggee || !targetTab) {
        throw new Error(
          `No tab found for method ${msg.params.method} sessionId: ${msg.params.sessionId}`
        );
      }
      logger2.debug("CDP command:", msg.params.method, "for tab:", targetTabId);
      const debuggerSession = {
        ...debuggee,
        sessionId: msg.params.sessionId !== targetTab.sessionId ? msg.params.sessionId : void 0,
      };
      return await chrome.debugger.sendCommand(
        debuggerSession,
        msg.params.method,
        msg.params.params
      );
    }
    function onDebuggerEvent(source, method, params) {
      const tab = source.tabId ? tabs.get(source.tabId) : void 0;
      if (!tab) return;
      logger2.debug("Forwarding CDP event:", method, "from tab:", source.tabId);
      if (
        method === "Target.attachedToTarget" &&
        params &&
        typeof params === "object" &&
        "sessionId" in params
      ) {
        const sessionId = params.sessionId;
        logger2.debug("Child target attached:", sessionId, "for tab:", source.tabId);
        childSessions.set(sessionId, source.tabId);
      }
      if (
        method === "Target.detachedFromTarget" &&
        params &&
        typeof params === "object" &&
        "sessionId" in params
      ) {
        const sessionId = params.sessionId;
        logger2.debug("Child target detached:", sessionId);
        childSessions.delete(sessionId);
      }
      sendMessage({
        method: "forwardCDPEvent",
        params: {
          sessionId: source.sessionId || tab.sessionId,
          method,
          params,
        },
      });
    }
    function onDebuggerDetach(source, reason) {
      const tabId = source.tabId;
      if (!tabId || !tabs.has(tabId)) {
        return;
      }
      logger2.debug(`Debugger detached for tab ${tabId}: ${reason}`);
      const tab = tabs.get(tabId);
      if (tab) {
        sendMessage({
          method: "forwardCDPEvent",
          params: {
            method: "Target.detachedFromTarget",
            params: { sessionId: tab.sessionId, targetId: tab.targetId },
          },
        });
      }
      for (const [childSessionId, parentTabId] of childSessions) {
        if (parentTabId === tabId) {
          childSessions.delete(childSessionId);
        }
      }
      tabs.delete(tabId);
      void updateIcons();
    }
    async function attachTab(tabId) {
      const debuggee = { tabId };
      logger2.debug("Attaching debugger to tab:", tabId);
      await chrome.debugger.attach(debuggee, "1.3");
      const result2 = await chrome.debugger.sendCommand(debuggee, "Target.getTargetInfo");
      const targetInfo = result2.targetInfo;
      const sessionId = `pw-tab-${nextSessionId++}`;
      tabs.set(tabId, {
        sessionId,
        targetId: targetInfo.targetId,
        state: "connected",
      });
      sendMessage({
        method: "forwardCDPEvent",
        params: {
          method: "Target.attachedToTarget",
          params: {
            sessionId,
            targetInfo: { ...targetInfo, attached: true },
            waitingForDebugger: false,
          },
        },
      });
      logger2.log("Tab attached:", tabId, "sessionId:", sessionId, "url:", targetInfo.url);
      void updateIcons();
      return targetInfo;
    }
    function detachTab(tabId, shouldDetachDebugger) {
      const tab = tabs.get(tabId);
      if (!tab) return;
      logger2.debug("Detaching tab:", tabId);
      sendMessage({
        method: "forwardCDPEvent",
        params: {
          method: "Target.detachedFromTarget",
          params: { sessionId: tab.sessionId, targetId: tab.targetId },
        },
      });
      tabs.delete(tabId);
      for (const [childSessionId, parentTabId] of childSessions) {
        if (parentTabId === tabId) {
          childSessions.delete(childSessionId);
        }
      }
      if (shouldDetachDebugger) {
        chrome.debugger.detach({ tabId }).catch((err) => {
          logger2.debug("Error detaching debugger:", err);
        });
      }
      void updateIcons();
    }
    async function ensureConnection() {
      if (ws$1?.readyState === WebSocket.OPEN) {
        return;
      }
      logger2.debug("Connecting to relay server...");
      while (true) {
        try {
          await fetch("http://localhost:9222", { method: "HEAD" });
          break;
        } catch {
          logger2.debug("Server not available, retrying...");
          await new Promise((resolve) => setTimeout(resolve, 1e3));
        }
      }
      logger2.debug("Creating WebSocket connection");
      const socket = new WebSocket(RELAY_URL);
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Connection timeout"));
        }, 5e3);
        socket.onopen = () => {
          clearTimeout(timeout);
          resolve();
        };
        socket.onerror = () => {
          clearTimeout(timeout);
          reject(new Error("WebSocket connection failed"));
        };
        socket.onclose = (event) => {
          clearTimeout(timeout);
          reject(new Error(`WebSocket closed: ${event.reason || event.code}`));
        };
      });
      ws$1 = socket;
      ws$1.onmessage = async (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch (error) {
          logger2.debug("Error parsing message:", error);
          sendMessage({
            error: { code: -32700, message: "Parse error" },
          });
          return;
        }
        const response = { id: message.id };
        try {
          response.result = await handleCommand(message);
        } catch (error) {
          logger2.debug("Error handling command:", error);
          response.error = error.message;
        }
        sendMessage(response);
      };
      ws$1.onclose = (event) => {
        logger2.debug("Connection closed:", event.code, event.reason);
        for (const tabId of tabs.keys()) {
          chrome.debugger.detach({ tabId }).catch(() => {});
        }
        tabs.clear();
        childSessions.clear();
        ws$1 = null;
        void updateIcons();
      };
      ws$1.onerror = (event) => {
        logger2.debug("WebSocket error:", event);
      };
      chrome.debugger.onEvent.addListener(onDebuggerEvent);
      chrome.debugger.onDetach.addListener(onDebuggerDetach);
      logger2.log("Connected to relay server");
      void updateIcons();
    }
    async function updateIcons() {
      const allTabs = await chrome.tabs.query({});
      for (const tab of allTabs) {
        if (!tab.id) continue;
        const tabInfo = tabs.get(tab.id);
        const isConnected = tabInfo?.state === "connected";
        const isRestricted = isRestrictedUrl(tab.url);
        if (isConnected) {
          await chrome.action.setIcon({
            tabId: tab.id,
            path: {
              16: "/icons/icon-green-16.png",
              32: "/icons/icon-green-32.png",
              48: "/icons/icon-green-48.png",
              128: "/icons/icon-green-128.png",
            },
          });
          await chrome.action.setTitle({
            tabId: tab.id,
            title: "Connected - Click to disconnect",
          });
        } else if (isRestricted) {
          await chrome.action.setIcon({
            tabId: tab.id,
            path: {
              16: "/icons/icon-gray-16.png",
              32: "/icons/icon-gray-32.png",
              48: "/icons/icon-gray-48.png",
              128: "/icons/icon-gray-128.png",
            },
          });
          await chrome.action.setTitle({
            tabId: tab.id,
            title: "Cannot attach to this page",
          });
        } else {
          await chrome.action.setIcon({
            tabId: tab.id,
            path: {
              16: "/icons/icon-black-16.png",
              32: "/icons/icon-black-32.png",
              48: "/icons/icon-black-48.png",
              128: "/icons/icon-black-128.png",
            },
          });
          await chrome.action.setTitle({
            tabId: tab.id,
            title: "Click to attach debugger",
          });
        }
        const connectedCount = Array.from(tabs.values()).filter(
          (t) => t.state === "connected"
        ).length;
        if (connectedCount > 0) {
          await chrome.action.setBadgeText({
            tabId: tab.id,
            text: String(connectedCount),
          });
          await chrome.action.setBadgeBackgroundColor({
            tabId: tab.id,
            color: "#22c55e",
            // green
          });
        } else {
          await chrome.action.setBadgeText({ tabId: tab.id, text: "" });
        }
      }
    }
    function isRestrictedUrl(url) {
      if (!url) return true;
      const restrictedPrefixes = ["chrome://", "chrome-extension://", "devtools://", "edge://"];
      return restrictedPrefixes.some((prefix) => url.startsWith(prefix));
    }
    async function onActionClicked(tab) {
      if (!tab.id) {
        logger2.debug("No tab ID available");
        return;
      }
      if (isRestrictedUrl(tab.url)) {
        logger2.debug("Cannot attach to restricted URL:", tab.url);
        return;
      }
      const tabInfo = tabs.get(tab.id);
      if (tabInfo?.state === "connected") {
        detachTab(tab.id, true);
      } else {
        try {
          tabs.set(tab.id, { state: "connecting" });
          await updateIcons();
          await ensureConnection();
          await attachTab(tab.id);
        } catch (error) {
          logger2.error("Failed to connect:", error);
          tabs.set(tab.id, {
            state: "error",
            errorText: error.message,
          });
          await updateIcons();
        }
      }
    }
    chrome.action.onClicked.addListener(onActionClicked);
    chrome.tabs.onRemoved.addListener((tabId) => {
      if (tabs.has(tabId)) {
        logger2.debug("Tab closed:", tabId);
        detachTab(tabId, false);
      }
    });
    chrome.tabs.onUpdated.addListener(() => {
      void updateIcons();
    });
    chrome.debugger.getTargets().then((targets) => {
      const attached = targets.filter((t) => t.tabId && t.attached);
      if (attached.length > 0) {
        logger2.log(`Detaching ${attached.length} stale debugger connections`);
        for (const target of attached) {
          chrome.debugger.detach({ tabId: target.tabId }).catch(() => {});
        }
      }
    });
    logger2.log("Extension initialized");
    void updateIcons();
  });
  function initPlugins() {}
  const browser$1 = globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome;
  const browser = browser$1;
  var _MatchPattern = class {
    constructor(matchPattern) {
      if (matchPattern === "<all_urls>") {
        this.isAllUrls = true;
        this.protocolMatches = [..._MatchPattern.PROTOCOLS];
        this.hostnameMatch = "*";
        this.pathnameMatch = "*";
      } else {
        const groups = /(.*):\/\/(.*?)(\/.*)/.exec(matchPattern);
        if (groups == null) throw new InvalidMatchPattern(matchPattern, "Incorrect format");
        const [_, protocol, hostname, pathname] = groups;
        validateProtocol(matchPattern, protocol);
        validateHostname(matchPattern, hostname);
        this.protocolMatches = protocol === "*" ? ["http", "https"] : [protocol];
        this.hostnameMatch = hostname;
        this.pathnameMatch = pathname;
      }
    }
    includes(url) {
      if (this.isAllUrls) return true;
      const u =
        typeof url === "string" ? new URL(url) : url instanceof Location ? new URL(url.href) : url;
      return !!this.protocolMatches.find((protocol) => {
        if (protocol === "http") return this.isHttpMatch(u);
        if (protocol === "https") return this.isHttpsMatch(u);
        if (protocol === "file") return this.isFileMatch(u);
        if (protocol === "ftp") return this.isFtpMatch(u);
        if (protocol === "urn") return this.isUrnMatch(u);
      });
    }
    isHttpMatch(url) {
      return url.protocol === "http:" && this.isHostPathMatch(url);
    }
    isHttpsMatch(url) {
      return url.protocol === "https:" && this.isHostPathMatch(url);
    }
    isHostPathMatch(url) {
      if (!this.hostnameMatch || !this.pathnameMatch) return false;
      const hostnameMatchRegexs = [
        this.convertPatternToRegex(this.hostnameMatch),
        this.convertPatternToRegex(this.hostnameMatch.replace(/^\*\./, "")),
      ];
      const pathnameMatchRegex = this.convertPatternToRegex(this.pathnameMatch);
      return (
        !!hostnameMatchRegexs.find((regex) => regex.test(url.hostname)) &&
        pathnameMatchRegex.test(url.pathname)
      );
    }
    isFileMatch(url) {
      throw Error("Not implemented: file:// pattern matching. Open a PR to add support");
    }
    isFtpMatch(url) {
      throw Error("Not implemented: ftp:// pattern matching. Open a PR to add support");
    }
    isUrnMatch(url) {
      throw Error("Not implemented: urn:// pattern matching. Open a PR to add support");
    }
    convertPatternToRegex(pattern) {
      const escaped = this.escapeForRegex(pattern);
      const starsReplaced = escaped.replace(/\\\*/g, ".*");
      return RegExp(`^${starsReplaced}$`);
    }
    escapeForRegex(string) {
      return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  };
  var MatchPattern = _MatchPattern;
  MatchPattern.PROTOCOLS = ["http", "https", "file", "ftp", "urn"];
  var InvalidMatchPattern = class extends Error {
    constructor(matchPattern, reason) {
      super(`Invalid match pattern "${matchPattern}": ${reason}`);
    }
  };
  function validateProtocol(matchPattern, protocol) {
    if (!MatchPattern.PROTOCOLS.includes(protocol) && protocol !== "*")
      throw new InvalidMatchPattern(
        matchPattern,
        `${protocol} not a valid protocol (${MatchPattern.PROTOCOLS.join(", ")})`
      );
  }
  function validateHostname(matchPattern, hostname) {
    if (hostname.includes(":"))
      throw new InvalidMatchPattern(matchPattern, `Hostname cannot include a port`);
    if (hostname.includes("*") && hostname.length > 1 && !hostname.startsWith("*."))
      throw new InvalidMatchPattern(
        matchPattern,
        `If using a wildcard (*), it must go at the start of the hostname`
      );
  }
  function print(method, ...args) {
    if (typeof args[0] === "string") {
      const message = args.shift();
      method(`[wxt] ${message}`, ...args);
    } else {
      method("[wxt]", ...args);
    }
  }
  const logger = {
    debug: (...args) => print(console.debug, ...args),
    log: (...args) => print(console.log, ...args),
    warn: (...args) => print(console.warn, ...args),
    error: (...args) => print(console.error, ...args),
  };
  let ws;
  function getDevServerWebSocket() {
    if (ws == null) {
      const serverUrl = "ws://localhost:3001";
      logger.debug("Connecting to dev server @", serverUrl);
      ws = new WebSocket(serverUrl, "vite-hmr");
      ws.addWxtEventListener = ws.addEventListener.bind(ws);
      ws.sendCustom = (event, payload) =>
        ws?.send(JSON.stringify({ type: "custom", event, payload }));
      ws.addEventListener("open", () => {
        logger.debug("Connected to dev server");
      });
      ws.addEventListener("close", () => {
        logger.debug("Disconnected from dev server");
      });
      ws.addEventListener("error", (event) => {
        logger.error("Failed to connect to dev server", event);
      });
      ws.addEventListener("message", (e) => {
        try {
          const message = JSON.parse(e.data);
          if (message.type === "custom") {
            ws?.dispatchEvent(new CustomEvent(message.event, { detail: message.data }));
          }
        } catch (err) {
          logger.error("Failed to handle message", err);
        }
      });
    }
    return ws;
  }
  function keepServiceWorkerAlive() {
    setInterval(async () => {
      await browser.runtime.getPlatformInfo();
    }, 5e3);
  }
  function reloadContentScript(payload) {
    const manifest = browser.runtime.getManifest();
    if (manifest.manifest_version == 2) {
      void reloadContentScriptMv2();
    } else {
      void reloadContentScriptMv3(payload);
    }
  }
  async function reloadContentScriptMv3({ registration, contentScript }) {
    if (registration === "runtime") {
      await reloadRuntimeContentScriptMv3(contentScript);
    } else {
      await reloadManifestContentScriptMv3(contentScript);
    }
  }
  async function reloadManifestContentScriptMv3(contentScript) {
    const id = `wxt:${contentScript.js[0]}`;
    logger.log("Reloading content script:", contentScript);
    const registered = await browser.scripting.getRegisteredContentScripts();
    logger.debug("Existing scripts:", registered);
    const existing = registered.find((cs) => cs.id === id);
    if (existing) {
      logger.debug("Updating content script", existing);
      await browser.scripting.updateContentScripts([
        {
          ...contentScript,
          id,
          css: contentScript.css ?? [],
        },
      ]);
    } else {
      logger.debug("Registering new content script...");
      await browser.scripting.registerContentScripts([
        {
          ...contentScript,
          id,
          css: contentScript.css ?? [],
        },
      ]);
    }
    await reloadTabsForContentScript(contentScript);
  }
  async function reloadRuntimeContentScriptMv3(contentScript) {
    logger.log("Reloading content script:", contentScript);
    const registered = await browser.scripting.getRegisteredContentScripts();
    logger.debug("Existing scripts:", registered);
    const matches = registered.filter((cs) => {
      const hasJs = contentScript.js?.find((js) => cs.js?.includes(js));
      const hasCss = contentScript.css?.find((css) => cs.css?.includes(css));
      return hasJs || hasCss;
    });
    if (matches.length === 0) {
      logger.log("Content script is not registered yet, nothing to reload", contentScript);
      return;
    }
    await browser.scripting.updateContentScripts(matches);
    await reloadTabsForContentScript(contentScript);
  }
  async function reloadTabsForContentScript(contentScript) {
    const allTabs = await browser.tabs.query({});
    const matchPatterns = contentScript.matches.map((match) => new MatchPattern(match));
    const matchingTabs = allTabs.filter((tab) => {
      const url = tab.url;
      if (!url) return false;
      return !!matchPatterns.find((pattern) => pattern.includes(url));
    });
    await Promise.all(
      matchingTabs.map(async (tab) => {
        try {
          await browser.tabs.reload(tab.id);
        } catch (err) {
          logger.warn("Failed to reload tab:", err);
        }
      })
    );
  }
  async function reloadContentScriptMv2(_payload) {
    throw Error("TODO: reloadContentScriptMv2");
  }
  {
    try {
      const ws2 = getDevServerWebSocket();
      ws2.addWxtEventListener("wxt:reload-extension", () => {
        browser.runtime.reload();
      });
      ws2.addWxtEventListener("wxt:reload-content-script", (event) => {
        reloadContentScript(event.detail);
      });
      if (true) {
        ws2.addEventListener("open", () => ws2.sendCustom("wxt:background-initialized"));
        keepServiceWorkerAlive();
      }
    } catch (err) {
      logger.error("Failed to setup web socket connection with dev server", err);
    }
    browser.commands.onCommand.addListener((command) => {
      if (command === "wxt:reload-extension") {
        browser.runtime.reload();
      }
    });
  }
  let result;
  try {
    initPlugins();
    result = definition.main();
    if (result instanceof Promise) {
      console.warn("The background's main() function return a promise, but it must be synchronous");
    }
  } catch (err) {
    logger.error("The background crashed on startup!");
    throw err;
  }
  const result$1 = result;
  return result$1;
})();
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYmFja2dyb3VuZC5qcyIsInNvdXJjZXMiOlsiLi4vLi4vbm9kZV9tb2R1bGVzL3d4dC9kaXN0L3V0aWxzL2RlZmluZS1iYWNrZ3JvdW5kLm1qcyIsIi4uLy4uL2VudHJ5cG9pbnRzL2JhY2tncm91bmQudHMiLCIuLi8uLi9ub2RlX21vZHVsZXMvQHd4dC1kZXYvYnJvd3Nlci9zcmMvaW5kZXgubWpzIiwiLi4vLi4vbm9kZV9tb2R1bGVzL3d4dC9kaXN0L2Jyb3dzZXIubWpzIiwiLi4vLi4vbm9kZV9tb2R1bGVzL0B3ZWJleHQtY29yZS9tYXRjaC1wYXR0ZXJucy9saWIvaW5kZXguanMiXSwic291cmNlc0NvbnRlbnQiOlsiZXhwb3J0IGZ1bmN0aW9uIGRlZmluZUJhY2tncm91bmQoYXJnKSB7XG4gIGlmIChhcmcgPT0gbnVsbCB8fCB0eXBlb2YgYXJnID09PSBcImZ1bmN0aW9uXCIpIHJldHVybiB7IG1haW46IGFyZyB9O1xuICByZXR1cm4gYXJnO1xufVxuIiwiLyoqXG4gKiBkZXYtYnJvd3NlciBDaHJvbWUgRXh0ZW5zaW9uIEJhY2tncm91bmQgU2NyaXB0XG4gKlxuICogVGhpcyBleHRlbnNpb24gY29ubmVjdHMgdG8gdGhlIGRldi1icm93c2VyIHJlbGF5IHNlcnZlciBhbmQgYWxsb3dzXG4gKiBQbGF5d3JpZ2h0IGF1dG9tYXRpb24gb2YgdGhlIHVzZXIncyBleGlzdGluZyBicm93c2VyIHRhYnMuXG4gKi9cblxuaW1wb3J0IHR5cGUge1xuICBUYWJJbmZvLFxuICBFeHRlbnNpb25Db21tYW5kTWVzc2FnZSxcbiAgRXh0ZW5zaW9uUmVzcG9uc2VNZXNzYWdlLFxuICBUYXJnZXRJbmZvLFxufSBmcm9tIFwiLi4vdXRpbHMvdHlwZXNcIjtcblxuY29uc3QgUkVMQVlfVVJMID0gXCJ3czovL2xvY2FsaG9zdDo5MjIyL2V4dGVuc2lvblwiO1xuXG4vLyBTdGF0ZVxuY29uc3QgdGFicyA9IG5ldyBNYXA8bnVtYmVyLCBUYWJJbmZvPigpO1xuY29uc3QgY2hpbGRTZXNzaW9ucyA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7IC8vIHNlc3Npb25JZCAtPiBwYXJlbnRUYWJJZFxubGV0IHdzOiBXZWJTb2NrZXQgfCBudWxsID0gbnVsbDtcbmxldCBuZXh0U2Vzc2lvbklkID0gMTtcblxuZXhwb3J0IGRlZmF1bHQgZGVmaW5lQmFja2dyb3VuZCgoKSA9PiB7XG4gIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgLy8gTG9nZ2luZ1xuICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgZnVuY3Rpb24gc2VuZExvZyhsZXZlbDogc3RyaW5nLCBhcmdzOiB1bmtub3duW10pIHtcbiAgICBzZW5kTWVzc2FnZSh7XG4gICAgICBtZXRob2Q6IFwibG9nXCIsXG4gICAgICBwYXJhbXM6IHtcbiAgICAgICAgbGV2ZWwsXG4gICAgICAgIGFyZ3M6IGFyZ3MubWFwKChhcmcpID0+IHtcbiAgICAgICAgICBpZiAoYXJnID09PSB1bmRlZmluZWQpIHJldHVybiBcInVuZGVmaW5lZFwiO1xuICAgICAgICAgIGlmIChhcmcgPT09IG51bGwpIHJldHVybiBcIm51bGxcIjtcbiAgICAgICAgICBpZiAodHlwZW9mIGFyZyA9PT0gXCJvYmplY3RcIikge1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KGFyZyk7XG4gICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgcmV0dXJuIFN0cmluZyhhcmcpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4gU3RyaW5nKGFyZyk7XG4gICAgICAgIH0pLFxuICAgICAgfSxcbiAgICB9KTtcbiAgfVxuXG4gIGNvbnN0IGxvZ2dlciA9IHtcbiAgICBsb2c6ICguLi5hcmdzOiB1bmtub3duW10pID0+IHtcbiAgICAgIGNvbnNvbGUubG9nKFwiW2Rldi1icm93c2VyXVwiLCAuLi5hcmdzKTtcbiAgICAgIHNlbmRMb2coXCJsb2dcIiwgYXJncyk7XG4gICAgfSxcbiAgICBkZWJ1ZzogKC4uLmFyZ3M6IHVua25vd25bXSkgPT4ge1xuICAgICAgY29uc29sZS5kZWJ1ZyhcIltkZXYtYnJvd3Nlcl1cIiwgLi4uYXJncyk7XG4gICAgICBzZW5kTG9nKFwiZGVidWdcIiwgYXJncyk7XG4gICAgfSxcbiAgICBlcnJvcjogKC4uLmFyZ3M6IHVua25vd25bXSkgPT4ge1xuICAgICAgY29uc29sZS5lcnJvcihcIltkZXYtYnJvd3Nlcl1cIiwgLi4uYXJncyk7XG4gICAgICBzZW5kTG9nKFwiZXJyb3JcIiwgYXJncyk7XG4gICAgfSxcbiAgfTtcblxuICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gIC8vIFdlYlNvY2tldCBDb21tdW5pY2F0aW9uXG4gIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICBmdW5jdGlvbiBzZW5kTWVzc2FnZShtZXNzYWdlOiB1bmtub3duKTogdm9pZCB7XG4gICAgaWYgKHdzPy5yZWFkeVN0YXRlID09PSBXZWJTb2NrZXQuT1BFTikge1xuICAgICAgdHJ5IHtcbiAgICAgICAgd3Muc2VuZChKU09OLnN0cmluZ2lmeShtZXNzYWdlKSk7XG4gICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBjb25zb2xlLmRlYnVnKFwiRXJyb3Igc2VuZGluZyBtZXNzYWdlOlwiLCBlcnJvcik7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAvLyBUYWIvU2Vzc2lvbiBIZWxwZXJzXG4gIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICBmdW5jdGlvbiBnZXRUYWJCeVNlc3Npb25JZChcbiAgICBzZXNzaW9uSWQ6IHN0cmluZ1xuICApOiB7IHRhYklkOiBudW1iZXI7IHRhYjogVGFiSW5mbyB9IHwgdW5kZWZpbmVkIHtcbiAgICBmb3IgKGNvbnN0IFt0YWJJZCwgdGFiXSBvZiB0YWJzKSB7XG4gICAgICBpZiAodGFiLnNlc3Npb25JZCA9PT0gc2Vzc2lvbklkKSB7XG4gICAgICAgIHJldHVybiB7IHRhYklkLCB0YWIgfTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuXG4gIGZ1bmN0aW9uIGdldFRhYkJ5VGFyZ2V0SWQoXG4gICAgdGFyZ2V0SWQ6IHN0cmluZ1xuICApOiB7IHRhYklkOiBudW1iZXI7IHRhYjogVGFiSW5mbyB9IHwgdW5kZWZpbmVkIHtcbiAgICBmb3IgKGNvbnN0IFt0YWJJZCwgdGFiXSBvZiB0YWJzKSB7XG4gICAgICBpZiAodGFiLnRhcmdldElkID09PSB0YXJnZXRJZCkge1xuICAgICAgICByZXR1cm4geyB0YWJJZCwgdGFiIH07XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cblxuICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gIC8vIENEUCBDb21tYW5kIEhhbmRsaW5nXG4gIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICBhc3luYyBmdW5jdGlvbiBoYW5kbGVDb21tYW5kKFxuICAgIG1zZzogRXh0ZW5zaW9uQ29tbWFuZE1lc3NhZ2VcbiAgKTogUHJvbWlzZTx1bmtub3duPiB7XG4gICAgaWYgKG1zZy5tZXRob2QgIT09IFwiZm9yd2FyZENEUENvbW1hbmRcIikgcmV0dXJuO1xuXG4gICAgbGV0IHRhcmdldFRhYklkOiBudW1iZXIgfCB1bmRlZmluZWQ7XG4gICAgbGV0IHRhcmdldFRhYjogVGFiSW5mbyB8IHVuZGVmaW5lZDtcblxuICAgIC8vIEZpbmQgdGFyZ2V0IHRhYiBieSBzZXNzaW9uSWRcbiAgICBpZiAobXNnLnBhcmFtcy5zZXNzaW9uSWQpIHtcbiAgICAgIGNvbnN0IGZvdW5kID0gZ2V0VGFiQnlTZXNzaW9uSWQobXNnLnBhcmFtcy5zZXNzaW9uSWQpO1xuICAgICAgaWYgKGZvdW5kKSB7XG4gICAgICAgIHRhcmdldFRhYklkID0gZm91bmQudGFiSWQ7XG4gICAgICAgIHRhcmdldFRhYiA9IGZvdW5kLnRhYjtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBDaGVjayBjaGlsZCBzZXNzaW9ucyAoaWZyYW1lcywgd29ya2VycylcbiAgICBpZiAoIXRhcmdldFRhYiAmJiBtc2cucGFyYW1zLnNlc3Npb25JZCkge1xuICAgICAgY29uc3QgcGFyZW50VGFiSWQgPSBjaGlsZFNlc3Npb25zLmdldChtc2cucGFyYW1zLnNlc3Npb25JZCk7XG4gICAgICBpZiAocGFyZW50VGFiSWQpIHtcbiAgICAgICAgdGFyZ2V0VGFiSWQgPSBwYXJlbnRUYWJJZDtcbiAgICAgICAgdGFyZ2V0VGFiID0gdGFicy5nZXQocGFyZW50VGFiSWQpO1xuICAgICAgICBsb2dnZXIuZGVidWcoXG4gICAgICAgICAgXCJGb3VuZCBwYXJlbnQgdGFiIGZvciBjaGlsZCBzZXNzaW9uOlwiLFxuICAgICAgICAgIG1zZy5wYXJhbXMuc2Vzc2lvbklkLFxuICAgICAgICAgIFwidGFiSWQ6XCIsXG4gICAgICAgICAgcGFyZW50VGFiSWRcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBGaW5kIGJ5IHRhcmdldElkIGluIHBhcmFtc1xuICAgIGlmIChcbiAgICAgICF0YXJnZXRUYWIgJiZcbiAgICAgIG1zZy5wYXJhbXMucGFyYW1zICYmXG4gICAgICB0eXBlb2YgbXNnLnBhcmFtcy5wYXJhbXMgPT09IFwib2JqZWN0XCIgJiZcbiAgICAgIFwidGFyZ2V0SWRcIiBpbiBtc2cucGFyYW1zLnBhcmFtc1xuICAgICkge1xuICAgICAgY29uc3QgZm91bmQgPSBnZXRUYWJCeVRhcmdldElkKG1zZy5wYXJhbXMucGFyYW1zLnRhcmdldElkIGFzIHN0cmluZyk7XG4gICAgICBpZiAoZm91bmQpIHtcbiAgICAgICAgdGFyZ2V0VGFiSWQgPSBmb3VuZC50YWJJZDtcbiAgICAgICAgdGFyZ2V0VGFiID0gZm91bmQudGFiO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IGRlYnVnZ2VlID0gdGFyZ2V0VGFiSWQgPyB7IHRhYklkOiB0YXJnZXRUYWJJZCB9IDogdW5kZWZpbmVkO1xuXG4gICAgLy8gSGFuZGxlIHNwZWNpYWwgY29tbWFuZHNcbiAgICBzd2l0Y2ggKG1zZy5wYXJhbXMubWV0aG9kKSB7XG4gICAgICBjYXNlIFwiUnVudGltZS5lbmFibGVcIjoge1xuICAgICAgICBpZiAoIWRlYnVnZ2VlKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgYE5vIGRlYnVnZ2VlIGZvdW5kIGZvciBSdW50aW1lLmVuYWJsZSAoc2Vzc2lvbklkOiAke21zZy5wYXJhbXMuc2Vzc2lvbklkfSlgXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICAvLyBEaXNhYmxlIGFuZCByZS1lbmFibGUgdG8gcmVzZXQgc3RhdGVcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBhd2FpdCBjaHJvbWUuZGVidWdnZXIuc2VuZENvbW1hbmQoZGVidWdnZWUsIFwiUnVudGltZS5kaXNhYmxlXCIpO1xuICAgICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIDIwMCkpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAvLyBJZ25vcmUgZXJyb3JzXG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGF3YWl0IGNocm9tZS5kZWJ1Z2dlci5zZW5kQ29tbWFuZChcbiAgICAgICAgICBkZWJ1Z2dlZSxcbiAgICAgICAgICBcIlJ1bnRpbWUuZW5hYmxlXCIsXG4gICAgICAgICAgbXNnLnBhcmFtcy5wYXJhbXNcbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgY2FzZSBcIlRhcmdldC5jcmVhdGVUYXJnZXRcIjoge1xuICAgICAgICBjb25zdCB1cmwgPSAobXNnLnBhcmFtcy5wYXJhbXM/LnVybCBhcyBzdHJpbmcpIHx8IFwiYWJvdXQ6YmxhbmtcIjtcbiAgICAgICAgbG9nZ2VyLmRlYnVnKFwiQ3JlYXRpbmcgbmV3IHRhYiB3aXRoIFVSTDpcIiwgdXJsKTtcbiAgICAgICAgY29uc3QgdGFiID0gYXdhaXQgY2hyb21lLnRhYnMuY3JlYXRlKHsgdXJsLCBhY3RpdmU6IGZhbHNlIH0pO1xuICAgICAgICBpZiAoIXRhYi5pZCkgdGhyb3cgbmV3IEVycm9yKFwiRmFpbGVkIHRvIGNyZWF0ZSB0YWJcIik7XG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIDEwMCkpO1xuICAgICAgICBjb25zdCB0YXJnZXRJbmZvID0gYXdhaXQgYXR0YWNoVGFiKHRhYi5pZCk7XG4gICAgICAgIHJldHVybiB7IHRhcmdldElkOiB0YXJnZXRJbmZvLnRhcmdldElkIH07XG4gICAgICB9XG5cbiAgICAgIGNhc2UgXCJUYXJnZXQuY2xvc2VUYXJnZXRcIjoge1xuICAgICAgICBpZiAoIXRhcmdldFRhYklkKSB7XG4gICAgICAgICAgbG9nZ2VyLmxvZyhgVGFyZ2V0IG5vdCBmb3VuZDogJHttc2cucGFyYW1zLnBhcmFtcz8udGFyZ2V0SWR9YCk7XG4gICAgICAgICAgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UgfTtcbiAgICAgICAgfVxuICAgICAgICBhd2FpdCBjaHJvbWUudGFicy5yZW1vdmUodGFyZ2V0VGFiSWQpO1xuICAgICAgICByZXR1cm4geyBzdWNjZXNzOiB0cnVlIH07XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKCFkZWJ1Z2dlZSB8fCAhdGFyZ2V0VGFiKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBObyB0YWIgZm91bmQgZm9yIG1ldGhvZCAke21zZy5wYXJhbXMubWV0aG9kfSBzZXNzaW9uSWQ6ICR7bXNnLnBhcmFtcy5zZXNzaW9uSWR9YFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBsb2dnZXIuZGVidWcoXCJDRFAgY29tbWFuZDpcIiwgbXNnLnBhcmFtcy5tZXRob2QsIFwiZm9yIHRhYjpcIiwgdGFyZ2V0VGFiSWQpO1xuXG4gICAgY29uc3QgZGVidWdnZXJTZXNzaW9uOiBjaHJvbWUuZGVidWdnZXIuRGVidWdnZXJTZXNzaW9uID0ge1xuICAgICAgLi4uZGVidWdnZWUsXG4gICAgICBzZXNzaW9uSWQ6XG4gICAgICAgIG1zZy5wYXJhbXMuc2Vzc2lvbklkICE9PSB0YXJnZXRUYWIuc2Vzc2lvbklkXG4gICAgICAgICAgPyBtc2cucGFyYW1zLnNlc3Npb25JZFxuICAgICAgICAgIDogdW5kZWZpbmVkLFxuICAgIH07XG5cbiAgICByZXR1cm4gYXdhaXQgY2hyb21lLmRlYnVnZ2VyLnNlbmRDb21tYW5kKFxuICAgICAgZGVidWdnZXJTZXNzaW9uLFxuICAgICAgbXNnLnBhcmFtcy5tZXRob2QsXG4gICAgICBtc2cucGFyYW1zLnBhcmFtc1xuICAgICk7XG4gIH1cblxuICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gIC8vIENocm9tZSBEZWJ1Z2dlciBFdmVudHNcbiAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gIGZ1bmN0aW9uIG9uRGVidWdnZXJFdmVudChcbiAgICBzb3VyY2U6IGNocm9tZS5kZWJ1Z2dlci5EZWJ1Z2dlclNlc3Npb24sXG4gICAgbWV0aG9kOiBzdHJpbmcsXG4gICAgcGFyYW1zOiB1bmtub3duXG4gICk6IHZvaWQge1xuICAgIGNvbnN0IHRhYiA9IHNvdXJjZS50YWJJZCA/IHRhYnMuZ2V0KHNvdXJjZS50YWJJZCkgOiB1bmRlZmluZWQ7XG4gICAgaWYgKCF0YWIpIHJldHVybjtcblxuICAgIGxvZ2dlci5kZWJ1ZyhcIkZvcndhcmRpbmcgQ0RQIGV2ZW50OlwiLCBtZXRob2QsIFwiZnJvbSB0YWI6XCIsIHNvdXJjZS50YWJJZCk7XG5cbiAgICAvLyBUcmFjayBjaGlsZCBzZXNzaW9uc1xuICAgIGlmIChcbiAgICAgIG1ldGhvZCA9PT0gXCJUYXJnZXQuYXR0YWNoZWRUb1RhcmdldFwiICYmXG4gICAgICBwYXJhbXMgJiZcbiAgICAgIHR5cGVvZiBwYXJhbXMgPT09IFwib2JqZWN0XCIgJiZcbiAgICAgIFwic2Vzc2lvbklkXCIgaW4gcGFyYW1zXG4gICAgKSB7XG4gICAgICBjb25zdCBzZXNzaW9uSWQgPSAocGFyYW1zIGFzIHsgc2Vzc2lvbklkOiBzdHJpbmcgfSkuc2Vzc2lvbklkO1xuICAgICAgbG9nZ2VyLmRlYnVnKFxuICAgICAgICBcIkNoaWxkIHRhcmdldCBhdHRhY2hlZDpcIixcbiAgICAgICAgc2Vzc2lvbklkLFxuICAgICAgICBcImZvciB0YWI6XCIsXG4gICAgICAgIHNvdXJjZS50YWJJZFxuICAgICAgKTtcbiAgICAgIGNoaWxkU2Vzc2lvbnMuc2V0KHNlc3Npb25JZCwgc291cmNlLnRhYklkISk7XG4gICAgfVxuXG4gICAgaWYgKFxuICAgICAgbWV0aG9kID09PSBcIlRhcmdldC5kZXRhY2hlZEZyb21UYXJnZXRcIiAmJlxuICAgICAgcGFyYW1zICYmXG4gICAgICB0eXBlb2YgcGFyYW1zID09PSBcIm9iamVjdFwiICYmXG4gICAgICBcInNlc3Npb25JZFwiIGluIHBhcmFtc1xuICAgICkge1xuICAgICAgY29uc3Qgc2Vzc2lvbklkID0gKHBhcmFtcyBhcyB7IHNlc3Npb25JZDogc3RyaW5nIH0pLnNlc3Npb25JZDtcbiAgICAgIGxvZ2dlci5kZWJ1ZyhcIkNoaWxkIHRhcmdldCBkZXRhY2hlZDpcIiwgc2Vzc2lvbklkKTtcbiAgICAgIGNoaWxkU2Vzc2lvbnMuZGVsZXRlKHNlc3Npb25JZCk7XG4gICAgfVxuXG4gICAgc2VuZE1lc3NhZ2Uoe1xuICAgICAgbWV0aG9kOiBcImZvcndhcmRDRFBFdmVudFwiLFxuICAgICAgcGFyYW1zOiB7XG4gICAgICAgIHNlc3Npb25JZDogc291cmNlLnNlc3Npb25JZCB8fCB0YWIuc2Vzc2lvbklkLFxuICAgICAgICBtZXRob2QsXG4gICAgICAgIHBhcmFtcyxcbiAgICAgIH0sXG4gICAgfSk7XG4gIH1cblxuICBmdW5jdGlvbiBvbkRlYnVnZ2VyRGV0YWNoKFxuICAgIHNvdXJjZTogY2hyb21lLmRlYnVnZ2VyLkRlYnVnZ2VlLFxuICAgIHJlYXNvbjogYCR7Y2hyb21lLmRlYnVnZ2VyLkRldGFjaFJlYXNvbn1gXG4gICk6IHZvaWQge1xuICAgIGNvbnN0IHRhYklkID0gc291cmNlLnRhYklkO1xuICAgIGlmICghdGFiSWQgfHwgIXRhYnMuaGFzKHRhYklkKSkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGxvZ2dlci5kZWJ1ZyhgRGVidWdnZXIgZGV0YWNoZWQgZm9yIHRhYiAke3RhYklkfTogJHtyZWFzb259YCk7XG5cbiAgICBjb25zdCB0YWIgPSB0YWJzLmdldCh0YWJJZCk7XG4gICAgaWYgKHRhYikge1xuICAgICAgc2VuZE1lc3NhZ2Uoe1xuICAgICAgICBtZXRob2Q6IFwiZm9yd2FyZENEUEV2ZW50XCIsXG4gICAgICAgIHBhcmFtczoge1xuICAgICAgICAgIG1ldGhvZDogXCJUYXJnZXQuZGV0YWNoZWRGcm9tVGFyZ2V0XCIsXG4gICAgICAgICAgcGFyYW1zOiB7IHNlc3Npb25JZDogdGFiLnNlc3Npb25JZCwgdGFyZ2V0SWQ6IHRhYi50YXJnZXRJZCB9LFxuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gQ2xlYW4gdXAgY2hpbGQgc2Vzc2lvbnNcbiAgICBmb3IgKGNvbnN0IFtjaGlsZFNlc3Npb25JZCwgcGFyZW50VGFiSWRdIG9mIGNoaWxkU2Vzc2lvbnMpIHtcbiAgICAgIGlmIChwYXJlbnRUYWJJZCA9PT0gdGFiSWQpIHtcbiAgICAgICAgY2hpbGRTZXNzaW9ucy5kZWxldGUoY2hpbGRTZXNzaW9uSWQpO1xuICAgICAgfVxuICAgIH1cblxuICAgIHRhYnMuZGVsZXRlKHRhYklkKTtcbiAgICB2b2lkIHVwZGF0ZUljb25zKCk7XG4gIH1cblxuICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gIC8vIFRhYiBBdHRhY2htZW50XG4gIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICBhc3luYyBmdW5jdGlvbiBhdHRhY2hUYWIodGFiSWQ6IG51bWJlcik6IFByb21pc2U8VGFyZ2V0SW5mbz4ge1xuICAgIGNvbnN0IGRlYnVnZ2VlID0geyB0YWJJZCB9O1xuXG4gICAgbG9nZ2VyLmRlYnVnKFwiQXR0YWNoaW5nIGRlYnVnZ2VyIHRvIHRhYjpcIiwgdGFiSWQpO1xuICAgIGF3YWl0IGNocm9tZS5kZWJ1Z2dlci5hdHRhY2goZGVidWdnZWUsIFwiMS4zXCIpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gKGF3YWl0IGNocm9tZS5kZWJ1Z2dlci5zZW5kQ29tbWFuZChcbiAgICAgIGRlYnVnZ2VlLFxuICAgICAgXCJUYXJnZXQuZ2V0VGFyZ2V0SW5mb1wiXG4gICAgKSkgYXMgeyB0YXJnZXRJbmZvOiBUYXJnZXRJbmZvIH07XG5cbiAgICBjb25zdCB0YXJnZXRJbmZvID0gcmVzdWx0LnRhcmdldEluZm87XG4gICAgY29uc3Qgc2Vzc2lvbklkID0gYHB3LXRhYi0ke25leHRTZXNzaW9uSWQrK31gO1xuXG4gICAgdGFicy5zZXQodGFiSWQsIHtcbiAgICAgIHNlc3Npb25JZCxcbiAgICAgIHRhcmdldElkOiB0YXJnZXRJbmZvLnRhcmdldElkLFxuICAgICAgc3RhdGU6IFwiY29ubmVjdGVkXCIsXG4gICAgfSk7XG5cbiAgICAvLyBOb3RpZnkgcmVsYXkgb2YgbmV3IHRhcmdldFxuICAgIHNlbmRNZXNzYWdlKHtcbiAgICAgIG1ldGhvZDogXCJmb3J3YXJkQ0RQRXZlbnRcIixcbiAgICAgIHBhcmFtczoge1xuICAgICAgICBtZXRob2Q6IFwiVGFyZ2V0LmF0dGFjaGVkVG9UYXJnZXRcIixcbiAgICAgICAgcGFyYW1zOiB7XG4gICAgICAgICAgc2Vzc2lvbklkLFxuICAgICAgICAgIHRhcmdldEluZm86IHsgLi4udGFyZ2V0SW5mbywgYXR0YWNoZWQ6IHRydWUgfSxcbiAgICAgICAgICB3YWl0aW5nRm9yRGVidWdnZXI6IGZhbHNlLFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGxvZ2dlci5sb2coXG4gICAgICBcIlRhYiBhdHRhY2hlZDpcIixcbiAgICAgIHRhYklkLFxuICAgICAgXCJzZXNzaW9uSWQ6XCIsXG4gICAgICBzZXNzaW9uSWQsXG4gICAgICBcInVybDpcIixcbiAgICAgIHRhcmdldEluZm8udXJsXG4gICAgKTtcbiAgICB2b2lkIHVwZGF0ZUljb25zKCk7XG4gICAgcmV0dXJuIHRhcmdldEluZm87XG4gIH1cblxuICBmdW5jdGlvbiBkZXRhY2hUYWIodGFiSWQ6IG51bWJlciwgc2hvdWxkRGV0YWNoRGVidWdnZXI6IGJvb2xlYW4pOiB2b2lkIHtcbiAgICBjb25zdCB0YWIgPSB0YWJzLmdldCh0YWJJZCk7XG4gICAgaWYgKCF0YWIpIHJldHVybjtcblxuICAgIGxvZ2dlci5kZWJ1ZyhcIkRldGFjaGluZyB0YWI6XCIsIHRhYklkKTtcblxuICAgIHNlbmRNZXNzYWdlKHtcbiAgICAgIG1ldGhvZDogXCJmb3J3YXJkQ0RQRXZlbnRcIixcbiAgICAgIHBhcmFtczoge1xuICAgICAgICBtZXRob2Q6IFwiVGFyZ2V0LmRldGFjaGVkRnJvbVRhcmdldFwiLFxuICAgICAgICBwYXJhbXM6IHsgc2Vzc2lvbklkOiB0YWIuc2Vzc2lvbklkLCB0YXJnZXRJZDogdGFiLnRhcmdldElkIH0sXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgdGFicy5kZWxldGUodGFiSWQpO1xuXG4gICAgLy8gQ2xlYW4gdXAgY2hpbGQgc2Vzc2lvbnNcbiAgICBmb3IgKGNvbnN0IFtjaGlsZFNlc3Npb25JZCwgcGFyZW50VGFiSWRdIG9mIGNoaWxkU2Vzc2lvbnMpIHtcbiAgICAgIGlmIChwYXJlbnRUYWJJZCA9PT0gdGFiSWQpIHtcbiAgICAgICAgY2hpbGRTZXNzaW9ucy5kZWxldGUoY2hpbGRTZXNzaW9uSWQpO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChzaG91bGREZXRhY2hEZWJ1Z2dlcikge1xuICAgICAgY2hyb21lLmRlYnVnZ2VyLmRldGFjaCh7IHRhYklkIH0pLmNhdGNoKChlcnIpID0+IHtcbiAgICAgICAgbG9nZ2VyLmRlYnVnKFwiRXJyb3IgZGV0YWNoaW5nIGRlYnVnZ2VyOlwiLCBlcnIpO1xuICAgICAgfSk7XG4gICAgfVxuXG4gICAgdm9pZCB1cGRhdGVJY29ucygpO1xuICB9XG5cbiAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAvLyBXZWJTb2NrZXQgQ29ubmVjdGlvblxuICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgYXN5bmMgZnVuY3Rpb24gZW5zdXJlQ29ubmVjdGlvbigpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAod3M/LnJlYWR5U3RhdGUgPT09IFdlYlNvY2tldC5PUEVOKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgbG9nZ2VyLmRlYnVnKFwiQ29ubmVjdGluZyB0byByZWxheSBzZXJ2ZXIuLi5cIik7XG5cbiAgICAvLyBXYWl0IGZvciBzZXJ2ZXIgdG8gYmUgYXZhaWxhYmxlXG4gICAgd2hpbGUgKHRydWUpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IGZldGNoKFwiaHR0cDovL2xvY2FsaG9zdDo5MjIyXCIsIHsgbWV0aG9kOiBcIkhFQURcIiB9KTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgbG9nZ2VyLmRlYnVnKFwiU2VydmVyIG5vdCBhdmFpbGFibGUsIHJldHJ5aW5nLi4uXCIpO1xuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4gc2V0VGltZW91dChyZXNvbHZlLCAxMDAwKSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgbG9nZ2VyLmRlYnVnKFwiQ3JlYXRpbmcgV2ViU29ja2V0IGNvbm5lY3Rpb25cIik7XG4gICAgY29uc3Qgc29ja2V0ID0gbmV3IFdlYlNvY2tldChSRUxBWV9VUkwpO1xuXG4gICAgYXdhaXQgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgY29uc3QgdGltZW91dCA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICByZWplY3QobmV3IEVycm9yKFwiQ29ubmVjdGlvbiB0aW1lb3V0XCIpKTtcbiAgICAgIH0sIDUwMDApO1xuXG4gICAgICBzb2NrZXQub25vcGVuID0gKCkgPT4ge1xuICAgICAgICBjbGVhclRpbWVvdXQodGltZW91dCk7XG4gICAgICAgIHJlc29sdmUoKTtcbiAgICAgIH07XG5cbiAgICAgIHNvY2tldC5vbmVycm9yID0gKCkgPT4ge1xuICAgICAgICBjbGVhclRpbWVvdXQodGltZW91dCk7XG4gICAgICAgIHJlamVjdChuZXcgRXJyb3IoXCJXZWJTb2NrZXQgY29ubmVjdGlvbiBmYWlsZWRcIikpO1xuICAgICAgfTtcblxuICAgICAgc29ja2V0Lm9uY2xvc2UgPSAoZXZlbnQpID0+IHtcbiAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVvdXQpO1xuICAgICAgICByZWplY3QobmV3IEVycm9yKGBXZWJTb2NrZXQgY2xvc2VkOiAke2V2ZW50LnJlYXNvbiB8fCBldmVudC5jb2RlfWApKTtcbiAgICAgIH07XG4gICAgfSk7XG5cbiAgICB3cyA9IHNvY2tldDtcblxuICAgIHdzLm9ubWVzc2FnZSA9IGFzeW5jIChldmVudDogTWVzc2FnZUV2ZW50KSA9PiB7XG4gICAgICBsZXQgbWVzc2FnZTogRXh0ZW5zaW9uQ29tbWFuZE1lc3NhZ2U7XG4gICAgICB0cnkge1xuICAgICAgICBtZXNzYWdlID0gSlNPTi5wYXJzZShldmVudC5kYXRhKTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGxvZ2dlci5kZWJ1ZyhcIkVycm9yIHBhcnNpbmcgbWVzc2FnZTpcIiwgZXJyb3IpO1xuICAgICAgICBzZW5kTWVzc2FnZSh7XG4gICAgICAgICAgZXJyb3I6IHsgY29kZTogLTMyNzAwLCBtZXNzYWdlOiBcIlBhcnNlIGVycm9yXCIgfSxcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgY29uc3QgcmVzcG9uc2U6IEV4dGVuc2lvblJlc3BvbnNlTWVzc2FnZSA9IHsgaWQ6IG1lc3NhZ2UuaWQgfTtcbiAgICAgIHRyeSB7XG4gICAgICAgIHJlc3BvbnNlLnJlc3VsdCA9IGF3YWl0IGhhbmRsZUNvbW1hbmQobWVzc2FnZSk7XG4gICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBsb2dnZXIuZGVidWcoXCJFcnJvciBoYW5kbGluZyBjb21tYW5kOlwiLCBlcnJvcik7XG4gICAgICAgIHJlc3BvbnNlLmVycm9yID0gKGVycm9yIGFzIEVycm9yKS5tZXNzYWdlO1xuICAgICAgfVxuICAgICAgc2VuZE1lc3NhZ2UocmVzcG9uc2UpO1xuICAgIH07XG5cbiAgICB3cy5vbmNsb3NlID0gKGV2ZW50OiBDbG9zZUV2ZW50KSA9PiB7XG4gICAgICBsb2dnZXIuZGVidWcoXCJDb25uZWN0aW9uIGNsb3NlZDpcIiwgZXZlbnQuY29kZSwgZXZlbnQucmVhc29uKTtcblxuICAgICAgLy8gRGV0YWNoIGFsbCB0YWJzIG9uIGRpc2Nvbm5lY3RcbiAgICAgIGZvciAoY29uc3QgdGFiSWQgb2YgdGFicy5rZXlzKCkpIHtcbiAgICAgICAgY2hyb21lLmRlYnVnZ2VyLmRldGFjaCh7IHRhYklkIH0pLmNhdGNoKCgpID0+IHt9KTtcbiAgICAgIH1cbiAgICAgIHRhYnMuY2xlYXIoKTtcbiAgICAgIGNoaWxkU2Vzc2lvbnMuY2xlYXIoKTtcbiAgICAgIHdzID0gbnVsbDtcblxuICAgICAgdm9pZCB1cGRhdGVJY29ucygpO1xuICAgIH07XG5cbiAgICB3cy5vbmVycm9yID0gKGV2ZW50OiBFdmVudCkgPT4ge1xuICAgICAgbG9nZ2VyLmRlYnVnKFwiV2ViU29ja2V0IGVycm9yOlwiLCBldmVudCk7XG4gICAgfTtcblxuICAgIC8vIFNldCB1cCBkZWJ1Z2dlciBldmVudCBsaXN0ZW5lcnNcbiAgICBjaHJvbWUuZGVidWdnZXIub25FdmVudC5hZGRMaXN0ZW5lcihvbkRlYnVnZ2VyRXZlbnQpO1xuICAgIGNocm9tZS5kZWJ1Z2dlci5vbkRldGFjaC5hZGRMaXN0ZW5lcihvbkRlYnVnZ2VyRGV0YWNoKTtcblxuICAgIGxvZ2dlci5sb2coXCJDb25uZWN0ZWQgdG8gcmVsYXkgc2VydmVyXCIpO1xuICAgIHZvaWQgdXBkYXRlSWNvbnMoKTtcbiAgfVxuXG4gIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgLy8gSWNvbiBTdGF0ZSBNYW5hZ2VtZW50XG4gIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICBhc3luYyBmdW5jdGlvbiB1cGRhdGVJY29ucygpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCBhbGxUYWJzID0gYXdhaXQgY2hyb21lLnRhYnMucXVlcnkoe30pO1xuXG4gICAgZm9yIChjb25zdCB0YWIgb2YgYWxsVGFicykge1xuICAgICAgaWYgKCF0YWIuaWQpIGNvbnRpbnVlO1xuXG4gICAgICBjb25zdCB0YWJJbmZvID0gdGFicy5nZXQodGFiLmlkKTtcbiAgICAgIGNvbnN0IGlzQ29ubmVjdGVkID0gdGFiSW5mbz8uc3RhdGUgPT09IFwiY29ubmVjdGVkXCI7XG4gICAgICBjb25zdCBpc1Jlc3RyaWN0ZWQgPSBpc1Jlc3RyaWN0ZWRVcmwodGFiLnVybCk7XG5cbiAgICAgIC8vIFNldCBpY29uIGNvbG9yIGJhc2VkIG9uIHN0YXRlXG4gICAgICBpZiAoaXNDb25uZWN0ZWQpIHtcbiAgICAgICAgYXdhaXQgY2hyb21lLmFjdGlvbi5zZXRJY29uKHtcbiAgICAgICAgICB0YWJJZDogdGFiLmlkLFxuICAgICAgICAgIHBhdGg6IHtcbiAgICAgICAgICAgIDE2OiBcIi9pY29ucy9pY29uLWdyZWVuLTE2LnBuZ1wiLFxuICAgICAgICAgICAgMzI6IFwiL2ljb25zL2ljb24tZ3JlZW4tMzIucG5nXCIsXG4gICAgICAgICAgICA0ODogXCIvaWNvbnMvaWNvbi1ncmVlbi00OC5wbmdcIixcbiAgICAgICAgICAgIDEyODogXCIvaWNvbnMvaWNvbi1ncmVlbi0xMjgucG5nXCIsXG4gICAgICAgICAgfSxcbiAgICAgICAgfSk7XG4gICAgICAgIGF3YWl0IGNocm9tZS5hY3Rpb24uc2V0VGl0bGUoe1xuICAgICAgICAgIHRhYklkOiB0YWIuaWQsXG4gICAgICAgICAgdGl0bGU6IFwiQ29ubmVjdGVkIC0gQ2xpY2sgdG8gZGlzY29ubmVjdFwiLFxuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSBpZiAoaXNSZXN0cmljdGVkKSB7XG4gICAgICAgIGF3YWl0IGNocm9tZS5hY3Rpb24uc2V0SWNvbih7XG4gICAgICAgICAgdGFiSWQ6IHRhYi5pZCxcbiAgICAgICAgICBwYXRoOiB7XG4gICAgICAgICAgICAxNjogXCIvaWNvbnMvaWNvbi1ncmF5LTE2LnBuZ1wiLFxuICAgICAgICAgICAgMzI6IFwiL2ljb25zL2ljb24tZ3JheS0zMi5wbmdcIixcbiAgICAgICAgICAgIDQ4OiBcIi9pY29ucy9pY29uLWdyYXktNDgucG5nXCIsXG4gICAgICAgICAgICAxMjg6IFwiL2ljb25zL2ljb24tZ3JheS0xMjgucG5nXCIsXG4gICAgICAgICAgfSxcbiAgICAgICAgfSk7XG4gICAgICAgIGF3YWl0IGNocm9tZS5hY3Rpb24uc2V0VGl0bGUoe1xuICAgICAgICAgIHRhYklkOiB0YWIuaWQsXG4gICAgICAgICAgdGl0bGU6IFwiQ2Fubm90IGF0dGFjaCB0byB0aGlzIHBhZ2VcIixcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBhd2FpdCBjaHJvbWUuYWN0aW9uLnNldEljb24oe1xuICAgICAgICAgIHRhYklkOiB0YWIuaWQsXG4gICAgICAgICAgcGF0aDoge1xuICAgICAgICAgICAgMTY6IFwiL2ljb25zL2ljb24tYmxhY2stMTYucG5nXCIsXG4gICAgICAgICAgICAzMjogXCIvaWNvbnMvaWNvbi1ibGFjay0zMi5wbmdcIixcbiAgICAgICAgICAgIDQ4OiBcIi9pY29ucy9pY29uLWJsYWNrLTQ4LnBuZ1wiLFxuICAgICAgICAgICAgMTI4OiBcIi9pY29ucy9pY29uLWJsYWNrLTEyOC5wbmdcIixcbiAgICAgICAgICB9LFxuICAgICAgICB9KTtcbiAgICAgICAgYXdhaXQgY2hyb21lLmFjdGlvbi5zZXRUaXRsZSh7XG4gICAgICAgICAgdGFiSWQ6IHRhYi5pZCxcbiAgICAgICAgICB0aXRsZTogXCJDbGljayB0byBhdHRhY2ggZGVidWdnZXJcIixcbiAgICAgICAgfSk7XG4gICAgICB9XG5cbiAgICAgIC8vIFNob3cgYmFkZ2Ugd2l0aCBjb3VudCBvZiBjb25uZWN0ZWQgdGFic1xuICAgICAgY29uc3QgY29ubmVjdGVkQ291bnQgPSBBcnJheS5mcm9tKHRhYnMudmFsdWVzKCkpLmZpbHRlcihcbiAgICAgICAgKHQpID0+IHQuc3RhdGUgPT09IFwiY29ubmVjdGVkXCJcbiAgICAgICkubGVuZ3RoO1xuICAgICAgaWYgKGNvbm5lY3RlZENvdW50ID4gMCkge1xuICAgICAgICBhd2FpdCBjaHJvbWUuYWN0aW9uLnNldEJhZGdlVGV4dCh7XG4gICAgICAgICAgdGFiSWQ6IHRhYi5pZCxcbiAgICAgICAgICB0ZXh0OiBTdHJpbmcoY29ubmVjdGVkQ291bnQpLFxuICAgICAgICB9KTtcbiAgICAgICAgYXdhaXQgY2hyb21lLmFjdGlvbi5zZXRCYWRnZUJhY2tncm91bmRDb2xvcih7XG4gICAgICAgICAgdGFiSWQ6IHRhYi5pZCxcbiAgICAgICAgICBjb2xvcjogXCIjMjJjNTVlXCIsIC8vIGdyZWVuXG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgYXdhaXQgY2hyb21lLmFjdGlvbi5zZXRCYWRnZVRleHQoeyB0YWJJZDogdGFiLmlkLCB0ZXh0OiBcIlwiIH0pO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIGlzUmVzdHJpY3RlZFVybCh1cmw6IHN0cmluZyB8IHVuZGVmaW5lZCk6IGJvb2xlYW4ge1xuICAgIGlmICghdXJsKSByZXR1cm4gdHJ1ZTtcbiAgICBjb25zdCByZXN0cmljdGVkUHJlZml4ZXMgPSBbXG4gICAgICBcImNocm9tZTovL1wiLFxuICAgICAgXCJjaHJvbWUtZXh0ZW5zaW9uOi8vXCIsXG4gICAgICBcImRldnRvb2xzOi8vXCIsXG4gICAgICBcImVkZ2U6Ly9cIixcbiAgICBdO1xuICAgIHJldHVybiByZXN0cmljdGVkUHJlZml4ZXMuc29tZSgocHJlZml4KSA9PiB1cmwuc3RhcnRzV2l0aChwcmVmaXgpKTtcbiAgfVxuXG4gIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgLy8gQWN0aW9uIENsaWNrIEhhbmRsZXJcbiAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gIGFzeW5jIGZ1bmN0aW9uIG9uQWN0aW9uQ2xpY2tlZCh0YWI6IGNocm9tZS50YWJzLlRhYik6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICghdGFiLmlkKSB7XG4gICAgICBsb2dnZXIuZGVidWcoXCJObyB0YWIgSUQgYXZhaWxhYmxlXCIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmIChpc1Jlc3RyaWN0ZWRVcmwodGFiLnVybCkpIHtcbiAgICAgIGxvZ2dlci5kZWJ1ZyhcIkNhbm5vdCBhdHRhY2ggdG8gcmVzdHJpY3RlZCBVUkw6XCIsIHRhYi51cmwpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IHRhYkluZm8gPSB0YWJzLmdldCh0YWIuaWQpO1xuXG4gICAgaWYgKHRhYkluZm8/LnN0YXRlID09PSBcImNvbm5lY3RlZFwiKSB7XG4gICAgICAvLyBEaXNjb25uZWN0XG4gICAgICBkZXRhY2hUYWIodGFiLmlkLCB0cnVlKTtcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gQ29ubmVjdFxuICAgICAgdHJ5IHtcbiAgICAgICAgdGFicy5zZXQodGFiLmlkLCB7IHN0YXRlOiBcImNvbm5lY3RpbmdcIiB9KTtcbiAgICAgICAgYXdhaXQgdXBkYXRlSWNvbnMoKTtcblxuICAgICAgICBhd2FpdCBlbnN1cmVDb25uZWN0aW9uKCk7XG4gICAgICAgIGF3YWl0IGF0dGFjaFRhYih0YWIuaWQpO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgbG9nZ2VyLmVycm9yKFwiRmFpbGVkIHRvIGNvbm5lY3Q6XCIsIGVycm9yKTtcbiAgICAgICAgdGFicy5zZXQodGFiLmlkLCB7XG4gICAgICAgICAgc3RhdGU6IFwiZXJyb3JcIixcbiAgICAgICAgICBlcnJvclRleHQ6IChlcnJvciBhcyBFcnJvcikubWVzc2FnZSxcbiAgICAgICAgfSk7XG4gICAgICAgIGF3YWl0IHVwZGF0ZUljb25zKCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAvLyBFdmVudCBMaXN0ZW5lcnNcbiAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gIGNocm9tZS5hY3Rpb24ub25DbGlja2VkLmFkZExpc3RlbmVyKG9uQWN0aW9uQ2xpY2tlZCk7XG5cbiAgY2hyb21lLnRhYnMub25SZW1vdmVkLmFkZExpc3RlbmVyKCh0YWJJZCkgPT4ge1xuICAgIGlmICh0YWJzLmhhcyh0YWJJZCkpIHtcbiAgICAgIGxvZ2dlci5kZWJ1ZyhcIlRhYiBjbG9zZWQ6XCIsIHRhYklkKTtcbiAgICAgIGRldGFjaFRhYih0YWJJZCwgZmFsc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgY2hyb21lLnRhYnMub25VcGRhdGVkLmFkZExpc3RlbmVyKCgpID0+IHtcbiAgICB2b2lkIHVwZGF0ZUljb25zKCk7XG4gIH0pO1xuXG4gIC8vIFJlc2V0IGFueSBzdGFsZSBkZWJ1Z2dlciBjb25uZWN0aW9ucyBvbiBzdGFydHVwXG4gIGNocm9tZS5kZWJ1Z2dlci5nZXRUYXJnZXRzKCkudGhlbigodGFyZ2V0cykgPT4ge1xuICAgIGNvbnN0IGF0dGFjaGVkID0gdGFyZ2V0cy5maWx0ZXIoKHQpID0+IHQudGFiSWQgJiYgdC5hdHRhY2hlZCk7XG4gICAgaWYgKGF0dGFjaGVkLmxlbmd0aCA+IDApIHtcbiAgICAgIGxvZ2dlci5sb2coYERldGFjaGluZyAke2F0dGFjaGVkLmxlbmd0aH0gc3RhbGUgZGVidWdnZXIgY29ubmVjdGlvbnNgKTtcbiAgICAgIGZvciAoY29uc3QgdGFyZ2V0IG9mIGF0dGFjaGVkKSB7XG4gICAgICAgIGNocm9tZS5kZWJ1Z2dlci5kZXRhY2goeyB0YWJJZDogdGFyZ2V0LnRhYklkIH0pLmNhdGNoKCgpID0+IHt9KTtcbiAgICAgIH1cbiAgICB9XG4gIH0pO1xuXG4gIGxvZ2dlci5sb2coXCJFeHRlbnNpb24gaW5pdGlhbGl6ZWRcIik7XG4gIHZvaWQgdXBkYXRlSWNvbnMoKTtcbn0pO1xuIiwiLy8gI3JlZ2lvbiBzbmlwcGV0XG5leHBvcnQgY29uc3QgYnJvd3NlciA9IGdsb2JhbFRoaXMuYnJvd3Nlcj8ucnVudGltZT8uaWRcbiAgPyBnbG9iYWxUaGlzLmJyb3dzZXJcbiAgOiBnbG9iYWxUaGlzLmNocm9tZTtcbi8vICNlbmRyZWdpb24gc25pcHBldFxuIiwiaW1wb3J0IHsgYnJvd3NlciBhcyBfYnJvd3NlciB9IGZyb20gXCJAd3h0LWRldi9icm93c2VyXCI7XG5leHBvcnQgY29uc3QgYnJvd3NlciA9IF9icm93c2VyO1xuZXhwb3J0IHt9O1xuIiwiLy8gc3JjL2luZGV4LnRzXG52YXIgX01hdGNoUGF0dGVybiA9IGNsYXNzIHtcbiAgY29uc3RydWN0b3IobWF0Y2hQYXR0ZXJuKSB7XG4gICAgaWYgKG1hdGNoUGF0dGVybiA9PT0gXCI8YWxsX3VybHM+XCIpIHtcbiAgICAgIHRoaXMuaXNBbGxVcmxzID0gdHJ1ZTtcbiAgICAgIHRoaXMucHJvdG9jb2xNYXRjaGVzID0gWy4uLl9NYXRjaFBhdHRlcm4uUFJPVE9DT0xTXTtcbiAgICAgIHRoaXMuaG9zdG5hbWVNYXRjaCA9IFwiKlwiO1xuICAgICAgdGhpcy5wYXRobmFtZU1hdGNoID0gXCIqXCI7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IGdyb3VwcyA9IC8oLiopOlxcL1xcLyguKj8pKFxcLy4qKS8uZXhlYyhtYXRjaFBhdHRlcm4pO1xuICAgICAgaWYgKGdyb3VwcyA9PSBudWxsKVxuICAgICAgICB0aHJvdyBuZXcgSW52YWxpZE1hdGNoUGF0dGVybihtYXRjaFBhdHRlcm4sIFwiSW5jb3JyZWN0IGZvcm1hdFwiKTtcbiAgICAgIGNvbnN0IFtfLCBwcm90b2NvbCwgaG9zdG5hbWUsIHBhdGhuYW1lXSA9IGdyb3VwcztcbiAgICAgIHZhbGlkYXRlUHJvdG9jb2wobWF0Y2hQYXR0ZXJuLCBwcm90b2NvbCk7XG4gICAgICB2YWxpZGF0ZUhvc3RuYW1lKG1hdGNoUGF0dGVybiwgaG9zdG5hbWUpO1xuICAgICAgdmFsaWRhdGVQYXRobmFtZShtYXRjaFBhdHRlcm4sIHBhdGhuYW1lKTtcbiAgICAgIHRoaXMucHJvdG9jb2xNYXRjaGVzID0gcHJvdG9jb2wgPT09IFwiKlwiID8gW1wiaHR0cFwiLCBcImh0dHBzXCJdIDogW3Byb3RvY29sXTtcbiAgICAgIHRoaXMuaG9zdG5hbWVNYXRjaCA9IGhvc3RuYW1lO1xuICAgICAgdGhpcy5wYXRobmFtZU1hdGNoID0gcGF0aG5hbWU7XG4gICAgfVxuICB9XG4gIGluY2x1ZGVzKHVybCkge1xuICAgIGlmICh0aGlzLmlzQWxsVXJscylcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIGNvbnN0IHUgPSB0eXBlb2YgdXJsID09PSBcInN0cmluZ1wiID8gbmV3IFVSTCh1cmwpIDogdXJsIGluc3RhbmNlb2YgTG9jYXRpb24gPyBuZXcgVVJMKHVybC5ocmVmKSA6IHVybDtcbiAgICByZXR1cm4gISF0aGlzLnByb3RvY29sTWF0Y2hlcy5maW5kKChwcm90b2NvbCkgPT4ge1xuICAgICAgaWYgKHByb3RvY29sID09PSBcImh0dHBcIilcbiAgICAgICAgcmV0dXJuIHRoaXMuaXNIdHRwTWF0Y2godSk7XG4gICAgICBpZiAocHJvdG9jb2wgPT09IFwiaHR0cHNcIilcbiAgICAgICAgcmV0dXJuIHRoaXMuaXNIdHRwc01hdGNoKHUpO1xuICAgICAgaWYgKHByb3RvY29sID09PSBcImZpbGVcIilcbiAgICAgICAgcmV0dXJuIHRoaXMuaXNGaWxlTWF0Y2godSk7XG4gICAgICBpZiAocHJvdG9jb2wgPT09IFwiZnRwXCIpXG4gICAgICAgIHJldHVybiB0aGlzLmlzRnRwTWF0Y2godSk7XG4gICAgICBpZiAocHJvdG9jb2wgPT09IFwidXJuXCIpXG4gICAgICAgIHJldHVybiB0aGlzLmlzVXJuTWF0Y2godSk7XG4gICAgfSk7XG4gIH1cbiAgaXNIdHRwTWF0Y2godXJsKSB7XG4gICAgcmV0dXJuIHVybC5wcm90b2NvbCA9PT0gXCJodHRwOlwiICYmIHRoaXMuaXNIb3N0UGF0aE1hdGNoKHVybCk7XG4gIH1cbiAgaXNIdHRwc01hdGNoKHVybCkge1xuICAgIHJldHVybiB1cmwucHJvdG9jb2wgPT09IFwiaHR0cHM6XCIgJiYgdGhpcy5pc0hvc3RQYXRoTWF0Y2godXJsKTtcbiAgfVxuICBpc0hvc3RQYXRoTWF0Y2godXJsKSB7XG4gICAgaWYgKCF0aGlzLmhvc3RuYW1lTWF0Y2ggfHwgIXRoaXMucGF0aG5hbWVNYXRjaClcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICBjb25zdCBob3N0bmFtZU1hdGNoUmVnZXhzID0gW1xuICAgICAgdGhpcy5jb252ZXJ0UGF0dGVyblRvUmVnZXgodGhpcy5ob3N0bmFtZU1hdGNoKSxcbiAgICAgIHRoaXMuY29udmVydFBhdHRlcm5Ub1JlZ2V4KHRoaXMuaG9zdG5hbWVNYXRjaC5yZXBsYWNlKC9eXFwqXFwuLywgXCJcIikpXG4gICAgXTtcbiAgICBjb25zdCBwYXRobmFtZU1hdGNoUmVnZXggPSB0aGlzLmNvbnZlcnRQYXR0ZXJuVG9SZWdleCh0aGlzLnBhdGhuYW1lTWF0Y2gpO1xuICAgIHJldHVybiAhIWhvc3RuYW1lTWF0Y2hSZWdleHMuZmluZCgocmVnZXgpID0+IHJlZ2V4LnRlc3QodXJsLmhvc3RuYW1lKSkgJiYgcGF0aG5hbWVNYXRjaFJlZ2V4LnRlc3QodXJsLnBhdGhuYW1lKTtcbiAgfVxuICBpc0ZpbGVNYXRjaCh1cmwpIHtcbiAgICB0aHJvdyBFcnJvcihcIk5vdCBpbXBsZW1lbnRlZDogZmlsZTovLyBwYXR0ZXJuIG1hdGNoaW5nLiBPcGVuIGEgUFIgdG8gYWRkIHN1cHBvcnRcIik7XG4gIH1cbiAgaXNGdHBNYXRjaCh1cmwpIHtcbiAgICB0aHJvdyBFcnJvcihcIk5vdCBpbXBsZW1lbnRlZDogZnRwOi8vIHBhdHRlcm4gbWF0Y2hpbmcuIE9wZW4gYSBQUiB0byBhZGQgc3VwcG9ydFwiKTtcbiAgfVxuICBpc1Vybk1hdGNoKHVybCkge1xuICAgIHRocm93IEVycm9yKFwiTm90IGltcGxlbWVudGVkOiB1cm46Ly8gcGF0dGVybiBtYXRjaGluZy4gT3BlbiBhIFBSIHRvIGFkZCBzdXBwb3J0XCIpO1xuICB9XG4gIGNvbnZlcnRQYXR0ZXJuVG9SZWdleChwYXR0ZXJuKSB7XG4gICAgY29uc3QgZXNjYXBlZCA9IHRoaXMuZXNjYXBlRm9yUmVnZXgocGF0dGVybik7XG4gICAgY29uc3Qgc3RhcnNSZXBsYWNlZCA9IGVzY2FwZWQucmVwbGFjZSgvXFxcXFxcKi9nLCBcIi4qXCIpO1xuICAgIHJldHVybiBSZWdFeHAoYF4ke3N0YXJzUmVwbGFjZWR9JGApO1xuICB9XG4gIGVzY2FwZUZvclJlZ2V4KHN0cmluZykge1xuICAgIHJldHVybiBzdHJpbmcucmVwbGFjZSgvWy4qKz9eJHt9KCl8W1xcXVxcXFxdL2csIFwiXFxcXCQmXCIpO1xuICB9XG59O1xudmFyIE1hdGNoUGF0dGVybiA9IF9NYXRjaFBhdHRlcm47XG5NYXRjaFBhdHRlcm4uUFJPVE9DT0xTID0gW1wiaHR0cFwiLCBcImh0dHBzXCIsIFwiZmlsZVwiLCBcImZ0cFwiLCBcInVyblwiXTtcbnZhciBJbnZhbGlkTWF0Y2hQYXR0ZXJuID0gY2xhc3MgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKG1hdGNoUGF0dGVybiwgcmVhc29uKSB7XG4gICAgc3VwZXIoYEludmFsaWQgbWF0Y2ggcGF0dGVybiBcIiR7bWF0Y2hQYXR0ZXJufVwiOiAke3JlYXNvbn1gKTtcbiAgfVxufTtcbmZ1bmN0aW9uIHZhbGlkYXRlUHJvdG9jb2wobWF0Y2hQYXR0ZXJuLCBwcm90b2NvbCkge1xuICBpZiAoIU1hdGNoUGF0dGVybi5QUk9UT0NPTFMuaW5jbHVkZXMocHJvdG9jb2wpICYmIHByb3RvY29sICE9PSBcIipcIilcbiAgICB0aHJvdyBuZXcgSW52YWxpZE1hdGNoUGF0dGVybihcbiAgICAgIG1hdGNoUGF0dGVybixcbiAgICAgIGAke3Byb3RvY29sfSBub3QgYSB2YWxpZCBwcm90b2NvbCAoJHtNYXRjaFBhdHRlcm4uUFJPVE9DT0xTLmpvaW4oXCIsIFwiKX0pYFxuICAgICk7XG59XG5mdW5jdGlvbiB2YWxpZGF0ZUhvc3RuYW1lKG1hdGNoUGF0dGVybiwgaG9zdG5hbWUpIHtcbiAgaWYgKGhvc3RuYW1lLmluY2x1ZGVzKFwiOlwiKSlcbiAgICB0aHJvdyBuZXcgSW52YWxpZE1hdGNoUGF0dGVybihtYXRjaFBhdHRlcm4sIGBIb3N0bmFtZSBjYW5ub3QgaW5jbHVkZSBhIHBvcnRgKTtcbiAgaWYgKGhvc3RuYW1lLmluY2x1ZGVzKFwiKlwiKSAmJiBob3N0bmFtZS5sZW5ndGggPiAxICYmICFob3N0bmFtZS5zdGFydHNXaXRoKFwiKi5cIikpXG4gICAgdGhyb3cgbmV3IEludmFsaWRNYXRjaFBhdHRlcm4oXG4gICAgICBtYXRjaFBhdHRlcm4sXG4gICAgICBgSWYgdXNpbmcgYSB3aWxkY2FyZCAoKiksIGl0IG11c3QgZ28gYXQgdGhlIHN0YXJ0IG9mIHRoZSBob3N0bmFtZWBcbiAgICApO1xufVxuZnVuY3Rpb24gdmFsaWRhdGVQYXRobmFtZShtYXRjaFBhdHRlcm4sIHBhdGhuYW1lKSB7XG4gIHJldHVybjtcbn1cbmV4cG9ydCB7XG4gIEludmFsaWRNYXRjaFBhdHRlcm4sXG4gIE1hdGNoUGF0dGVyblxufTtcbiJdLCJuYW1lcyI6WyJ3cyIsImxvZ2dlciIsInJlc3VsdCIsImJyb3dzZXIiLCJfYnJvd3NlciJdLCJtYXBwaW5ncyI6Ijs7QUFBTyxXQUFTLGlCQUFpQixLQUFLO0FBQ3BDLFFBQUksT0FBTyxRQUFRLE9BQU8sUUFBUSxXQUFZLFFBQU8sRUFBRSxNQUFNLElBQUc7QUFDaEUsV0FBTztB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QUEsUUFDN0MsS0FBSyxzQkFBc0IsS0FBSyxjQUFjLFFBQVEsU0FBUyxFQUFFLENBQUM7QUFBQSxNQUN4RTtBQUNJLFlBQU0scUJBQXFCLEtBQUssc0JBQXNCLEtBQUssYUFBYTtBQUN4RSxhQUFPLENBQUMsQ0FBQyxvQkFBb0IsS0FBSyxDQUFDLFVBQVUsTUFBTSxLQUFLLElBQUksUUFBUSxDQUFDLEtBQUssbUJBQW1CLEtBQUssSUFBSSxRQUFRO0FBQUEsSUFDaEg7QUFBQSxJQUNBLFlBQVksS0FBSztBQUNmLFlBQU0sTUFBTSxxRUFBcUU7QUFBQSxJQUNuRjtBQUFBLElBQ0EsV0FBVyxLQUFLO0FBQ2QsWUFBTSxNQUFNLG9FQUFvRTtBQUFBLElBQ2xGO0FBQUEsSUFDQSxXQUFXLEtBQUs7QUFDZCxZQUFNLE1BQU0sb0VBQW9FO0FBQUEsSUFDbEY7QUFBQSxJQUNBLHNCQUFzQixTQUFTO0FBQzdCLFlBQU0sVUFBVSxLQUFLLGVBQWUsT0FBTztBQUMzQyxZQUFNLGdCQUFnQixRQUFRLFFBQVEsU0FBUyxJQUFJO0FBQ25ELGFBQU8sT0FBTyxJQUFJLGFBQWEsR0FBRztBQUFBLElBQ3BDO0FBQUEsSUFDQSxlQUFlLFFBQVE7QUFDckIsYUFBTyxPQUFPLFFBQVEsdUJBQXVCLE1BQU07QUFBQSxJQUNyRDtBQUFBLEVBQ0Y7QUFDQSxNQUFJLGVBQWU7QUFDbkIsZUFBYSxZQUFZLENBQUMsUUFBUSxTQUFTLFFBQVEsT0FBTyxLQUFLO0FBQy9ELE1BQUksc0JBQXNCLGNBQWMsTUFBTTtBQUFBLElBQzVDLFlBQVksY0FBYyxRQUFRO0FBQ2hDLFlBQU0sMEJBQTBCLFlBQVksTUFBTSxNQUFNLEVBQUU7QUFBQSxJQUM1RDtBQUFBLEVBQ0Y7QUFDQSxXQUFTLGlCQUFpQixjQUFjLFVBQVU7QUFDaEQsUUFBSSxDQUFDLGFBQWEsVUFBVSxTQUFTLFFBQVEsS0FBSyxhQUFhO0FBQzdELFlBQU0sSUFBSTtBQUFBLFFBQ1I7QUFBQSxRQUNBLEdBQUcsUUFBUSwwQkFBMEIsYUFBYSxVQUFVLEtBQUssSUFBSSxDQUFDO0FBQUEsTUFDNUU7QUFBQSxFQUNBO0FBQ0EsV0FBUyxpQkFBaUIsY0FBYyxVQUFVO0FBQ2hELFFBQUksU0FBUyxTQUFTLEdBQUc7QUFDdkIsWUFBTSxJQUFJLG9CQUFvQixjQUFjLGdDQUFnQztBQUM5RSxRQUFJLFNBQVMsU0FBUyxHQUFHLEtBQUssU0FBUyxTQUFTLEtBQUssQ0FBQyxTQUFTLFdBQVcsSUFBSTtBQUM1RSxZQUFNLElBQUk7QUFBQSxRQUNSO0FBQUEsUUFDQTtBQUFBLE1BQ047QUFBQSxFQUNBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7IiwieF9nb29nbGVfaWdub3JlTGlzdCI6WzAsMiwzLDRdfQ==
