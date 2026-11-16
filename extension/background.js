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
//
// The tabs agents open sit in one tab group per profile ("AI"), whatever the
// number of agents. The debugger (and Chrome's "is debugging" bar) is only
// attached while an agent clicks, types or takes screenshots; reading pages
// goes through content scripts.

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
/** The one tab group agent tabs share in a profile. */
const GROUP_TITLE = "AI";
const GROUP_COLOR = "blue";
/** The debugger is detached from a tab this long after its last use, so Chrome's bar goes away. */
const DEBUGGER_IDLE_MS = 20_000;
/** Reads right after a page loaded wait (at most this long) for its content to settle. */
const FRESH_PAGE_MS = 8_000;
/** Largest file browser_get_file returns. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** What the overlay says an agent is doing, by message. */
const ACTIVITY = {
  browser_snapshot: "reading", browser_get_text: "reading", browser_get_console_logs: "reading", browser_get_file: "reading",
  browser_navigate: "opening", browser_go_back: "opening", browser_go_forward: "opening",
  browser_click: "clicking", browser_hover: "clicking", browser_drag: "clicking", browser_select_option: "clicking",
  browser_handle_dialog: "clicking", browser_type: "typing", browser_fill_form: "typing", browser_press_key: "typing",
  browser_scroll: "scrolling", browser_screenshot: "looking", browser_upload_file: "uploading", browser_evaluate: "running",
};
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
  "browser_get_text",
  "browser_get_file",
  "browser_downloads",
  "browser_download",
  "browser_tab_handoff",
  "browser_tab_take",
  "browser_tab_release",
  "frames",
  "element_screenshot",
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
  /** tabId -> { note, agent, sessionId, at }: tabs an agent left to the user. */
  handoffs: new Map(),
  /** tabId -> { sessionId, kind, at }: agent tabs the user stepped in on (clicked or typed in). */
  stepIns: new Map(),
  /**
   * tabId -> { sessionId, agent, note, from: { windowId, index, groupId, pinned } }:
   * the user's tabs an agent took to work in. They stay the user's: given back
   * (never closed) when the agent is done.
   */
  taken: new Map(),
  /** sessionId -> tabId the user took back from it (Give back), reported on its next request. */
  reclaimed: new Map(),
  /** tabId -> [start, end] of the agent's last request there: input then is the agent's. */
  agentWindow: new Map(),
  /** The "AI" tab group of this profile. */
  groupId: null,
  /**
   * windowId -> ids of the tabs the window showed, most recent first: what to
   * show again when an agent's tab comes to the front by itself.
   */
  shown: new Map(),
  /** tabId -> when an agent's page opened it (a link to a new tab), while it may still come to the front. */
  openedByAgent: new Map(),
  /** tabId -> last time the debugger was used in it. */
  cdpUsedAt: new Map(),
  /** tabId -> requests running in it (its debugger stays attached meanwhile). */
  busy: new Map(),
  /** tabId -> when its page last committed a navigation. */
  committedAt: new Map(),
  /** tabId -> { text, ms }: the last snapshot, to report what an action changed. */
  lastSnap: new Map(),
  /** tabId -> Map(frameId -> { token, inlined, parent, url }) from the last multi-frame read. */
  frameInfo: new Map(),
  /** tabId -> failed network requests since the page loaded. */
  network: new Map(),
  /** tabId -> when the agent's last action in it ended. */
  actedAt: new Map(),
  /** Tabs whose current page got the agent's input (it may now ask before unloading). */
  activated: new Set(),
  /** tabId -> when the console hook went into its page. */
  hookedAt: new Map(),
  /** tabId -> console messages from before the hook, replayed by the debugger. */
  earlyConsole: new Map(),
  /** Downloads started while an action ran, by the tab of that action. */
  downloadWatch: new Map(),
  attached: new Set(),
  /** tabId -> Map(contextId -> context) from Runtime.executionContextCreated. */
  contexts: new Map(),
  /** tabId -> main frame id, to tell top-level navigations from iframe ones. */
  mainFrames: new Map(),
  /** tabId -> open JavaScript dialog (alert/confirm/prompt/beforeunload). */
  dialogs: new Map(),
  /** tabId -> tail of that tab's request queue. */
  queues: new Map(),
  /** tabId -> tab ids opened by the page during the running action. */
  opened: new Map(),
};

// ---------------------------------------------------------------------------
// Persistence and lifecycle

async function persist() {
  const tabs = {
    created: [...state.created],
    handoffs: [...state.handoffs],
    stepIns: [...state.stepIns],
    taken: [...state.taken],
    groupId: state.groupId,
  };
  await Promise.all([
    chrome.storage.session.set({
      pool: [...state.pool],
      sessions: [...state.sessions.values()],
      lostAt: state.lostAt,
      paused: state.paused,
      ...tabs,
    }),
    // Survives reloading the extension (session storage does not), so agent
    // tabs are still closed when their agent ends. Tab ids are not reused
    // after a browser restart, so stale entries never match a user's tab.
    chrome.storage.local.set({ agentTabs: tabs }),
  ]);
}

let restoring = null;

/** Loads the saved state once per service worker start; every entry point awaits it. */
function restore() {
  return (restoring ??= load());
}

async function load() {
  const [saved, local] = await Promise.all([
    chrome.storage.session.get(["pool", "created", "sessions", "lostAt", "paused", "handoffs", "stepIns", "taken", "groupId", "shown"]),
    chrome.storage.local.get(["port", "autoConnect", "installId", "profile", "agentTabs"]),
  ]);
  // The extension was reloaded: session storage is empty, the local copy is not.
  const tabsSaved = saved.created ? saved : (local.agentTabs ?? {});
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
  for (const [tabId, sessionId] of tabsSaved.created ?? []) if (alive.has(tabId)) state.created.set(tabId, sessionId);
  for (const [tabId, handoff] of tabsSaved.handoffs ?? []) if (alive.has(tabId)) state.handoffs.set(tabId, handoff);
  for (const [tabId, stepIn] of tabsSaved.stepIns ?? []) if (alive.has(tabId)) state.stepIns.set(tabId, stepIn);
  for (const [tabId, taken] of tabsSaved.taken ?? []) if (alive.has(tabId)) state.taken.set(tabId, taken);
  if (Number.isInteger(tabsSaved.groupId)) {
    state.groupId = (await chrome.tabGroups?.get(tabsSaved.groupId).catch(() => null)) ? tabsSaved.groupId : null;
  }
  for (const [windowId, ids] of saved.shown ?? []) {
    const kept = ids.filter((id) => alive.has(id));
    if (kept.length) state.shown.set(windowId, kept);
  }
  for (const tab of tabs) if (tab.active && !state.shown.has(tab.windowId)) state.shown.set(tab.windowId, [tab.id]);
  for (const session of saved.sessions ?? []) {
    session.busy = 0;
    if (session.tabId !== null && !alive.has(session.tabId)) session.tabId = null;
    state.sessions.set(session.id, session);
    if (session.tabId !== null) state.owner.set(session.tabId, session.id);
  }
  // Woken up without a server connection while agent tabs are open: they
  // close unless a server answers within the grace period.
  if (state.lostAt === null && (state.created.size || state.taken.size)) state.lostAt = Date.now();
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
  const tab = await chrome.tabs.get(tabId);
  if (!/^(https?|file):/.test(tab.url || tab.pendingUrl || "")) {
    throw new Error("This page can't be automated (browser pages and the Web Store are off limits). Open a website first.");
  }
  state.pool.add(tabId);
  state.handoffs.delete(tabId);
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
  if (state.handoffs.has(tabId)) await handoffSeen(tabId);
  state.created.delete(tabId);
  const sessionId = state.owner.get(tabId);
  if (sessionId) unassign(state.sessions.get(sessionId));
  await ungroupTab(tabId);
  await persist();
  refreshBadges();
}

/**
 * The agent leaves a tab to the user (a sign-in, a captcha, a result to look
 * at): it leaves the group, never closes with the agent, and the page and the
 * toolbar icon show that something waits for the user.
 */
async function handoffTab(session, tabId, note) {
  const mine = state.created.get(tabId) === session.id || state.owner.get(tabId) === session.id;
  if (!mine) {
    throw new Error(`Tab ${tabId} is not one of your tabs. Hand over a tab you opened or work in (browser_tab_list shows them).`);
  }
  // A tab taken from the user goes back to its place first, then waits for them there.
  if (state.taken.get(tabId)?.sessionId === session.id) await giveBack(tabId);
  state.created.delete(tabId);
  if (state.owner.get(tabId) === session.id) unassign(session);
  await ungroupTab(tabId);
  state.stepIns.delete(tabId);
  const tab = await chrome.tabs.get(tabId);
  const window = await chrome.windows.get(tab.windowId).catch(() => null);
  state.handoffs.set(tabId, { note, agent: session.name, sessionId: session.id, at: Date.now() });
  // Blinks even if the user is looking: it stops when they click or type in the page.
  await runAgent(tabId, 0, "handoffNotice", [session.name, note]).catch(() => {});
  // A window in the background asks for attention once (macOS: one Dock bounce).
  if (window && !window.focused) await chrome.windows.update(window.id, { drawAttention: true }).catch(() => {});
  await persist();
  refreshBadges();
  return tabInfo(await chrome.tabs.get(tabId), session);
}

/**
 * The agent takes a tab of the user's to work in, where it is, as it is: the
 * page is not reloaded or copied (a tab in another window is moved, which
 * keeps it as it is). It joins the AI group, unless the user is looking at it
 * in another window: then it stays there, in front. No window shows another
 * tab because of it. The user is told once and can give it back. It stays
 * the user's: never closed, given back when done.
 */
