// Browser MCP Companion: background service worker.
//
// Speaks the Browser MCP WebSocket protocol with the local MCP server and
// drives the connected tab through the debugger API (trusted input events,
// screenshots, console capture, file uploads) plus an injected page agent
// (content/agent.js) for the accessibility snapshot and DOM work.

import { keyEvents } from "./keys.js";

const DEFAULT_PORT = 9009;
const RECONNECT_MS = 1_000;
const KEEPALIVE_MS = 20_000;
const MAX_CONSOLE_ENTRIES = 1_000;
const EXTENSION_ORIGIN = `chrome-extension://${chrome.runtime.id}`;

/** Messages beyond the original extension protocol; announced in `hello`. */
const CAPABILITIES = [
  "browser_upload_file",
  "browser_evaluate",
  "browser_scroll",
  "browser_tab_list",
  "browser_tab_new",
  "browser_tab_select",
  "browser_tab_close",
];

const state = {
  tabId: null,
  port: DEFAULT_PORT,
  ws: null,
  attached: new Set(),
  /** tabId -> Map(contextId -> context) from Runtime.executionContextCreated. */
  contexts: new Map(),
  consoleLogs: [],
  restored: false,
};

// ---------------------------------------------------------------------------
// Persistence and lifecycle

async function restore() {
  if (state.restored) return;
  state.restored = true;
  const [{ tabId }, { port }] = await Promise.all([
    chrome.storage.session.get("tabId"),
    chrome.storage.local.get("port"),
  ]);
  if (Number.isInteger(port)) state.port = port;
  if (Number.isInteger(tabId) && (await tabExists(tabId))) {
    state.tabId = tabId;
    setBadge(tabId, true);
  }
  ensureSocket();
}

async function tabExists(tabId) {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

async function connectTab(tabId) {
  await restore();
  await selectTab(tabId);
  ensureSocket();
}

async function disconnect() {
  const tabId = state.tabId;
  state.tabId = null;
  await chrome.storage.session.remove("tabId");
  if (tabId !== null) {
    setBadge(tabId, false);
    await detach(tabId);
  }
  state.ws?.close();
  state.ws = null;
}

async function selectTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (state.tabId !== null && state.tabId !== tabId) {
    setBadge(state.tabId, false);
    await detach(state.tabId);
  }
  state.tabId = tabId;
  state.consoleLogs = [];
  await chrome.storage.session.set({ tabId });
  await ensureAttached(tabId);
  setBadge(tabId, true);
  return tab;
}

async function setPort(port) {
  state.port = port;
  await chrome.storage.local.set({ port });
  state.ws?.close();
  state.ws = null;
  ensureSocket();
}

function setBadge(tabId, on) {
  chrome.action.setBadgeText({ tabId, text: on ? "ON" : "" }).catch(() => {});
  if (on) chrome.action.setBadgeBackgroundColor({ tabId, color: "#1a7f37" }).catch(() => {});
}

// ---------------------------------------------------------------------------
// WebSocket connection to the MCP server

let reconnectTimer = null;
let keepaliveTimer = null;

function ensureSocket() {
  if (state.tabId === null) return;
  if (state.ws && state.ws.readyState <= WebSocket.OPEN) return;
  clearTimeout(reconnectTimer);

  const ws = new WebSocket(`ws://localhost:${state.port}`);
  state.ws = ws;

  ws.onopen = () => {
    send(ws, {
      type: "hello",
      payload: {
        name: "browsermcp-companion",
        version: chrome.runtime.getManifest().version,
        capabilities: CAPABILITIES,
      },
    });
    clearInterval(keepaliveTimer);
    // Socket traffic keeps the MV3 service worker alive while connected.
    keepaliveTimer = setInterval(() => send(ws, { type: "ping" }), KEEPALIVE_MS);
  };

  ws.onmessage = (event) => onServerMessage(ws, event.data);

  ws.onclose = () => {
    clearInterval(keepaliveTimer);
    if (state.ws === ws) state.ws = null;
    if (state.tabId !== null) {
      reconnectTimer = setTimeout(ensureSocket, RECONNECT_MS);
    }
  };
  ws.onerror = () => {};
}

