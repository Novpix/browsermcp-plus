// What agents can reach: frames from other sites, closed shadow DOM, full
// text, files and downloads, console and network errors; how they show they
// are at work (the "AI" group, the page overlay), how they leave a tab to the
// user, and that reading never needs Chrome's debugger.

/// <reference lib="dom" />
declare const chrome: any;

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium, type BrowserContext, type Worker } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { freePort } from "../helpers";

const root = path.resolve(fileURLToPath(import.meta.url), "../../..");
const fixtures = path.join(root, "test/e2e/fixtures");

let site: http.Server;
let sitePort: number;
let base: string; // http://127.0.0.1:<port>
let other: string; // http://localhost:<port>: another site for Chrome
let context: BrowserContext;
let worker: Worker;
let port: number;
let filesDir: string;
const agents: Record<string, Client> = {};

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer: Buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** A small solid-colour PNG. */
function png(width: number, height: number, [r, g, b]: number[]) {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length);
    head.write(type, 4);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.from([0, ...Array.from({ length: width }, () => [r, g, b]).flat()])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);

async function startAgent(name: string) {
  const client = new Client({ name, version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, "dist/index.js"), "--port", String(port), "--session-name", name],
      env: { ...process.env, BROWSERMCP_FILES_DIR: filesDir } as Record<string, string>,
      stderr: process.env.DEBUG ? "inherit" : "ignore",
    }),
  );
  agents[name] = client;
}

async function stopAgent(name: string) {
  await agents[name].close();
  delete agents[name];
}

type CallResult = { text: string; isError?: boolean; content: { type: string; data?: string; mimeType?: string; text?: string }[] };

async function call(agent: string, name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  const result = (await agents[agent].callTool({ name, arguments: args })) as CallResult;
  return { ...result, text: result.content.map((c) => c.text ?? "").join("\n") };
}

function ref(snapshot: string, pattern: RegExp): string {
  const line = snapshot.split("\n").find((l) => pattern.test(l));
  const match = line && /\[ref=([^\]]+)\]/.exec(line);
  if (!match) throw new Error(`No element matching ${pattern} in snapshot:\n${snapshot}`);
  return match[1];
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

const bmcp = <T>(fn: string, ...args: unknown[]) =>
  worker.evaluate(({ fn, args }) => (globalThis as any).bmcp[fn](...args), { fn, args }) as Promise<T>;

/** The id of the tab an agent works in. */
async function tabOf(agent: string): Promise<number> {
  const list = (await call(agent, "browser_tab_list")).text;
  return Number(/\[(\d+)\][^\n]*you work in it/.exec(list)![1]);
}

const pageOfTab = (url: RegExp) => waitFor(async () => context.pages().find((p) => url.test(p.url())));

/** Whether the extension's debugger is on the tab (Playwright's own connection does not count). */
const debuggerOn = async (tabId: number) => (await bmcp<number[]>("debuggerTabs")).includes(tabId);

const tabIds = () => worker.evaluate(async () => (await chrome.tabs.query({})).map((t: any) => t.id)) as Promise<number[]>;

beforeAll(async () => {
  filesDir = await mkdtemp(path.join(os.tmpdir(), "bmcp-files-"));
  site = http.createServer(async (req, res) => {
    const name = path.basename(new URL(req.url!, "http://x").pathname);
    if (name === "file.png") return res.writeHead(200, { "content-type": "image/png" }).end(png(4, 3, [0, 128, 255]));
    if (name === "file.pdf") return res.writeHead(200, { "content-type": "application/pdf" }).end(PDF);
    if (name === "slow-editor.js") {
      await new Promise((r) => setTimeout(r, 700));
      return res.writeHead(200, { "content-type": "text/javascript" }).end(`
        const frame = document.createElement("iframe");
        frame.title = "Rich Text Area";
        frame.srcdoc = '<body contenteditable="true"><p>Your content goes here.</p></body>';
        document.body.append(frame);
      `);
    }
    if (name === "download.txt") {
      return res
        .writeHead(200, { "content-type": "text/plain", "content-disposition": 'attachment; filename="report.txt"' })
        .end("quarterly numbers\n");
    }
    try {
      const body = (await readFile(path.join(fixtures, name), "utf8"))
        .replaceAll("{{OTHER_ORIGIN}}", other)
        .replaceAll("{{SAME_ORIGIN}}", base);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
    } catch {
      res.writeHead(404, { "content-type": "application/json" }).end("{}");
    }
  });
  // Both address families: "localhost" may resolve to either.
  await new Promise<void>((resolve) => site.listen(0, "::", resolve));
  sitePort = (site.address() as { port: number }).port;
  base = `http://127.0.0.1:${sitePort}`;
  other = `http://localhost:${sitePort}`;
  port = await freePort();

  const extensionPath = path.join(root, "extension");
  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  // Playwright dismisses dialogs nobody listens to; a listener leaves them open, like a real browser.
  context.on("page", (page) => page.on("dialog", () => {}));
  await bmcp("setPort", port);
  await startAgent("alpha");
  await waitFor(async () => (await bmcp<{ serverConnected: boolean }>("status")).serverConnected);
}, 60_000);

