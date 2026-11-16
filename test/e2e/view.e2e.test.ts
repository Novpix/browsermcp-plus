// Agents work in the background: opening tabs, taking and giving back the
// user's tabs and keeping the AI group at the right never change the tab the
// user is looking at, in any window.

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
let base: string;
let context: BrowserContext;
let worker: Worker;
let port: number;
let agent: Client;

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = (await agent.callTool({ name, arguments: args })) as { content: { text?: string }[]; isError?: boolean };
  return { ...result, text: result.content.map((c) => c.text ?? "").join("\n") };
}

async function waitFor<T>(probe: () => Promise<T | undefined | null | false>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The tab each window shows: what the user sees. */
const shown = () =>
  worker.evaluate(async () => {
    const view: Record<number, number> = {};
    for (const tab of await chrome.tabs.query({ active: true })) view[tab.windowId] = tab.id;
    return view;
  }) as Promise<Record<number, number>>;

const tabOf = (id: number) => worker.evaluate((id) => chrome.tabs.get(id), id) as Promise<{ id: number; windowId: number; index: number; groupId: number; active: boolean }>;

const newTab = (windowId: number, query: string, active = false) =>
  worker.evaluate(async ({ windowId, url, active }) => (await chrome.tabs.create({ windowId, url, active })).id, {
    windowId,
    url: `${base}/page2.html?${query}`,
    active,
  }) as Promise<number>;

/** A window of the user's, in the background, with tabs at the given queries; the first one is shown. */
const newWindow = (queries: string[]) =>
  worker.evaluate(
    async (urls) => {
      const window = await chrome.windows.create({ url: urls[0], focused: false });
      const ids = [window.tabs[0].id];
      for (const url of urls.slice(1)) ids.push((await chrome.tabs.create({ windowId: window.id, url, active: false })).id);
      return { windowId: window.id, ids };
    },
    queries.map((q) => `${base}/page2.html?${q}`),
  ) as Promise<{ windowId: number; ids: number[] }>;

const show = (tabId: number) => worker.evaluate((id) => chrome.tabs.update(id, { active: true }), tabId);

/** Waits out the calm regrouping (1.5 s after the last change) so nothing moves later. */
const settle = () => sleep(1_800);

let home = 0; // the user's window, where the AI group lives
let userTab = 0; // the tab the user looks at there

beforeAll(async () => {
  site = http.createServer(async (req, res) => {
    try {
      const body = await readFile(path.join(fixtures, path.basename(new URL(req.url!, "http://x").pathname)));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  port = await freePort();

  const extensionPath = path.join(root, "extension");
  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${base}/page2.html?user`);
  await worker.evaluate((port) => (globalThis as any).bmcp.setPort(port), port);

  agent = new Client({ name: "alpha", version: "0" });
  await agent.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, "dist/index.js"), "--port", String(port), "--session-name", "alpha"],
      stderr: process.env.DEBUG ? "inherit" : "ignore",
    }),
  );
  await waitFor(async () => (await worker.evaluate(() => (globalThis as any).bmcp.status())).serverConnected);
  const [tab] = await worker.evaluate(() => chrome.tabs.query({ active: true }));
  home = tab.windowId;
  userTab = tab.id;
}, 60_000);

afterAll(async () => {
  await agent?.close().catch(() => {});
  await context?.close();
  await new Promise((resolve) => site?.close(resolve));
});

describe("the user's view stays put", () => {
  it("opening agent tabs and putting the group back at the right", async () => {
    const before = await shown();
    expect((await call("browser_tab_new", { url: `${base}/page2.html?agent-1` })).isError).toBeFalsy();
    expect((await call("browser_tab_new", { url: `${base}/page2.html?agent-2` })).isError).toBeFalsy();
    expect(await shown()).toEqual(before);
    // The user opens a tab right of the group: the group moves back to the right, calmly.
    const right = await newTab(home, "user-right");
    await settle();
    expect(await shown()).toEqual(before);
    await worker.evaluate((id) => chrome.tabs.remove(id), right);
  });

  it("a link the agent opens in a new tab opens behind", async () => {
    const before = await shown();
    const nav = await call("browser_navigate", { url: `${base}/actions.html` });
    const link = /link "Open help in new tab" \[ref=([^\]]+)\]/.exec(nav.text)![1];
    const tabsBefore = (await worker.evaluate(() => chrome.tabs.query({}))).length;
    const clicked = await call("browser_click", { element: "Open help in new tab", ref: link });
    expect(clicked.isError, clicked.text).toBeFalsy();
    await waitFor(async () => (await worker.evaluate(() => chrome.tabs.query({}))).length > tabsBefore);
    await settle();
    expect(await shown()).toEqual(before);
  });

  it("a link the user clicks in the agent's tab opens in front, as usual", async () => {
    const page = await waitFor(async () => context.pages().find((p) => p.url().endsWith("/actions.html")));
    const agentTab = await worker.evaluate(async () => (await chrome.tabs.query({ url: "*://*/actions.html" }))[0].id);
    // The user goes to the agent's tab and clicks the link there.
    await show(agentTab);
    await page.click("text=Open help in new tab");
    const opened = await waitFor(async () => {
      const view = await shown();
      return view[home] !== agentTab && view[home];
    });
    await settle();
    expect((await shown())[home]).toBe(opened);
    await show(userTab);
    // The agent goes on (the click paused it there).
    expect((await call("browser_tab_select", { tabId: agentTab })).isError).toBeFalsy();
  });

  it("taking and giving back a background tab of another window", async () => {
    const other = await newWindow(["looked-at", "to-take", "third"]);
    const [lookedAt, toTake] = other.ids;
    const before = await shown();
    expect(before[other.windowId]).toBe(lookedAt);
    const from = await tabOf(toTake);

    const taken = await call("browser_tab_take", { tabId: toTake, note: "checking" });
    expect(taken.isError, taken.text).toBeFalsy();
    await settle();
    expect(await shown()).toEqual(before);
    expect((await tabOf(toTake)).windowId).toBe(home);

    const released = await call("browser_tab_release", {});
    expect(released.isError, released.text).toBeFalsy();
    await settle();
    expect(await shown()).toEqual(before);
    const back = await tabOf(toTake);
    expect([back.windowId, back.index]).toEqual([other.windowId, from.index]);
    await worker.evaluate((id) => chrome.windows.remove(id), other.windowId);
  });

  it("taking the tab the user is looking at in another window: it stays in front, there", async () => {
    const other = await newWindow(["in-front", "behind"]);
    const [inFront] = other.ids;
    const before = await shown();

    const taken = await call("browser_tab_take", { tabId: inFront, note: "filling the form" });
    expect(taken.isError, taken.text).toBeFalsy();
    await settle();
    expect(await shown()).toEqual(before);
    expect((await tabOf(inFront)).windowId).toBe(other.windowId);
    expect((await call("browser_tab_list")).text).toMatch(new RegExp(`\\[${inFront}\\][^\\n]*lent to you`));

    expect((await call("browser_tab_release", {})).isError).toBeFalsy();
    await settle();
    expect(await shown()).toEqual(before);
    await worker.evaluate((id) => chrome.windows.remove(id), other.windowId);
  });

  it("taking the tab the user is looking at in the group's window: it stays in front, and after", async () => {
    const before = await shown();
    const from = await tabOf(userTab);
    const taken = await call("browser_tab_take", { tabId: userTab, note: "watch me" });
    expect(taken.isError, taken.text).toBeFalsy();
    await settle();
    expect(await shown()).toEqual(before);
    expect((await tabOf(userTab)).groupId).not.toBe(-1);

    expect((await call("browser_tab_release", {})).isError).toBeFalsy();
    await settle();
    expect(await shown()).toEqual(before);
    const back = await tabOf(userTab);
    expect([back.windowId, back.index, back.groupId]).toEqual([from.windowId, from.index, -1]);
  });

  it("giving back a tab the user switched to, to watch: it stays in front", async () => {
    const other = await newWindow(["their-window", "watched"]);
    const watched = other.ids[1];
    expect((await call("browser_tab_take", { tabId: watched, note: "booking" })).isError).toBeFalsy();
    await settle();
    // The user goes to the tab in the AI group to watch the agent.
    await show(watched);
    const before = await shown();
    expect(before[home]).toBe(watched);

    const released = await call("browser_tab_release", {});
    expect(released.isError, released.text).toBeFalsy();
    expect(released.text).toContain("They are looking at it, so it stays where it is.");
    await settle();
    expect(await shown()).toEqual(before);
    expect((await tabOf(watched)).groupId).toBe(-1);
    await show(userTab);
    await worker.evaluate((id) => chrome.windows.remove(id), other.windowId);
    await worker.evaluate((id) => chrome.tabs.remove(id), watched).catch(() => {});
  });
});