function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

// Wakes the worker periodically so it reconnects after the server restarts.
chrome.alarms?.create("reconnect", { periodInMinutes: 0.5 });
chrome.alarms?.onAlarm.addListener(() => restore().then(ensureSocket));

let queue = Promise.resolve();

async function onServerMessage(ws, data) {
  let message;
  try {
    message = JSON.parse(data);
  } catch {
    return;
  }
  if (!message || typeof message.id !== "string" || typeof message.type !== "string") return;

  // Run requests one at a time so input events never interleave.
  const run = queue.then(() => handle(message.type, message.payload ?? {}));
  queue = run.catch(() => {});
  let response;
  try {
    response = { requestId: message.id, result: await run };
  } catch (error) {
    response = { requestId: message.id, error: errorMessage(error) };
  }
  send(ws, { type: "messageResponse", payload: response });
}

function errorMessage(error) {
  const text = error instanceof Error ? error.message : String(error);
  // chrome.debugger errors arrive as JSON strings.
  try {
    const parsed = JSON.parse(text);
    if (parsed && parsed.message) return parsed.message;
  } catch {
    // not JSON
  }
  return text;
}

// ---------------------------------------------------------------------------
// Debugger (CDP) plumbing

function cdp(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function ensureAttached(tabId) {
  if (state.attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (error) {
    // After a service worker restart we may still hold the session.
    const ours = await cdp(tabId, "Runtime.disable").then(
      () => true,
      () => false,
    );
    if (!ours) {
      const reason = errorMessage(error);
      throw new Error(
        /already attached/i.test(reason)
          ? "Cannot control this tab because another debugger (e.g. DevTools or another automation extension) is attached to it."
          : `Cannot control this tab: ${reason}`,
      );
    }
  }
  state.attached.add(tabId);
  state.contexts.set(tabId, new Map());
  await cdp(tabId, "Runtime.enable");
}

async function detach(tabId) {
  state.attached.delete(tabId);
  state.contexts.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

const eventWaiters = new Set();

function waitForEvent(tabId, method, timeoutMs) {
  return new Promise((resolve, reject) => {
    const waiter = {
      tabId,
      method,
      resolve: (params) => {
        clearTimeout(timer);
        eventWaiters.delete(waiter);
        resolve(params);
      },
    };
    const timer = setTimeout(() => {
      eventWaiters.delete(waiter);
      reject(new Error(`Timed out waiting for ${method}`));
    }, timeoutMs);
    eventWaiters.add(waiter);
  });
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  for (const waiter of eventWaiters) {
    if (waiter.tabId === tabId && waiter.method === method) waiter.resolve(params);
  }

  const contexts = state.contexts.get(tabId);
  if (contexts) {
    if (method === "Runtime.executionContextCreated") contexts.set(params.context.id, params.context);
    else if (method === "Runtime.executionContextDestroyed") contexts.delete(params.executionContextId);
    else if (method === "Runtime.executionContextsCleared") contexts.clear();
  }

  if (tabId !== state.tabId) return;
  if (method === "Runtime.consoleAPICalled") {
    pushLog({
      type: params.type,
      timestamp: params.timestamp,
      message: params.args.map(formatRemoteObject).join(" "),
    });
  } else if (method === "Runtime.exceptionThrown") {
    const details = params.exceptionDetails;
    pushLog({
      type: "error",
      timestamp: params.timestamp,
      message: details.exception?.description ?? details.text,
    });
  }
});

function pushLog(entry) {
  state.consoleLogs.push(entry);
  if (state.consoleLogs.length > MAX_CONSOLE_ENTRIES) state.consoleLogs.shift();
}

function formatRemoteObject(object) {
  if ("value" in object) {
    return typeof object.value === "string" ? object.value : JSON.stringify(object.value);
  }
  if (object.unserializableValue) return object.unserializableValue;
  if (object.preview?.properties) {
    const props = object.preview.properties.map((p) => `${p.name}: ${p.value}`).join(", ");
    return object.subtype === "array" ? `[${props}]` : `{${props}}`;
  }
  return object.description ?? object.type;
}

chrome.debugger.onDetach.addListener((source, reason) => {
  state.attached.delete(source.tabId);
  state.contexts.delete(source.tabId);
  if (source.tabId === state.tabId && reason === "canceled_by_user") void disconnect();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === state.tabId) void disconnect();
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === state.tabId && info.status === "loading") state.consoleLogs = [];
});