async function takeTab(session, tabId, note) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw new Error(`Tab ${tabId} does not exist (browser_tab_list shows the tabs).`);
  ensureOwnable(session, tabId);
  if (state.created.get(tabId) === session.id) throw new Error(`Tab ${tabId} is already yours; browser_tab_select works in it.`);
  if (state.taken.get(tabId)?.sessionId === session.id) {
    await assign(session, tabId);
    return tabInfo(await chrome.tabs.get(tabId), session);
  }
  const url = tab.url || tab.pendingUrl || "";
  if (!/^(https?|file):/.test(url)) {
    throw new Error(`Tab ${tabId} shows ${url || "a browser page"}, which extensions may not control.`);
  }
  const from = {
    windowId: tab.windowId,
    index: tab.index,
    pinned: tab.pinned,
    groupId: tab.groupId !== -1 && tab.groupId !== state.groupId ? tab.groupId : -1,
  };
  state.taken.set(tabId, { sessionId: session.id, agent: session.name, note, from });
  if (state.handoffs.delete(tabId)) runAgent(tabId, 0, "handoffClear", []).catch(() => {});
  try {
    await assign(session, tabId);
  } catch (error) {
    state.taken.delete(tabId);
    throw error;
  }
  await groupAgentTab(tabId);
  await persist();
  refreshBadges();
  showActivity(tabId, session, "reading");
  notifyTaken(tabId, tab.title || url, note);
  return tabInfo(await chrome.tabs.get(tabId), session);
}

/** One quiet notification that an agent took a tab, with a way to give it back. */
function notifyTaken(tabId, title, note) {
  if (!chrome.notifications) return;
  const tr = chrome.i18n.getUILanguage().toLowerCase().startsWith("tr");
  const shortTitle = title.length > 60 ? `${title.slice(0, 59)}…` : title;
  chrome.notifications
    .create(`take-${tabId}`, {
      type: "basic",
      iconUrl: "icons/128.png",
      title: "Browser MCP Plus",
      message: tr ? `AI '${shortTitle}' sekmesini aldı: ${note}` : `AI took the tab '${shortTitle}': ${note}`,
      buttons: [{ title: tr ? "Geri ver" : "Give back" }],
      priority: 0,
      silent: true,
    })
    .catch(() => {});
}

/**
 * A taken tab goes back to the user: out of the group, to its old window and
 * place (and its own group, pinned state) when they still exist. A tab the
 * user is looking at in another window than its own stays there, in front.
 * Pass `byUser` when the user asked for it: the agent hears so on its next
 * request. The result says whether the tab stayed in front (`keptInFront`).
 */
async function giveBack(tabId, { byUser = false } = {}) {
  await restore();
  const taken = state.taken.get(tabId);
  if (!taken) return null;
  state.taken.delete(tabId);
  chrome.notifications?.clear(`take-${tabId}`).catch(() => {});
  const sessionId = state.owner.get(tabId);
  if (sessionId) unassign(state.sessions.get(sessionId));
  if (byUser && taken.sessionId) state.reclaimed.set(taken.sessionId, tabId);
  let keptInFront = false;
  await withGroupLock(async () => {
    await ungroupTab(tabId);
    const { from } = taken;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    // Moving it to its window would leave this one showing another tab.
    if (tab.active && tab.windowId !== from.windowId) {
      keptInFront = true;
      return;
    }
    const window = await chrome.windows.get(from.windowId).catch(() => null);
    if (!window) return;
    const count = (await chrome.tabs.query({ windowId: from.windowId })).length;
    await chrome.tabs.move(tabId, { windowId: from.windowId, index: Math.min(from.index, count) }).catch(() => {});
    if (from.groupId !== -1 && (await chrome.tabGroups?.get(from.groupId).catch(() => null))) {
      await chrome.tabs.group({ groupId: from.groupId, tabIds: [tabId] }).catch(() => {});
    }
    if (from.pinned) await chrome.tabs.update(tabId, { pinned: true }).catch(() => {});
    return [tabId];
  }).catch(() => {});
  await persist();
  refreshBadges();
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return tab ? { ...tabInfo(tab), ...(keptInFront ? { keptInFront } : {}) } : null;
}

chrome.notifications?.onButtonClicked.addListener((id) => {
  const tabId = Number(id.replace(/^take-/, ""));
  if (Number.isInteger(tabId)) void giveBack(tabId, { byUser: true });
});

chrome.notifications?.onClicked.addListener((id) => {
  const tabId = Number(id.replace(/^take-/, ""));
  if (Number.isInteger(tabId)) void focusTab(tabId).catch(() => {});
});

/**
 * The handover is over: the user clicked or typed in the page, or pressed
 * Done/Keep. The note, the blinking and the badge go together; looking at
 * the tab alone does not end it.
 */
async function handoffSeen(tabId) {
  await restore();
  if (!state.handoffs.delete(tabId)) return;
  runAgent(tabId, 0, "handoffClear", []).catch(() => {});
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab && !state.handoffs.size) await chrome.windows.update(tab.windowId, { drawAttention: false }).catch(() => {});
  await persist();
  refreshBadges();
}

/** Real input (click or key) the page reported: the agent's own, the user stepping in, or the end of a handover. */
async function userInput(tabId, kind, at) {
  await restore();
  if (state.handoffs.has(tabId)) return handoffSeen(tabId);
  const sessionId = state.owner.get(tabId);
  const session = sessionId && state.sessions.get(sessionId);
  if (!session || state.stepIns.has(tabId)) return;
  // Input while the agent's request ran in this tab (and a moment after) is the agent's.
  const [start, end] = state.agentWindow.get(tabId) ?? [0, 0];
  if ((state.busy.get(tabId) ?? 0) > 0 || (at >= start - 50 && at <= end + 500)) return;
  state.stepIns.set(tabId, { sessionId, kind, at });
  runAgent(tabId, 0, "paused", []).catch(() => {});
  await persist();
}

function stepInError(tabId) {
  const stepIn = state.stepIns.get(tabId);
  const what = stepIn?.kind === "key" ? "typed" : "clicked";
  return new Error(
    `The user stepped in on this tab (they ${what} in it), so you are paused here. Stop and ask the user what they want; when they tell you, continue with browser_tab_select (tabId ${tabId}).`,
  );
}

// ---------------------------------------------------------------------------
// The "AI" tab group: one per profile, however many agents work in it.

let groupLock = Promise.resolve();

/** Changes to the tab strip (moving, grouping), one at a time, none changing what the user sees. */
function withGroupLock(fn) {
  return serialized(() => keepingView(fn));
}

function serialized(fn) {
  const run = groupLock.then(fn, fn);
  groupLock = run.catch(() => {});
  return run;
}

/**
 * Runs a change to the tab strip without changing what the user sees. `fn`
 * returns the ids of the tabs it moved; a window that came to show one of
 * them meanwhile (Chrome may show a tab moved into a window) shows its tab
 * again. Tabs the user brings to the front meanwhile stay. (Moving the shown
 * tab out of a window would make Chrome show a neighbour: callers don't.)
 */
async function keepingView(fn) {
  const before = new Map((await chrome.tabs.query({ active: true }).catch(() => [])).map((t) => [t.windowId, t.id]));
  let moved = [];
  try {
    moved = (await fn()) ?? [];
    return moved;
  } finally {
    for (const tab of moved.length ? await chrome.tabs.query({ active: true }).catch(() => []) : []) {
      const was = before.get(tab.windowId);
      if (was === undefined || was === tab.id || !moved.includes(tab.id)) continue;
      const wasTab = await chrome.tabs.get(was).catch(() => null);
      if (wasTab?.windowId === tab.windowId) await chrome.tabs.update(was, { active: true }).catch(() => {});
    }
  }
}

const SHOWN_KEPT = 8;

/** The user (or Chrome) brought a tab to the front: remembered per window. */
async function noticeShown(tabId, windowId) {
  await restore();
  const ids = (state.shown.get(windowId) ?? []).filter((id) => id !== tabId);
  state.shown.set(windowId, [tabId, ...ids].slice(0, SHOWN_KEPT));
  await chrome.storage.session.set({ shown: [...state.shown] }).catch(() => {});
  // Opened in front by an agent's page a moment ago: it goes behind.
  const opened = state.openedByAgent.get(tabId);
  if (opened !== undefined && Date.now() - opened < 2_000) await keepBehind(tabId);
}

/**
 * An agent's page opened a tab in front (a link to a new tab; Chrome shows
 * those): the window shows again the tab it showed before. The user switches
 * to the new tab if they want to watch. Serialized with tab strip changes, so
 * their guard does not undo it.
 */
function keepBehind(tabId) {
  return serialized(async () => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.active) return;
    state.openedByAgent.delete(tabId);
    for (const id of state.shown.get(tab.windowId) ?? []) {
      if (id === tabId) continue;
      const before = await chrome.tabs.get(id).catch(() => null);
      if (before?.windowId !== tab.windowId) continue;
      await chrome.tabs.update(id, { active: true }).catch(() => {});
      return;
    }
  }).catch(() => {});
}

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => void noticeShown(tabId, windowId));

chrome.windows.onRemoved.addListener((windowId) => {
  if (state.shown.delete(windowId)) chrome.storage.session.set({ shown: [...state.shown] }).catch(() => {});
});

async function liveGroup() {
  if (state.groupId === null || !chrome.tabGroups) return null;
  const group = await chrome.tabGroups.get(state.groupId).catch(() => null);
  if (!group) state.groupId = null;
  return group;
}

/**
 * Puts an agent tab (opened or taken by an agent) in the profile's group, at
 * its end, moving it to the group's window if needed; the group stays at the
 * right end of the tab strip. A tab the user is looking at in another window
 * stays there, in front.
 */
function groupAgentTab(tabId) {
  if (!chrome.tabGroups) return Promise.resolve();
  return withGroupLock(async () => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || !(state.created.has(tabId) || state.taken.has(tabId))) return;
    const window = await chrome.windows.get(tab.windowId).catch(() => null);
    if (window?.type !== "normal") return; // popups cannot hold groups
    const group = await liveGroup();
    if (group && tab.groupId === group.id) return;
    // Moving it would leave its window showing another tab.
    if (group && group.windowId !== tab.windowId && tab.active) return;
    if (tab.pinned) await chrome.tabs.update(tabId, { pinned: false });
    if (group) {
      // Moving keeps the page as it is: no reload.
      await chrome.tabs.move(tabId, { windowId: group.windowId, index: -1 });
      await chrome.tabs.group({ groupId: group.id, tabIds: [tabId] });
    } else {
      await chrome.tabs.move(tabId, { index: -1 });
      const groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } });
      await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: GROUP_COLOR, collapsed: false });
      state.groupId = groupId;
      await persist();
    }
    return [tabId, ...(await groupToTheRight())];
  }).catch(() => {
    // Grouping is cosmetic.
  });
}

