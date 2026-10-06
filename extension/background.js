// Browser MCP Plus: background service worker.
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
/** Below the server's 30 s request timeout, so a stuck request never blocks the queue. */
const REQUEST_TIMEOUT_MS = 25_000;
/** Cap on waiting for a page to load; slow trackers must not fail navigation. */
const NAVIGATION_TIMEOUT_MS = 15_000;
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
  "browser_handle_dialog",
  "browser_fill_form",
];

const state = {
  tabId: null,
  port: DEFAULT_PORT,
  ws: null,
  attached: new Set(),
  /** tabId -> Map(contextId -> context) from Runtime.executionContextCreated. */
  contexts: new Map(),
  consoleLogs: [],
  /** Open JavaScript dialog (alert/confirm/prompt/beforeunload) on the connected tab. */
  dialog: null,
  /** Tabs opened by the connected tab during the current action. */
  newTabs: [],
  /** tabId -> main frame id, to tell top-level navigations from iframe ones. */
  mainFrames: new Map(),
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
  // Attach first: a tab we can't debug (chrome://, Web Store) must not replace a working one.
  await attachDebugger(tabId);
  if (state.tabId !== null && state.tabId !== tabId) {
    setBadge(state.tabId, false);
    await detach(state.tabId);
  }
  state.tabId = tabId;
  state.consoleLogs = [];
  state.dialog = null;
  await chrome.storage.session.set({ tabId });
  // Enable the runtime only now so its replayed console entries are kept for this tab.
  if (!state.attached.has(tabId)) await enableRuntime(tabId);
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
        name: "browsermcp-plus",
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

/** Reads that never touch the page, so they need not wait for the queue. */
const UNQUEUED = new Set(["getUrl", "getTitle", "browser_tab_list", "browser_get_console_logs", "browser_wait"]);

async function onServerMessage(ws, data) {
  let message;
  try {
    message = JSON.parse(data);
  } catch {
    return;
  }
  if (!message || typeof message.id !== "string" || typeof message.type !== "string") return;

  // Run requests one at a time so input events never interleave, and give
  // each a deadline so one that hangs cannot block everything queued after it.
  // Plain reads don't touch the page and answer immediately, even while a
  // long action is running.
  const timeoutMs =
    message.type === "browser_wait"
      ? (Number(message.payload?.time) || 0) * 1000 + REQUEST_TIMEOUT_MS
      : REQUEST_TIMEOUT_MS;
  const execute = () => withTimeout(handle(message.type, message.payload ?? {}), timeoutMs, message.type);
  let run;
  if (UNQUEUED.has(message.type)) {
    run = execute();
  } else {
    run = queue.then(execute);
    queue = run.catch(() => {});
  }
  let response;
  try {
    response = { requestId: message.id, result: await run };
  } catch (error) {
    response = { requestId: message.id, error: errorMessage(error) };
  }
  send(ws, { type: "messageResponse", payload: response });
}

function withTimeout(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`"${label}" did not finish within ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
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
  await attachDebugger(tabId);
  await enableRuntime(tabId);
}

// Fails for tabs Chrome won't let us debug (chrome://, Web Store) or that DevTools holds.
async function attachDebugger(tabId) {
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
}

async function enableRuntime(tabId) {
  state.attached.add(tabId);
  state.contexts.set(tabId, new Map());
  await cdp(tabId, "Runtime.enable");
  // Page events: JavaScript dialogs, navigation start/finish, main frame id.
  await cdp(tabId, "Page.enable");
  const { frameTree } = await cdp(tabId, "Page.getFrameTree");
  state.mainFrames.set(tabId, frameTree.frame.id);
}

async function detach(tabId) {
  state.attached.delete(tabId);
  state.contexts.delete(tabId);
  state.mainFrames.delete(tabId);
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

  if (method === "Page.frameNavigated" && !params.frame.parentId) state.mainFrames.set(tabId, params.frame.id);

  if (tabId !== state.tabId) return;
  if (method === "Page.javascriptDialogOpening") {
    state.dialog = { type: params.type, message: params.message, defaultPrompt: params.defaultPrompt };
    for (const notify of dialogWaiters) notify();
    dialogWaiters.clear();
  } else if (method === "Page.javascriptDialogClosed") {
    state.dialog = null;
  } else if (method === "Runtime.consoleAPICalled") {
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

chrome.tabs.onCreated.addListener((tab) => {
  if (state.tabId !== null && tab.openerTabId === state.tabId) state.newTabs.push(tab.id);
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === state.tabId && info.status === "loading") state.consoleLogs = [];
});

// ---------------------------------------------------------------------------
// Dialogs and navigation tracking

const dialogWaiters = new Set();

/** Resolves when a JavaScript dialog opens on the connected tab. */
function whenDialogOpens() {
  let notify;
  const promise = new Promise((resolve) => {
    notify = resolve;
    dialogWaiters.add(resolve);
  });
  return { promise, cancel: () => dialogWaiters.delete(notify) };
}

function dialogError() {
  const { type, message } = state.dialog;
  return new Error(
    `A JavaScript ${type} dialog is open: ${JSON.stringify(message)}. The page is blocked until you call browser_handle_dialog to accept or dismiss it.`,
  );
}

const NAVIGATION_START = new Set([
  "Page.frameRequestedNavigation",
  "Page.frameStartedLoading",
  "Page.frameStartedNavigating",
  "Page.frameNavigated",
]);
const NAVIGATION_END = new Set([
  "Page.domContentEventFired",
  "Page.loadEventFired",
  "Page.frameStoppedLoading",
  "Page.downloadWillBegin",
]);

/** Watches the tab's main frame for a navigation starting and its document becoming ready. */
function trackNavigation(tabId) {
  const tracker = { started: false };
  let markStarted;
  let markDone;
  let markLoaded;
  tracker.whenStarted = new Promise((resolve) => (markStarted = resolve));
  tracker.whenDone = new Promise((resolve) => (markDone = resolve));
  tracker.whenLoaded = new Promise((resolve) => (markLoaded = resolve));
  const listener = (source, method, params) => {
    if (source.tabId !== tabId) return;
    // Only top-level navigations count; DOMContentLoaded/load are main-frame events already.
    const isMainFrame =
      method === "Page.frameNavigated"
        ? !params.frame.parentId
        : params?.frameId === undefined || params.frameId === state.mainFrames.get(tabId);
    if (!isMainFrame) return;
    if (NAVIGATION_START.has(method)) {
      if (method === "Page.frameStartedNavigating" && /sameDocument/i.test(params.navigationType ?? "")) return;
      tracker.started = true;
      markStarted();
    } else if (NAVIGATION_END.has(method) && tracker.started) {
      markDone();
      if (method !== "Page.domContentEventFired") markLoaded();
    }
  };
  chrome.debugger.onEvent.addListener(listener);
  tracker.stop = () => chrome.debugger.onEvent.removeListener(listener);
  return tracker;
}

/** Grace period for the load event after DOMContentLoaded: scripts often reshape the page by then. */
const LOAD_GRACE_MS = 1_500;

/**
 * Waits until the tab has a usable document: DOMContentLoaded, then the load
 * event for at most LOAD_GRACE_MS, so slow third-party resources never stall
 * the agent. Polls the tab status as a fallback for untracked navigations.
 */
async function waitForDocument(tabId, tracker) {
  const deadline = Date.now() + NAVIGATION_TIMEOUT_MS;
  let done = false;
  tracker?.whenDone.then(() => (done = true));
  await sleep(50);
  while (!done && Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || tab.status === "complete") return;
    await sleep(100);
  }
  if (tracker) await Promise.race([tracker.whenLoaded, sleep(LOAD_GRACE_MS)]);
}

/**
 * Runs a page action, then lets the page react: follows a navigation the
 * action started, otherwise waits briefly for the DOM to settle. A dialog
 * opened by the action ends the wait (the page is blocked until it is
 * handled). Returns a report of what happened.
 */
async function runAction(tabId, action, { startWindowMs = 80, allowDialog = false } = {}) {
  if (state.dialog && !allowDialog) throw dialogError();
  state.newTabs = [];
  const tracker = trackNavigation(tabId);
  const dialog = whenDialogOpens();
  try {
    const work = (async () => {
      const value = await action();
      if (state.dialog) return value;
      const quiet = callAgent("settle", 60, 1_500).catch(() => {});
      await Promise.race([tracker.whenStarted, sleep(startWindowMs)]);
      if (!tracker.started) await quiet;
      if (tracker.started) {
        await waitForDocument(tabId, tracker);
        await callAgent("settle", 60, 1_000).catch(() => {});
      }
      return value;
    })();
    work.catch(() => {}); // keeps running in the background if a dialog interrupts it
    const value = await Promise.race([work, dialog.promise.then(() => undefined)]);
    return await actionReport(tabId, tracker, value);
  } finally {
    tracker.stop();
    dialog.cancel();
  }
}

async function actionReport(tabId, tracker, value) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const report = { url: tab?.url ?? "", title: tab?.title ?? "", navigated: tracker.started };
  if (state.dialog) report.dialog = { ...state.dialog };
  if (state.newTabs.length) {
    const tabs = await Promise.all(state.newTabs.map((id) => chrome.tabs.get(id).then(tabInfo, () => null)));
    report.newTabs = tabs.filter(Boolean);
  }
  if (value !== undefined) report.value = value;
  return report;
}

// ---------------------------------------------------------------------------
// Page agent

const NAVIGATION_ERROR = /removed|No frame|Frame with ID|did not respond|navigat|context was destroyed/i;

/** Calls the page agent; blocked by an open dialog, retried once if the page was navigating. */
async function callAgent(method, ...args) {
  const tabId = requireTab();
  if (state.dialog) throw dialogError();
  const dialog = whenDialogOpens();
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        return await Promise.race([
          runAgent(tabId, method, args),
          dialog.promise.then(() => {
            throw dialogError();
          }),
        ]);
      } catch (error) {
        const message = errorMessage(error);
        const blocked = /Cannot access (contents of )?(url|the page)|cannot be scripted/i.exec(message);
        if (blocked) {
          const { url } = await chrome.tabs.get(tabId);
          throw new Error(`This page (${url}) can't be read or controlled by extensions. Navigate to a website first.`);
        }
        if (attempt > 0 || state.dialog || !NAVIGATION_ERROR.test(message)) throw error;
        await waitForDocument(tabId);
      }
    }
  } finally {
    dialog.cancel();
  }
}

