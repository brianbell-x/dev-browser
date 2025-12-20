var background = (function () {
  "use strict";
  function w(i) {
    return i == null || typeof i == "function" ? { main: i } : i;
  }
  const T = "ws://localhost:9222/extension",
    c = new Map(),
    g = new Map();
  let u = null,
    y = 1;
  const v = w(() => {
    function i(e, o) {
      b({
        method: "log",
        params: {
          level: e,
          args: o.map((t) => {
            if (t === void 0) return "undefined";
            if (t === null) return "null";
            if (typeof t == "object")
              try {
                return JSON.stringify(t);
              } catch {
                return String(t);
              }
            return String(t);
          }),
        },
      });
    }
    const r = {
      log: (...e) => {
        (console.log("[dev-browser]", ...e), i("log", e));
      },
      debug: (...e) => {
        (console.debug("[dev-browser]", ...e), i("debug", e));
      },
      error: (...e) => {
        (console.error("[dev-browser]", ...e), i("error", e));
      },
    };
    function b(e) {
      if (u?.readyState === WebSocket.OPEN)
        try {
          u.send(JSON.stringify(e));
        } catch (o) {
          console.debug("Error sending message:", o);
        }
    }
    function k(e) {
      for (const [o, t] of c) if (t.sessionId === e) return { tabId: o, tab: t };
    }
    function S(e) {
      for (const [o, t] of c) if (t.targetId === e) return { tabId: o, tab: t };
    }
    async function E(e) {
      if (e.method !== "forwardCDPCommand") return;
      let o, t;
      if (e.params.sessionId) {
        const s = k(e.params.sessionId);
        s && ((o = s.tabId), (t = s.tab));
      }
      if (!t && e.params.sessionId) {
        const s = g.get(e.params.sessionId);
        s &&
          ((o = s),
          (t = c.get(s)),
          r.debug("Found parent tab for child session:", e.params.sessionId, "tabId:", s));
      }
      if (
        !t &&
        e.params.params &&
        typeof e.params.params == "object" &&
        "targetId" in e.params.params
      ) {
        const s = S(e.params.params.targetId);
        s && ((o = s.tabId), (t = s.tab));
      }
      const n = o ? { tabId: o } : void 0;
      switch (e.params.method) {
        case "Runtime.enable": {
          if (!n)
            throw new Error(
              `No debuggee found for Runtime.enable (sessionId: ${e.params.sessionId})`
            );
          try {
            (await chrome.debugger.sendCommand(n, "Runtime.disable"),
              await new Promise((s) => setTimeout(s, 200)));
          } catch {}
          return await chrome.debugger.sendCommand(n, "Runtime.enable", e.params.params);
        }
        case "Target.createTarget": {
          const s = e.params.params?.url || "about:blank";
          r.debug("Creating new tab with URL:", s);
          const f = await chrome.tabs.create({ url: s, active: !1 });
          if (!f.id) throw new Error("Failed to create tab");
          return (
            await new Promise(($) => setTimeout($, 100)),
            { targetId: (await m(f.id)).targetId }
          );
        }
        case "Target.closeTarget":
          return o
            ? (await chrome.tabs.remove(o), { success: !0 })
            : (r.log(`Target not found: ${e.params.params?.targetId}`), { success: !1 });
      }
      if (!n || !t)
        throw new Error(
          `No tab found for method ${e.params.method} sessionId: ${e.params.sessionId}`
        );
      r.debug("CDP command:", e.params.method, "for tab:", o);
      const a = {
        ...n,
        sessionId: e.params.sessionId !== t.sessionId ? e.params.sessionId : void 0,
      };
      return await chrome.debugger.sendCommand(a, e.params.method, e.params.params);
    }
    function P(e, o, t) {
      const n = e.tabId ? c.get(e.tabId) : void 0;
      if (n) {
        if (
          (r.debug("Forwarding CDP event:", o, "from tab:", e.tabId),
          o === "Target.attachedToTarget" && t && typeof t == "object" && "sessionId" in t)
        ) {
          const a = t.sessionId;
          (r.debug("Child target attached:", a, "for tab:", e.tabId), g.set(a, e.tabId));
        }
        if (o === "Target.detachedFromTarget" && t && typeof t == "object" && "sessionId" in t) {
          const a = t.sessionId;
          (r.debug("Child target detached:", a), g.delete(a));
        }
        b({
          method: "forwardCDPEvent",
          params: { sessionId: e.sessionId || n.sessionId, method: o, params: t },
        });
      }
    }
    function D(e, o) {
      const t = e.tabId;
      if (!t || !c.has(t)) return;
      r.debug(`Debugger detached for tab ${t}: ${o}`);
      const n = c.get(t);
      n &&
        b({
          method: "forwardCDPEvent",
          params: {
            method: "Target.detachedFromTarget",
            params: { sessionId: n.sessionId, targetId: n.targetId },
          },
        });
      for (const [a, s] of g) s === t && g.delete(a);
      (c.delete(t), d());
    }
    async function m(e) {
      const o = { tabId: e };
      (r.debug("Attaching debugger to tab:", e), await chrome.debugger.attach(o, "1.3"));
      const n = (await chrome.debugger.sendCommand(o, "Target.getTargetInfo")).targetInfo,
        a = `pw-tab-${y++}`;
      return (
        c.set(e, { sessionId: a, targetId: n.targetId, state: "connected" }),
        b({
          method: "forwardCDPEvent",
          params: {
            method: "Target.attachedToTarget",
            params: { sessionId: a, targetInfo: { ...n, attached: !0 }, waitingForDebugger: !1 },
          },
        }),
        r.log("Tab attached:", e, "sessionId:", a, "url:", n.url),
        d(),
        n
      );
    }
    function I(e, o) {
      const t = c.get(e);
      if (t) {
        (r.debug("Detaching tab:", e),
          b({
            method: "forwardCDPEvent",
            params: {
              method: "Target.detachedFromTarget",
              params: { sessionId: t.sessionId, targetId: t.targetId },
            },
          }),
          c.delete(e));
        for (const [n, a] of g) a === e && g.delete(n);
        (o &&
          chrome.debugger.detach({ tabId: e }).catch((n) => {
            r.debug("Error detaching debugger:", n);
          }),
          d());
      }
    }
    async function x() {
      if (u?.readyState === WebSocket.OPEN) return;
      for (r.debug("Connecting to relay server..."); ; )
        try {
          await fetch("http://localhost:9222", { method: "HEAD" });
          break;
        } catch {
          (r.debug("Server not available, retrying..."),
            await new Promise((o) => setTimeout(o, 1e3)));
        }
      r.debug("Creating WebSocket connection");
      const e = new WebSocket(T);
      (await new Promise((o, t) => {
        const n = setTimeout(() => {
          t(new Error("Connection timeout"));
        }, 5e3);
        ((e.onopen = () => {
          (clearTimeout(n), o());
        }),
          (e.onerror = () => {
            (clearTimeout(n), t(new Error("WebSocket connection failed")));
          }),
          (e.onclose = (a) => {
            (clearTimeout(n), t(new Error(`WebSocket closed: ${a.reason || a.code}`)));
          }));
      }),
        (u = e),
        (u.onmessage = async (o) => {
          let t;
          try {
            t = JSON.parse(o.data);
          } catch (a) {
            (r.debug("Error parsing message:", a),
              b({ error: { code: -32700, message: "Parse error" } }));
            return;
          }
          const n = { id: t.id };
          try {
            n.result = await E(t);
          } catch (a) {
            (r.debug("Error handling command:", a), (n.error = a.message));
          }
          b(n);
        }),
        (u.onclose = (o) => {
          r.debug("Connection closed:", o.code, o.reason);
          for (const t of c.keys()) chrome.debugger.detach({ tabId: t }).catch(() => {});
          (c.clear(), g.clear(), (u = null), d());
        }),
        (u.onerror = (o) => {
          r.debug("WebSocket error:", o);
        }),
        chrome.debugger.onEvent.addListener(P),
        chrome.debugger.onDetach.addListener(D),
        r.log("Connected to relay server"),
        d());
    }
    async function d() {
      const e = await chrome.tabs.query({});
      for (const o of e) {
        if (!o.id) continue;
        const n = c.get(o.id)?.state === "connected",
          a = p(o.url);
        n
          ? (await chrome.action.setIcon({
              tabId: o.id,
              path: {
                16: "/icons/icon-green-16.png",
                32: "/icons/icon-green-32.png",
                48: "/icons/icon-green-48.png",
                128: "/icons/icon-green-128.png",
              },
            }),
            await chrome.action.setTitle({ tabId: o.id, title: "Connected - Click to disconnect" }))
          : a
            ? (await chrome.action.setIcon({
                tabId: o.id,
                path: {
                  16: "/icons/icon-gray-16.png",
                  32: "/icons/icon-gray-32.png",
                  48: "/icons/icon-gray-48.png",
                  128: "/icons/icon-gray-128.png",
                },
              }),
              await chrome.action.setTitle({ tabId: o.id, title: "Cannot attach to this page" }))
            : (await chrome.action.setIcon({
                tabId: o.id,
                path: {
                  16: "/icons/icon-black-16.png",
                  32: "/icons/icon-black-32.png",
                  48: "/icons/icon-black-48.png",
                  128: "/icons/icon-black-128.png",
                },
              }),
              await chrome.action.setTitle({ tabId: o.id, title: "Click to attach debugger" }));
        const s = Array.from(c.values()).filter((f) => f.state === "connected").length;
        s > 0
          ? (await chrome.action.setBadgeText({ tabId: o.id, text: String(s) }),
            await chrome.action.setBadgeBackgroundColor({ tabId: o.id, color: "#22c55e" }))
          : await chrome.action.setBadgeText({ tabId: o.id, text: "" });
      }
    }
    function p(e) {
      return e
        ? ["chrome://", "chrome-extension://", "devtools://", "edge://"].some((t) =>
            e.startsWith(t)
          )
        : !0;
    }
    async function R(e) {
      if (!e.id) {
        r.debug("No tab ID available");
        return;
      }
      if (p(e.url)) {
        r.debug("Cannot attach to restricted URL:", e.url);
        return;
      }
      if (c.get(e.id)?.state === "connected") I(e.id, !0);
      else
        try {
          (c.set(e.id, { state: "connecting" }), await d(), await x(), await m(e.id));
        } catch (t) {
          (r.error("Failed to connect:", t),
            c.set(e.id, { state: "error", errorText: t.message }),
            await d());
        }
    }
    (chrome.action.onClicked.addListener(R),
      chrome.tabs.onRemoved.addListener((e) => {
        c.has(e) && (r.debug("Tab closed:", e), I(e, !1));
      }),
      chrome.tabs.onUpdated.addListener(() => {
        d();
      }),
      chrome.debugger.getTargets().then((e) => {
        const o = e.filter((t) => t.tabId && t.attached);
        if (o.length > 0) {
          r.log(`Detaching ${o.length} stale debugger connections`);
          for (const t of o) chrome.debugger.detach({ tabId: t.tabId }).catch(() => {});
        }
      }),
      r.log("Extension initialized"),
      d());
  });
  function L() {}
  globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome;
  function l(i, ...r) {}
  const C = {
    debug: (...i) => l(console.debug, ...i),
    log: (...i) => l(console.log, ...i),
    warn: (...i) => l(console.warn, ...i),
    error: (...i) => l(console.error, ...i),
  };
  let h;
  try {
    ((h = v.main()),
      h instanceof Promise &&
        console.warn(
          "The background's main() function return a promise, but it must be synchronous"
        ));
  } catch (i) {
    throw (C.error("The background crashed on startup!"), i);
  }
  return h;
})();