/**
 * Moves the group, whole, to the right end of its window; the user's tabs
 * keep their order. Returns the ids of the tabs it moved.
 */
async function groupToTheRight() {
  const group = await liveGroup();
  if (!group) return [];
  const tabs = await chrome.tabs.query({ windowId: group.windowId });
  const ours = tabs.filter((t) => t.groupId === group.id);
  const others = tabs.filter((t) => t.groupId !== group.id).map((t) => t.index);
  if (!ours.length || !others.length || Math.max(...others) < Math.min(...ours.map((t) => t.index))) return [];
  await chrome.tabGroups.move(group.id, { index: -1 });
  return ours.map((t) => t.id);
}

let rightTimer = null;

/**
 * After tabs open or move, puts the group back at the right end, calmly: a
 * second and a half after the last change, and later if the user is still
 * dragging a tab (Chrome refuses edits meanwhile).
 */
function scheduleGroupRight(delay = 1_500) {
  if (state.groupId === null || !chrome.tabGroups) return;
  clearTimeout(rightTimer);
  rightTimer = setTimeout(() => {
    withGroupLock(groupToTheRight).catch((error) => {
      if (/drag|cannot be edited/i.test(errorMessage(error))) scheduleGroupRight(2_000);
    });
  }, delay);
}

for (const event of [chrome.tabs.onCreated, chrome.tabs.onMoved, chrome.tabs.onAttached]) {
  event.addListener(() => scheduleGroupRight());
}

async function ungroupTab(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab && tab.groupId !== -1 && tab.groupId === state.groupId) await chrome.tabs.ungroup(tabId).catch(() => {});
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

/**
 * Badges: the agent's initials on its tabs, ON on free connected tabs, "!"
 * on tabs handed to the user; on every other tab, how many handed-over tabs
 * the user has not looked at yet.
 */
function refreshBadges() {
  const tabs = new Set([...state.pool, ...state.created.keys(), ...state.owner.keys(), ...state.handoffs.keys()]);
  for (const tabId of state.badged) if (!tabs.has(tabId)) clearBadge(tabId);
  state.badged = tabs;
  for (const tabId of tabs) {
    const session = state.sessions.get(state.owner.get(tabId) ?? state.created.get(tabId));
    const handoff = !session && state.handoffs.has(tabId);
    const text = session ? shortLabel(session.name) : handoff ? "!" : state.pool.has(tabId) ? "ON" : "AI";
    const color = handoff ? "#ff9f0a" : state.pool.has(tabId) && !session ? "#1a7f37" : "#0969da";
    chrome.action.setBadgeText({ tabId, text }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  }
  const waiting = state.handoffs.size;
  for (const tabId of state.taken.keys()) tabs.add(tabId);
  chrome.action.setBadgeText({ text: waiting ? String(waiting) : "" }).catch(() => {});
  if (waiting) chrome.action.setBadgeBackgroundColor({ color: "#ff9f0a" }).catch(() => {});
  syncNetworkListeners();
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
  if (state.stepIns.delete(tabId)) runAgent(tabId, 0, "pauseClear", []).catch(() => {});
  // A free tab keeps no debugger attached (and no "is debugging" banner from it).
  void detach(tabId);
  refreshBadges();
}

/** Gives a session the tab, debugger attached. Fails for tabs that cannot be debugged. */
async function assign(session, tabId) {
  ensureOwnable(session, tabId);
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url || tab.pendingUrl || "";
  if (url && !/^(https?|file|about|data|blob):/.test(url)) {
    throw new Error(`Tab ${tabId} shows ${url}, which extensions may not control. Navigate it to a website first.`);
  }
  if (session.tabId !== null && session.tabId !== tabId) unassign(session);
  session.tabId = tabId;
  state.owner.set(tabId, session.id);
  state.handoffs.delete(tabId);
  void installConsoleHook(tabId);
  await persist();
  refreshBadges();
}

/** The session ended: its tabs close, except the ones the user connected or kept. */
function endSession(session) {
  unassign(session);
  state.sessions.delete(session.id);
  closeAgentTabs((sessionId) => sessionId === session.id);
  // The user's tabs it took go back where they were, open.
  for (const [tabId, taken] of [...state.taken]) if (taken.sessionId === session.id) void giveBack(tabId);
  state.reclaimed.delete(session.id);
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
  await groupAgentTab(tab.id);
  return tab.id;
}

/** Where a new agent tab goes: the "AI" group's window, else next to the agent's tabs, else the last used window. */
async function windowFor(session) {
  const group = await liveGroup();
  if (group) return group.windowId;
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
  for (const [tabId, taken] of [...state.taken]) if (!active.has(taken.sessionId)) void giveBack(tabId);
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
  for (const tabId of [...state.taken.keys()]) void giveBack(tabId);
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
    await groupAgentTab(adopt.tabId);
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
  const reclaimed = state.reclaimed.get(session.id);
  if (reclaimed !== undefined && !QUIET.has(type)) {
    state.reclaimed.delete(session.id);
    throw new Error(
      `The user took tab ${reclaimed} back (Give back). Stop and ask them how to continue; browser_tab_new opens a tab of your own.`,
    );
  }
  const tabId = await tabFor(session);
  // The user stepped in: nothing more happens here until the agent asks and resumes.
  if (state.stepIns.has(tabId) && !QUIET.has(type)) throw stepInError(tabId);
  if (ACTIVITY[type]) showActivity(tabId, session, ACTIVITY[type]);
  const run = async () => {
    state.busy.set(tabId, (state.busy.get(tabId) ?? 0) + 1);
    const started = Date.now();
    state.agentWindow.set(tabId, [started, started]);
    try {
      return await handler(payload, { session, tabId });
    } finally {
      state.busy.set(tabId, state.busy.get(tabId) - 1);
      state.agentWindow.set(tabId, [started, Date.now()]);
    }
  };
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

/** The page shows (subtly) that this agent is at work, and doing what. Never waited for. */
function showActivity(tabId, session, kind) {
  if (state.handoffs.has(tabId)) return;
  runAgent(tabId, 0, "activity", [session.name, kind]).catch(() => {});
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
  state.cdpUsedAt.set(tabId, Date.now());
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

const attaching = new Map();

/** Attaches the debugger for input, screenshots and evaluate; reading never needs it. */
function ensureAttached(tabId) {
  // A dialog opened while detached blocks the page: attaching would hang.
  if (state.dialogs.get(tabId)?.unanswerable) return Promise.reject(dialogError(tabId));
  if (state.attached.has(tabId)) {
    state.cdpUsedAt.set(tabId, Date.now());
    return Promise.resolve();
  }
  let pending = attaching.get(tabId);
  if (!pending) {
    pending = (async () => {
      await attachDebugger(tabId);
      if (!state.attached.has(tabId)) await enableDomains(tabId);
    })().finally(() => attaching.delete(tabId));
    attaching.set(tabId, pending);
  }
  return pending;
}

// Detaches idle tabs, so Chrome's "is debugging this browser" bar only shows
// while agents act. A tab with an open dialog or a running request stays.
function sweepDebugger(idleMs = DEBUGGER_IDLE_MS) {
  const now = Date.now();
  for (const tabId of [...state.attached]) {
    if (state.dialogs.has(tabId) || (state.busy.get(tabId) ?? 0) > 0) continue;
    if (now - (state.cdpUsedAt.get(tabId) ?? 0) >= idleMs) void detach(tabId);
  }
}
setInterval(sweepDebugger, 5_000);

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
  // Page events first: JavaScript dialogs, navigation start/finish, main frame id.
  // A page that does not answer (blocked by a dialog) fails here, it does not hang.
  await withTimeout(cdp(tabId, "Page.enable"), 5_000, "Page.enable").catch((error) => {
    void detach(tabId);
    throw new Error(`The page does not respond (${errorMessage(error)}). It may be busy or blocked; try browser_reload.`);
  });
  await cdp(tabId, "Runtime.enable");
  // Agents often work in background tabs, which Chrome hides: it stops
  // rendering them, throttles their timers ~100x and leaves input events
  // unprocessed. Focus emulation (DevTools' "Emulate a focused page") keeps
  // the page visible and responsive while the debugger is attached.
  await cdp(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  const { frameTree } = await cdp(tabId, "Page.getFrameTree");
  state.mainFrames.set(tabId, frameTree.frame.id);
}

async function detach(tabId) {
  const wasAttached = state.attached.delete(tabId);
  state.contexts.delete(tabId);
  state.mainFrames.delete(tabId);
  state.dialogs.delete(tabId);
  state.cdpUsedAt.delete(tabId);
  if (wasAttached || attaching.has(tabId)) await chrome.debugger.detach({ tabId }).catch(() => {});
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
  } else if (method === "Runtime.consoleAPICalled" || method === "Runtime.exceptionThrown") {
    // Chrome replays a page's earlier console messages when the debugger
    // attaches: they fill in what happened before the console hook came.
    const hookedAt = state.hookedAt.get(tabId) ?? Infinity;
    if (params.timestamp >= hookedAt) return;
    const list = state.earlyConsole.get(tabId) ?? [];
    if (list.length >= 500) return;
    list.push(
      method === "Runtime.consoleAPICalled"
        ? { type: params.type === "warning" ? "warn" : params.type, timestamp: params.timestamp, message: params.args.map(remoteText).join(" ") }
        : { type: "error", timestamp: params.timestamp, message: params.exceptionDetails.exception?.description ?? params.exceptionDetails.text },
    );
    state.earlyConsole.set(tabId, list);
  }
});

function remoteText(object) {
  if ("value" in object) return typeof object.value === "string" ? object.value : JSON.stringify(object.value);
  if (object.unserializableValue) return object.unserializableValue;
  if (object.preview?.properties) {
    const props = object.preview.properties.map((p) => `${p.name}: ${p.value}`).join(", ");
    return object.subtype === "array" ? `[${props}]` : `{${props}}`;
  }
  return object.description ?? object.type;
}

// ---------------------------------------------------------------------------
// Console messages and failed requests, read without the debugger

/** Runs in the page's own world from the start of each load of an agent tab. */
function consoleHookSource() {
  const KEY = Symbol.for("browsermcp-plus.console");
  if (window[KEY]) return;
  const entries = [];
  const format = (value) => {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.stack || String(value);
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  };
  const push = (type, args) => {
    entries.push({ type, timestamp: Date.now(), message: args.map(format).join(" ").slice(0, 4000) });
    if (entries.length > 1000) entries.shift();
  };
  for (const type of ["log", "info", "warn", "error", "debug"]) {
    const original = console[type];
    console[type] = function (...args) {
      push(type, args);
      return original.apply(this, args);
    };
  }
  addEventListener("error", (event) => {
    if (event instanceof ErrorEvent) push("error", [event.error ?? event.message]);
  });
  addEventListener("unhandledrejection", (event) => push("error", ["Unhandled promise rejection:", event.reason]));
  Object.defineProperty(window, KEY, { value: () => entries.slice() });
  // Tells the extension (through the isolated world) about a JavaScript
  // dialog before it blocks the page: one that opens while no agent acts
  // cannot be seen through the debugger.
  for (const type of ["alert", "confirm", "prompt"]) {
    const original = window[type];
    window[type] = function (...args) {
      const say = (name) => document.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify({ type, message: String(args[0] ?? "") }) }));
      say("__bmcp_dialog");
      try {
        return original.apply(this, args);
      } finally {
        say("__bmcp_dialog_closed");
      }
    };
  }
}

