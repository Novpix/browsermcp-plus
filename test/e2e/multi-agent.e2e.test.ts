// Several agents (MCP server processes) sharing one browser, each in its own tab.

/// <reference lib="dom" />
declare const chrome: any;

import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium, type BrowserContext, type Worker } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { freePort } from "../helpers";

const root = path.resolve(fileURLToPath(import.meta.url), "../../..");
const fixtures = path.join(root, "test/e2e/fixtures");

let site: http.Server;
let siteUrl: string;
let context: BrowserContext;
let worker: Worker;
let port: number;
const agents: Record<string, Client> = {};

async function startAgent(name: string): Promise<Client> {
  const client = new Client({ name, version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, "dist/index.js"), "--port", String(port), "--session-name", name],
      stderr: process.env.DEBUG ? "inherit" : "ignore",
    }),
  );
  agents[name] = client;
  return client;
}

async function call(agent: string, name: string, args: Record<string, unknown> = {}) {
  const result = (await agents[agent].callTool({ name, arguments: args })) as {
    content: { type: string; text?: string }[];
    isError?: boolean;
  };
  return { ...result, text: result.content.map((c) => c.text ?? "").join("\n") };
}

const extensionStatus = () =>
  worker.evaluate(() => (globalThis as unknown as { bmcp: any }).bmcp.status()) as Promise<{
    tabs: { id: number; title: string; agent: string | null }[];
    serverConnected: boolean;
  }>;

const tabCount = async () => (await context.pages()).length;

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  site = http.createServer(async (req, res) => {
    try {
      const body = await readFile(path.join(fixtures, path.basename(new URL(req.url!, "http://x").pathname)));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  port = await freePort();

  const extensionPath = path.join(root, "extension");
  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${siteUrl}/form.html`);

  // The first agent becomes the hub, the second joins it.
  await startAgent("alpha");
  await startAgent("beta");

  // The user connects one tab.
  await worker.evaluate(async ({ port }) => {
    const [tab] = await chrome.tabs.query({ active: true });
    const api = (globalThis as unknown as { bmcp: any }).bmcp;
    await api.setPort(port);
    await api.connectTab(tab.id);
  }, { port });
  await waitFor(async () => (await extensionStatus()).serverConnected);
}, 60_000);

afterAll(async () => {
  for (const client of Object.values(agents)) await client.close().catch(() => {});
  await context?.close();
  await new Promise((resolve) => site?.close(resolve));
});

describe("several agents in one browser", () => {
  it("the first agent works in the connected tab, the next one gets a new tab", async () => {
    const before = await tabCount();
    const a = await call("alpha", "browser_navigate", { url: `${siteUrl}/form.html`, snapshot: false });
    expect(a.isError, a.text).toBeFalsy();
    expect(await tabCount()).toBe(before);

    const b = await call("beta", "browser_navigate", { url: `${siteUrl}/page2.html`, snapshot: false });
    expect(b.isError, b.text).toBeFalsy();
    expect(await tabCount()).toBe(before + 1);

    const status = await extensionStatus();
    expect(status.tabs.map((t) => t.agent).sort()).toEqual(["alpha", "beta"]);
  });

  it("puts tabs opened for an agent in a labelled group", async () => {
    const groups = await worker.evaluate(() => chrome.tabGroups.query({}));
    expect(groups.map((g: { title: string }) => g.title)).toContain("🤖 beta");
  });

  it("each agent sees and drives only its own tab, in parallel", async () => {
    const [snapA, snapB] = await Promise.all([call("alpha", "browser_snapshot"), call("beta", "browser_snapshot")]);
    expect(snapA.text).toContain("- Page Title: Fixture form");
    expect(snapB.text).toContain("- Page Title: Second page");

    // Two one-second waits inside the pages finish together, not one after the other.
    const started = Date.now();
    const slow = "() => new Promise((r) => setTimeout(() => r(document.title), 1000))";
    const [ra, rb] = await Promise.all([
      call("alpha", "browser_evaluate", { function: slow }),
      call("beta", "browser_evaluate", { function: slow }),
    ]);
    expect(ra.text).toBe("Fixture form");
    expect(rb.text).toBe("Second page");
    expect(Date.now() - started).toBeLessThan(1_900);
  });

  it("shows other agents' tabs and refuses to take them", async () => {
    const list = await call("alpha", "browser_tab_list");
    const betaLine = list.text.split("\n").find((l) => l.includes('used by agent "beta"'));
    expect(betaLine, list.text).toBeDefined();
    expect(list.text).toMatch(/Fixture form .*\(connected/);
    const betaTab = Number(/\[(\d+)\]/.exec(betaLine!)![1]);

    const taken = await call("alpha", "browser_tab_select", { tabId: betaTab });
    expect(taken.isError).toBe(true);
    expect(taken.text).toContain("being used by another agent (beta)");
    const closed = await call("alpha", "browser_tab_close", { tabId: betaTab });
    expect(closed.isError).toBe(true);
  });

  it("frees an agent's tab when it exits and reuses it for the next agent", async () => {
    await agents.beta.close();
    delete agents.beta;
    await waitFor(async () => !(await extensionStatus()).tabs.some((t) => t.agent === "beta"));

    const before = await tabCount();
    await startAgent("gamma");
    const g = await call("gamma", "browser_snapshot");
    expect(g.isError, g.text).toBeFalsy();
    // gamma got beta's old tab rather than a new one.
    expect(g.text).toContain("- Page Title: Second page");
    expect(await tabCount()).toBe(before);
  });

  it("keeps working when the hub agent exits", async () => {
    await agents.alpha.close();
    delete agents.alpha;
    // gamma becomes the hub and the extension reconnects to it.
    let result = await call("gamma", "browser_snapshot");
    const deadline = Date.now() + 10_000;
    while (result.isError && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      result = await call("gamma", "browser_snapshot");
    }
    expect(result.isError, result.text).toBeFalsy();
    expect(result.text).toContain("- Page Title: Second page");
    await waitFor(async () => !(await extensionStatus()).tabs.some((t) => t.agent === "alpha"));
  });
});
