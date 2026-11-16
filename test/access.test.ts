import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PLUS_ORIGIN } from "../src/config";
import { PLUS_MESSAGES, type ActionReport, type TabInfo } from "../src/protocol";
import { createServer } from "../src/server";
import { pageOf } from "../src/snapshot";
import { fileNameFor, formatDownload } from "../src/tools/files";
import { formatTabs } from "../src/tools/plus";
import { FakeExtension, fakePage, freePort, waitUntil } from "./helpers";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

let filesDir = "";
beforeEach(async () => {
  filesDir = await mkdtemp(path.join(os.tmpdir(), "bmcp-unit-files-"));
  process.env.BROWSERMCP_FILES_DIR = filesDir;
  cleanups.push(() => rm(filesDir, { recursive: true, force: true }));
});

async function setup(extra: Record<string, (payload: any) => unknown> = {}) {
  const port = await freePort();
  const server = await createServer({ version: "test", port, connectWaitMs: 200 });
  cleanups.push(() => server.close());
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.mcp.connect(b)]);
  cleanups.push(() => client.close());
  const { page, handlers } = fakePage();
  const extension = new FakeExtension({ ...handlers, ...extra }, [...PLUS_MESSAGES]);
  await extension.connect(port, PLUS_ORIGIN);
  cleanups.push(() => extension.close());
  await waitUntil(() => server.bridge.isConnected);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: { type: string; text?: string; data?: string; mimeType?: string }[];
      isError?: boolean;
    };
    return { ...result, text: result.content.map((c) => c.text ?? "").join("\n") };
  };
  return { call, extension, page, server, port };
}

const tab = (over: Partial<TabInfo>): TabInfo => ({
  id: 1,
  windowId: 1,
  title: "Tab",
  url: "https://example.com/",
  active: false,
  connected: false,
  ...over,
});

describe("paging long output", () => {
  const body = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");

  it("cuts at a line and says where to continue", () => {
    const first = pageOf(body, 40);
    expect(first).toMatch(/^line 0\nline 1\n/);
    const next = Number(/offset: (\d+)/.exec(first)![1]);
    expect(body.slice(next)).toMatch(/^line \d+\n/);
    expect(pageOf(body, 40, next)).toMatch(new RegExp(`^${body.slice(next).split("\n")[0]}`));
  });

  it("moves an offset in the middle of a line to the next line, and ends cleanly", () => {
    expect(pageOf(body, 10_000, 3)).toMatch(/^line 1\n/);
    expect(pageOf(body, 10_000, body.length + 5)).toBe("# (end of the content)");
    expect(pageOf("short", 0)).toBe("short");
  });
});

describe("file names", () => {
  it("uses Content-Disposition, then the URL, then the type", () => {
    expect(fileNameFor({ url: "https://x/a", mimeType: "application/pdf", disposition: 'attachment; filename="Invoice 7.pdf"' })).toBe("Invoice 7.pdf");
    expect(fileNameFor({ url: "https://x/a", mimeType: "text/plain", disposition: "attachment; filename*=UTF-8''%C3%B6zet.txt" })).toBe("özet.txt");
    expect(fileNameFor({ url: "https://x/files/photo.jpeg?size=2", mimeType: "image/jpeg" })).toBe("photo.jpeg");
    expect(fileNameFor({ url: "https://x/download", mimeType: "application/pdf; charset=binary" })).toBe("download.pdf");
    expect(fileNameFor({ url: "blob:https://x/123", mimeType: "image/png" })).toBe("file.png");
    expect(fileNameFor({ url: "https://x/a", mimeType: "", disposition: 'filename="../../etc/passwd"' })).toBe("_.._etc_passwd");
  });

  it("describes downloads", () => {
    const base = { id: 1, url: "https://x/r.csv", path: "/Users/u/Downloads/r.csv", mimeType: "text/csv", startTime: "" };
    expect(formatDownload({ ...base, state: "complete", bytes: 2048, totalBytes: 2048 })).toBe(
      "- [complete] /Users/u/Downloads/r.csv — 2 kB, from https://x/r.csv",
    );
    expect(formatDownload({ ...base, state: "in_progress", bytes: 500, totalBytes: 1000 })).toContain("[in_progress 50%]");
    expect(formatDownload({ ...base, state: "interrupted", bytes: 0, totalBytes: 0, error: "NETWORK_FAILED" })).toContain(
      "(error: NETWORK_FAILED)",
    );
  });
});