/** Relays the page's dialog notices to the background; runs in the isolated world. */
function dialogRelaySource() {
  if (globalThis.__bmcpDialogRelay) return;
  globalThis.__bmcpDialogRelay = true;
  for (const name of ["__bmcp_dialog", "__bmcp_dialog_closed"]) {
    document.addEventListener(name, (event) => {
      let detail = {};
      try {
        detail = JSON.parse(event.detail);
      } catch {
        // not ours
      }
      chrome.runtime.sendMessage({ cmd: name === "__bmcp_dialog" ? "dialogOpening" : "dialogClosed", ...detail }).catch(() => {});
    });
  }
}

function isAgentTab(tabId) {
  return state.owner.has(tabId) || state.created.has(tabId) || state.pool.has(tabId);
}

function installConsoleHook(tabId) {
  if (!state.hookedAt.has(tabId)) state.hookedAt.set(tabId, Date.now());
  const target = { tabId, frameIds: [0] };
  return Promise.all([
    chrome.scripting.executeScript({ target, world: "ISOLATED", injectImmediately: true, func: dialogRelaySource }),
    chrome.scripting.executeScript({ target, world: "MAIN", injectImmediately: true, func: consoleHookSource }),
  ]).catch(() => {});
}

async function readConsole(tabId) {
  const [frame] = await chrome.scripting
    .executeScript({
      target: { tabId, frameIds: [0] },
      world: "MAIN",
      func: () => window[Symbol.for("browsermcp-plus.console")]?.() ?? null,
    })
    .catch(() => []);
  return frame?.result ?? null;
}

function recordRequest(tabId, entry) {
  if (tabId < 0 || !isAgentTab(tabId)) return;
  const list = state.network.get(tabId) ?? [];
  list.push({ ...entry, timestamp: Date.now() });
  if (list.length > 300) list.shift();
  state.network.set(tabId, list);
}

/** tabId -> Map(requestId -> start time) of the agent tabs' requests in flight. */
const inflight = new Map();

const onRequestStart = (d) => {
  if (d.tabId < 0 || !isAgentTab(d.tabId)) return;
  const map = inflight.get(d.tabId) ?? new Map();
  map.set(d.requestId, Date.now());
  inflight.set(d.tabId, map);
};
const onRequestError = (d) => {
  inflight.get(d.tabId)?.delete(d.requestId);
  recordRequest(d.tabId, { url: d.url, method: d.method, type: d.type, error: d.error });
};
const onRequestDone = (d) => {
  inflight.get(d.tabId)?.delete(d.requestId);
  if (d.statusCode >= 400) recordRequest(d.tabId, { url: d.url, method: d.method, type: d.type, status: d.statusCode });
};

/** Whether the page is still loading something it asked for recently (long polls do not count). */
function loadingRecently(tabId) {
  const now = Date.now();
  for (const started of inflight.get(tabId)?.values() ?? []) if (now - started < 3_000) return true;
  return false;
}
let listeningToRequests = false;

/** Watches requests only while agents have tabs: other browsing is left alone. */
function syncNetworkListeners() {
  if (!chrome.webRequest) return;
  const wanted = state.owner.size > 0 || state.created.size > 0;
  if (wanted === listeningToRequests) return;
  listeningToRequests = wanted;
  const filter = { urls: ["<all_urls>"] };
  if (wanted) {
    chrome.webRequest.onBeforeRequest.addListener(onRequestStart, filter);
    chrome.webRequest.onErrorOccurred.addListener(onRequestError, filter);
    chrome.webRequest.onCompleted.addListener(onRequestDone, filter);
  } else {
    chrome.webRequest.onBeforeRequest.removeListener(onRequestStart);
    chrome.webRequest.onErrorOccurred.removeListener(onRequestError);
    chrome.webRequest.onCompleted.removeListener(onRequestDone);
    inflight.clear();
  }
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
  state.dialogs.delete(tabId);
  state.queues.delete(tabId);
  state.claims.delete(tabId);
  state.badged.delete(tabId);
  state.lastSnap.delete(tabId);
  state.frameInfo.delete(tabId);
  state.network.delete(tabId);
  state.committedAt.delete(tabId);
  state.stepIns.delete(tabId);
  state.agentWindow.delete(tabId);
  state.openedByAgent.delete(tabId);
  const wasTaken = state.taken.delete(tabId);
  chrome.notifications?.clear(`take-${tabId}`).catch(() => {});
  const handedOff = state.handoffs.delete(tabId) || wasTaken;
  const pooled = state.pool.delete(tabId);
  const created = state.created.delete(tabId);
  if (handedOff) refreshBadges();
  if (pooled || created || sessionId || handedOff) {
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
    // The agent's click opened it (not the user's, stepping in): it opens behind.
    if (byAgent(sourceTabId)) {
      state.openedByAgent.set(tabId, Date.now());
      setTimeout(() => state.openedByAgent.delete(tabId), 2_000);
      void keepBehind(tabId);
    }
    void groupAgentTab(tabId);
  });
});

/** Whether what just happened in the tab came from the agent's request (running, or ended a moment ago). */
function byAgent(tabId) {
  const [, end] = state.agentWindow.get(tabId) ?? [0, 0];
  return (state.busy.get(tabId) ?? 0) > 0 || Date.now() <= end + 1_000;
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) noticeClaim(tabId, info.url);
});

// A new document in an agent tab: fresh console hook and request log; the
// last snapshot no longer describes the page.
chrome.webNavigation.onCommitted.addListener(({ tabId, frameId }) => {
  if (frameId !== 0) return;
  state.committedAt.set(tabId, Date.now());
  state.lastSnap.delete(tabId);
  state.frameInfo.delete(tabId);
  state.earlyConsole.delete(tabId);
  state.hookedAt.delete(tabId);
  state.activated.delete(tabId);
  if (state.dialogs.get(tabId)?.unanswerable) state.dialogs.delete(tabId);
  if (isAgentTab(tabId)) {
    state.network.set(tabId, []);
    void installConsoleHook(tabId);
  }
});

// The note on a handed-over page comes back after the user navigates it.
// A handover note, or the "paused" label, comes back after the page navigates.
chrome.webNavigation.onCompleted.addListener(({ tabId, frameId }) => {
  if (frameId !== 0) return;
  const handoff = state.handoffs.get(tabId);
  if (handoff) runAgent(tabId, 0, "handoffNotice", [handoff.agent, handoff.note]).catch(() => {});
  else if (state.stepIns.has(tabId)) runAgent(tabId, 0, "paused", []).catch(() => {});
});

chrome.tabGroups?.onRemoved.addListener((group) => {
  if (group.id === state.groupId) {
    state.groupId = null;
    void persist();
  }
});

