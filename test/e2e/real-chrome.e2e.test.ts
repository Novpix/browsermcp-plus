// Agents in background tabs of a real, visible Chromium. Playwright-launched
// browsers disable background throttling and keep every page visible, which
// hides the problem this guards against: Chrome stops processing input in
// hidden tabs. Needs a display, so it only runs with REAL_CHROME=1
// (`npm run test:real`).

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { PLUS_EXTENSION_ID } from "../../src/config";
import { freePort } from "../helpers";

const root = path.resolve(fileURLToPath(import.meta.url), "../../..");

describe.skipIf(!process.env.REAL_CHROME)("agents in a real Chromium", () => {
  let site: http.Server;
  let base: string;
  let browser: ChildProcess;
  const agents: Client[] = [];

  async function startAgent(name: string, port: number) {
    const client = new Client({ name, version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.join(root, "dist/index.js"), "--port", String(port), "--session-name", name],
        stderr: "ignore",
      }),
    );
    agents.push(client);
    return client;
  }

  async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
    const result = (await client.callTool({ name, arguments: args })) as { content: { text?: string }[]; isError?: boolean };
    return { text: result.content.map((c) => c.text ?? "").join(""), isError: result.isError };
  }

  /** Connects the extension's first tab to the server through the DevTools protocol, then lets go. */
  async function connectFirstTab(wsUrl: string, port: number) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve) => ws.once("open", resolve));
    let id = 0;
    const pending = new Map<number, (m: any) => void>();
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      pending.get(message.id)?.(message);
    });
    const send = (method: string, params = {}, sessionId?: string) =>
      new Promise<any>((resolve) => {
        const n = ++id;
        pending.set(n, resolve);
        ws.send(JSON.stringify({ id: n, method, params, sessionId }));
      });
    let worker: { targetId: string } | undefined;
    for (let i = 0; i < 50 && !worker; i++) {
      const { result } = await send("Target.getTargets");
      worker = result.targetInfos.find(
        (t: { type: string; url: string }) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${PLUS_EXTENSION_ID}/`),
      );
      if (!worker) await new Promise((r) => setTimeout(r, 200));
    }
    const { result } = await send("Target.attachToTarget", { targetId: worker!.targetId, flatten: true });
    await new Promise((r) => setTimeout(r, 1_000));
    await send(
      "Runtime.evaluate",
      {
        expression: `(async () => { const [t] = await chrome.tabs.query({ active: true }); await bmcp.setPort(${port}); await bmcp.connectTab(t.id); })()`,
        awaitPromise: true,
      },
      result.sessionId,
    );
    // Detach so nothing but the extension touches the pages.
    ws.close();
  }

  beforeAll(async () => {
    const fixtures = path.join(root, "test/e2e/fixtures");
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
    base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;

    const port = await freePort();
    await startAgent("front", port);
    await startAgent("back", port);

    const profile = await mkdtemp(path.join(os.tmpdir(), "bmcp-real-"));
    const extension = path.join(root, "extension");
    browser = spawn(
      chromium.executablePath(),
      [
        `--user-data-dir=${profile}`,
        "--remote-debugging-port=0",
        "--no-first-run",
        "--no-default-browser-check",
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
        `${base}/form.html`,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const wsUrl = await new Promise<string>((resolve) => {
      let output = "";
      browser.stderr!.on("data", (chunk) => {
        output += chunk;
        const match = /DevTools listening on (ws:\S+)/.exec(output);
        if (match) resolve(match[1]);
      });
    });
    await connectFirstTab(wsUrl, port);
  }, 60_000);

  afterAll(async () => {
    for (const agent of agents) await agent.close().catch(() => {});
    browser?.kill();
    await new Promise((resolve) => site?.close(resolve));
  });

  it("an agent in a background tab clicks, types and runs timers as fast as one in the active tab", async () => {
    const [front, back] = agents;
    let opened = await call(front, "browser_navigate", { url: `${base}/form.html`, snapshot: false });
    for (let i = 0; opened.isError && i < 20; i++) {
      await new Promise((r) => setTimeout(r, 300));
      opened = await call(front, "browser_navigate", { url: `${base}/form.html`, snapshot: false });
    }
    // The second agent gets a new, inactive tab.
    await call(back, "browser_navigate", { url: `${base}/form.html`, snapshot: false });
    await new Promise((r) => setTimeout(r, 3_000));

    for (const agent of [front, back]) {
      const snapshot = (await call(agent, "browser_snapshot")).text;
      const ref = (re: RegExp) => /\[ref=([^\]]+)\]/.exec(snapshot.split("\n").find((l) => re.test(l))!)![1];
      const started = Date.now();
      for (let i = 0; i < 3; i++) await call(agent, "browser_click", { element: "Click me", ref: ref(/button "Click me|button "Clicked/) });
      await call(agent, "browser_type", { element: "Email", ref: ref(/textbox "Email"/), text: "a@b.c" });
      const elapsed = Date.now() - started;
      const page = await call(agent, "browser_evaluate", {
        function:
          "() => new Promise(r => { const s = performance.now(); let n = 0; const t = () => (++n < 10 ? setTimeout(t, 10) : r({ visibility: document.visibilityState, timers: performance.now() - s, clicks: window.clicks, email: document.querySelector('#email').value })); t(); })",
      });
      const state = JSON.parse(page.text);
      expect(state.visibility).toBe("visible");
      expect(state.clicks).toBe(3);
      expect(state.email).toBe("a@b.c");
      expect(state.timers).toBeLessThan(500);
      expect(elapsed).toBeLessThan(2_000);
    }
  });
});
