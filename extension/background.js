// Browser MCP Plus: background service worker.
//
// Speaks the Browser MCP WebSocket protocol with the local MCP server and
// drives tabs through the debugger API (trusted input events, screenshots,
// console capture, file uploads) plus an injected page agent
// (content/agent.js) for the accessibility snapshot and DOM work.
//
// Several agents can work at once. Every request carries the id of the agent
// session that sent it; each session works in a tab of its own: a free tab
// the user connected, or a tab opened for it. Tabs opened for a session, and
// the tabs its pages open, close when the session ends unless the user keeps
// them. Requests for different tabs run in parallel; requests for the same
// tab run one at a time.
//
// Every Chrome profile runs its own copy of this extension. The server tells
// them apart by a random install id and the profile's Google account, or by a
// one-time page it opens in a profile (see noticeClaim).

import { keyEvents } from "./keys.js";

const DEFAULT_PORT = 9009;
/** Waits between reconnection attempts; the last one repeats. */
const RECONNECT_MS = [1_000, 1_000, 2_000, 3_000, 5_000];
const KEEPALIVE_MS = 20_000;
/**
 * When the server connection drops without the server saying which sessions
 * ended (it crashed or was killed), agent tabs close after this long unless a
 * server comes back and reports its sessions.
 */
const ORPHAN_GRACE_MS = 10_000;
const MAX_CONSOLE_ENTRIES = 1_000;
/** Below the server's 30 s request timeout, so a stuck request never blocks the queue. */
const REQUEST_TIMEOUT_MS = 25_000;
/** Cap on waiting for a page to load; slow trackers must not fail navigation. */
const NAVIGATION_TIMEOUT_MS = 15_000;
/** Grace period for the load event after DOMContentLoaded: scripts often reshape the page by then. */
const LOAD_GRACE_MS = 1_500;
const EXTENSION_ORIGIN = `chrome-extension://${chrome.runtime.id}`;
/** Sessions of servers that predate multi-agent support share this id. */
const DEFAULT_SESSION = "default";
/** Colours that tell agents apart in the popup. */
const AGENT_COLORS = ["blue", "purple", "cyan", "orange", "pink", "green", "red", "yellow"];
/** The page a server opens a Chrome profile with; the token tells the server which profile this is. */
const CLAIM_URL = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)\/browsermcp-plus\/profile\/([\w-]{16,})(?:[?#].*)?$/;

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
  "sessions_update",
  "profile_set",
];

const state = {
  port: DEFAULT_PORT,
  /** Stay connected to the server without connected tabs, so agents can open their own. */
  autoConnect: true,
  /** The user stopped all agents: no server connection until they resume or connect a tab. */
  paused: false,
  ws: null,
  restored: false,
  /** Random id kept per profile; lets the server tell this profile's extension from the others. */
  installId: null,
  /** The Google account of this profile (chrome.identity), if any. */
  account: null,
  /** { directory, name, userDataDir }: the Chrome profile this runs in, as the server identified it. */
  profile: null,
  /** Tabs the user connected. Agents may use them; they never close for an agent. */
  pool: new Set(),
  /** tabId -> sessionId: tabs opened for an agent or by its pages. They close when the session ends. */
  created: new Map(),
  /** sessionId -> { id, name, tabId, color, ... } */
  sessions: new Map(),
  /** tabId -> sessionId of the agent working in it. */
  owner: new Map(),
  /** When the server connection was lost while agent tabs were open (ms), else null. */
  lostAt: null,
  /** tabId -> token of profile pages not reported to the server yet. */
  claims: new Map(),
  /** Tabs showing a badge. */
  badged: new Set(),
  attached: new Set(),
  /** tabId -> Map(contextId -> context) from Runtime.executionContextCreated. */
  contexts: new Map(),
  /** tabId -> main frame id, to tell top-level navigations from iframe ones. */
  mainFrames: new Map(),
  /** tabId -> open JavaScript dialog (alert/confirm/prompt/beforeunload). */
  dialogs: new Map(),
  /** tabId -> console entries since the last page load. */
  consoleLogs: new Map(),
  /** tabId -> tail of that tab's request queue. */
  queues: new Map(),
  /** tabId -> tab ids opened by the page during the running action. */
  opened: new Map(),
};

// ---------------------------------------------------------------------------
// Persistence and lifecycle

async function persist() {
  await chrome.storage.session.set({
    pool: [...state.pool],
    created: [...state.created],
    sessions: [...state.sessions.values()],
    lostAt: state.lostAt,
    paused: state.paused,
  });
}

let restoring = null;

/** Loads the saved state once per service worker start; every entry point awaits it. */
function restore() {
  return (restoring ??= load());
}

async function load() {
  const [saved, local] = await Promise.all([
    chrome.storage.session.get(["pool", "created", "sessions", "lostAt", "paused"]),
    chrome.storage.local.get(["port", "autoConnect", "installId", "profile"]),
  ]);
  if (Number.isInteger(local.port)) state.port = local.port;
  if (typeof local.autoConnect === "boolean") state.autoConnect = local.autoConnect;
  state.installId = typeof local.installId === "string" ? local.installId : crypto.randomUUID();
  if (local.installId !== state.installId) await chrome.storage.local.set({ installId: state.installId });
  if (typeof local.profile?.directory === "string") state.profile = local.profile;
  state.paused = saved.paused === true;
  state.lostAt = typeof saved.lostAt === "number" ? saved.lostAt : null;

  const tabs = await chrome.tabs.query({});
  const alive = new Set(tabs.map((t) => t.id));
  for (const tabId of saved.pool ?? []) if (alive.has(tabId)) state.pool.add(tabId);
  for (const [tabId, sessionId] of saved.created ?? []) if (alive.has(tabId)) state.created.set(tabId, sessionId);
  for (const session of saved.sessions ?? []) {
    session.busy = 0;
    if (session.tabId !== null && !alive.has(session.tabId)) session.tabId = null;
    state.sessions.set(session.id, session);
    if (session.tabId !== null) state.owner.set(session.tabId, session.id);
  }
  // Woken up without a server connection while agent tabs are open: they
  // close unless a server answers within the grace period.
  if (state.lostAt === null && state.created.size) state.lostAt = Date.now();
  for (const tab of tabs) noticeClaim(tab.id, tab.url || tab.pendingUrl);
  state.account = await readAccount();
  state.restored = true;
  refreshBadges();
  ensureSocket();
}

/** The profile's Google account, which tells the server which profile this is. */
function readAccount() {
  return new Promise((resolve) => {
    try {
      chrome.identity.getProfileUserInfo({ accountStatus: "ANY" }, (info) => {
        void chrome.runtime.lastError;
        resolve(info?.email || info?.id ? { email: info.email || undefined, id: info.id || undefined } : null);
      });
    } catch {
      resolve(null);
    }
  });
}

async function tabExists(tabId) {
  return chrome.tabs.get(tabId).then(
    () => true,
    () => false,
  );
}

/** The user allows agents to use this tab (popup "Connect"). */
async function connectTab(tabId) {
  await restore();
  await attachDebugger(tabId);
  if (!state.attached.has(tabId)) await enableDomains(tabId);
  state.pool.add(tabId);
  // A tab the user connected is theirs: it never closes with an agent.
  state.created.delete(tabId);
  state.paused = false;
  await persist();
  refreshBadges();
  ensureSocket();
}

/** The user withdraws a tab; an agent working in it moves on to another tab. */
async function disconnectTab(tabId) {
  await restore();
  state.pool.delete(tabId);
  state.created.delete(tabId);
  const sessionId = state.owner.get(tabId);
  if (sessionId) unassign(state.sessions.get(sessionId));
  await detach(tabId);
  if (!wantsSocket()) closeSocket();
  await persist();
  refreshBadges();
}

/** The user takes over a tab opened for an agent: it stays open and the agent lets go of it. */
async function keepTab(tabId) {
  await restore();
  state.created.delete(tabId);
  const sessionId = state.owner.get(tabId);
  if (sessionId) unassign(state.sessions.get(sessionId));
  await persist();
  refreshBadges();
}

/**
 * Stops all automation: every tab is released, tabs opened for agents stay
 * open as the user's, and the server connection stays closed until resumed.
 */
async function disconnectAll() {
  await restore();
  for (const tabId of [...state.attached]) await detach(tabId);
  for (const session of state.sessions.values()) unassign(session);
  state.sessions.clear();
  state.pool.clear();
  state.created.clear();
  state.paused = true;
  closeSocket();
  await persist();
  refreshBadges();
}

async function resume() {
  await restore();
  state.paused = false;
  await persist();
  ensureSocket();
}

async function setPort(port) {
  await restore();
  state.port = port;
  await chrome.storage.local.set({ port });
  closeSocket();
  ensureSocket();
}

async function setAutoConnect(value) {
  await restore();
  state.autoConnect = !!value;
  await chrome.storage.local.set({ autoConnect: state.autoConnect });
  if (wantsSocket()) ensureSocket();
  else closeSocket();
}

function shortLabel(name) {
  return (name || "AI").replace(/[^\p{L}\p{N}]/gu, "").slice(0, 3).toUpperCase() || "AI";
}

/** Badges: the agent's initials on its tabs, ON on free connected tabs. */
function refreshBadges() {
  const tabs = new Set([...state.pool, ...state.created.keys(), ...state.owner.keys()]);
  for (const tabId of state.badged) if (!tabs.has(tabId)) clearBadge(tabId);
  state.badged = tabs;
  for (const tabId of tabs) {
    const session = state.sessions.get(state.owner.get(tabId) ?? state.created.get(tabId));
    const text = session ? shortLabel(session.name) : state.pool.has(tabId) ? "ON" : "AI";
    chrome.action.setBadgeText({ tabId, text }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ tabId, color: state.pool.has(tabId) && !session ? "#1a7f37" : "#0969da" }).catch(() => {});
  }
}