chrome.downloads?.onCreated.addListener((item) => {
  for (const list of state.downloadWatch.values()) list.push(item);
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
  const { type, message, unanswerable } = state.dialogs.get(tabId);
  if (unanswerable) {
    return new Error(
      `A JavaScript ${type} dialog is open: ${JSON.stringify(message)}. The page opened it while no agent was acting, so it can only be closed by reloading the page: call browser_handle_dialog to do that, or ask the user to answer it.`,
    );
  }
  return new Error(
    `A JavaScript ${type} dialog is open: ${JSON.stringify(message)}. The page is blocked until you call browser_handle_dialog to accept or dismiss it.`,
  );
}

/**
 * Watches the tab's top frame for a navigation starting and its document
 * becoming ready, through webNavigation: no debugger needed. Same-document
 * navigations (pushState, #hash) are not navigations here.
 */
function trackNavigation(tabId) {
  const tracker = { started: false, error: null };
  let markStarted;
  let markDone;
  let markLoaded;
  tracker.whenStarted = new Promise((resolve) => (markStarted = resolve));
  tracker.whenDone = new Promise((resolve) => (markDone = resolve));
  tracker.whenLoaded = new Promise((resolve) => (markLoaded = resolve));
  const ours = (d) => d.tabId === tabId && d.frameId === 0 && d.documentLifecycle !== "prerender";
  const onStart = (d) => {
    if (!ours(d)) return;
    tracker.started = true;
    markStarted();
  };
  const onReady = (d) => {
    if (ours(d) && tracker.started) markDone();
  };
  const onLoaded = (d) => {
    if (!ours(d) || !tracker.started) return;
    markDone();
    markLoaded();
  };
  const onError = (d) => {
    if (!ours(d) || !tracker.started) return;
    tracker.error = d.error;
    markDone();
    markLoaded();
  };
  const nav = chrome.webNavigation;
  nav.onBeforeNavigate.addListener(onStart);
  nav.onDOMContentLoaded.addListener(onReady);
  nav.onCompleted.addListener(onLoaded);
  nav.onErrorOccurred.addListener(onError);
  tracker.stop = () => {
    nav.onBeforeNavigate.removeListener(onStart);
    nav.onDOMContentLoaded.removeListener(onReady);
    nav.onCompleted.removeListener(onLoaded);
    nav.onErrorOccurred.removeListener(onError);
  };
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
 * handled). Returns a report of what happened: navigation, dialog, new tabs
 * (the agent moves to a tab the page opened), downloads, and what changed on
 * the page since the agent's last snapshot.
 */
async function runAction(
  tabId,
  action,
  { startWindowMs = 80, allowDialog = false, session = null, failOnNavigationError = false } = {},
) {
  if (state.dialogs.has(tabId) && !allowDialog) throw dialogError(tabId);
  const opened = [];
  const downloads = [];
  state.opened.set(tabId, opened);
  state.downloadWatch.set(tabId, downloads);
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
        if (session) showActivity(tabId, session, "reading");
      }
      return value;
    })();
    work.catch(() => {}); // keeps running in the background if a dialog interrupts it
    const value = await Promise.race([work, dialog.promise.then(() => undefined)]);
    if (failOnNavigationError && tracker.error && !/ERR_ABORTED/.test(tracker.error)) {
      throw new Error(`Could not open the page: ${tracker.error}. Check the address, or whether the site is reachable.`);
    }
    state.actedAt.set(tabId, Date.now());
    const report = await actionReport(tabId, tracker, value, opened);
    if (downloads.length) {
      report.downloads = downloads.map((d) => ({ id: d.id, url: d.finalUrl || d.url, filename: d.filename || "" }));
    }
    if (session && opened.length) await switchToNewTab(session, opened, report);
    else if (!report.navigated && !report.dialog) await reportChanges(tabId, report);
    return report;
  } finally {
    tracker.stop();
    dialog.cancel();
    if (state.opened.get(tabId) === opened) state.opened.delete(tabId);
    if (state.downloadWatch.get(tabId) === downloads) state.downloadWatch.delete(tabId);
  }
}

/** The page opened a tab (a link to a new tab, a popup): the agent continues there. */
async function switchToNewTab(session, opened, report) {
  for (const tabId of [...opened].reverse()) {
    try {
      await waitForDocument(tabId);
      await assign(session, tabId);
      report.switchedTo = tabInfo(await chrome.tabs.get(tabId), session);
      return;
    } catch {
      // e.g. it closed already: try the previous one
    }
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

/** Most lines a change report shows; past that, a snapshot is the better read. */
const MAX_CHANGE_LINES = 40;
/** Snapshots slower than this are not taken after every action. */
const MAX_DIFF_SNAPSHOT_MS = 600;

/** What the action changed on the page, compared with the agent's last snapshot of it. */
async function reportChanges(tabId, report) {
  const before = state.lastSnap.get(tabId);
  if (!before || before.ms > MAX_DIFF_SNAPSHOT_MS) return;
  try {
    let changes;
    if (before.frames > 1) {
      // Frames from other sites: compare the stitched snapshots here.
      changes = diffSnapshots(before.text, await pageSnapshot(tabId));
    } else {
      // One document: the page agent compares, and skips the work if nothing changed.
      changes = await callAgent(tabId, "changes", MAX_CHANGE_LINES);
      if (!changes) return;
    }
    report.changes = changes.lines;
    if (changes.more) report.moreChanges = changes.more;
  } catch {
    // The report stands without it.
  }
}

/**
 * Lines added, changed or removed between two snapshots. Elements are matched
 * by ref (refs are stable), text lines by content.
 */
function diffSnapshots(before, after) {
  const index = (text) => {
    const byRef = new Map();
    const texts = new Map();
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("- /url:")) continue;
      const ref = /\[ref=([^\]]+)\]/.exec(line)?.[1];
      if (ref) byRef.set(ref, line);
      else texts.set(line, (texts.get(line) ?? 0) + 1);
    }
    return { byRef, texts };
  };
  const old = index(before);
  const now = index(after);
  const lines = [];
  for (const [ref, line] of now.byRef) {
    const was = old.byRef.get(ref);
    if (was === undefined) lines.push(`+ ${line.slice(2)}`);
    else if (was !== line) lines.push(`~ ${line.slice(2)}`);
  }
  for (const [line, count] of now.texts) {
    if (count > (old.texts.get(line) ?? 0)) lines.push(`+ ${line.slice(2)}`);
  }
  for (const [ref, line] of old.byRef) if (!now.byRef.has(ref)) lines.push(`- ${line.slice(2)}`);
  for (const [line, count] of old.texts) {
    if (count > (now.texts.get(line) ?? 0)) lines.push(`- ${line.slice(2)}`);
  }
  return { lines: lines.slice(0, MAX_CHANGE_LINES), more: Math.max(0, lines.length - MAX_CHANGE_LINES) };
}
// ---------------------------------------------------------------------------
// Page agent

const NAVIGATION_ERROR = /removed|No frame|Frame with ID|did not respond|navigat|context was destroyed/i;

/** The frame a ref belongs to: refs of subframes are "f<frameId>e<n>". */
function frameOfRef(ref) {
  const match = /^f(\d+)e\d+$/.exec(ref ?? "");
  return match ? Number(match[1]) : 0;
}

/** Calls the page agent in the tab's top frame. */
function callAgent(tabId, method, ...args) {
  return callFrame(tabId, 0, method, args);
}

/** Calls the page agent in the frame that owns `ref`, with the ref as first argument. */
function callRef(tabId, ref, method, ...args) {
  return callFrame(tabId, frameOfRef(ref), method, [ref, ...args]);
}

/** Calls a frame's page agent; blocked by an open dialog, retried once if the page was navigating. */
async function callFrame(tabId, frameId, method, args) {
  if (state.dialogs.has(tabId)) throw dialogError(tabId);
  const dialog = whenDialogOpens(tabId);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        return await Promise.race([
          watchForDialog(tabId, runAgent(tabId, frameId, method, args)),
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
        if (frameId !== 0 && /No frame|Frame with ID/i.test(message)) {
          throw new Error("The frame this element was in has gone (the page changed). Take a new snapshot.");
        }
        if (attempt > 0 || state.dialogs.has(tabId) || !NAVIGATION_ERROR.test(message)) throw error;
        await waitForDocument(tabId);
      }
    }
  } finally {
    dialog.cancel();
  }
}

/**
 * A page blocked by alert()/confirm() never answers a script. The page's
 * dialog notices (see consoleHookSource) end the wait with a clear error.
 */
function watchForDialog(tabId, promise) {
  return promise;
}

async function runAgent(tabId, frameId, method, args) {
  const prefix = frameId ? `f${frameId}` : "";
  const run = () =>
    chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: (name, params, refPrefix) => {
        const agent = globalThis.__bmcp;
        if (!agent) return { missing: true };
        agent.setPrefix?.(refPrefix);
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
      args: [method, args, prefix],
    });
  let [frame] = await run();
  if (frame?.result?.missing) {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ["content/agent.js"] });
    [frame] = await run();
  }
  const result = frame?.result;
  if (!result) throw new Error("The page did not respond. It may still be loading.");
  if (result.error) throw new Error(result.error);
  return result.value;
}

/** Frames of the tab that hold a live document. */
async function framesOf(tabId) {
  const frames = (await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null)) ?? [];
  return frames.filter(
    (f) => !f.errorOccurred && f.documentLifecycle !== "prerender" && f.documentLifecycle !== "pending_deletion",
  );
}

/** Runs an agent method in each frame; frames that cannot be scripted give null. */
async function inEveryFrame(tabId, frames, method, args = []) {
  return Promise.all(frames.map((f) => runAgent(tabId, f.frameId, method, args).catch(() => null)));
}

/**
 * Introduces frames to their parents (postMessage handshake), so each
 * parent knows which of its <iframe>s holds which child's agent.
 */
async function introduceFrames(tabId, frames) {
  const asked = await inEveryFrame(tabId, frames, "probe");
  if (asked.some((n) => n > 0)) await sleep(40);
}

/**
 * The page's snapshot, including frames from other sites: each runs its own
 * agent, and its snapshot replaces the placeholder its parent left.
 */
async function pageSnapshot(tabId) {
  const started = Date.now();
  const frames = await framesOf(tabId);
  let text = null;
  if (frames.length > 1) {
    await introduceFrames(tabId, frames);
    const results = await inEveryFrame(tabId, frames, "frameSnapshot");
    text = stitchFrames(tabId, frames, results, /^( *)- <<frame:([^>]+)>>$/gm, {
      missing: (pad) => `${pad}- text: (a frame from another site that cannot be read)`,
      place: (pad, child) => indentLines(child, pad),
      append: (url, child) => `- iframe "${url}":\n${indentLines(child, "  ")}`,
    });
  }
  if (text === null) text = await callAgent(tabId, "snapshot");
  // Single-document pages keep their baseline in the page agent; the text is kept for frames.
  state.lastSnap.set(tabId, { text: frames.length > 1 ? text : "", frames: frames.length, ms: Date.now() - started });
  return text;
}