// ---------------------------------------------------------------------------
// Page agent

async function callAgent(method, ...args) {
  const tabId = requireTab();
  const run = () =>
    chrome.scripting.executeScript({
      target: { tabId },
      func: (name, params) => {
        const agent = globalThis.__bmcp;
        if (!agent) return { missing: true };
        try {
          const value = agent[name](...params);
          if (value && typeof value.then === "function") {
            return value.then(
              (v) => ({ value: v }),
              (e) => ({ error: String(e?.message ?? e) }),
            );
          }
          return { value };
        } catch (e) {
          return { error: String(e?.message ?? e) };
        }
      },
      args: [method, args],
    });
  let [frame] = await run();
  if (frame?.result?.missing) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content/agent.js"] });
    [frame] = await run();
  }
  const result = frame?.result;
  if (!result) throw new Error("The page did not respond. It may still be loading.");
  if (result.error) throw new Error(result.error);
  return result.value;
}

/** CDP handle for the element behind a snapshot ref, in the page's own (main) world. */
async function resolveRef(ref, { mainWorld = false } = {}) {
  const tabId = requireTab();
  // Validates the ref (and injects the agent) with a readable error first.
  await callAgent("check", ref);
  const contextId = await agentContextId(tabId);
  const { result, exceptionDetails } = await cdp(tabId, "Runtime.evaluate", {
    expression: `globalThis.__bmcp.element(${JSON.stringify(ref)})`,
    contextId,
  });
  if (exceptionDetails) throw new Error(exceptionText(exceptionDetails));
  if (!mainWorld) return result.objectId;
  const { node } = await cdp(tabId, "DOM.describeNode", { objectId: result.objectId });
  const resolved = await cdp(tabId, "DOM.resolveNode", { backendNodeId: node.backendNodeId });
  return resolved.object.objectId;
}

async function agentContextId(tabId) {
  const { frameTree } = await cdp(tabId, "Page.getFrameTree");
  const topFrameId = frameTree.frame.id;
  for (let attempt = 0; attempt < 10; attempt++) {
    const contexts = [...(state.contexts.get(tabId)?.values() ?? [])];
    const match = contexts
      .filter((c) => c.origin === EXTENSION_ORIGIN && c.auxData?.frameId === topFrameId && !c.auxData?.isDefault)
      .pop();
    if (match) return match.id;
    await sleep(50);
  }
  throw new Error("Could not find the page agent's execution context. Take a new snapshot and retry.");
}

function exceptionText(details) {
  const description = details.exception?.description ?? details.text ?? "Script error";
  return description.split("\n")[0].replace(/^Error: /, "");
}

// ---------------------------------------------------------------------------
// Input helpers

async function mouseClick(tabId, { x, y }) {
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}

async function pressKey(tabId, key) {
  for (const event of keyEvents(key)) {
    await cdp(tabId, "Input.dispatchKeyEvent", event);
  }
}

async function drag(tabId, from, to) {
  let dragData = null;
  const intercepted = waitForEvent(tabId, "Input.dragIntercepted", 1_000).then(
    (params) => (dragData = params.data),
    () => {},
  );
  await cdp(tabId, "Input.setInterceptDrags", { enabled: true });
  try {
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
      if (dragData) break;
    }
    await Promise.race([intercepted, sleep(100)]);
    if (dragData) {
      // Native HTML5 drag and drop.
      for (const type of ["dragEnter", "dragOver", "drop"]) {
        await cdp(tabId, "Input.dispatchDragEvent", { type, x: to.x, y: to.y, data: dragData });
      }
    }
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
  } finally {
    await cdp(tabId, "Input.setInterceptDrags", { enabled: false }).catch(() => {});
  }
}

