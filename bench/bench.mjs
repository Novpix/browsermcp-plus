// Measures what an agent waits for: tool call latency (median of several runs)
// and snapshot size on a large page, through the real MCP server, extension and
// Chromium. Usage: node bench/bench.mjs [repository root] (default: this one).
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "playwright-core";

const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const RUNS = Number(process.env.RUNS ?? 7);
/** Rows in the page's list (1500: a very large page; 150: an ordinary one). */
const ROWS = Number(process.env.ROWS ?? 1500);

/** A long page: navigation, a 1500-row list of links and buttons, a long article and a 300-row table. */
function bigPage() {
  const words = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore".split(" ");
  const sentence = (i) => Array.from({ length: 18 }, (_, k) => words[(i * 7 + k) % words.length]).join(" ") + ".";
  const items = Array.from({ length: ROWS }, (_, i) =>
    `<li class="row"><input type="checkbox" aria-label="Select ${i}"><a href="/m/${i}">Message ${i} from sender${i % 40}@example.com</a> <span>${sentence(i)}</span> <button>Archive</button></li>`,
  ).join("");
  const article = Array.from({ length: Math.round(ROWS / 4) }, (_, i) => `<p>${sentence(i)} ${sentence(i + 1)} ${sentence(i + 2)}</p>`).join("");
  const rows = Array.from({ length: Math.round(ROWS / 5) }, (_, i) => `<tr><td>${i}</td><td>Item ${i}</td><td>${(i * 3.7).toFixed(2)}</td><td>${sentence(i).slice(0, 40)}</td></tr>`).join("");
  return `<!doctype html><html><head><title>Big page</title></head><body>
<nav>${Array.from({ length: 60 }, (_, i) => `<a href="/n/${i}">Section ${i}</a>`).join(" ")}</nav>
<main><h1>Inbox</h1><label>Search <input id="q"></label> <button id="go" onclick="document.getElementById('out').textContent='Searched '+document.getElementById('q').value">Search</button>
<div id="out" role="status"></div><ul>${items}</ul><article><h2>Article</h2>${article}</article>
<table><caption>Numbers</caption><thead><tr><th>#</th><th>Name</th><th>Value</th><th>Note</th></tr></thead><tbody>${rows}</tbody></table></main></body></html>`;
}

async function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const html = bigPage();
const site = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${site.address().port}/big.html`;

const port = await freePort();
const extension = path.join(root, "extension");
const context = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(url);
await worker.evaluate(async (port) => {
  const api = globalThis.bmcp;
  await api.setPort(port);
  const [tab] = await chrome.tabs.query({ active: true });
  await api.connectTab(tab.id);
}, port);

const client = new Client({ name: "bench", version: "0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    // No truncation, so the snapshot size is the page's real size.
    args: [path.join(root, "dist/index.js"), "--port", String(port), "--snapshot-max-chars", "0"],
    stderr: "ignore",
  }),
);
const call = async (name, args = {}) => {
  const started = performance.now();
  const result = await client.callTool({ name, arguments: args });
  const ms = performance.now() - started;
  const text = result.content.map((c) => c.text ?? "").join("\n");
  if (result.isError) throw new Error(`${name}: ${text}`);
  return { ms, text };
};
for (let i = 0; ; i++) {
  try {
    await call("browser_snapshot");
    break;
  } catch (error) {
    if (i > 50) throw error;
    await new Promise((r) => setTimeout(r, 200));
  }
}

const results = {};
async function measure(label, fn) {
  const times = [];
  let extra;
  for (let i = 0; i < RUNS; i++) {
    const { ms, info } = await fn(i);
    times.push(ms);
    extra = info;
  }
  results[label] = { ms: Math.round(median(times)), ...(extra ? { info: extra } : {}) };
}

const refOf = (snapshot, pattern) => new RegExp(`${pattern}[^\\n]*\\[ref=([^\\]]+)\\]`).exec(snapshot)?.[1];

await measure("navigate (no snapshot)", async () => {
  const { ms } = await call("browser_navigate", { url, snapshot: false });
  return { ms };
});
let snapshot = "";
await measure("snapshot (whole page)", async () => {
  const { ms, text } = await call("browser_snapshot");
  snapshot = text;
  return { ms, info: `${text.length} chars` };
});
await measure("find (one element)", async () => {
  const { ms } = await call("browser_find", { text: "Message 1234 from" });
  return { ms };
});
const tools = (await client.listTools()).tools.map((t) => t.name);
if (tools.includes("browser_get_text")) {
  await measure("read the article text", async () => {
    const { ms, text } = await call("browser_get_text", { selector: "article" });
    return { ms, info: `${text.length} chars` };
  });
}
// Reading alone should leave Chrome's "is debugging" bar off. (Playwright
// attaches to every tab itself, so only the extension's own record counts;
// extensions before 0.7 have none: they attach as soon as an agent takes a tab.)
const attachedAfterReads = await worker.evaluate(() =>
  globalThis.bmcp.debuggerTabs ? globalThis.bmcp.debuggerTabs().length : "n/a (attached on first use)",
);
const search = refOf(snapshot, 'textbox "Search"');
const button = refOf(snapshot, 'button "Search"');
await measure("type into a field", async (i) => {
  const { ms } = await call("browser_type", { element: "Search", ref: search, text: `query ${i}`, submit: false });
  return { ms };
});
await measure("click a button", async () => {
  const { ms } = await call("browser_click", { element: "Search", ref: button });
  return { ms };
});
await measure("click, then find the result", async (i) => {
  const started = performance.now();
  await call("browser_type", { element: "Search", ref: search, text: `loop ${i}`, submit: false });
  await call("browser_click", { element: "Search", ref: button });
  await call("browser_find", { text: `Searched loop ${i}` });
  return { ms: performance.now() - started };
});

console.log(JSON.stringify({ root, runs: RUNS, rows: ROWS, results, debuggerAttachedAfterReads: attachedAfterReads }, null, 2));
await client.close();
await context.close();
site.close();