describe("tab lists", () => {
  it("say whose each tab is, window by window", () => {
    const text = formatTabs([
      tab({ id: 1, windowId: 7, title: "Mine", owner: "you", connected: true, grouped: true }),
      tab({ id: 2, windowId: 7, title: "Beta's", owner: "agent", agent: "beta" }),
      tab({ id: 3, windowId: 9, title: "Mail", owner: "user", active: true, focusedWindow: true }),
      tab({ id: 4, windowId: 9, title: "Shared", owner: "user-connected", focusedWindow: true }),
      tab({ id: 5, windowId: 9, title: "Sign in", owner: "handed-off", note: "sign-in needed", focusedWindow: true }),
      tab({ id: 6, windowId: 7, title: "Order", owner: "taken", note: "finishing the order", connected: true, userSteppedIn: true }),
    ]);
    expect(text.split("\n")[0]).toBe("Window 1 (the user's current window) [9]:");
    expect(text).toContain("- [3] Mail — https://example.com/ (the user's — hands off, active)");
    expect(text).toContain("- [4] Shared — https://example.com/ (the user's, connected for agents — you may use it)");
    expect(text).toContain('- [5] Sign in — https://example.com/ (handed to the user: "sign-in needed" — waiting for them)');
    expect(text).toContain("Window 2 [7]:");
    expect(text).toContain("- [1] Mine — https://example.com/ (yours, you work in it, in the AI group)");
    expect(text).toContain("- [2] Beta's — https://example.com/ (agent \"beta\"'s — hands off)");
    expect(text).toContain(
      '- [6] Order — https://example.com/ (the user\'s, lent to you: "finishing the order", you work in it — give it back with browser_tab_release, the user stepped in: ask them, then browser_tab_select to resume)',
    );
  });
});

describe("action reports", () => {
  it("show what changed, a tab the page opened and downloads", async () => {
    let report: ActionReport = { url: "https://example.com/", title: "Example", navigated: false, changes: ["+ dialog \"Confirm\" [ref=e9]", "~ button \"Save\" [disabled] [ref=e3]"], moreChanges: 3 };
    const { call } = await setup({ browser_click: () => report });
    let result = await call("browser_click", { element: "Save", ref: "e3" });
    expect(result.text).toContain("- Changes on the page since your last snapshot (+ added, ~ changed, - removed):\n  + dialog \"Confirm\" [ref=e9]\n  ~ button \"Save\" [disabled] [ref=e3]\n  … and 3 more");

    report = { url: "https://example.com/", title: "Example", navigated: false, changes: [] };
    result = await call("browser_click", { element: "Save", ref: "e3" });
    expect(result.text).toContain("- Nothing changed on the page.");

    report = {
      url: "https://example.com/",
      title: "Example",
      navigated: false,
      switchedTo: tab({ id: 44, title: "Help", url: "https://example.com/help" }),
      downloads: [{ id: 1, url: "https://example.com/r.pdf", filename: "/Downloads/r.pdf" }],
    };
    result = await call("browser_click", { element: "Help", ref: "e4" });
    expect(result.text).toContain("you now work in it: [44] Help — https://example.com/help");
    expect(result.text).toContain("- A download started: /Downloads/r.pdf");
  });
});