async function waitForLoad(tabId, { timeoutMs = 30_000, graceMs = 1_000 } = {}) {
  const started = Date.now();
  let sawLoading = false;
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "loading") sawLoading = true;
    else if (sawLoading || Date.now() - started > graceMs) return;
    await sleep(100);
  }
}

/** Lets the page react to an action: follow a navigation it triggered, then wait for DOM quiet. */
async function afterAction(tabId) {
  await waitForLoad(tabId, { graceMs: 200 });
  await callAgent("settle", 100, 1_000).catch(() => {});
}

function requireTab() {
  if (state.tabId === null) throw new Error("No tab is connected");
  return state.tabId;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Message handlers

async function tabInfo(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    title: tab.title ?? "",
    url: tab.url ?? tab.pendingUrl ?? "",
    active: tab.active,
    connected: tab.id === state.tabId,
  };
}

const handlers = {
  async getUrl() {
    return (await chrome.tabs.get(requireTab())).url;
  },
  async getTitle() {
    return (await chrome.tabs.get(requireTab())).title;
  },
  async browser_snapshot() {
    requireTab();
    return callAgent("snapshot");
  },
  async browser_navigate({ url }) {
    const tabId = requireTab();
    await chrome.tabs.update(tabId, { url });
    await waitForLoad(tabId);
  },
  async browser_go_back() {
    const tabId = requireTab();
    await chrome.tabs.goBack(tabId);
    await waitForLoad(tabId);
  },
  async browser_go_forward() {
    const tabId = requireTab();
    await chrome.tabs.goForward(tabId);
    await waitForLoad(tabId);
  },
  async browser_wait({ time }) {
    await sleep(Math.max(0, Number(time) || 0) * 1000);
  },
  async browser_press_key({ key }) {
    const tabId = requireTab();
    await pressKey(tabId, key);
    await afterAction(tabId);
  },
  async browser_click({ ref }) {
    const tabId = requireTab();
    await ensureAttached(tabId);
    await mouseClick(tabId, await callAgent("point", ref));
    await afterAction(tabId);
  },
  async browser_hover({ ref }) {
    const tabId = requireTab();
    await ensureAttached(tabId);
    const { x, y } = await callAgent("point", ref);
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await afterAction(tabId);
  },
  async browser_drag({ startRef, endRef }) {
    const tabId = requireTab();
    await ensureAttached(tabId);
    const { from, to } = await callAgent("dragPoints", startRef, endRef);
    await drag(tabId, from, to);
    await afterAction(tabId);
  },
  async browser_type({ ref, text, submit }) {
    const tabId = requireTab();
    await ensureAttached(tabId);
    await callAgent("prepareTyping", ref);
    if (text) await cdp(tabId, "Input.insertText", { text });
    else await pressKey(tabId, "Backspace");
    if (submit) await pressKey(tabId, "Enter");
    await afterAction(tabId);
  },
  async browser_select_option({ ref, values }) {
    const tabId = requireTab();
    const selected = await callAgent("selectOptions", ref, values);
    await afterAction(tabId);
    return selected;
  },
  async browser_screenshot() {
    const tabId = requireTab();
    await ensureAttached(tabId);
    const { data } = await cdp(tabId, "Page.captureScreenshot", { format: "png" });
    return data;
  },
  async browser_get_console_logs() {
    requireTab();
    return state.consoleLogs;
  },

  // --- Companion-only messages -------------------------------------------

  async browser_upload_file({ ref, paths }) {
    const tabId = requireTab();
    await ensureAttached(tabId);
    if (await callAgent("isFileInput", ref)) {
      const objectId = await resolveRef(ref);
      await cdp(tabId, "DOM.setFileInputFiles", { files: paths, objectId });
    } else {
      // A button that opens a file chooser: intercept the dialog instead of showing it.
      await cdp(tabId, "Page.enable");
      await cdp(tabId, "Page.setInterceptFileChooserDialog", { enabled: true });
      try {
        const opened = waitForEvent(tabId, "Page.fileChooserOpened", 5_000);
        await mouseClick(tabId, await callAgent("point", ref));
        const chooser = await opened.catch(() => {
          throw new Error("Clicking the element did not open a file chooser. Use the file input itself or the button that opens the chooser.");
        });
        if (chooser.mode === "selectSingle" && paths.length > 1) {
          throw new Error("This file chooser accepts a single file.");
        }
        if (!chooser.backendNodeId) throw new Error("The file chooser is not backed by a file input.");
        await cdp(tabId, "DOM.setFileInputFiles", { files: paths, backendNodeId: chooser.backendNodeId });
      } finally {
        await cdp(tabId, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
      }
    }
    await afterAction(tabId);
  },

  async browser_evaluate({ function: source, ref }) {
    const tabId = requireTab();
    await ensureAttached(tabId);
    const options = { awaitPromise: true, returnByValue: true, userGesture: true };
    let response;
    if (ref) {
      const objectId = await resolveRef(ref, { mainWorld: true });
      response = await cdp(tabId, "Runtime.callFunctionOn", {
        ...options,
        functionDeclaration: source,
        objectId,
        arguments: [{ objectId }],
      });
    } else {
      response = await cdp(tabId, "Runtime.evaluate", {
        ...options,
        expression: `(${source})()`,
      });
    }
    if (response.exceptionDetails) throw new Error(exceptionText(response.exceptionDetails));
    const { type, value, unserializableValue, description } = response.result;
    return { type, value, unserializableValue, description };
  },

  async browser_scroll({ ref, deltaX = 0, deltaY = 0 }) {
    const tabId = requireTab();
    await ensureAttached(tabId);
    if (ref) {
      await callAgent("scrollIntoView", ref);
    } else {
      const { width, height } = await callAgent("viewport");
      await cdp(tabId, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: width / 2,
        y: height / 2,
        deltaX,
        deltaY,
      });
    }
    await afterAction(tabId);
  },

  async browser_tab_list() {
    const tabs = await chrome.tabs.query({});
    return Promise.all(tabs.map(tabInfo));
  },

  async browser_tab_new({ url }) {
    const created = await chrome.tabs.create({ url: url || "about:blank", active: true });
    await selectTab(created.id);
    if (url) await waitForLoad(created.id);
    return tabInfo(await chrome.tabs.get(created.id));
  },

  async browser_tab_select({ tabId }) {
    const tab = await selectTab(tabId);
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    return tabInfo(await chrome.tabs.get(tabId));
  },

  async browser_tab_close({ tabId }) {
    const target = tabId ?? requireTab();
    const tab = await chrome.tabs.get(target);
    const wasConnected = target === state.tabId;
    if (wasConnected) {
      // Keep the session alive: hand control to the tab that becomes active.
      setBadge(target, false);
      await detach(target);
    }
    await chrome.tabs.remove(target);
    if (!wasConnected) return null;
    const [next] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    if (!next) {
      await disconnect();
      return null;
    }
    await selectTab(next.id);
    return tabInfo(await chrome.tabs.get(next.id));
  },
};

async function handle(type, payload) {
  await restore();
  const handler = handlers[type];
  if (!handler) throw new Error(`Unsupported message "${type}"`);
  if (state.tabId !== null && type !== "browser_tab_list") await ensureAttached(state.tabId);
  return handler(payload);
}

// ---------------------------------------------------------------------------
// Popup and test hooks

async function status() {
  await restore();
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  return {
    port: state.port,
    tabId: state.tabId,
    activeTabId: active?.id ?? null,
    serverConnected: state.ws?.readyState === WebSocket.OPEN,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const actions = {
    status: () => status(),
    connect: () => connectTab(message.tabId).then(status),
    disconnect: () => disconnect().then(status),
    setPort: () => setPort(message.port).then(status),
  };
  const action = actions[message?.cmd];
  if (!action) return false;
  action().then(
    (value) => sendResponse({ ok: true, value }),
    (error) => sendResponse({ ok: false, error: errorMessage(error) }),
  );
  return true;
});

globalThis.bmcp = { connectTab, disconnect, setPort, status };

void restore();
