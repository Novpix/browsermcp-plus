const $ = (id) => document.getElementById(id);

/** Agent colours, lightened for the dark popup. */
const AGENT_COLORS = {
  grey: "#bdc1c6",
  blue: "#8ab4f8",
  red: "#f28b82",
  yellow: "#fdd663",
  green: "#81c995",
  pink: "#ff8bcb",
  purple: "#c58af9",
  cyan: "#78d9ec",
  orange: "#fcad70",
};

async function call(cmd, extra = {}) {
  const response = await chrome.runtime.sendMessage({ cmd, ...extra });
  if (!response?.ok) throw new Error(response?.error ?? "No response from the extension");
  return response.value;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "style") Object.assign(node.style, value);
    else if (key.startsWith("--")) node.style.setProperty(key, value);
    else if (key === "class") node.className = value;
    else node[key] = value;
  }
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

function ago(timestamp) {
  if (!timestamp) return "idle";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function host(url) {
  try {
    return new URL(url).host || url;
  } catch {
    return url || "";
  }
}

function render(status) {
  const profile = status.profile?.name || status.account;
  $("version").textContent = `v${status.version}${profile ? ` · ${profile}` : ""}`;
  $("version").title = status.profile ? `Chrome profile folder: ${status.profile.directory}` : "";

  // Server pill
  const server = $("server");
  const waiting = !status.paused && (status.autoConnect || status.tabs.length > 0);
  server.className = `pill ${status.serverConnected ? "ok" : waiting ? "warn" : ""}`;
  $("serverText").textContent = status.serverConnected
    ? "Connected"
    : status.paused
      ? "Stopped"
      : waiting
        ? "Waiting for server"
        : "Off";
  $("paused").hidden = !status.paused;
  $("resume").onclick = () => run(() => call("resume"));

  // Stats
  const working = status.agents.filter((a) => a.busy).length;
  const free = status.tabs.filter((t) => !t.agent).length;
  $("agentCount").textContent = status.agents.length;
  $("agentSub").textContent = working ? `${working} working` : status.agents.length ? "all idle" : "none yet";
  $("tabCount").textContent = status.tabs.length;
  const opened = status.tabs.filter((t) => t.openedForAgent).length;
  $("tabSub").textContent = status.tabs.length ? `${opened} opened · ${free} free` : "none";
  $("portValue").textContent = status.port;

  // This tab
  const here = status.activeConnected;
  const agentTab = status.activeAgentTab;
  const toggle = $("toggle");
  if (status.activeHandoff) {
    // An agent left this tab to the user.
    $("currentText").textContent = `${status.activeHandoff.agent} is waiting for you: ${status.activeHandoff.note}`;
    toggle.textContent = "Done";
    toggle.className = "primary";
    toggle.disabled = false;
    toggle.title = "Clear the note; the tab stays open and stays yours.";
    toggle.onclick = () => run(() => call("dismissHandoff", { tabId: status.activeTabId }));
  } else if (agentTab) {
    // Opened for an agent: it closes when the agent is done, unless the user keeps it.
    $("currentText").textContent = `${agentTab.agent ? `Opened by ${agentTab.agent}` : "Opened by an agent"} — closes when it is done`;
    toggle.textContent = "Keep this tab";
    toggle.className = "primary";
    toggle.disabled = false;
    toggle.title = "The tab stays open and becomes yours; the agent lets go of it.";
    toggle.onclick = () => run(() => call("keepTab", { tabId: status.activeTabId }));
  } else {
    $("currentText").textContent = here
      ? "Connected — agents may use it"
      : status.activeRestricted
        ? "This page can't be automated"
        : "Not connected";
    toggle.textContent = here ? "Disconnect" : "Connect";
    toggle.className = here ? "" : "primary";
    toggle.disabled = !here && status.activeRestricted;
    toggle.title = here ? "" : "Let agents work in this tab too";
    toggle.onclick = () => run(() => call(here ? "disconnect" : "connect", { tabId: status.activeTabId }));
  }

  // Tabs agents left to the user
  $("waitingSection").hidden = status.handoffs.length === 0;
  $("waiting").replaceChildren(
    ...status.handoffs.map((h) =>
      el(
        "button",
        { class: "plate agent", "--agent": "#ff9f0a", title: "Show this tab", onclick: () => run(() => call("focusTab", { tabId: h.tabId })) },
        el("div", { class: "top" }, el("span", { class: "name ellipsis", textContent: h.note }), el("span", { class: "chip", textContent: h.agent })),
        el("div", { class: "line small muted" }, el("span", { class: "ellipsis", textContent: `▸ ${h.title}` })),
      ),
    ),
  );

  // Agents
  $("agentHeading").textContent = status.agents.length ? `· ${status.agents.length}` : "";
  const agents = status.agents.map((agent) => {
    const color = AGENT_COLORS[agent.color] ?? AGENT_COLORS.blue;
    const card = el(
      "button",
      {
        class: `plate agent${agent.busy ? " working" : ""}`,
        "--agent": color,
        title: agent.tabId ? "Show this agent's tab" : "",
        disabled: !agent.tabId,
        onclick: () => agent.tabId && run(() => call("focusTab", { tabId: agent.tabId })),
      },
      el(
        "div",
        { class: "top" },
        el("span", { class: "busy" }),
        el("span", { class: "name ellipsis", textContent: agent.name }),
        el("span", { class: "chip", textContent: `${agent.actions} action${agent.actions === 1 ? "" : "s"}` }),
      ),
      el(
        "div",
        { class: "line small muted" },
        el("span", {
          class: "ellipsis",
          style: { flex: "1", minWidth: "0" },
          textContent: agent.tabId
            ? `▸ ${agent.tabTitle || host(agent.tabUrl) || `Tab ${agent.tabId}`}${agent.tabCount > 1 ? ` +${agent.tabCount - 1}` : ""}`
            : "No tab yet",
        }),
        agent.lastAction && el("span", { class: "chip", textContent: agent.busy ? `${agent.lastAction}…` : agent.lastAction }),
        el("span", { textContent: agent.busy ? "working" : ago(agent.lastActivity) }),
      ),
      agent.lastError && el("div", { class: "error ellipsis", title: agent.lastError, textContent: `⚠ ${agent.lastError}` }),
    );
    return card;
  });
  $("agents").replaceChildren(
    ...(agents.length
      ? agents
      : [
          el(
            "div",
            { class: "plate empty" },
            "No agents yet. Start Claude Code (or any MCP client) with ",
            el("code", { textContent: "browsermcp-plus" }),
            " — each session appears here and works in tabs of its own, which close when it is done.",
          ),
        ]),
  );

  // Connected tabs
  $("tabHeading").textContent = status.tabs.length ? `· ${status.tabs.length}` : "";
  const tabs = status.tabs.map((tab) =>
    el(
      "div",
      { class: "tab" },
      tab.favIconUrl ? el("img", { src: tab.favIconUrl, alt: "" }) : el("span", { class: "noicon" }),
      el("span", { class: "title ellipsis", title: tab.url, textContent: tab.title || host(tab.url) || `Tab ${tab.id}` }),
      tab.agent
        ? el("span", { class: "owner", "--agent": AGENT_COLORS[tab.color] ?? AGENT_COLORS.blue, textContent: tab.agent })
        : el("span", { class: "owner free", textContent: "free" }),
      tab.openedForAgent &&
        el("button", {
          class: "keep",
          textContent: "Keep",
          title: "Keep this tab open after the agent is done; the agent lets go of it",
          onclick: () => run(() => call("keepTab", { tabId: tab.id })),
        }),
    ),
  );
  $("tabs").replaceChildren(
    ...(tabs.length
      ? tabs
      : [
          el("div", {
            class: "empty",
            textContent: status.autoConnect
              ? "Agents open tabs of their own here and close them when they are done. Connect a tab to let them use it too."
              : "Connect a tab to let agents use your browser.",
          }),
        ]),
  );

  $("stopAll").hidden = status.paused || (status.tabs.length === 0 && status.agents.length === 0);
  $("stopAll").onclick = () => run(() => call("disconnectAll"));
  if (document.activeElement !== $("port")) $("port").value = status.port;
  $("autoConnect").checked = status.autoConnect;
}

async function run(action) {
  $("error").textContent = "";
  try {
    render(await action());
  } catch (error) {
    $("error").textContent = error.message;
  }
}

$("port").addEventListener("change", () => {
  const port = Number($("port").value);
  if (Number.isInteger(port) && port > 0 && port < 65536) run(() => call("setPort", { port }));
});

$("autoConnect").addEventListener("change", () => run(() => call("setAutoConnect", { value: $("autoConnect").checked })));

run(() => call("status"));
setInterval(() => run(() => call("status")), 1000);