/** The page's readable text, frames from other sites included. */
async function pageText(tabId, options = {}) {
  const top = await callAgent(tabId, "readText", options);
  if (!/\[\[bmcp-frame:/.test(top.text)) return top;
  const frames = await framesOf(tabId);
  await introduceFrames(tabId, frames);
  // The top frame's text again, now that it knows its frames' tokens.
  const results = await inEveryFrame(tabId, frames, "frameText", [{ links: options.links }]);
  const index = frames.findIndex((f) => f.frameId === 0);
  if (index >= 0) results[index] = { token: results[index]?.token, ...(await callAgent(tabId, "readText", options)) };
  const text = stitchFrames(tabId, frames, results, /^()\[\[bmcp-frame:([^\]]+)\]\]$/gm, {
    missing: () => "(a frame from another site that cannot be read)",
    place: (_pad, child) => child,
    append: (url, child) => `\n[frame: ${url}]\n${child}`,
  });
  return { ...top, text: text ?? top.text };
}

/**
 * Replaces each frame placeholder in the top frame's output with that
 * frame's output, recursively. Frames whose parent could not place them are
 * appended. Returns null if the top frame gave nothing.
 */
function stitchFrames(tabId, frames, results, pattern, { missing, place, append }) {
  const info = new Map();
  const byToken = new Map();
  let top = null;
  frames.forEach((frame, i) => {
    const result = results[i];
    if (!result) return;
    info.set(frame.frameId, { token: result.token, inlined: !!result.inlined, parent: frame.parentFrameId, url: frame.url });
    if (frame.frameId === 0) top = result;
    else if (!result.inlined) byToken.set(result.token, { frame, output: result.text ?? "" });
  });
  state.frameInfo.set(tabId, info);
  if (!top) return null;
  const used = new Set();
  const expand = (output, depth) =>
    output.replace(pattern, (_match, pad, token) => {
      const child = byToken.get(token);
      if (!child || depth > 10) return missing(pad);
      used.add(token);
      return child.output ? place(pad, expand(child.output, depth + 1)) : "";
    });
  let output = expand(top.text ?? "", 0);
  for (const [token, child] of byToken) {
    if (used.has(token) || !child.output) continue;
    used.add(token);
    output += `\n${append(child.frame.url, expand(child.output, 1))}`;
  }
  return output.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
}

function indentLines(text, pad) {
  return text
    .split("\n")
    .map((line) => (line ? pad + line : line))
    .join("\n");
}

/**
 * For an element in a frame from another site: the chain of (frame, the
 * frame whose agent knows its <iframe>) links up to the top frame.
 */
async function frameChain(tabId, frameId) {
  let info = state.frameInfo.get(tabId);
  if (!info?.has(frameId)) {
    const frames = await framesOf(tabId);
    await introduceFrames(tabId, frames);
    const results = await inEveryFrame(tabId, frames, "info");
    info = new Map();
    frames.forEach((frame, i) => {
      if (results[i]) {
        info.set(frame.frameId, { token: results[i].token, inlined: results[i].inlined, parent: frame.parentFrameId, url: frame.url });
      }
    });
    state.frameInfo.set(tabId, info);
  }
  const chain = [];
  for (let id = frameId; id > 0; ) {
    const entry = info.get(id);
    if (!entry) throw new Error("The frame this element is in has gone (the page changed). Take a new snapshot.");
    // The nearest ancestor that is not inlined into its own parent knows the <iframe>.
    let mapper = entry.parent;
    while (mapper > 0 && info.get(mapper)?.inlined) mapper = info.get(mapper).parent;
    mapper = Math.max(mapper, 0);
    chain.push({ token: entry.token, mapper });
    id = mapper;
  }
  return chain;
}

/** Translates a point in a frame's viewport to the tab's viewport, checking no ancestor covers the frame. */
async function toTopPoint(tabId, ref, point, { check = false } = {}) {
  const frameId = frameOfRef(ref);
  if (!frameId) return point;
  const chain = await frameChain(tabId, frameId);
  let { x, y } = point;
  for (const link of chain) {
    const offset = await runAgent(tabId, link.mapper, "frameOffset", [link.token, false]);
    x += offset.x;
    y += offset.y;
    if (check) {
      const blocker = await runAgent(tabId, link.mapper, "frameBlocker", [link.token, x, y]);
      if (blocker) {
        throw new Error(`Element "${ref}" is in a frame covered by ${blocker}, which would receive the click. Dismiss or close it first.`);
      }
    }
  }
  return { ...point, x, y };
}

/** Scrolls the frames holding `ref` into view, outermost first. */
async function revealFrames(tabId, ref) {
  const frameId = frameOfRef(ref);
  if (!frameId) return;
  const chain = await frameChain(tabId, frameId);
  for (const link of [...chain].reverse()) await runAgent(tabId, link.mapper, "frameOffset", [link.token, true]);
}

/**
 * Where to click an element: scrolls it into view, waits until its position
 * is stable and, with `check`, makes sure it is enabled and not covered by
 * another element. The waiting is timed here rather than in the page, whose
 * timers are throttled in background tabs. Elements in frames from other
 * sites are translated to the tab's viewport, where Chrome routes the input.
 */
async function pointFor(tabId, ref, check = true) {
  await revealFrames(tabId, ref);
  await callRef(tabId, ref, "prepareTarget", check);
  let point = await callRef(tabId, ref, "center");
  for (let i = 0; i < 6; i++) {
    await sleep(30);
    const next = await callRef(tabId, ref, "center");
    if (next.x === point.x && next.y === point.y) break;
    point = next;
  }
  if (check) {
    for (let attempt = 0; ; attempt++) {
      const blocker = await callRef(tabId, ref, "blocker");
      if (!blocker) {
        point = await callRef(tabId, ref, "center");
        break;
      }
      if (attempt >= 4) {
        throw new Error(`Element "${ref}" is covered by ${blocker}, which would receive the click. Dismiss or close it first.`);
      }
      await sleep(100);
    }
  }
  return toTopPoint(tabId, ref, point, { check });
}

/** CDP handle for the element behind a snapshot ref, in the page's own (main) world. */
async function resolveRef(tabId, ref, { mainWorld = false } = {}) {
  if (frameOfRef(ref)) {
    throw new Error(
      `Element "${ref}" is in a frame from another site. Uploading files and evaluate with a ref work on the page's own elements; click and type work everywhere.`,
    );
  }
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
  state.activated.add(tabId);
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}

async function pressKey(tabId, key) {
  state.activated.add(tabId);
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
  const kind = await callRef(tabId, ref, "editKind");
  if (kind === "direct") {
    // Date, time, colour and range inputs cannot be typed into reliably.
    await callRef(tabId, ref, "setValue", text);
  } else {
    try {
      await mouseClick(tabId, await pointFor(tabId, ref));
    } catch (error) {
      // A floating label or similar overlay: focusing programmatically is fine for typing.
      if (!/covered by/.test(errorMessage(error))) throw error;
    }
    const hadContent = await callRef(tabId, ref, "selectContent");
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
  const value = await callRef(tabId, ref, "fieldValue").catch(() => undefined);
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
      if ((await callRef(tabId, ref, "isChecked")) !== want) await mouseClick(tabId, await pointFor(tabId, ref));
      if ((await callRef(tabId, ref, "isChecked")) !== want) throw new Error(`could not ${want ? "check" : "uncheck"} it`);
      return `${name}: ${want ? "checked" : "unchecked"}`;
    }
    case "combobox":
    case "listbox": {
      if (!(await callRef(tabId, ref, "isNativeSelect"))) {
        throw new Error("not a native <select>; open it with browser_click and click the option instead");
      }
      return `${name}: ${(await callRef(tabId, ref, "selectOptions", [value])).join(", ")}`;
    }
    case "slider":
      return `${name}: ${await callRef(tabId, ref, "setValue", value)}`;
    default:
      throw new Error(`unsupported field type "${type}"`);
  }
}

