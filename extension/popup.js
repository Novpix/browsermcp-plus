const $ = (id) => document.getElementById(id);

async function call(cmd, extra = {}) {
  const response = await chrome.runtime.sendMessage({ cmd, ...extra });
  if (!response?.ok) throw new Error(response?.error ?? "No response from the extension");
  return response.value;
}

function render(status) {
  const here = status.tabId !== null && status.tabId === status.activeTabId;
  const elsewhere = status.tabId !== null && !here;
  $("tabDot").classList.toggle("on", here);
  $("tabStatus").textContent = here
    ? "This tab is connected"
    : elsewhere
      ? "Another tab is connected"
      : "No tab connected";
  $("serverDot").classList.toggle("on", status.serverConnected);
  $("serverStatus").textContent = status.serverConnected
    ? `MCP server connected (port ${status.port})`
    : status.tabId !== null
      ? `Waiting for MCP server on port ${status.port}…`
      : "MCP server not connected";
  $("toggle").textContent = here ? "Disconnect" : elsewhere ? "Connect this tab instead" : "Connect";
  $("toggle").className = here ? "secondary" : "";
  $("toggle").onclick = () =>
    run(() => (here ? call("disconnect") : call("connect", { tabId: status.activeTabId })));
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