describe("reading and files", () => {
  it("pages through long text", async () => {
    const long = Array.from({ length: 400 }, (_, i) => `Sentence number ${i} of a long email.`).join("\n");
    const { call, extension } = await setup({
      browser_get_text: () => ({ text: long, url: "https://mail.example/", title: "Inbox" }),
    });
    const first = await call("browser_get_text", { ref: "e7", maxChars: 2_000 });
    expect(first.text).toContain(`- Text of e7 (${long.length} characters):`);
    expect(first.text).toContain("Sentence number 0 of a long email.");
    const next = /offset: (\d+) and ref: "e7"/.exec(first.text);
    expect(next, first.text).not.toBeNull();
    const second = await call("browser_get_text", { ref: "e7", maxChars: 2_000, offset: Number(next![1]) });
    expect(second.text).not.toContain("Sentence number 0 of");
    expect(extension.received.filter((m) => m.type === "browser_get_text").at(-1)?.payload).toEqual({ ref: "e7" });
  });

  it("saves fetched files, shows images and inlines text", async () => {
    const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const { call } = await setup({
      browser_get_file: ({ url }: { url?: string }) =>
        url?.endsWith(".csv")
          ? { url, base64: Buffer.from("a,b\n1,2\n").toString("base64"), mimeType: "text/csv", size: 8 }
          : { url: "https://example.com/pic.png", base64: pngBase64, mimeType: "image/png", size: 70 },
    });
    const image = await call("browser_get_file", { ref: "e5" });
    expect(image.content.find((c) => c.type === "image")).toMatchObject({ mimeType: "image/png", data: pngBase64 });
    const saved = /to (\S+pic\.png)/.exec(image.text)![1];
    expect(saved.startsWith(filesDir)).toBe(true);
    expect((await readFile(saved)).subarray(1, 4).toString()).toBe("PNG");

    const csv = await call("browser_get_file", { url: "https://example.com/data.csv" });
    expect(csv.text).toContain("a,b\n1,2");
    expect(csv.content.some((c) => c.type === "image")).toBe(false);
  });

  it("waits for running downloads when asked", async () => {
    let polls = 0;
    const item = { id: 3, url: "https://x/big.zip", path: "/d/big.zip", mimeType: "application/zip", startTime: "", totalBytes: 100 };
    const { call } = await setup({
      browser_downloads: () => [{ ...item, state: ++polls < 3 ? "in_progress" : "complete", bytes: polls < 3 ? 50 : 100 }],
    });
    const result = await call("browser_downloads", { wait: 5 });
    expect(polls).toBe(3);
    expect(result.text).toBe("- [complete] /d/big.zip — 100 bytes, from https://x/big.zip");
  });

  it("hands a tab to the user", async () => {
    const { call, extension } = await setup({
      browser_tab_handoff: ({ tabId, note }: { tabId?: number; note: string }) => tab({ id: tabId ?? 8, title: "Sign in", owner: "handed-off", note }),
    });
    const result = await call("browser_tab_handoff", { note: "sign-in needed" });
    expect(result.text).toContain('Handed tab 8 (Sign in) to the user: "sign-in needed"');
    expect(extension.received.at(-1)).toEqual({ type: "browser_tab_handoff", payload: { note: "sign-in needed" } });
    expect((await call("browser_tab_handoff", { note: "x".repeat(121) })).isError).toBe(true);
  });

  it("lists the tabs of every connected profile", async () => {
    const { call, port } = await setup({
      browser_tab_list: () => [tab({ id: 1, title: "First profile tab", owner: "you", connected: true })],
    });
    const second = new FakeExtension(
      { browser_tab_list: () => [tab({ id: 2, title: "Second profile tab", owner: "user" })] },
      [...PLUS_MESSAGES],
      { installId: "second" },
    );
    await second.connect(port, PLUS_ORIGIN);
    cleanups.push(() => second.close());
    const result = await call("browser_tab_list", { allProfiles: true });
    expect(result.text).toContain("First profile tab");
    expect(result.text).toContain("Second profile tab");
    expect(result.text.match(/^## Chrome profile/gm)).toHaveLength(2);
  });
});