async function uploadFiles(tabId, ref, paths) {
  if (await callRef(tabId, ref, "isFileInput")) {
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

/**
 * A tab as agents see it, with who it belongs to: the asking agent ("you"),
 * another agent, the user (connected for agents, or not), or the user after
 * an agent handed it over.
 */
function tabInfo(tab, session) {
  const workerId = state.owner.get(tab.id);
  const openerId = state.created.get(tab.id);
  const agent = state.sessions.get(workerId ?? openerId);
  const handoff = state.handoffs.get(tab.id);
  const taken = state.taken.get(tab.id);
  let owner = "user";
  if (taken && taken.sessionId === session?.id) owner = "taken";
  else if (agent && agent.id === session?.id) owner = "you";
  else if (agent) owner = "agent";
  else if (handoff) owner = "handed-off";
  else if (state.pool.has(tab.id)) owner = "user-connected";
  return {
    id: tab.id,
    windowId: tab.windowId,
    title: tab.title ?? "",
    // A tab that is still loading has an empty url and the target in pendingUrl.
    url: tab.url || tab.pendingUrl || "",
    active: tab.active,
    connected: !!session && workerId === session.id,
    owner,
    ...(agent && agent.id !== session?.id ? { agent: agent.name } : {}),
    ...(handoff ? { note: handoff.note, handedOffBy: handoff.agent } : {}),
    ...(taken ? { note: taken.note } : {}),
    ...(tab.groupId !== -1 && tab.groupId === state.groupId ? { grouped: true } : {}),
    ...(state.stepIns.has(tab.id) ? { userSteppedIn: true } : {}),
  };
}

/** The page loaded moments ago, the agent has not acted on it yet, and it is still fetching or changing. */
async function stillLoading(tabId) {
  const committed = state.committedAt.get(tabId);
  if (!committed || Date.now() - committed > 10_000 || (state.actedAt.get(tabId) ?? 0) > committed) return false;
  if (loadingRecently(tabId)) return true;
  return (await callAgent(tabId, "quietFor").catch(() => Infinity)) < 300;
}

/** A page that loaded moments ago and is still changing (an editor, an app view) gets a moment to settle before a read. */
async function settleIfFresh(tabId) {
  const committed = state.committedAt.get(tabId);
  if (!committed || Date.now() - committed > FRESH_PAGE_MS) return;
  // After the agent's own action, that action already waited for the page.
  if ((state.actedAt.get(tabId) ?? 0) > committed) return;
  const quiet = await callAgent(tabId, "quietFor").catch(() => Infinity);
  if (quiet < 150) await settleDom(tabId, 150, 1_200).catch(() => {});
}

/** The element's box in the tab's viewport, scrolled into view. */
async function boxFor(tabId, ref) {
  await revealFrames(tabId, ref);
  const box = await callRef(tabId, ref, "boxIn");
  return toTopPoint(tabId, ref, box);
}

async function withoutOverlay(tabId, fn) {
  await runAgent(tabId, 0, "overlayHidden", [true]).catch(() => {});
  try {
    return await fn();
  } finally {
    runAgent(tabId, 0, "overlayHidden", [false]).catch(() => {});
  }
}

/** Fetches a file with the profile's logins: in the page for its own and blob: URLs, else from here. */
async function fetchFile(tabId, url) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  let pageOrigin = null;
  try {
    pageOrigin = new URL(tab?.url ?? "").origin;
  } catch {
    // no page
  }
  const target = new URL(url, tab?.url);
  const inPage = target.protocol === "blob:" || target.protocol === "data:" || target.origin === pageOrigin;
  if (inPage) {
    const [frame] = await chrome.scripting
      .executeScript({
        target: { tabId, frameIds: [0] },
        func: async (address, max) => {
          try {
            const response = await fetch(address, { credentials: "include" });
            if (!response.ok) return { error: `HTTP ${response.status}` };
            const blob = await response.blob();
            if (blob.size > max) return { error: `too large (${blob.size} bytes)` };
            const dataUrl = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = () => reject(reader.error);
              reader.readAsDataURL(blob);
            });
            return {
              base64: String(dataUrl).slice(String(dataUrl).indexOf(",") + 1),
              mimeType: blob.type || response.headers.get("content-type") || "",
              disposition: response.headers.get("content-disposition") || "",
              size: blob.size,
            };
          } catch (error) {
            return { error: String(error?.message ?? error) };
          }
        },
        args: [target.href, MAX_FILE_BYTES],
      })
      .catch(() => []);
    if (frame?.result && !frame.result.error) return { url: target.href, ...frame.result };
  }
  const response = await fetch(target.href, { credentials: "include" });
  if (!response.ok) throw new Error(`Could not get ${target.href}: HTTP ${response.status}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_FILE_BYTES) {
    throw new Error(`The file is ${Math.round(bytes.length / 1e6)} MB; files up to ${MAX_FILE_BYTES / 1e6} MB can be read. Use browser_download.`);
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return {
    url: target.href,
    base64: btoa(binary),
    mimeType: response.headers.get("content-type") || "",
    disposition: response.headers.get("content-disposition") || "",
    size: bytes.length,
  };
}

function downloadInfo(item) {
  return {
    id: item.id,
    url: item.finalUrl || item.url,
    path: item.filename || "",
    state: item.state,
    bytes: item.bytesReceived,
    totalBytes: item.totalBytes,
    mimeType: item.mime || "",
    startTime: item.startTime,
    ...(item.error ? { error: item.error } : {}),
    ...(item.danger && item.danger !== "safe" && item.danger !== "accepted" ? { danger: item.danger } : {}),
  };
}

/** Waits for a download to finish, at most `timeoutMs`; returns its latest state. */
async function settleDownload(id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [item] = await chrome.downloads.search({ id });
    if (!item || item.state !== "in_progress" || Date.now() > deadline) return item;
    await sleep(250);
  }
}

const handlers = {
  async getUrl(_payload, { tabId }) {
    return (await chrome.tabs.get(tabId)).url;
  },
  async getTitle(_payload, { tabId }) {
    return (await chrome.tabs.get(tabId)).title;
  },
  async browser_snapshot({ expect } = {}, { tabId }) {
    if (state.dialogs.has(tabId)) throw dialogError(tabId);
    await settleIfFresh(tabId);
    let text = await pageSnapshot(tabId);
    // Looking for something on a page that has just loaded and is still
    // fetching or building (an editor from a CDN, an app view): give it a moment.
    const deadline = Date.now() + 1_500;
    while (expect && !text.toLowerCase().includes(String(expect).toLowerCase()) && Date.now() < deadline && (await stillLoading(tabId))) {
      await sleep(250);
      text = await pageSnapshot(tabId);
    }
    return text;
  },
  async browser_get_text({ ref, selector, links }, { tabId }) {
    if (state.dialogs.has(tabId)) throw dialogError(tabId);
    await settleIfFresh(tabId);
    if (ref && frameOfRef(ref)) {
      return { ...(await callRef(tabId, ref, "readText")), ref };
    }
    return pageText(tabId, { ref, selector, links });
  },
  async browser_navigate({ url }, { tabId, session }) {
    // Navigation is tracked through webNavigation. After the agent's input the
    // page may ask "Leave site?": the debugger is what sees that dialog.
    if (state.activated.has(tabId)) await ensureAttached(tabId);
    return runAction(tabId, () => chrome.tabs.update(tabId, { url }), {
      startWindowMs: 1_000,
      session,
      failOnNavigationError: true,
    });
  },
  async browser_go_back(_payload, { tabId, session }) {
    if (state.activated.has(tabId)) await ensureAttached(tabId);
    return runAction(tabId, () => chrome.tabs.goBack(tabId), { startWindowMs: 1_000, session });
  },
  async browser_go_forward(_payload, { tabId, session }) {
    if (state.activated.has(tabId)) await ensureAttached(tabId);
    return runAction(tabId, () => chrome.tabs.goForward(tabId), { startWindowMs: 1_000, session });
  },
  async browser_wait({ time }) {
    await sleep(Math.max(0, Number(time) || 0) * 1000);
  },
  async browser_press_key({ key }, { tabId, session }) {
    await ensureAttached(tabId);
    return runAction(tabId, () => pressKey(tabId, key), { session });
  },
  async browser_click({ ref }, { tabId, session }) {
    await ensureAttached(tabId);
    return runAction(tabId, async () => mouseClick(tabId, await pointFor(tabId, ref)), { session });
  },
  async browser_hover({ ref }, { tabId, session }) {
    await ensureAttached(tabId);
    return runAction(
      tabId,
      async () => {
        const { x, y } = await pointFor(tabId, ref, false);
        await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      },
      { session },
    );
  },
  async browser_drag({ startRef, endRef }, { tabId, session }) {
    if (frameOfRef(startRef) !== frameOfRef(endRef)) {
      throw new Error("Both ends of a drag must be in the same frame.");
    }
    await ensureAttached(tabId);
    return runAction(
      tabId,
      async () => {
        await revealFrames(tabId, startRef);
        const points = await callRef(tabId, startRef, "dragPoints", endRef);
        const from = await toTopPoint(tabId, startRef, points.from);
        const to = await toTopPoint(tabId, startRef, points.to);
        await drag(tabId, from, to);
      },
      { session },
    );
  },
  async browser_type({ ref, text, submit, slowly }, { tabId, session }) {
    await ensureAttached(tabId);
    return runAction(tabId, () => typeInto(tabId, ref, text, { submit, slowly }), { session });
  },
  async browser_select_option({ ref, values }, { tabId, session }) {
    // A DOM-level change: no debugger.
    return runAction(tabId, () => callRef(tabId, ref, "selectOptions", values), { session });
  },
  async browser_screenshot({ ref, fullPage } = {}, { tabId }) {
    await ensureAttached(tabId);
    if (state.dialogs.has(tabId)) throw dialogError(tabId);
    const params = { format: "png" };
    if (ref) {
      const box = await boxFor(tabId, ref);
      const { cssVisualViewport } = await cdp(tabId, "Page.getLayoutMetrics");
      params.clip = {
        x: box.x + cssVisualViewport.pageX,
        y: box.y + cssVisualViewport.pageY,
        width: box.width,
        height: box.height,
        scale: 1,
      };
      params.captureBeyondViewport = true;
    } else if (fullPage) {
      const { cssContentSize } = await cdp(tabId, "Page.getLayoutMetrics");
      params.clip = { x: 0, y: 0, width: cssContentSize.width, height: Math.min(cssContentSize.height, 16_384), scale: 1 };
      params.captureBeyondViewport = true;
    }
    // The working-agent overlay stays out of the picture.
    const { data } = await withoutOverlay(tabId, async () => {
      await sleep(30);
      return cdp(tabId, "Page.captureScreenshot", params);
    });
    return data;
  },
  async browser_get_console_logs(_payload, { tabId }) {
    let entries = await readConsole(tabId);
    if (entries === null) {
      // Not hooked yet (the page loaded before the agent came): from now on.
      await installConsoleHook(tabId);
      entries = [];
    }
    const failed = (state.network.get(tabId) ?? []).map((r) => ({
      type: "network",
      timestamp: r.timestamp,
      message: `${r.method ?? "GET"} ${r.url} ${r.status ? `→ HTTP ${r.status}` : `→ ${r.error}`}${r.type ? ` (${r.type})` : ""}`,
    }));
    const early = state.earlyConsole.get(tabId) ?? [];
    return [...early, ...entries, ...failed].sort((a, b) => a.timestamp - b.timestamp);
  },

  // --- Browser MCP Plus-only messages -------------------------------------

  async browser_upload_file({ ref, paths }, { tabId, session }) {
    if (frameOfRef(ref)) {
      throw new Error(
        `Element "${ref}" is in a frame from another site; file uploads work on the page's own file inputs. Open the frame's address in a tab of its own (browser_tab_new) and upload there.`,
      );
    }
    await ensureAttached(tabId);
    return runAction(tabId, () => uploadFiles(tabId, ref, paths), { session });
  },

  async browser_handle_dialog({ accept, promptText }, { tabId, session }) {
    const dialog = state.dialogs.get(tabId);
    if (!dialog) throw new Error("No dialog is open.");
    if (dialog.unanswerable) {
      // Opened while no debugger was attached: only leaving the page closes it.
      return runAction(
        tabId,
        async () => {
          state.dialogs.delete(tabId);
          await chrome.tabs.reload(tabId);
          return `Reloaded the page to close the ${dialog.type} dialog ${JSON.stringify(dialog.message)} (it opened while no agent was acting, so it could not be ${accept ? "accepted" : "dismissed"} as such).`;
        },
        { allowDialog: true, startWindowMs: 1_000, session },
      );
    }
    return runAction(
      tabId,
      async () => {
        await cdp(tabId, "Page.handleJavaScriptDialog", { accept, ...(promptText === undefined ? {} : { promptText }) });
        state.dialogs.delete(tabId);
        return `${accept ? "Accepted" : "Dismissed"} the ${dialog.type} dialog ${JSON.stringify(dialog.message)}`;
      },
      { allowDialog: true, startWindowMs: 300, session },
    );
  },

  async browser_fill_form({ fields }, { tabId, session }) {
    await ensureAttached(tabId);
    return runAction(
      tabId,
      async () => {
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
      },
      { session },
    );
  },

  async browser_evaluate({ function: source, ref }, { tabId }) {
    if (ref) await callRef(tabId, ref, "guardSecret");
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

  async browser_scroll({ ref, deltaX = 0, deltaY = 0 }, { tabId, session }) {
    if (ref) {
      return runAction(
        tabId,
        async () => {
          await revealFrames(tabId, ref);
          await callRef(tabId, ref, "scrollIntoView");
        },
        { session },
      );
    }
    await ensureAttached(tabId);
    return runAction(
      tabId,
      async () => {
        const { width, height } = await callAgent(tabId, "viewport");
        await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x: width / 2, y: height / 2, deltaX, deltaY });
      },
      { session },
    );
  },

  async browser_get_file({ url, ref }, { tabId }) {
    let target = url;
    if (!target && ref) target = await callRef(tabId, ref, "resourceOf");
    if (!target) target = (await chrome.tabs.get(tabId)).url;
    if (!target || !/^(https?|file|blob|data):/.test(target)) {
      throw new Error("Give the file's URL, or the ref of an image or link that points to it.");
    }
    return fetchFile(tabId, target);
  },

  async browser_downloads({ limit = 10 }) {
    if (!chrome.downloads) throw new Error("This build of the extension cannot see downloads.");
    const items = await chrome.downloads.search({ orderBy: ["-startTime"], limit: Math.min(Math.max(limit, 1), 50) });
    return items.map(downloadInfo);
  },

  async browser_download({ url }) {
    if (!chrome.downloads) throw new Error("This build of the extension cannot download files.");
    const id = await chrome.downloads.download({ url, conflictAction: "uniquify" });
    return downloadInfo(await settleDownload(id, 20_000));
  },

  async browser_tab_list(_payload, { session }) {
    const tabs = await chrome.tabs.query({});
    const windows = await chrome.windows.getAll().catch(() => []);
    const focused = windows.find((w) => w.focused)?.id;
    return tabs.map((tab) => ({ ...tabInfo(tab, session), ...(tab.windowId === focused ? { focusedWindow: true } : {}) }));
  },

  async browser_tab_new({ url }, { session }) {
    // The tab is the agent's even if it cannot be controlled (e.g. chrome://): it closes with the agent.
    const tabId = await openTabFor(session, url);
    await assign(session, tabId);
    if (url) await waitForDocument(tabId);
    return tabInfo(await chrome.tabs.get(tabId), session);
  },

  async browser_tab_select({ tabId: target }, { session }) {
    ensureOwnable(session, target);
    const own = state.created.get(target) === session.id || state.owner.get(target) === session.id;
    const handedBack = state.handoffs.get(target)?.sessionId === session.id;
    if (!own && !state.pool.has(target) && !handedBack) {
      throw new Error(
        `Tab ${target} is the user's own tab. Agents work only in their own tabs and in tabs the user connected (Browser MCP Plus icon → Connect). Open a tab of your own with browser_tab_new.`,
      );
    }
    if (handedBack) {
      // Taken back: the agent's tab again until it hands it over or closes it.
      state.handoffs.delete(target);
      state.created.set(target, session.id);
      await runAgent(target, 0, "handoffClear", []).catch(() => {});
      refreshBadges();
    }
    await assign(session, target);
    if (state.stepIns.get(target)?.sessionId === session.id) {
      state.stepIns.delete(target);
      await runAgent(target, 0, "pauseClear", []).catch(() => {});
    }
    await persist();
    if (state.created.get(target) === session.id) await groupAgentTab(target);
    return tabInfo(await chrome.tabs.get(target), session);
  },

  async browser_tab_close({ tabId: target }, { session }) {
    target ??= session.tabId;
    if (target === null || target === undefined) throw new Error("You have no tab to close.");
    ensureOwnable(session, target);
    if (state.taken.get(target)?.sessionId === session.id) {
      throw new Error(
        `Tab ${target} is the user's tab you took to work in, so it stays open. When you are done, give it back with browser_tab_release.`,
      );
    }
    if (state.created.get(target) !== session.id) {
      throw new Error(
        `Tab ${target} is not one you opened, so it stays open. Agents close only their own tabs; use browser_tab_handoff to leave a tab to the user.`,
      );
    }
    const wasCurrent = target === session.tabId;
    if (wasCurrent) unassign(session);
    await chrome.tabs.remove(target);
    // Closing its current tab, the agent carries on in another of its tabs or
    // a free connected tab; otherwise a tab is found (or opened) on the next request.
    if (wasCurrent && (await takeFreeTab(session, target))) return tabInfo(await chrome.tabs.get(session.tabId), session);
    return null;
  },

  async browser_tab_take({ tabId: target, note }, { session }) {
    return takeTab(session, target, String(note ?? "").slice(0, 120) || "continuing here");
  },

  async browser_tab_release({ tabId: target }, { session }) {
    target ??= session.tabId;
    if (target === null || target === undefined || state.taken.get(target)?.sessionId !== session.id) {
      throw new Error("That is not a tab you took from the user. browser_tab_list shows them (\"the user's, lent to you\").");
    }
    return giveBack(target);
  },

  async browser_tab_handoff({ tabId: target, note }, { session }) {
    target ??= session.tabId;
    if (target === null || target === undefined) throw new Error("You have no tab to hand over.");
    return handoffTab(session, target, String(note ?? "").slice(0, 120) || "your turn");
  },

  sessions_update: updateSessions,
  profile_set: setProfile,
};