function clearBadge(tabId) {
  chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Sessions and their tabs

function sessionFor(id, name) {
  let session = state.sessions.get(id);
  if (!session) {
    session = {
      id,
      name: name || id,
      tabId: null,
      color: AGENT_COLORS[state.sessions.size % AGENT_COLORS.length],
      actions: 0,
      lastAction: null,
      lastActivity: null,
      lastError: null,
      busy: 0,
    };
    state.sessions.set(id, session);
  } else if (name && session.name !== name) {
    session.name = name;
  }
  return session;
}

/** Tabs opened for the session (or by its pages) that are still open. */
function createdBy(session) {
  return [...state.created].filter(([, sessionId]) => sessionId === session.id).map(([tabId]) => tabId);
}

function ensureOwnable(session, tabId) {
  const other = state.owner.get(tabId) ?? state.created.get(tabId);
  if (other && other !== session.id) {
    throw new Error(`Tab ${tabId} is being used by another agent (${state.sessions.get(other)?.name ?? other}).`);
  }
}

function unassign(session) {
  if (!session || session.tabId === null) return;
  const tabId = session.tabId;
  state.owner.delete(tabId);
  session.tabId = null;
  // A free tab keeps no debugger attached (and no "is debugging" banner from it).
  void detach(tabId);
  refreshBadges();
}

/** Gives a session the tab, debugger attached. Fails for tabs that cannot be debugged. */
async function assign(session, tabId) {
  ensureOwnable(session, tabId);
  await attachDebugger(tabId);
  if (!state.attached.has(tabId)) await enableDomains(tabId);
  if (session.tabId !== null && session.tabId !== tabId) unassign(session);
  session.tabId = tabId;
  state.owner.set(tabId, session.id);
  await persist();
  refreshBadges();
}

/** The session ended: its tabs close, except the ones the user connected or kept. */
function endSession(session) {
  unassign(session);
  state.sessions.delete(session.id);
  closeAgentTabs((sessionId) => sessionId === session.id);
}

function closeAgentTabs(belongs) {
  for (const [tabId, sessionId] of [...state.created]) {
    if (!belongs(sessionId)) continue;
    state.created.delete(tabId);
    chrome.tabs.remove(tabId).catch(() => {});
  }
}

const claims = new Map();

/** The session's tab: its current one, another of its own, a free connected tab, or a new tab. */
function tabFor(session) {
  // Serialized per session so parallel requests don't each open a tab.
  const pending = claims.get(session.id);
  if (pending) return pending;
  const claim = claimTab(session).finally(() => claims.delete(session.id));
  claims.set(session.id, claim);
  return claim;
}

async function claimTab(session) {
  if (session.tabId !== null) {
    if (await tabExists(session.tabId)) return session.tabId;
    unassign(session);
  }
  if (await takeFreeTab(session)) return session.tabId;
  if (!state.autoConnect && !state.pool.size) throw new Error("No tab is connected");
  const tabId = await openTabFor(session);
  await assign(session, tabId);
  return tabId;
}

/** Moves the session to another of its own tabs, or a free tab the user connected. */
async function takeFreeTab(session, except = null) {
  for (const tabId of [...createdBy(session), ...state.pool]) {
    if (tabId === except || state.owner.has(tabId) || !(await tabExists(tabId))) continue;
    try {
      await assign(session, tabId);
      return true;
    } catch {
      // e.g. a connected tab now showing chrome://: try the next one.
    }
  }
  return false;
}

/** Opens a background tab for the session: next to its other tabs, else in the last used window. */
async function openTabFor(session, url) {
  const target = url || "about:blank";
  const windowId = await windowFor(session);
  let tab;
  if (windowId !== null) {
    tab = await chrome.tabs.create({ url: target, active: false, windowId });
  } else {
    // This profile has no window (e.g. it was just opened for the agent).
    const window = await chrome.windows.create({ url: target, focused: false });
    tab = window.tabs[0];
  }
  state.created.set(tab.id, session.id);
  await persist();
  return tab.id;
}

async function windowFor(session) {
  for (const tabId of [session.tabId, ...createdBy(session), ...state.pool]) {
    if (tabId === null) continue;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const window = tab && (await chrome.windows.get(tab.windowId).catch(() => null));
    if (window?.type === "normal") return window.id;
  }
  const window = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
  return window?.id ?? null;
}

/** The server's list of live sessions: the tabs of the others close. */
async function updateSessions({ sessions }) {
  const active = new Set(sessions.map((s) => s.id));
  for (const s of sessions) sessionFor(s.id, s.name);
  for (const session of [...state.sessions.values()]) {
    if (!active.has(session.id)) endSession(session);
  }
  closeAgentTabs((sessionId) => !active.has(sessionId));
  await persist();
  refreshBadges();
  return { ok: true };
}

/** The server went away and did not come back: every agent tab closes. */
async function checkOrphans() {
  await restore();
  // Connected, or still trying: the server decides.
  if (state.ws && state.ws.readyState <= WebSocket.OPEN) return;
  if (state.lostAt === null || Date.now() - state.lostAt < ORPHAN_GRACE_MS) return;
  state.lostAt = null;
  for (const session of [...state.sessions.values()]) endSession(session);
  closeAgentTabs(() => true);
  await persist();
  refreshBadges();
}

function markLost() {
  if (state.lostAt === null) state.lostAt = Date.now();
  void persist();
  setTimeout(() => void checkOrphans(), ORPHAN_GRACE_MS + 250);
}

// ---------------------------------------------------------------------------
// Chrome profiles

/**
 * A server that opens this profile loads its one-time page here; reporting
 * the token tells it which connection runs in the profile. The server answers
 * with profile_set, which also hands this tab to the agent that asked.
 */
function noticeClaim(tabId, url) {
  const match = url && CLAIM_URL.exec(url);
  if (!match || Number(match[1]) !== state.port) return;
  state.claims.set(tabId, match[2]);
  flushClaims();
  ensureSocket();
}

function flushClaims() {
  const ws = state.ws;
  if (ws?.readyState !== WebSocket.OPEN) return;
  for (const [tabId, token] of state.claims) send(ws, { type: "profile_claim", payload: { token, tabId } });
  state.claims.clear();
}

async function setProfile({ profile, adopt }) {
  state.profile = profile;
  await chrome.storage.local.set({ profile });
  if (adopt && (await tabExists(adopt.tabId))) {
    const session = sessionFor(adopt.sessionId, adopt.sessionName);
    state.created.set(adopt.tabId, session.id);
    await chrome.tabs.update(adopt.tabId, { url: "about:blank" }).catch(() => {});
    await waitForDocument(adopt.tabId);
    await assign(session, adopt.tabId).catch(() => {});
  }
  await persist();
  refreshBadges();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// WebSocket connection to the MCP server

let reconnectTimer = null;
let attempts = 0;

function wantsSocket() {
  return !state.paused && (state.autoConnect || state.pool.size > 0 || state.created.size > 0 || state.claims.size > 0);
}

function ensureSocket() {
  if (!state.restored || !wantsSocket()) return;
  if (state.ws && state.ws.readyState <= WebSocket.OPEN) return;
  clearTimeout(reconnectTimer);

  const ws = new WebSocket(`ws://localhost:${state.port}`);
  state.ws = ws;
  let opened = false;
  let keepalive = null;

  ws.onopen = () => {
    opened = true;
    attempts = 0;
    // The server reports its sessions shortly; it decides which agent tabs stay.
    state.lostAt = null;
    void persist();
    send(ws, { type: "hello", payload: helloPayload() });
    flushClaims();
    // Socket traffic keeps the MV3 service worker alive while connected.
    keepalive = setInterval(() => send(ws, { type: "ping" }), KEEPALIVE_MS);
  };

  ws.onmessage = (event) => onServerMessage(ws, event.data);

  ws.onclose = () => {
    clearInterval(keepalive);
    if (state.ws === ws) state.ws = null;
    // A newer socket replaced this one (e.g. the port changed): it decides.
    if (state.ws) return;
    if (opened) markLost();
    else void checkOrphans();
    if (wantsSocket()) {
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(ensureSocket, RECONNECT_MS[Math.min(attempts++, RECONNECT_MS.length - 1)]);
    }
  };
  ws.onerror = () => {};
}

function helloPayload() {
  return {
    name: "browsermcp-plus",
    version: chrome.runtime.getManifest().version,
    capabilities: CAPABILITIES,
    installId: state.installId,
    ...(state.account ? { account: state.account } : {}),
    ...(state.profile ? { profile: state.profile } : {}),
  };
}

function closeSocket() {
  clearTimeout(reconnectTimer);
  const ws = state.ws;
  state.ws = null;
  ws?.close();
}

function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

// Wakes the worker periodically so it reconnects after the server restarts,
// and closes agent tabs a vanished server left behind.
chrome.alarms?.create("reconnect", { periodInMinutes: 0.5 });
chrome.alarms?.onAlarm.addListener(() =>
  restore().then(() => {
    ensureSocket();
    void checkOrphans();
  }),
);

/** Messages that don't act in a tab. */
const TABLESS = new Set(["browser_wait", "browser_tab_list", "sessions_update", "profile_set"]);
/** Reads that never touch the page, so they need not wait for the tab's queue. */
const UNQUEUED = new Set(["getUrl", "getTitle", "browser_get_console_logs"]);

async function onServerMessage(ws, data) {
  let message;
  try {
    message = JSON.parse(data);
  } catch {
    return;
  }
  if (!message || typeof message.id !== "string" || typeof message.type !== "string") return;

  const timeoutMs =
    message.type === "browser_wait"
      ? (Number(message.payload?.time) || 0) * 1000 + REQUEST_TIMEOUT_MS
      : REQUEST_TIMEOUT_MS;
  let response;
  try {
    const result = await withTimeout(dispatch(message), timeoutMs, message.type);
    response = { requestId: message.id, result };
  } catch (error) {
    response = { requestId: message.id, error: errorMessage(error) };
  }
  send(ws, { type: "messageResponse", payload: response });
}

/** Messages that are bookkeeping rather than something an agent did. */
const QUIET = new Set(["getUrl", "getTitle", "sessions_update", "profile_set"]);

async function dispatch(message) {
  await restore();
  if (!handlers[message.type]) throw new Error(`Unsupported message "${message.type}"`);
  const session = sessionFor(message.sessionId || DEFAULT_SESSION, message.sessionName);
  if (QUIET.has(message.type)) return execute(message, session);
  // Activity shown in the popup.
  session.busy = (session.busy ?? 0) + 1;
  session.actions = (session.actions ?? 0) + 1;
  session.lastAction = message.type.replace(/^browser_/, "");
  session.lastActivity = Date.now();
  try {
    const result = await execute(message, session);
    session.lastError = null;
    return result;
  } catch (error) {
    session.lastError = errorMessage(error).slice(0, 140);
    throw error;
  } finally {
    session.busy -= 1;
    session.lastActivity = Date.now();
  }
}

async function execute({ type, payload = {} }, session) {
  const handler = handlers[type];
  if (TABLESS.has(type)) return handler(payload, { session, tabId: null });
  const tabId = await tabFor(session);
  const run = () => handler(payload, { session, tabId });
  if (UNQUEUED.has(type)) return run();
  // One request at a time per tab, so input events never interleave; other
  // agents' tabs proceed in parallel.
  const result = (state.queues.get(tabId) ?? Promise.resolve()).then(run);
  state.queues.set(
    tabId,
    result.catch(() => {}),
  );
  return result;
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
  await enableDomains(tabId);
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

async function enableDomains(tabId) {
  state.attached.add(tabId);
  state.contexts.set(tabId, new Map());
  state.consoleLogs.set(tabId, []);
  await cdp(tabId, "Runtime.enable");
  // Page events: JavaScript dialogs, navigation start/finish, main frame id.
  await cdp(tabId, "Page.enable");
  // Agents often work in background tabs, which Chrome hides: it stops
  // rendering them, throttles their timers ~100x and leaves input events
  // unprocessed. Focus emulation (DevTools' "Emulate a focused page") keeps
  // the page visible and responsive while the debugger is attached.
  await cdp(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  const { frameTree } = await cdp(tabId, "Page.getFrameTree");
  state.mainFrames.set(tabId, frameTree.frame.id);
}

async function detach(tabId) {
  state.attached.delete(tabId);
  state.contexts.delete(tabId);
  state.mainFrames.delete(tabId);
  state.dialogs.delete(tabId);
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

  if (method === "Page.javascriptDialogOpening") {
    state.dialogs.set(tabId, { type: params.type, message: params.message, defaultPrompt: params.defaultPrompt });
    for (const waiter of dialogWaiters) if (waiter.tabId === tabId) waiter.notify();
  } else if (method === "Page.javascriptDialogClosed") {
    state.dialogs.delete(tabId);
  } else if (method === "Runtime.consoleAPICalled") {
    pushLog(tabId, {
      type: params.type,
      timestamp: params.timestamp,
      message: params.args.map(formatRemoteObject).join(" "),
    });
  } else if (method === "Runtime.exceptionThrown") {
    const details = params.exceptionDetails;
    pushLog(tabId, {
      type: "error",
      timestamp: params.timestamp,
      message: details.exception?.description ?? details.text,
    });
  }
});

function pushLog(tabId, entry) {
  const logs = state.consoleLogs.get(tabId);
  if (!logs) return;
  logs.push(entry);
  if (logs.length > MAX_CONSOLE_ENTRIES) logs.shift();
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
  state.dialogs.delete(source.tabId);
  // The user pressed "Cancel" on Chrome's debugging banner: stop all automation.
  if (reason === "canceled_by_user") void disconnectAll();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const sessionId = state.owner.get(tabId);
  if (sessionId) {
    state.owner.delete(tabId);
    const session = state.sessions.get(sessionId);
    if (session) session.tabId = null;
  }
  state.attached.delete(tabId);
  state.contexts.delete(tabId);
  state.consoleLogs.delete(tabId);
  state.dialogs.delete(tabId);
  state.queues.delete(tabId);
  state.claims.delete(tabId);
  state.badged.delete(tabId);
  const pooled = state.pool.delete(tabId);
  const created = state.created.delete(tabId);
  if (pooled || created || sessionId) {
    if (!wantsSocket()) closeSocket();
    void persist();
  }
});

// A page opened a tab or window (a link to a new tab, window.open). Unlike a
// tab's openerTabId, which Chrome sets to the window's active tab when a
// background tab opens one, sourceTabId names the tab that really did.
chrome.webNavigation.onCreatedNavigationTarget.addListener(({ sourceTabId, tabId }) => {
  void restore().then(() => {
    state.opened.get(sourceTabId)?.push(tabId);
    // The agent working in (or owning) the source tab owns the new one: it closes with the agent.
    const sessionId = state.owner.get(sourceTabId) ?? state.created.get(sourceTabId);
    if (!sessionId || state.created.has(tabId) || state.pool.has(tabId)) return;
    state.created.set(tabId, sessionId);
    void persist();
    refreshBadges();
  });
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading" && state.consoleLogs.has(tabId)) state.consoleLogs.set(tabId, []);
  if (info.url) noticeClaim(tabId, info.url);
});

// ---------------------------------------------------------------------------
// Dialogs and navigation tracking

const dialogWaiters = new Set();

/** Resolves when a JavaScript dialog opens in the tab. */
function whenDialogOpens(tabId) {
  const waiter = { tabId };
  const promise = new Promise((resolve) => (waiter.notify = resolve));
  dialogWaiters.add(waiter);
  return { promise, cancel: () => dialogWaiters.delete(waiter) };
}

function dialogError(tabId) {
  const { type, message } = state.dialogs.get(tabId);
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
 * Waits until the DOM has stopped changing for `quietMs` (at most `maxMs`).
 * Timed from the service worker: timers inside background tabs are throttled
 * to about once per second, the worker's are not.
 */
async function settleDom(tabId, quietMs = 60, maxMs = 1_500) {
  const deadline = Date.now() + maxMs;
  let last = await callAgent(tabId, "mutations");
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    await sleep(20);
    const count = await callAgent(tabId, "mutations");
    if (count !== last) {
      last = count;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= quietMs) {
      return;
    }
  }
}

/**
 * Runs a page action, then lets the page react: follows a navigation the
 * action started, otherwise waits briefly for the DOM to settle. A dialog
 * opened by the action ends the wait (the page is blocked until it is
 * handled). Returns a report of what happened.
 */
async function runAction(tabId, action, { startWindowMs = 80, allowDialog = false } = {}) {
  if (state.dialogs.has(tabId) && !allowDialog) throw dialogError(tabId);
  const opened = [];
  state.opened.set(tabId, opened);
  const tracker = trackNavigation(tabId);
  const dialog = whenDialogOpens(tabId);
  try {
    const work = (async () => {
      const value = await action();
      if (state.dialogs.has(tabId)) return value;
      const quiet = settleDom(tabId).catch(() => {});
      await Promise.race([tracker.whenStarted, sleep(startWindowMs)]);
      if (!tracker.started) await quiet;
      if (tracker.started) {
        await waitForDocument(tabId, tracker);
        await settleDom(tabId, 60, 1_000).catch(() => {});
      }
      return value;
    })();
    work.catch(() => {}); // keeps running in the background if a dialog interrupts it
    const value = await Promise.race([work, dialog.promise.then(() => undefined)]);
    return await actionReport(tabId, tracker, value, opened);
  } finally {
    tracker.stop();
    dialog.cancel();
    if (state.opened.get(tabId) === opened) state.opened.delete(tabId);
  }
}

async function actionReport(tabId, tracker, value, opened = []) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const report = { url: tab?.url || tab?.pendingUrl || "", title: tab?.title ?? "", navigated: tracker.started };
  if (state.dialogs.has(tabId)) report.dialog = { ...state.dialogs.get(tabId) };
  if (opened.length) {
    const tabs = await Promise.all(opened.map((id) => chrome.tabs.get(id).then((t) => tabInfo(t), () => null)));
    report.newTabs = tabs.filter(Boolean);
  }
  if (value !== undefined) report.value = value;
  return report;
}

// ---------------------------------------------------------------------------
// Page agent

const NAVIGATION_ERROR = /removed|No frame|Frame with ID|did not respond|navigat|context was destroyed/i;

/** Calls the page agent in a tab; blocked by an open dialog, retried once if the page was navigating. */
async function callAgent(tabId, method, ...args) {
  if (state.dialogs.has(tabId)) throw dialogError(tabId);
  const dialog = whenDialogOpens(tabId);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        return await Promise.race([
          runAgent(tabId, method, args),
          dialog.promise.then(() => {
            throw dialogError(tabId);
          }),
        ]);
      } catch (error) {
        const message = errorMessage(error);
        if (/Cannot access (contents of )?(url|the page)|cannot be scripted/i.test(message)) {
          const { url } = await chrome.tabs.get(tabId);
          throw new Error(`This page (${url}) can't be read or controlled by extensions. Navigate to a website first.`);
        }
        if (attempt > 0 || state.dialogs.has(tabId) || !NAVIGATION_ERROR.test(message)) throw error;
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

/**
 * Where to click an element: scrolls it into view, waits until its position
 * is stable and, with `check`, makes sure it is enabled and not covered by
 * another element. The waiting is timed here rather than in the page, whose
 * timers are throttled in background tabs.
 */
async function pointFor(tabId, ref, check = true) {
  await callAgent(tabId, "prepareTarget", ref, check);
  let point = await callAgent(tabId, "center", ref);
  for (let i = 0; i < 6; i++) {
    await sleep(30);
    const next = await callAgent(tabId, "center", ref);
    if (next.x === point.x && next.y === point.y) break;
    point = next;
  }
  if (!check) return point;
  for (let attempt = 0; ; attempt++) {
    const blocker = await callAgent(tabId, "blocker", ref);
    if (!blocker) return callAgent(tabId, "center", ref);
    if (attempt >= 4) {
      throw new Error(`Element "${ref}" is covered by ${blocker}, which would receive the click. Dismiss or close it first.`);
    }
    await sleep(100);
  }
}

/** CDP handle for the element behind a snapshot ref, in the page's own (main) world. */
async function resolveRef(tabId, ref, { mainWorld = false } = {}) {
  // Validates the ref (and injects the agent) with a readable error first.
  await callAgent(tabId, "check", ref);
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
  const kind = await callAgent(tabId, "editKind", ref);
  if (kind === "direct") {
    // Date, time, colour and range inputs cannot be typed into reliably.
    await callAgent(tabId, "setValue", ref, text);
  } else {
    try {
      await mouseClick(tabId, await pointFor(tabId, ref));
    } catch (error) {
      // A floating label or similar overlay: focusing programmatically is fine for typing.
      if (!/covered by/.test(errorMessage(error))) throw error;
    }
    const hadContent = await callAgent(tabId, "selectContent", ref);
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
  const value = await callAgent(tabId, "fieldValue", ref).catch(() => undefined);
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
      if ((await callAgent(tabId, "isChecked", ref)) !== want) await mouseClick(tabId, await pointFor(tabId, ref));
      if ((await callAgent(tabId, "isChecked", ref)) !== want) throw new Error(`could not ${want ? "check" : "uncheck"} it`);
      return `${name}: ${want ? "checked" : "unchecked"}`;
    }
    case "combobox":
    case "listbox": {
      if (!(await callAgent(tabId, "isNativeSelect", ref))) {
        throw new Error("not a native <select>; open it with browser_click and click the option instead");
      }
      return `${name}: ${(await callAgent(tabId, "selectOptions", ref, [value])).join(", ")}`;
    }
    case "slider":
      return `${name}: ${await callAgent(tabId, "setValue", ref, value)}`;
    default:
      throw new Error(`unsupported field type "${type}"`);
  }
}

async function uploadFiles(tabId, ref, paths) {
  if (await callAgent(tabId, "isFileInput", ref)) {
    const objectId = await resolveRef(tabId, ref);
    await cdp(tabId, "DOM.setFileInputFiles", { files: paths, objectId });
    return;
  }
  // A button that opens a file chooser: intercept the dialog instead of showing it.
  await cdp(tabId, "Page.setInterceptFileChooserDialog", { enabled: true });
  try {
    const opened = waitForEvent(tabId, "Page.fileChooserOpened", 5_000);
    await mouseClick(tabId, await pointFor(tabId, ref));
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Message handlers. Each gets the payload and { session, tabId }.

function tabInfo(tab, session) {
  const owner = state.sessions.get(state.owner.get(tab.id) ?? state.created.get(tab.id));
  return {
    id: tab.id,
    windowId: tab.windowId,
    title: tab.title ?? "",
    // A tab that is still loading has an empty url and the target in pendingUrl.
    url: tab.url || tab.pendingUrl || "",
    active: tab.active,
    connected: !!session && state.owner.get(tab.id) === session.id,
    ...(owner && owner.id !== session?.id ? { agent: owner.name } : {}),
  };
}

const handlers = {
  async getUrl(_payload, { tabId }) {
    return (await chrome.tabs.get(tabId)).url;
  },
  async getTitle(_payload, { tabId }) {
    return (await chrome.tabs.get(tabId)).title;
  },
  async browser_snapshot(_payload, { tabId }) {
    if (state.dialogs.has(tabId)) throw dialogError(tabId);
    return callAgent(tabId, "snapshot");
  },
  async browser_navigate({ url }, { tabId }) {
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
  async browser_go_back(_payload, { tabId }) {
    await ensureAttached(tabId);
    return runAction(tabId, () => chrome.tabs.goBack(tabId), { startWindowMs: 1_000 });
  },
  async browser_go_forward(_payload, { tabId }) {
    await ensureAttached(tabId);
    return runAction(tabId, () => chrome.tabs.goForward(tabId), { startWindowMs: 1_000 });
  },
  async browser_wait({ time }) {
    await sleep(Math.max(0, Number(time) || 0) * 1000);
  },
  async browser_press_key({ key }, { tabId }) {
    await ensureAttached(tabId);
    return runAction(tabId, () => pressKey(tabId, key));
  },
  async browser_click({ ref }, { tabId }) {
    await ensureAttached(tabId);
    return runAction(tabId, async () => mouseClick(tabId, await pointFor(tabId, ref)));
  },
  async browser_hover({ ref }, { tabId }) {
    await ensureAttached(tabId);
    return runAction(tabId, async () => {
      const { x, y } = await pointFor(tabId, ref, false);
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    });
  },
  async browser_drag({ startRef, endRef }, { tabId }) {
    await ensureAttached(tabId);
    return runAction(tabId, async () => {
      const { from, to } = await callAgent(tabId, "dragPoints", startRef, endRef);
      await drag(tabId, from, to);
    });
  },
  async browser_type({ ref, text, submit, slowly }, { tabId }) {
    await ensureAttached(tabId);
    return runAction(tabId, () => typeInto(tabId, ref, text, { submit, slowly }));
  },
  async browser_select_option({ ref, values }, { tabId }) {
    await ensureAttached(tabId);
    return runAction(tabId, () => callAgent(tabId, "selectOptions", ref, values));
  },
  async browser_screenshot(_payload, { tabId }) {
    await ensureAttached(tabId);
    if (state.dialogs.has(tabId)) throw dialogError(tabId);
    const { data } = await cdp(tabId, "Page.captureScreenshot", { format: "png" });
    return data;
  },
  async browser_get_console_logs(_payload, { tabId }) {
    return state.consoleLogs.get(tabId) ?? [];
  },

  // --- Browser MCP Plus-only messages -------------------------------------

  async browser_upload_file({ ref, paths }, { tabId }) {
    await ensureAttached(tabId);
    return runAction(tabId, () => uploadFiles(tabId, ref, paths));
  },

  async browser_handle_dialog({ accept, promptText }, { tabId }) {
    const dialog = state.dialogs.get(tabId);
    if (!dialog) throw new Error("No dialog is open.");
    return runAction(
      tabId,
      async () => {
        await cdp(tabId, "Page.handleJavaScriptDialog", { accept, ...(promptText === undefined ? {} : { promptText }) });
        state.dialogs.delete(tabId);
        return `${accept ? "Accepted" : "Dismissed"} the ${dialog.type} dialog ${JSON.stringify(dialog.message)}`;
      },
      { allowDialog: true, startWindowMs: 300 },
    );
  },

  async browser_fill_form({ fields }, { tabId }) {
    await ensureAttached(tabId);
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

  async browser_evaluate({ function: source, ref }, { tabId }) {
    await ensureAttached(tabId);
    if (state.dialogs.has(tabId)) throw dialogError(tabId);
    const options = { awaitPromise: true, returnByValue: true, userGesture: true };
    let response;
    if (ref) {
      const objectId = await resolveRef(tabId, ref, { mainWorld: true });
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

  async browser_scroll({ ref, deltaX = 0, deltaY = 0 }, { tabId }) {
    await ensureAttached(tabId);
    return runAction(tabId, async () => {
      if (ref) {
        await callAgent(tabId, "scrollIntoView", ref);
        return;
      }
      const { width, height } = await callAgent(tabId, "viewport");
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x: width / 2, y: height / 2, deltaX, deltaY });
    });
  },

  async browser_tab_list(_payload, { session }) {
    const tabs = await chrome.tabs.query({});
    return tabs.map((tab) => tabInfo(tab, session));
  },

  async browser_tab_new({ url }, { session }) {
    // The tab is the agent's even if it cannot be controlled (e.g. chrome://): it closes with the agent.
    const tabId = await openTabFor(session, url);
    await assign(session, tabId);
    if (url) await waitForDocument(tabId);
    return tabInfo(await chrome.tabs.get(tabId), session);
  },

  async browser_tab_select({ tabId: target }, { session }) {
    await assign(session, target);
    return tabInfo(await chrome.tabs.get(target), session);
  },

  async browser_tab_close({ tabId: target }, { session }) {
    target ??= session.tabId;
    if (target === null || target === undefined) throw new Error("You have no tab to close.");
    ensureOwnable(session, target);
    if (target === session.tabId) unassign(session);
    await chrome.tabs.remove(target);
    // Carry on in another tab of this agent's, or a free connected tab;
    // otherwise a tab is found (or opened) on the next request.
    if (await takeFreeTab(session, target)) return tabInfo(await chrome.tabs.get(session.tabId), session);
    return null;
  },

  sessions_update: updateSessions,
  profile_set: setProfile,
};

// The agent's tab is resolved in dispatch(); these handlers use the session instead.
TABLESS.add("browser_tab_new");
TABLESS.add("browser_tab_select");
TABLESS.add("browser_tab_close");

// ---------------------------------------------------------------------------
// Popup and test hooks

async function status() {
  await restore();
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabs = [];
  for (const tabId of new Set([...state.pool, ...state.created.keys(), ...state.owner.keys()])) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) continue;
    const session = state.sessions.get(state.owner.get(tab.id) ?? state.created.get(tab.id));
    tabs.push({
      id: tab.id,
      title: tab.title ?? "",
      url: tab.url || tab.pendingUrl || "",
      favIconUrl: tab.favIconUrl ?? "",
      agent: session?.name ?? null,
      color: session?.color ?? null,
      /** Opened for an agent (or by its page): closes when the agent's session ends. */
      openedForAgent: state.created.has(tab.id),
      connectedByUser: state.pool.has(tab.id),
    });
  }
  // Agents that worked in this profile; the others work in other profiles.
  const agents = [...state.sessions.values()]
    .filter((s) => s.actions || s.tabId !== null || createdBy(s).length > 0)
    .map((s) => {
      const tab = tabs.find((t) => t.id === s.tabId);
      return {
        id: s.id,
        name: s.name,
        color: s.color,
        tabId: s.tabId,
        tabTitle: tab?.title ?? null,
        tabUrl: tab?.url ?? null,
        tabCount: createdBy(s).length,
        busy: (s.busy ?? 0) > 0,
        actions: s.actions ?? 0,
        lastAction: s.lastAction ?? null,
        lastActivity: s.lastActivity ?? null,
        lastError: s.lastError ?? null,
      };
    });
  const here = active ? tabs.find((t) => t.id === active.id) : undefined;
  return {
    port: state.port,
    version: chrome.runtime.getManifest().version,
    autoConnect: state.autoConnect,
    paused: state.paused,
    profile: state.profile,
    account: state.account?.email ?? null,
    activeTabId: active?.id ?? null,
    activeConnected: active ? state.pool.has(active.id) : false,
    /** The active tab was opened for an agent: the popup offers to keep it. */
    activeAgentTab: here?.openedForAgent ? { agent: here.agent } : null,
    activeRestricted: !active?.url || !/^(https?|file):/.test(active.url),
    tabs,
    agents,
    serverConnected: state.ws?.readyState === WebSocket.OPEN,
  };
}

async function focusTab(tabId) {
  const tab = await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  return status();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const actions = {
    status: () => status(),
    connect: () => connectTab(message.tabId).then(status),
    disconnect: () => (message.tabId ? disconnectTab(message.tabId) : disconnectAll()).then(status),
    disconnectAll: () => disconnectAll().then(status),
    keepTab: () => keepTab(message.tabId).then(status),
    resume: () => resume().then(status),
    focusTab: () => focusTab(message.tabId),
    setPort: () => setPort(message.port).then(status),
    setAutoConnect: () => setAutoConnect(message.value).then(status),
  };
  const action = actions[message?.cmd];
  if (!action) return false;
  action().then(
    (value) => sendResponse({ ok: true, value }),
    (error) => sendResponse({ ok: false, error: errorMessage(error) }),
  );
  return true;
});

globalThis.bmcp = { connectTab, disconnectTab, disconnectAll, keepTab, resume, setPort, setAutoConnect, status, checkOrphans };

void restore();
