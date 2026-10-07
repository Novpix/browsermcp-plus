const $ = (id) => document.getElementById(id);

/** Chrome tab-group colours, lightened for the dark popup. */
const GROUP_COLORS = {
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
  $("version").textContent = `v${status.version}`;

  // Server pill
  const server = $("server");
  server.className = `pill ${status.serverConnected ? "ok" : status.tabs.length ? "warn" : ""}`;
  $("serverText").textContent = status.serverConnected
    ? "Connected"
    : status.tabs.length
      ? "Waiting for server"
      : "Off";

  // Stats
  const working = status.agents.filter((a) => a.busy).length;
  const free = status.tabs.filter((t) => !t.agent).length;
  $("agentCount").textContent = status.agents.length;
  $("agentSub").textContent = working ? `${working} working` : status.agents.length ? "all idle" : "none yet";
  $("tabCount").textContent = status.tabs.length;
  $("tabSub").textContent = status.tabs.length ? `${free} free` : "connected";
  $("portValue").textContent = status.port;

  // This tab
  const here = status.activeConnected;
  $("currentText").textContent = here
    ? "Connected — agents may use it"
    : status.activeRestricted
      ? "This page can't be automated"
      : "Not connected";
  const toggle = $("toggle");
  toggle.textContent = here ? "Disconnect" : "Connect";
  toggle.className = here ? "" : "primary";
  toggle.disabled = !here && status.activeRestricted;
  toggle.onclick = () => run(() => call(here ? "disconnect" : "connect", { tabId: status.activeTabId }));

  // Agents
  $("agentHeading").textContent = status.agents.length ? `· ${status.agents.length}` : "";
  const agents = status.agents.map((agent) => {
    const color = GROUP_COLORS[agent.color] ?? GROUP_COLORS.blue;
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
          textContent: agent.tabId ? `▸ ${agent.tabTitle || host(agent.tabUrl) || `Tab ${agent.tabId}`}` : "No tab yet",
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
            " — each session appears here and works in its own tab.",
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
        ? el("span", { class: "owner", "--agent": GROUP_COLORS[tab.color] ?? GROUP_COLORS.blue, textContent: tab.agent })
        : el("span", { class: "owner free", textContent: "free" }),
    ),
  );
  $("tabs").replaceChildren(
    ...(tabs.length
      ? tabs
      : [el("div", { class: "empty", textContent: "Connect a tab to let agents use your browser. Agents open more tabs when they need them." })]),
  );

  $("stopAll").hidden = status.tabs.length === 0;
  $("stopAll").onclick = () => run(() => call("disconnectAll"));
  if (document.activeElement !== $("port")) $("port").value = status.port;
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

run(() => call("status"));
setInterval(() => run(() => call("status")), 1000);