// The agent's tab is resolved in dispatch(); these handlers use the session instead.
TABLESS.add("browser_tab_new");
TABLESS.add("browser_tab_select");
TABLESS.add("browser_tab_close");
TABLESS.add("browser_tab_handoff");
TABLESS.add("browser_tab_take");
TABLESS.add("browser_tab_release");
TABLESS.add("browser_downloads");
TABLESS.add("browser_download");

// ---------------------------------------------------------------------------
// Popup and test hooks

async function status() {
  await restore();
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabs = [];
  for (const tabId of new Set([...state.pool, ...state.created.keys(), ...state.owner.keys(), ...state.taken.keys()])) {
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
      taken: state.taken.has(tab.id) ? { note: state.taken.get(tab.id).note, agent: state.taken.get(tab.id).agent } : null,
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
        pausedByUser: s.tabId !== null && state.stepIns.has(s.tabId),
      };
    });
  const here = active ? tabs.find((t) => t.id === active.id) : undefined;
  const handoffs = [];
  for (const [tabId, handoff] of state.handoffs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab) handoffs.push({ tabId, title: tab.title ?? "", note: handoff.note, agent: handoff.agent });
  }
  const activeHandoff = active ? state.handoffs.get(active.id) : undefined;
  return {
    handoffs,
    activeHandoff: activeHandoff ? { note: activeHandoff.note, agent: activeHandoff.agent } : null,
    activeTaken: here?.taken ?? null,
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Real input in a page the agent knows (from the page agent).
  if (message?.cmd === "userInput" && sender.tab) {
    void userInput(sender.tab.id, message.kind === "key" ? "key" : "click", Number(message.at) || Date.now());
    return false;
  }
  // A page is about to show (or has closed) a JavaScript dialog (from the page hook).
  if ((message?.cmd === "dialogOpening" || message?.cmd === "dialogClosed") && sender.tab && sender.frameId === 0) {
    const tabId = sender.tab.id;
    if (message.cmd === "dialogClosed") {
      if (state.dialogs.get(tabId)?.unanswerable) state.dialogs.delete(tabId);
    } else if (!state.attached.has(tabId)) {
      state.dialogs.set(tabId, { type: String(message.type), message: String(message.message), unanswerable: true });
      for (const waiter of dialogWaiters) if (waiter.tabId === tabId) waiter.notify();
    }
    return false;
  }
  const actions = {
    status: () => status(),
    connect: () => connectTab(message.tabId).then(status),
    disconnect: () => (message.tabId ? disconnectTab(message.tabId) : disconnectAll()).then(status),
    disconnectAll: () => disconnectAll().then(status),
    keepTab: () => keepTab(message.tabId).then(status),
    dismissHandoff: () => handoffSeen(message.tabId).then(status),
    giveBack: () => giveBack(message.tabId, { byUser: true }).then(status),
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

globalThis.bmcp = {
  connectTab, disconnectTab, disconnectAll, keepTab, resume, setPort, setAutoConnect, status, checkOrphans, handoffSeen,
  sweepDebugger,
  giveBack,
  /** Tabs this extension's debugger is attached to (Playwright attaches to every tab itself). */
  debuggerTabs: () => [...state.attached],
  /**
   * What reloading the extension does to its state (session storage and memory
   * gone, local storage kept), for tests: Playwright cannot reload an extension
   * loaded from the command line.
   */
  async simulateReload() {
    await chrome.storage.session.clear();
    closeSocket();
    for (const key of ["pool", "created", "sessions", "owner", "handoffs", "attached"]) state[key].clear();
    state.groupId = null;
    state.lostAt = null;
    state.restored = false;
    restoring = null;
    await restore();
  },
};

void restore();
