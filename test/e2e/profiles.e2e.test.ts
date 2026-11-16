// Chrome profiles end to end: the extension connects on its own, a server
// opens a profile it cannot identify, the profile's extension reports back and
// the agent works in the tab the profile was opened with.

/// <reference lib="dom" />
declare const chrome: any;

import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium, type BrowserContext, type Page, type Worker } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { freePort } from "../helpers";

const root = path.resolve(fileURLToPath(import.meta.url), "../../..");
const fixtures = path.join(root, "test/e2e/fixtures");

let site: http.Server;
let siteUrl: string;
let context: BrowserContext;
let worker: Worker;
let port: number;
let userDataDir: string;
let scratch: string;
const agents: Record<string, Client> = {};

async function startAgent(name: string) {
  const client = new Client({ name, version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        path.join(root, "dist/index.js"),
        "--port",
        String(port),
        "--session-name",
        name,
        "--chrome-user-data-dir",
        userDataDir,
        "--chrome-path",
        path.join(scratch, "fake-chrome.sh"),
      ],
      stderr: process.env.DEBUG ? "inherit" : "ignore",
    }),
  );
  agents[name] = client;
}

async function call(agent: string, name: string, args: Record<string, unknown> = {}) {
  const result = (await agents[agent].callTool({ name, arguments: args })) as {
    content: { text?: string }[];
    isError?: boolean;
  };
  return { isError: result.isError, text: result.content.map((c) => c.text ?? "").join("\n") };
}

async function waitFor<T>(probe: () => Promise<T | undefined | false>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

const launchedArgs = () =>
  readFile(path.join(scratch, "launch.txt"), "utf8").then(
    (text) => text.trim().split("\n"),
    () => undefined,
  );

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

  scratch = await mkdtemp(path.join(os.tmpdir(), "bmcp-e2e-"));
  // Stands in for Chrome: records how the server asked to open a profile.
  const fake = path.join(scratch, "fake-chrome.sh");
  await writeFile(fake, `#!/bin/sh\nfor arg in "$@"; do echo "$arg"; done > "${path.join(scratch, "launch.txt")}"\n`);
  await chmod(fake, 0o755);

  userDataDir = await mkdtemp(path.join(os.tmpdir(), "bmcp-chrome-"));
  // A profile without a Google account: the server cannot tell it by its account.
  await writeFile(
    path.join(userDataDir, "Local State"),
    JSON.stringify({ profile: { info_cache: { Default: { name: "E2E profile" } }, last_used: "Default" } }),
  );

  const extensionPath = path.join(root, "extension");
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  // No tab connected: the extension connects to the server by itself.
  await worker.evaluate((port) => (globalThis as unknown as { bmcp: any }).bmcp.setPort(port), port);
  await startAgent("alpha");
}, 60_000);

afterAll(async () => {
  for (const client of Object.values(agents)) await client.close().catch(() => {});
  await context?.close();
  await new Promise((resolve) => site?.close(resolve));
  for (const dir of [scratch, userDataDir]) if (dir) await rm(dir, { recursive: true, force: true });
});

describe("Chrome profiles", () => {
  it("connects without a connected tab and lists the profile, not yet identified", async () => {
    const list = await waitFor(async () => {
      const result = await call("alpha", "browser_profiles");
      return result.text.includes("1 more connected extension") && result;
    });
    expect(list.text).toContain('- Default ("E2E profile") — not connected');
  });

  let profileTab: Page;

  it("opens the profile, learns which extension runs there and works in the tab it opened", async () => {
    const selecting = call("alpha", "browser_profile_select", { profile: "E2E profile" });
    // Chrome would hand the URL to the running browser; open it like it would.
    const args = await waitFor(launchedArgs);
    expect(args).toEqual([
      `--user-data-dir=${userDataDir}`,
      "--profile-directory=Default",
      expect.stringMatching(new RegExp(`^http://127\\.0\\.0\\.1:${port}/browsermcp-plus/profile/[\\w-]{16,}$`)),
    ]);
    profileTab = await context.newPage();
    await profileTab.goto(args[2]);

    const selected = await selecting;
    expect(selected.isError, selected.text).toBeFalsy();
    expect(selected.text).toContain('Opened Chrome profile Default ("E2E profile")');

    const list = await call("alpha", "browser_profiles");
    expect(list.text).toContain('- Default ("E2E profile") — connected, last used in Chrome ← you work here');
    expect(list.text).not.toContain("more connected extension");

    // The agent works in the tab the profile was opened with.
    const nav = await call("alpha", "browser_navigate", { url: `${siteUrl}/page2.html`, snapshot: false });
    expect(nav.isError, nav.text).toBeFalsy();
    expect(profileTab.url()).toBe(`${siteUrl}/page2.html`);
  });

  it("closes the tab it opened the profile with when the agent is done", async () => {
    await agents.alpha.close();
    delete agents.alpha;
    await waitFor(async () => profileTab.isClosed());
  });

  it("remembers its profile, so the next server knows it at once", async () => {
    const saved = await worker.evaluate(() => chrome.storage.local.get("profile"));
    expect(saved.profile).toEqual({ directory: "Default", name: "E2E profile", userDataDir });

    // A new server, which has opened nothing: the extension tells it its profile.
    await startAgent("beta");
    const list = await waitFor(async () => {
      const result = await call("beta", "browser_profiles");
      return result.text.includes('- Default ("E2E profile") — connected') && result;
    }, 15_000);
    expect(list.text).not.toContain("more connected extension");
  });
});