async function runAgent(tabId, method, args) {
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

/** Types into a field the way a user would: click to focus, select the old content, then type. */
async function typeInto(tabId, ref, text, { submit = false, slowly = false } = {}) {
  const kind = await callAgent("editKind", ref);
  if (kind === "direct") {
    // Date, time, colour and range inputs cannot be typed into reliably.
    await callAgent("setValue", ref, text);
  } else {
    try {
      await mouseClick(tabId, await callAgent("point", ref));
    } catch (error) {
      // A floating label or similar overlay: focusing programmatically is fine for typing.
      if (!/covered by/.test(errorMessage(error))) throw error;
    }
    const hadContent = await callAgent("selectContent", ref);
    if (!text) {
      if (hadContent) await pressKey(tabId, "Backspace");
    } else if (slowly) {
      // Key by key, for inputs that format as you type (phone, card, date masks).
      if (hadContent) await pressKey(tabId, "Backspace");
      for (const char of text) await pressKey(tabId, char === "\n" ? "Enter" : char);
    } else {
      await cdp(tabId, "Input.insertText", { text });
    }
  }
  const value = await callAgent("fieldValue", ref).catch(() => undefined);
  if (submit) await pressKey(tabId, "Enter");
  return value;
}

async function fillField(tabId, { name, type, ref, value }) {
  switch (type) {
    case "textbox":
    case "searchbox":
    case "spinbutton":
      return `${name}: ${JSON.stringify(await typeInto(tabId, ref, value))}`;
    case "checkbox":
    case "radio":
    case "switch": {
      const want = value === "true";
      if (type === "radio" && !want) return `${name}: unchanged (a radio button is cleared by selecting another one)`;
      if ((await callAgent("isChecked", ref)) !== want) await mouseClick(tabId, await callAgent("point", ref));
      if ((await callAgent("isChecked", ref)) !== want) throw new Error(`could not ${want ? "check" : "uncheck"} it`);
      return `${name}: ${want ? "checked" : "unchecked"}`;
    }
    case "combobox":
    case "listbox": {
      if (!(await callAgent("isNativeSelect", ref))) {
        throw new Error("not a native <select>; open it with browser_click and click the option instead");
      }
      return `${name}: ${(await callAgent("selectOptions", ref, [value])).join(", ")}`;
    }
    case "slider":
      return `${name}: ${await callAgent("setValue", ref, value)}`;
    default:
      throw new Error(`unsupported field type "${type}"`);
  }
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
    if (state.dialog) throw dialogError();
    return callAgent("snapshot");
  },
  async browser_navigate({ url }) {
    const tabId = requireTab();
    const attached = await ensureAttached(tabId).then(
      () => true,
      () => false,
    );
    if (!attached) {
      // The current page can't be debugged (chrome://, Web Store): navigate without CDP.
      await chrome.tabs.update(tabId, { url });
      await waitForDocument(tabId);
      return actionReport(tabId, { started: true }, undefined);
    }
    return runAction(
      tabId,
      async () => {
        const result = await cdp(tabId, "Page.navigate", { url }).catch(() => null);
        if (!result) {
          await chrome.tabs.update(tabId, { url });
        } else if (result.errorText && result.errorText !== "net::ERR_ABORTED") {
          throw new Error(`Could not open ${url}: ${result.errorText}`);
        }
      },
      { startWindowMs: 1_000 },
    );
  },
  async browser_go_back() {
    const tabId = requireTab();
    return runAction(tabId, () => chrome.tabs.goBack(tabId), { startWindowMs: 1_000 });
  },
  async browser_go_forward() {
    const tabId = requireTab();
    return runAction(tabId, () => chrome.tabs.goForward(tabId), { startWindowMs: 1_000 });
  },
  async browser_wait({ time }) {
    await sleep(Math.max(0, Number(time) || 0) * 1000);
  },
  async browser_press_key({ key }) {
    const tabId = requireTab();
    return runAction(tabId, () => pressKey(tabId, key));
  },
  async browser_click({ ref }) {
    const tabId = requireTab();
    return runAction(tabId, async () => mouseClick(tabId, await callAgent("point", ref)));
  },
  async browser_hover({ ref }) {
    const tabId = requireTab();
    return runAction(tabId, async () => {
      const { x, y } = await callAgent("point", ref, false);
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    });
  },
  async browser_drag({ startRef, endRef }) {
    const tabId = requireTab();
    return runAction(tabId, async () => {
      const { from, to } = await callAgent("dragPoints", startRef, endRef);
      await drag(tabId, from, to);
    });
  },
  async browser_type({ ref, text, submit, slowly }) {
    const tabId = requireTab();
    return runAction(tabId, () => typeInto(tabId, ref, text, { submit, slowly }));
  },
  async browser_select_option({ ref, values }) {
    const tabId = requireTab();
    return runAction(tabId, () => callAgent("selectOptions", ref, values));
  },
  async browser_screenshot() {
    const tabId = requireTab();
    if (state.dialog) throw dialogError();
    const { data } = await cdp(tabId, "Page.captureScreenshot", { format: "png" });
    return data;
  },
  async browser_get_console_logs() {
    requireTab();
    return state.consoleLogs;
  },

  // --- Browser MCP Plus-only messages -------------------------------------------

  async browser_upload_file({ ref, paths }) {
    const tabId = requireTab();
    return runAction(tabId, () => uploadFiles(tabId, ref, paths));
  },

  async browser_handle_dialog({ accept, promptText }) {
    const tabId = requireTab();
    if (!state.dialog) throw new Error("No dialog is open.");
    const { type, message } = state.dialog;
    return runAction(
      tabId,
      async () => {
        await cdp(tabId, "Page.handleJavaScriptDialog", { accept, ...(promptText === undefined ? {} : { promptText }) });
        state.dialog = null;
        return `${accept ? "Accepted" : "Dismissed"} the ${type} dialog ${JSON.stringify(message)}`;
      },
      { allowDialog: true, startWindowMs: 300 },
    );
  },

  async browser_fill_form({ fields }) {
    const tabId = requireTab();
    return runAction(tabId, async () => {
      const done = [];
      for (const field of fields) {
        try {
          done.push(await fillField(tabId, field));
        } catch (error) {
          const filled = done.length ? ` Filled so far: ${done.join("; ")}.` : "";
          throw new Error(`Field "${field.name}" failed: ${errorMessage(error)}.${filled}`);
        }
      }
      return done;
    });
  },

  async browser_evaluate({ function: source, ref }) {
    const tabId = requireTab();
    if (state.dialog) throw dialogError();
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
    return runAction(tabId, async () => {
      if (ref) {
        await callAgent("scrollIntoView", ref);
        return;
      }
      const { width, height } = await callAgent("viewport");
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x: width / 2, y: height / 2, deltaX, deltaY });
    });
  },

  async browser_tab_list() {
    const tabs = await chrome.tabs.query({});
    return Promise.all(tabs.map(tabInfo));
  },

  async browser_tab_new({ url }) {
    const created = await chrome.tabs.create({ url: url || "about:blank", active: true });
    await selectTab(created.id);
    if (url) await waitForDocument(created.id);
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
    if (target !== state.tabId) {
      await chrome.tabs.remove(target);
      return null;
    }
    // Keep the session alive: move to another tab *before* closing this one,
    // otherwise the tab-removed handler sees the connected tab go and disconnects.
    const next = await switchAwayFrom(target, tab.windowId);
    await chrome.tabs.remove(target);
    if (!next) {
      await disconnect();
      return null;
    }
    return tabInfo(await chrome.tabs.get(next.id));
  },
};