afterAll(async () => {
  for (const client of Object.values(agents)) await client.close().catch(() => {});
  await context?.close();
  await new Promise((resolve) => site?.close(resolve));
  if (filesDir) await rm(filesDir, { recursive: true, force: true });
});

describe("frames and shadow DOM", () => {
  let snap = "";

  it("shows frames from other sites, nested ones too, in place", async () => {
    const nav = await call("alpha", "browser_navigate", { url: `${base}/frames.html` });
    expect(nav.isError, nav.text).toBeFalsy();
    snap = await waitFor(async () => {
      const text = (await call("alpha", "browser_snapshot")).text;
      return text.includes("Nested action") && text;
    });
    // In place: under the iframe, more indented than it.
    const lines = snap.split("\n");
    const frameLine = lines.findIndex((l) => /- iframe "Other site"/.test(l));
    const insideLine = lines.findIndex((l) => l.includes('heading "Inside the other site"'));
    expect(frameLine).toBeGreaterThan(-1);
    expect(insideLine).toBeGreaterThan(frameLine);
    expect(lines[insideLine].search(/\S/)).toBeGreaterThan(lines[frameLine].search(/\S/));
    // Refs of a frame carry it.
    expect(ref(snap, /button "Frame action"/)).toMatch(/^f\d+e\d+$/);
    expect(ref(snap, /button "Nested action"/)).toMatch(/^f\d+e\d+$/);
    // A hidden frame is not listed.
    expect(snap).not.toContain("Hidden frame text");
  });

  it("finds text inside them", async () => {
    const found = await call("alpha", "browser_find", { text: "Inside the other site" });
    expect(found.text).toContain("1 match");
  });

  it("clicks and types inside them, nested frames included", async () => {
    const frames = (await pageOfTab(/frames\.html/)).frames();
    const inner = frames.find((f) => f.url().endsWith("frame-inner.html"))!;
    const nested = frames.find((f) => f.url().endsWith("frame-nested.html"))!;

    const click = await call("alpha", "browser_click", { element: "Frame action", ref: ref(snap, /button "Frame action"/) });
    expect(click.isError, click.text).toBeFalsy();
    expect(await inner.textContent("#frame-status")).toBe("Frame clicked");
    // The report says what changed, there too.
    expect(click.text).toContain("Frame clicked");

    const typed = await call("alpha", "browser_type", { element: "Name on card", ref: ref(snap, /textbox "Name on card"/), text: "Ada Lovelace" });
    expect(typed.isError, typed.text).toBeFalsy();
    expect(await inner.inputValue("#card-name")).toBe("Ada Lovelace");

    const nestedClick = await call("alpha", "browser_click", { element: "Nested action", ref: ref(snap, /button "Nested action"/) });
    expect(nestedClick.isError, nestedClick.text).toBeFalsy();
    expect(await nested.textContent("#nested-status")).toBe("Nested clicked");
  });

  it("reads and clicks inside closed shadow roots", async () => {
    const button = ref(snap, /button "Closed shadow button"/);
    const click = await call("alpha", "browser_click", { element: "Closed shadow button", ref: button });
    expect(click.isError, click.text).toBeFalsy();
    expect(await (await pageOfTab(/frames\.html/)).textContent("#top-status")).toBe("Closed shadow clicked");
  });

  it("reads a frame's full text", async () => {
    const read = await call("alpha", "browser_get_text", {});
    expect(read.text).toContain("Inside the other site");
    expect(read.text).toContain("FRAME-TEXT-END");
  });

  it("finds an editor that appears after the page loaded", async () => {
    await call("alpha", "browser_navigate", { url: `${base}/late-editor.html`, snapshot: false });
    const found = await call("alpha", "browser_find", { text: "Your content goes here" });
    expect(found.text, found.text).toContain("1 match");
  });

  it("does not wait to find text that is not there on a page that has loaded", async () => {
    const started = Date.now();
    const found = await call("alpha", "browser_find", { text: "Text that is nowhere" });
    expect(found.text).toContain("No elements match");
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("reading", () => {
  it("reads long text in full, as Markdown, in pages", async () => {
    await call("alpha", "browser_navigate", { url: `${base}/article.html`, snapshot: false });
    const read = await call("alpha", "browser_get_text", { selector: "article", maxChars: 3_000 });
    expect(read.text).toContain("# A long article");
    expect(read.text).toContain("FIRST-PARAGRAPH-END");
    expect(read.text).toContain("[second page](/page2.html)");
    expect(read.text).toContain("- First point");
    expect(read.text).toContain("| Name | Value |\n| --- | --- |\n| Alpha | 1 |");
    expect(read.text).toContain("```\ncode line 1\n  code line 2\n```");
    expect(read.text).not.toContain("Hidden text");
    const next = /offset: (\d+)/.exec(read.text);
    expect(next, read.text).not.toBeNull();

    let all = read.text;
    let offset = Number(next![1]);
    for (let i = 0; i < 30; i++) {
      const page = await call("alpha", "browser_get_text", { selector: "article", maxChars: 3_000, offset });
      all += page.text;
      const more = /offset: (\d+)/.exec(page.text);
      if (!more) break;
      offset = Number(more[1]);
    }
    expect(all).toContain("END59.");
  });

  it("reads one element's text by ref", async () => {
    const snap = (await call("alpha", "browser_snapshot")).text;
    const story = ref(snap, /- article/);
    const read = await call("alpha", "browser_get_text", { ref: story, maxChars: 2_000 });
    expect(read.text).toContain("FIRST-PARAGRAPH-END");
    expect(read.text).not.toContain("[Home]");
  });

  it("does not attach the debugger to read", async () => {
    const tabId = await tabOf("alpha");
    await bmcp("sweepDebugger", 0);
    await waitFor(async () => !(await debuggerOn(tabId)));
    await call("alpha", "browser_navigate", { url: `${base}/article.html`, snapshot: true });
    await call("alpha", "browser_find", { text: "Paragraph 3" });
    await call("alpha", "browser_get_text", { maxChars: 1_000 });
    await call("alpha", "browser_get_console_logs");
    expect(await debuggerOn(tabId)).toBe(false);
    // Acting attaches it; idle, it goes again.
    const snap = (await call("alpha", "browser_snapshot")).text;
    await call("alpha", "browser_click", { element: "Home link", ref: ref(snap, /link "Home"/) });
    expect(await debuggerOn(tabId)).toBe(true);
    await bmcp("sweepDebugger", 0);
    await waitFor(async () => !(await debuggerOn(tabId)));
  });

  it("notices an alert that opened while nobody was acting", async () => {
    const started = Date.now();
    await call("alpha", "browser_navigate", { url: `${base}/dialog-timer.html`, snapshot: false });
    await new Promise((r) => setTimeout(r, 600));
    const read = await call("alpha", "browser_snapshot");
    expect(read.isError).toBe(true);
    expect(read.text).toContain('alert dialog is open: "Timer alert"');
    expect(Date.now() - started).toBeLessThan(5_000);
    // Answering it means reloading the page; the alert comes again after 300 ms.
    const handled = await call("alpha", "browser_handle_dialog", { accept: true });
    expect(handled.isError, handled.text).toBeFalsy();
    expect(handled.text).toContain("Reloaded the page to close the alert dialog");
  });

  it("reports console errors, uncaught exceptions and failed requests", async () => {
    await call("alpha", "browser_navigate", { url: `${base}/errors.html`, snapshot: false });
    const logs = await waitFor(async () => {
      const text = (await call("alpha", "browser_get_console_logs")).text;
      return text.includes("kaboom") && text.includes("404") && text;
    });
    expect(logs).toContain('[error] boom error {"code":7}');
    expect(logs).toContain("uncaught kaboom");
    expect(logs).toMatch(/\[network\] GET http:\/\/127\.0\.0\.1:\d+\/missing\.json → HTTP 404/);
  });
});

describe("acting like a person", () => {
  it("types into a React-style controlled input", async () => {
    await call("alpha", "browser_navigate", { url: `${base}/react.html`, snapshot: false });
    const snap = (await call("alpha", "browser_snapshot")).text;
    const typed = await call("alpha", "browser_type", { element: "Controlled", ref: ref(snap, /textbox "Controlled"/), text: "kept by state" });
    expect(typed.isError, typed.text).toBeFalsy();
    const page = await pageOfTab(/react\.html/);
    await new Promise((r) => setTimeout(r, 200));
    expect(await page.inputValue("#controlled")).toBe("kept by state");
    expect(await page.textContent("#state")).toBe("state: kept by state");
  });

  it("shows that it is working without getting into screenshots or the snapshot", async () => {
    await call("alpha", "browser_navigate", { url: `${base}/box.html`, snapshot: false });
    const snap = (await call("alpha", "browser_snapshot")).text;
    expect(snap).not.toMatch(/alpha · |okuyor|reading/);
    const page = await pageOfTab(/box\.html/);
    // The overlay: fixed, out of the way of clicks.
    const host = await page.evaluate(() => {
      const el = document.documentElement.lastElementChild as HTMLElement;
      const style = getComputedStyle(el);
      return { position: style.position, pointerEvents: style.pointerEvents, shadow: el.shadowRoot === null };
    });
    expect(host).toEqual({ position: "fixed", pointerEvents: "none", shadow: true });

    const shot = await call("alpha", "browser_screenshot");
    const pixel = await page.evaluate(async (data) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(image, 0, 0);
      return [...ctx.getImageData(1, 1, 1, 1).data];
    }, shot.content[0].data!);
    // The page is white at its corner; the glow would tint it blue.
    expect(pixel.slice(0, 3).every((v) => v > 245), String(pixel)).toBe(true);
  });

  it("takes a screenshot of one element", async () => {
    const snap = (await call("alpha", "browser_snapshot")).text;
    const shot = await call("alpha", "browser_screenshot", { element: "Red box", ref: ref(snap, /region "Red box"/) });
    expect(shot.isError, shot.text).toBeFalsy();
    const bytes = Buffer.from(shot.content[0].data!, "base64");
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([120, 80]);
  });
});

describe("files", () => {
  it("gets an image the page links to, inline and saved", async () => {
    const snap = (await call("alpha", "browser_snapshot")).text;
    const file = await call("alpha", "browser_get_file", { element: "The image", ref: ref(snap, /link "The image"/) });
    expect(file.isError, file.text).toBeFalsy();
    expect(file.content.find((c) => c.type === "image")?.mimeType).toBe("image/png");
    const saved = /to (\/\S+\.png)/.exec(file.text)![1];
    expect((await stat(saved)).size).toBeGreaterThan(50);
  });

  it("saves a PDF and tells where it is", async () => {
    const file = await call("alpha", "browser_get_file", { url: `${base}/file.pdf` });
    expect(file.isError, file.text).toBeFalsy();
    const saved = /to (\/\S+\.pdf)/.exec(file.text)![1];
    expect((await readFile(saved)).subarray(0, 5).toString()).toBe("%PDF-");
    expect(file.text).toContain("Open the PDF");
  });

  it("reports a download a click started, and lists downloads", async () => {
    const snap = (await call("alpha", "browser_snapshot")).text;
    const click = await call("alpha", "browser_click", { element: "report", ref: ref(snap, /link "Get the report"/) });
    expect(click.isError, click.text).toBeFalsy();
    expect(click.text).toContain("A download started");
    const list = await call("alpha", "browser_downloads", { wait: 5 });
    expect(list.text).toContain("/download.txt");
  });
});

describe("tabs, the AI group and handing a tab to the user", () => {
  let waitingTab = 0;

  it("keeps every agent's tabs in one AI group", async () => {
    await startAgent("beta");
    const a = await call("alpha", "browser_tab_new", { url: `${base}/page2.html` });
    const b = await call("beta", "browser_tab_new", { url: `${base}/form.html` });
    expect(a.isError || b.isError, a.text + b.text).toBeFalsy();
    const groups = await worker.evaluate(() => chrome.tabGroups.query({}));
    expect(groups.map((g: any) => [g.title, g.color])).toEqual([["AI", "blue"]]);
    const alphaTab = await tabOf("alpha");
    const betaTab = await tabOf("beta");
    const grouped = await worker.evaluate(
      async (ids) => Promise.all(ids.map(async (id: number) => (await chrome.tabs.get(id)).groupId)),
      [alphaTab, betaTab],
    );
    expect(grouped[0]).toBe(groups[0].id);
    expect(grouped[1]).toBe(groups[0].id);
  });

  it("lists whose each tab is, and refuses the user's own tabs", async () => {
    const userPage = await context.newPage();
    await userPage.goto(`${base}/page2.html?user`);
    const list = (await call("alpha", "browser_tab_list")).text;
    expect(list).toMatch(/page2\.html\?user \(the user's — hands off/);
    expect(list).toMatch(/agent "beta"'s — hands off/);
    expect(list).toMatch(/yours, you work in it/);
    const userId = Number(/\[(\d+)\][^\n]*page2\.html\?user/.exec(list)![1]);
    const taken = await call("alpha", "browser_tab_select", { tabId: userId });
    expect(taken.isError).toBe(true);
    expect(taken.text).toContain("is the user's own tab");
    const closed = await call("alpha", "browser_tab_close", { tabId: userId });
    expect(closed.isError).toBe(true);
    await userPage.close();
  });

  it("hands a tab to the user: out of the group, blinking, marked, kept after the agent ends", async () => {
    // Watch for the one call for attention.
    await worker.evaluate(() => {
      const original = chrome.windows.update;
      (globalThis as any).__attention = [];
      chrome.windows.update = (id: number, info: any) => {
        (globalThis as any).__attention.push(info);
        return original.call(chrome.windows, id, info);
      };
    });
    await call("beta", "browser_navigate", { url: `${base}/box.html?beta`, snapshot: false });
    waitingTab = await tabOf("beta");
    const page = await pageOfTab(/box\.html\?beta/);
    // Another tab is in front: the user is not looking at this one.
    const front = await context.newPage();
    await front.goto(`${base}/page2.html?front`);
    await front.bringToFront();
    await worker.evaluate((id) => chrome.tabs.update(id, { active: false }).catch(() => {}), waitingTab);

    const handed = await call("beta", "browser_tab_handoff", { note: "sign-in needed" });
    expect(handed.isError, handed.text).toBeFalsy();
    const tab = await worker.evaluate((id) => chrome.tabs.get(id), waitingTab);
    expect(tab.groupId).toBe(-1);

    // The title and icon alternate with the note.
    const titles = new Set<string>();
    for (let i = 0; i < 25; i++) {
      titles.add(await page.title());
      await new Promise((r) => setTimeout(r, 100));
    }
    // "🔑 Your turn: …" ("🔑 Sende: …" in a Turkish browser).
    expect([...titles].some((t) => /^🔑 (Your turn|Sende): sign-in needed$/.test(t)), [...titles].join(" | ")).toBe(true);
    expect([...titles]).toContain("Box");
    // The page retitles itself meanwhile: that title survives.
    await page.evaluate(() => (document.title = "Retitled by the page"));

    // The toolbar counts it; the list says whose it is.
    const status = await bmcp<{ handoffs: { note: string }[] }>("status");
    expect(status.handoffs.map((h) => h.note)).toEqual(["sign-in needed"]);
    expect((await call("alpha", "browser_tab_list")).text).toMatch(/handed to the user: "sign-in needed" — waiting for them/);
    const attention = await worker.evaluate(() => (globalThis as any).__attention);
    expect(attention.filter((a: any) => a.drawAttention === true).length).toBeLessThanOrEqual(1);

    // Switching to the tab does not stop it: the user may just be looking.
    await page.bringToFront();
    await worker.evaluate((id) => chrome.tabs.update(id, { active: true }), waitingTab);
    const looking = new Set<string>();
    for (let i = 0; i < 15; i++) {
      looking.add(await page.title());
      await new Promise((r) => setTimeout(r, 100));
    }
    expect([...looking].some((t) => t.startsWith("🔑 ")), [...looking].join(" | ")).toBe(true);
    expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe("1");

    // A click in the page ends it: blinking, note and badge together; the page's own title is back.
    await page.mouse.click(5, 300);
    await waitFor(async () => (await bmcp<{ handoffs: unknown[] }>("status")).handoffs.length === 0);
    await new Promise((r) => setTimeout(r, 1_200));
    const after = new Set<string>();
    for (let i = 0; i < 12; i++) {
      after.add(await page.title());
      await new Promise((r) => setTimeout(r, 100));
    }
    expect([...after]).toEqual(["Retitled by the page"]);
    const marked = await page.evaluate(() =>
      Array.from(document.querySelectorAll("link[rel=icon]")).some((l) => (l as HTMLLinkElement).href.startsWith("data:image/svg")),
    );
    expect(marked).toBe(false);
    expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe("");
    expect((await call("alpha", "browser_tab_list")).text).toMatch(new RegExp(`\\[${waitingTab}\\][^\\n]*the user's — hands off`));
    await front.close();

    // The agent ends: its own tab closes, the handed-over one stays.
    const betaOther = (await bmcp<{ tabs: { id: number; agent: string | null }[] }>("status")).tabs.filter((t) => t.agent === "beta").map((t) => t.id);
    await stopAgent("beta");
    await waitFor(async () => {
      const open = await tabIds();
      return betaOther.every((id) => !open.includes(id));
    });
    expect(await tabIds()).toContain(waitingTab);
  });

  it("starts blinking even when the user is looking at the tab", async () => {
    await call("alpha", "browser_tab_new", { url: `${base}/box.html?looking` });
    const tabId = await tabOf("alpha");
    const page = await pageOfTab(/box\.html\?looking/);
    await page.bringToFront();
    await worker.evaluate((id) => chrome.tabs.update(id, { active: true }), tabId);
    await call("alpha", "browser_tab_handoff", { note: "look here" });
    const titles = new Set<string>();
    for (let i = 0; i < 15; i++) {
      titles.add(await page.title());
      await new Promise((r) => setTimeout(r, 100));
    }
    expect([...titles].some((t) => t.startsWith("🔑 ")), [...titles].join(" | ")).toBe(true);
    // A key pressed in the page ends it too.
    await page.keyboard.press("Shift");
    await waitFor(async () => (await bmcp<{ handoffs: unknown[] }>("status")).handoffs.length === 0);
  });

  it("takes back a handed-over tab as its own again, even after the user looked at it", async () => {
    await call("alpha", "browser_tab_new", { url: `${base}/form.html?A` });
    const a = await tabOf("alpha");
    await call("alpha", "browser_tab_handoff", { note: "have a look" });
    // The user looks at it (no click).
    await worker.evaluate((id) => chrome.tabs.update(id, { active: true }), a);
    const back = await call("alpha", "browser_tab_select", { tabId: a });
    expect(back.isError, back.text).toBeFalsy();
    await call("alpha", "browser_navigate", { url: `${base}/form.html?A2`, snapshot: false });
    const snap = (await call("alpha", "browser_snapshot")).text;
    await call("alpha", "browser_type", { element: "Email", ref: ref(snap, /textbox "Email"/), text: "a@example.com" });
    // Another tab of its own: A stays its own, and in the AI group.
    await call("alpha", "browser_tab_new", { url: `${base}/page2.html?B` });
    const list = (await call("alpha", "browser_tab_list")).text;
    expect(list).toMatch(new RegExp(`\\[${a}\\][^\\n]*\\(yours[^\\n]*in the AI group`));
    const again = await call("alpha", "browser_tab_handoff", { tabId: a, note: "again" });
    expect(again.isError, again.text).toBeFalsy();
    await bmcp("handoffSeen", a);
  });

  describe("the user watching, and stepping in", () => {
    let tabId = 0;
    let page: import("playwright-core").Page;
    let snap = "";
    const counter = () => page.textContent("#counter");

    it("lets the user watch: switching to the tab, scrolling and moving the mouse change nothing", async () => {
      await call("alpha", "browser_tab_new", { url: `${base}/form.html?watch` });
      tabId = await tabOf("alpha");
      page = await pageOfTab(/form\.html\?watch/);
      snap = (await call("alpha", "browser_snapshot")).text;
      await page.bringToFront();
      await worker.evaluate((id) => chrome.tabs.update(id, { active: true }), tabId);
      await page.mouse.move(200, 200);
      await page.mouse.wheel(0, 400);
      await page.mouse.move(260, 240);
      await new Promise((r) => setTimeout(r, 400));
      const click = await call("alpha", "browser_click", { element: "Click me", ref: ref(snap, /button "Click me"/) });
      expect(click.isError, click.text).toBeFalsy();
      expect(await counter()).toBe("Clicked 1x");
      expect((await call("alpha", "browser_tab_list")).text).toMatch(new RegExp(`\\[${tabId}\\][^\\n]*yours, you work in it[^\\n]*in the AI group`));
    });

    it("does not count its own input or the page's synthetic events as the user", async () => {
      await call("alpha", "browser_type", { element: "Email", ref: ref(snap, /textbox "Email"/), text: "me@example.com" });
      await call("alpha", "browser_press_key", { key: "Tab" });
      await page.evaluate(() => {
        document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
      });
      await new Promise((r) => setTimeout(r, 700));
      const click = await call("alpha", "browser_click", { element: "Click me", ref: ref(snap, /button "Click me"/) });
      expect(click.isError, click.text).toBeFalsy();
      expect(await counter()).toBe("Clicked 2x");
    });

    it("pauses when the user clicks in its tab, and resumes with browser_tab_select", async () => {
      await new Promise((r) => setTimeout(r, 700));
      await page.mouse.click(5, 5);
      const blocked = await waitFor(async () => {
        const result = await call("alpha", "browser_click", { element: "Click me", ref: ref(snap, /button "Click me"/) });
        return result.isError && result;
      });
      expect(blocked.text).toContain("The user stepped in on this tab (they clicked in it)");
      expect(blocked.text).toContain(`browser_tab_select (tabId ${tabId})`);
      expect(await counter()).toBe("Clicked 2x");
      expect((await call("alpha", "browser_tab_list")).text).toMatch(/the user stepped in: ask them/);
      const agents = (await bmcp<{ agents: { name: string; pausedByUser: boolean }[] }>("status")).agents;
      expect(agents.find((a) => a.name === "alpha")?.pausedByUser).toBe(true);
      // Still the agent's, still in the group.
      const tab = await worker.evaluate((id) => chrome.tabs.get(id), tabId);
      expect(tab.groupId).not.toBe(-1);

      const resumed = await call("alpha", "browser_tab_select", { tabId });
      expect(resumed.isError, resumed.text).toBeFalsy();
      const click = await call("alpha", "browser_click", { element: "Click me", ref: ref(snap, /button "Click me"/) });
      expect(click.isError, click.text).toBeFalsy();
      expect(await counter()).toBe("Clicked 3x");
    });

    it("pauses when the user types in its tab", async () => {
      await new Promise((r) => setTimeout(r, 700));
      await page.keyboard.press("x");
      const blocked = await waitFor(async () => {
        const result = await call("alpha", "browser_snapshot");
        return result.isError && result;
      });
      expect(blocked.text).toContain("(they typed in it)");
      expect((await call("alpha", "browser_tab_select", { tabId })).isError).toBeFalsy();
      expect((await call("alpha", "browser_snapshot")).isError).toBeFalsy();
    });
  });

  it("refuses to type a password and says to hand the tab over", async () => {
    await call("alpha", "browser_navigate", { url: `${base}/form.html`, snapshot: false });
    const snap = (await call("alpha", "browser_snapshot")).text;
    const typed = await call("alpha", "browser_type", { element: "Password", ref: ref(snap, /textbox "Password"/), text: "hunter2" });
    expect(typed.isError).toBe(true);
    expect(typed.text).toContain("browser_tab_handoff");
    const filled = await call("alpha", "browser_fill_form", {
      fields: [{ name: "Password", type: "textbox", ref: ref(snap, /textbox "Password"/), value: "hunter2" }],
    });
    expect(filled.isError).toBe(true);
    const page = await pageOfTab(/form\.html/);
    expect(await page.inputValue("#password")).toBe("");
  });
});

describe("the AI group at the right, and taking the user's tab", () => {
  /** Ids of a window's tabs in strip order, and the AI group's id. */
  const strip = (windowId: number) =>
    worker.evaluate(async (id) => {
      const tabs = await chrome.tabs.query({ windowId: id });
      const [group] = await chrome.tabGroups.query({ title: "AI" });
      return { tabs: tabs.map((t: any) => ({ id: t.id, grouped: !!group && t.groupId === group.id })), groupId: group?.id ?? null };
    }, windowId) as Promise<{ tabs: { id: number; grouped: boolean }[]; groupId: number | null }>;
  const groupIsRightmost = (tabs: { grouped: boolean }[]) => {
    const firstGrouped = tabs.findIndex((t) => t.grouped);
    return firstGrouped >= 0 && tabs.slice(firstGrouped).every((t) => t.grouped);
  };

  it("keeps the AI group at the right end, the user's tabs in their order", async () => {
    await call("alpha", "browser_tab_new", { url: `${base}/page2.html?right` });
    const agentTab = await tabOf("alpha");
    const windowId = (await worker.evaluate((id) => chrome.tabs.get(id), agentTab)).windowId;
    expect(groupIsRightmost((await strip(windowId)).tabs)).toBe(true);
    const userOrder = (await strip(windowId)).tabs.filter((t) => !t.grouped).map((t) => t.id);

    // The user opens a tab at the end, right of the group.
    const userTab = await worker.evaluate(async ({ windowId, url }) => (await chrome.tabs.create({ windowId, url, active: false })).id, {
      windowId,
      url: `${base}/page2.html?user-right`,
    });
    let now = await strip(windowId);
    expect(now.tabs.at(-1)!.id).toBe(userTab);
    // Calmly, the group goes back to the right; the user's tabs keep their order.
    now = await waitFor(async () => {
      const s = await strip(windowId);
      return groupIsRightmost(s.tabs) && s;
    }, 6_000);
    expect(now.tabs.filter((t) => !t.grouped).map((t) => t.id)).toEqual([...userOrder, userTab]);

    // A new agent tab opens at the group's end.
    await call("alpha", "browser_tab_new", { url: `${base}/page2.html?right2` });
    const newest = await tabOf("alpha");
    now = await strip(windowId);
    expect(now.tabs.at(-1)!.id).toBe(newest);
    await worker.evaluate((id) => chrome.tabs.remove(id), userTab);
  });

  let takenTab = 0;
  let homeWindow = 0;
  let homeIndex = 0;

  it("takes the user's tab as it is: no reload, fields and scroll kept, moved into the group", async () => {
    // The user's tab, in a window of its own, with typed text and a scroll position.
    const created = await worker.evaluate(async (url) => {
      const window = await chrome.windows.create({ url, focused: false });
      await chrome.tabs.create({ windowId: window.id, url: "about:blank", active: false });
      return { tabId: window.tabs[0].id, windowId: window.id };
    }, `${base}/article.html?user-tab`);
    takenTab = created.tabId;
    homeWindow = created.windowId;
    const page = await pageOfTab(/article\.html\?user-tab/);
    await page.waitForLoadState();
    await page.evaluate(() => {
      const input = document.createElement("input");
      input.id = "draft";
      document.querySelector("h1")!.after(input);
      input.value = "half-written reply";
      window.scrollTo(0, 900);
      (window as any).__sameDocument = "yes";
    });
    homeIndex = (await worker.evaluate((id) => chrome.tabs.get(id), takenTab)).index;
    await worker.evaluate(() => {
      (globalThis as any).__notes = [];
      const original = chrome.notifications.create;
      chrome.notifications.create = (id: string, options: any) => {
        (globalThis as any).__notes.push({ id, ...options });
        return original.call(chrome.notifications, id, options);
      };
    });

    const listed = (await call("alpha", "browser_tab_list", {})).text;
    expect(listed).toMatch(new RegExp(`\\[${takenTab}\\][^\\n]*the user's — hands off`));
    const taken = await call("alpha", "browser_tab_take", { tabId: takenTab, note: "finishing the reply" });
    expect(taken.isError, taken.text).toBeFalsy();
    expect(taken.text).toContain("- Page Title: Long article");

    // The same document: nothing reloaded, the field and the scroll are as the user left them.
    expect(await page.evaluate(() => (window as any).__sameDocument)).toBe("yes");
    expect(await page.inputValue("#draft")).toBe("half-written reply");
    expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(900);
    // Moved into the AI group's window, in the group, at the right.
    const tab = await worker.evaluate((id) => chrome.tabs.get(id), takenTab);
    expect(tab.windowId).not.toBe(homeWindow);
    expect((await strip(tab.windowId)).tabs.find((t) => t.id === takenTab)?.grouped).toBe(true);
    expect(groupIsRightmost((await strip(tab.windowId)).tabs)).toBe(true);
    // The user is told once, with a way to give it back.
    const notes = await worker.evaluate(() => (globalThis as any).__notes);
    expect(notes).toHaveLength(1);
    expect(notes[0].message).toMatch(/^(AI took the tab 'Long article': finishing the reply|AI 'Long article' sekmesini aldı: finishing the reply)$/);
    expect(notes[0].buttons[0].title).toMatch(/^(Give back|Geri ver)$/);
    // It shows as lent; the agent can act in it.
    expect((await call("alpha", "browser_tab_list")).text).toMatch(/the user's, lent to you: "finishing the reply", you work in it/);
    const snap = (await call("alpha", "browser_snapshot")).text;
    const typed = await call("alpha", "browser_type", { element: "draft", ref: ref(snap, /textbox/), text: "finished reply" });
    expect(typed.isError, typed.text).toBeFalsy();
    expect(await page.inputValue("#draft")).toBe("finished reply");
  });

  it("does not close a taken tab, and gives it back to its place", async () => {
    const closed = await call("alpha", "browser_tab_close", { tabId: takenTab });
    expect(closed.isError).toBe(true);
    expect(closed.text).toContain("browser_tab_release");
    const released = await call("alpha", "browser_tab_release", {});
    expect(released.isError, released.text).toBeFalsy();
    const tab = await worker.evaluate((id) => chrome.tabs.get(id), takenTab);
    expect([tab.windowId, tab.index, tab.groupId]).toEqual([homeWindow, homeIndex, -1]);
    const page = await pageOfTab(/article\.html\?user-tab/);
    expect(await page.evaluate(() => (window as any).__sameDocument)).toBe("yes");
    expect((await call("alpha", "browser_tab_list")).text).toMatch(new RegExp(`\\[${takenTab}\\][^\\n]*the user's — hands off`));
  });

  it("gives a taken tab back when the agent ends, and tells it when the user took one back", async () => {
    await startAgent("tau");
    expect((await call("tau", "browser_tab_take", { tabId: takenTab, note: "checking" })).isError).toBeFalsy();
    // The user presses Give back (popup or notification).
    await bmcp("giveBack", takenTab, { byUser: true });
    const next = await call("tau", "browser_snapshot");
    expect(next.isError).toBe(true);
    expect(next.text).toContain(`The user took tab ${takenTab} back`);

    expect((await call("tau", "browser_tab_take", { tabId: takenTab, note: "checking again" })).isError).toBeFalsy();
    await stopAgent("tau");
    await waitFor(async () => (await worker.evaluate((id) => chrome.tabs.get(id), takenTab)).windowId === homeWindow);
    const tab = await worker.evaluate((id) => chrome.tabs.get(id), takenTab);
    expect([tab.windowId, tab.groupId]).toEqual([homeWindow, -1]);
    await worker.evaluate((id) => chrome.windows.remove(id), homeWindow);
  });

  it("will not take another agent's tab", async () => {
    await startAgent("omega");
    await call("omega", "browser_tab_new", { url: `${base}/page2.html?omega` });
    const omegaTab = await tabOf("omega");
    const taken = await call("alpha", "browser_tab_take", { tabId: omegaTab, note: "mine now" });
    expect(taken.isError).toBe(true);
    expect(taken.text).toContain("being used by another agent (omega)");
    await stopAgent("omega");
  });
});

describe("staying connected", () => {
  it("reconnects after the extension is reloaded and still closes the agent's tabs", async () => {
    await startAgent("rho");
    await call("rho", "browser_tab_new", { url: `${base}/page2.html?rho` });
    const rhoTab = await tabOf("rho");
    // Reloading loses session storage and memory; the agent tabs are kept in local storage.
    await bmcp("simulateReload");
    const read = await waitFor(async () => {
      const result = await call("rho", "browser_snapshot");
      return !result.isError && result;
    }, 20_000);
    expect(read.text).toContain("page2.html?rho");
    await stopAgent("rho");
    await waitFor(async () => !(await tabIds()).includes(rhoTab), 15_000);
  });
});