/** Connects the most recently used other tab (same window first) and activates it. */
async function switchAwayFrom(tabId, windowId) {
  const others = (await chrome.tabs.query({})).filter((t) => t.id !== tabId);
  others.sort(
    (a, b) => Number(b.windowId === windowId) - Number(a.windowId === windowId) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0),
  );
  for (const candidate of others) {
    try {
      await selectTab(candidate.id);
      await chrome.tabs.update(candidate.id, { active: true });
      return candidate;
    } catch {
      // e.g. a chrome:// tab that cannot be debugged: try the next one.
    }
  }
  return null;
}

async function uploadFiles(tabId, ref, paths) {
  if (await callAgent("isFileInput", ref)) {
    const objectId = await resolveRef(ref);
    await cdp(tabId, "DOM.setFileInputFiles", { files: paths, objectId });
    return;
  }
  // A button that opens a file chooser: intercept the dialog instead of showing it.
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

/** Messages that work without the debugger, e.g. while the tab shows a chrome:// page. */
const NO_DEBUGGER = new Set([
  "getUrl",
  "getTitle",
  "browser_navigate",
  "browser_wait",
  "browser_get_console_logs",
  "browser_tab_list",
  "browser_tab_select",
  "browser_tab_new",
  "browser_tab_close",
]);

async function handle(type, payload) {
  await restore();
  const handler = handlers[type];
  if (!handler) throw new Error(`Unsupported message "${type}"`);
  // Tab and navigation commands must work even when the connected tab can't be debugged.
  if (state.tabId !== null && !NO_DEBUGGER.has(type)) await ensureAttached(state.tabId);
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
