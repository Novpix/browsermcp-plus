// End-to-end test: real Chromium + the Browser MCP Plus extension + the built server.
// Run with `npm run test:e2e` (requires `npm run build` and a Playwright Chromium).

/// <reference lib="dom" />
declare const chrome: any;

import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium, type BrowserContext, type Page, type Worker } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PLUS_EXTENSION_ID } from "../../src/config";
import { freePort } from "../helpers";

const root = path.resolve(fileURLToPath(import.meta.url), "../../..");
const fixtures = path.join(root, "test/e2e/fixtures");

let site: http.Server;
let siteUrl: string;
let context: BrowserContext;
let worker: Worker;
let page: Page;
let client: Client;

type CallResult = { text: string; isError?: boolean; content: { type: string; data?: string }[] };

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text?: string; data?: string }[];
    isError?: boolean;
  };
  return { ...result, text: result.content.map((c) => c.text ?? "").join("\n") };
}

/** Finds the ref of the first snapshot line matching `pattern`. */
function ref(snapshot: string, pattern: RegExp): string {
  const line = snapshot.split("\n").find((l) => pattern.test(l));
  const match = line && /\[ref=([^\]]+)\]/.exec(line);
  if (!match) throw new Error(`No element matching ${pattern} in snapshot:\n${snapshot}`);
  return match[1];
}

async function snapshot() {
  const result = await call("browser_snapshot");
  expect(result.isError, result.text).toBeFalsy();
  return result.text;
}

const domText = (selector: string) => page.locator(selector).textContent();

beforeAll(async () => {
  site = http.createServer(async (req, res) => {
    try {
      const file = path.join(fixtures, path.basename(new URL(req.url!, "http://x").pathname));
      const body = await readFile(file);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}`;

  const port = await freePort();
  client = new Client({ name: "e2e", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, "dist/index.js"), "--port", String(port), "--no-takeover"],
      stderr: process.env.DEBUG ? "inherit" : "ignore",
    }),
  );

  const extensionPath = path.join(root, "extension");
  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${siteUrl}/form.html`);

  await worker.evaluate(async ({ port }) => {
    const [tab] = await chrome.tabs.query({ active: true });
    const api = (globalThis as unknown as { bmcp: any }).bmcp;
    await api.setPort(port);
    await api.connectTab(tab.id);
  }, { port });

  // Wait until the extension has reached the server.
  const deadline = Date.now() + 10_000;
  for (;;) {
    const result = await call("browser_snapshot");
    if (!result.isError) break;
    if (Date.now() > deadline) throw new Error(`Extension never connected: ${result.text}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}, 60_000);

afterAll(async () => {
  await client?.close();
  await context?.close();
  await new Promise((resolve) => site?.close(resolve));
});

describe("Browser MCP Plus extension end to end", () => {
  it("loads with the pinned extension id", () => {
    expect(new URL(worker.url()).host).toBe(PLUS_EXTENSION_ID);
  });

  it("produces an accessibility snapshot with refs", async () => {
    const text = await snapshot();
    expect(text).toContain("- Page Title: Fixture form");
    expect(text).toMatch(/- heading "Fixture form" \[level=1\] \[ref=e\d+\]/);
    expect(text).toMatch(/- textbox "Email" \[ref=[^\]]+\]: old@example.com/);
    expect(text).toMatch(/- combobox "Country" \[ref=[^\]]+\]: United States/);
    expect(text).toMatch(/- checkbox "Accept terms"/);
    expect(text).toMatch(/- button "Document" \[file-input multiple\]/);
    expect(text).toMatch(/- link "Second page" \[ref=[^\]]+\]:\n\s+- \/url: http/);
    expect(text).toMatch(/- iframe "Inner frame"/);
    expect(text).toMatch(/- button "Frame button"/);
    expect(text).not.toContain("hidden-file");
  });

  it("keeps refs stable across snapshots", async () => {
    const first = ref(await snapshot(), /button "Click me"/);
    const second = ref(await snapshot(), /button "Click me"/);
    expect(second).toBe(first);
  });

  it("types, replacing existing content, and submits", async () => {
    const snap = await snapshot();
    await call("browser_type", { element: "Email", ref: ref(snap, /textbox "Email"/), text: "new@example.com" });
    expect(await page.inputValue("#email")).toBe("new@example.com");
    await call("browser_type", { element: "Bio", ref: ref(snap, /textbox "Bio"/), text: "Hello", submit: false });
    expect(await page.inputValue("#bio")).toBe("Hello");
    const password = await call("browser_type", {
      element: "Password",
      ref: ref(snap, /textbox "Password"/),
      text: "s3cret",
      submit: true,
      snapshot: true,
    });
    expect(await page.inputValue("#password")).toBe("s3cret");
    expect(await domText("#status")).toBe("Submitted new@example.com");
    expect(password.text).not.toContain("s3cret: ");
    expect(password.text).toMatch(/textbox "Password" \[ref=[^\]]+\]: •+/);
  });

  it("types into contenteditable", async () => {
    const snap = await snapshot();
    await call("browser_type", { element: "Editor", ref: ref(snap, /textbox "Editor"/), text: "Fresh" });
    expect(await domText("#editor")).toBe("Fresh");
  });

  it("clicks with trusted events, including inside a same-origin iframe", async () => {
    let snap = await snapshot();
    const result = await call("browser_click", { element: "Click me", ref: ref(snap, /button "Click me"/), snapshot: true });
    expect(result.text).toContain('button "Clicked 1x"');
    snap = await snapshot();
    await call("browser_click", { element: "Frame button", ref: ref(snap, /button "Frame button"/) });
    expect(await page.frameLocator("iframe").locator("button").textContent()).toBe("Frame clicked");
    snap = await snapshot();
    await call("browser_click", { element: "Accept terms", ref: ref(snap, /checkbox "Accept terms"/) });
    expect(await page.isChecked("#terms")).toBe(true);
  });

  it("hovers", async () => {
    const snap = await snapshot();
    await call("browser_hover", { element: "Hover target", ref: ref(snap, /note "Hover target"/) });
    expect(await domText("#hover")).toBe("Hovered!");
  });

  it("selects options by label or value", async () => {
    let snap = await snapshot();
    await call("browser_select_option", { element: "Country", ref: ref(snap, /combobox "Country"/), values: ["Türkiye"] });
    expect(await page.inputValue("#country")).toBe("tr");
    snap = await snapshot();
    await call("browser_select_option", { element: "Country", ref: ref(snap, /combobox "Country"/), values: ["us"] });
    expect(await page.inputValue("#country")).toBe("us");
  });

  it("uploads files into a file input", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bmcp-e2e-"));
    const a = path.join(dir, "report.pdf");
    const b = path.join(dir, "photo.png");
    await writeFile(a, "12345");
    await writeFile(b, "1234567");
    const snap = await snapshot();
    const result = await call("browser_file_upload", {
      element: "Document",
      ref: ref(snap, /button "Document" \[file-input/),
      paths: [a, b],
      snapshot: true,
    });
    expect(result.isError, result.text).toBeFalsy();
    expect(await domText("#files")).toBe("report.pdf:5,photo.png:7");
    expect(result.text).toMatch(/button "Document" \[file-input multiple\] \[ref=[^\]]+\]: report.pdf, photo.png/);
  });

  it("uploads through a button that opens the file chooser", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bmcp-e2e-"));
    const file = path.join(dir, "me.jpg");
    await writeFile(file, "x");
    const snap = await snapshot();
    const result = await call("browser_file_upload", {
      element: "Choose avatar",
      ref: ref(snap, /button "Choose avatar"/),
      paths: [file],
    });
    expect(result.isError, result.text).toBeFalsy();
    expect(await domText("#files")).toBe("avatar=me.jpg");
  });

  it("drags with HTML5 drag and drop", async () => {
    const snap = await snapshot();
    const result = await call("browser_drag", {
      startElement: "Card",
      startRef: ref(snap, /group "Card"/),
      endElement: "Drop zone",
      endRef: ref(snap, /region "Drop zone"/),
    });
    expect(result.isError, result.text).toBeFalsy();
    expect(await domText("#dropzone")).toBe("Dropped card");
  });

  it("evaluates JavaScript in the page's main world", async () => {
    const plain = await call("browser_evaluate", { function: "() => ({ answer: window.answer, title: document.title })" });
    expect(JSON.parse(plain.text)).toEqual({ answer: 42, title: "Fixture form" });
    const snap = await snapshot();
    const withElement = await call("browser_evaluate", {
      function: "(el) => el.value + '|' + typeof window.clicks",
      element: "Email",
      ref: ref(snap, /textbox "Email"/),
    });
    expect(withElement.text).toBe("new@example.com|number");
    const failing = await call("browser_evaluate", { function: "() => { throw new Error('boom') }" });
    expect(failing.isError).toBe(true);
    expect(failing.text).toContain("boom");
    const asyncValue = await call("browser_evaluate", { function: "async () => 7 * 6" });
    expect(asyncValue.text).toBe("42");
  });

  it("presses keys", async () => {
    const snap = await snapshot();
    await call("browser_click", { element: "Bio", ref: ref(snap, /textbox "Bio"/) });
    await call("browser_press_key", { key: "End" });
    await call("browser_press_key", { key: "!" });
    expect(await page.inputValue("#bio")).toBe("Hello!");
    await call("browser_press_key", { key: "Backspace" });
    expect(await page.inputValue("#bio")).toBe("Hello");
  });

  it("scrolls by pixels and to an element", async () => {
    await call("browser_evaluate", { function: "() => window.scrollTo(0, 0)" });
    await call("browser_scroll", { deltaY: 800 });
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(300);
    const snap = await snapshot();
    const result = await call("browser_scroll", { element: "Bottom", ref: ref(snap, /Bottom of the page/) });
    expect(result.isError, result.text).toBeFalsy();
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(2_000);
  });

  it("captures console logs and screenshots", async () => {
    const logs = await call("browser_get_console_logs");
    expect(logs.text).toContain('"message":"counter clicked 1"');
    expect(logs.text).toContain('"type":"warning"');
    const shot = await call("browser_screenshot");
    expect(shot.content[0].type).toBe("image");
    expect(Buffer.from(shot.content[0].data!, "base64").subarray(1, 4).toString()).toBe("PNG");
  });

  it("navigates, waits for content, and goes back and forward", async () => {
    let snap = await snapshot();
    const clicked = await call("browser_click", { element: "Second page", ref: ref(snap, /link "Second page"/) });
    expect(clicked.text).toContain("- Page Title: Second page");
    const waited = await call("browser_wait_for", { text: "Async content ready", timeout: 5 });
    expect(waited.isError, waited.text).toBeFalsy();
    const back = await call("browser_go_back");
    expect(back.text).toContain("- Page Title: Fixture form");
    const forward = await call("browser_go_forward");
    expect(forward.text).toContain("- Page Title: Second page");
    const nav = await call("browser_navigate", { url: `${siteUrl}/form.html` });
    expect(nav.text).toContain("- Page Title: Fixture form");
    const reload = await call("browser_reload");
    expect(reload.isError).toBeFalsy();
    snap = await snapshot();
    expect(snap).toContain('button "Click me"');
  });

  it("rejects unknown refs with guidance", async () => {
    const result = await call("browser_click", { element: "Old", ref: "e999999" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/not found in the current page snapshot|no longer on the page/);
  });

  it("manages tabs", async () => {
    const opened = await call("browser_tab_new", { url: `${siteUrl}/page2.html` });
    expect(opened.isError, opened.text).toBeFalsy();
    expect(opened.text).toContain("- Page Title: Second page");
    const list = await call("browser_tab_list");
    const lines = list.text.split("\n");
    expect(lines).toHaveLength(2);
    const connected = lines.find((l) => l.includes("(connected"))!;
    expect(connected).toContain("Second page");
    const firstId = Number(/\[(\d+)\]/.exec(lines.find((l) => !l.includes("connected"))!)![1]);

    const selected = await call("browser_tab_select", { tabId: firstId });
    expect(selected.text).toContain("- Page Title: Fixture form");

    const secondId = Number(/\[(\d+)\]/.exec(connected)![1]);
    const closedOther = await call("browser_tab_close", { tabId: secondId });
    expect(closedOther.text).toBe(`Closed tab ${secondId}`);
    expect((await call("browser_tab_list")).text.split("\n")).toHaveLength(1);
  });

  it("keeps the working tab when a restricted page can't be controlled", async () => {
    const before = (await call("browser_tab_list")).text;
    const workingId = Number(/\[(\d+)\][^\n]*\(connected/.exec(before)![1]);
    const blocked = await call("browser_tab_new", { url: "chrome://version" });
    expect(blocked.isError).toBe(true);
    const list = (await call("browser_tab_list")).text;
    expect(/\[(\d+)\][^\n]*\(connected/.exec(list)![1]).toBe(String(workingId));
    const restrictedId = Number(/\[(\d+)\][^\n]*chrome:\/\/version/.exec(list)![1]);
    // Tab commands still work and the snapshot still comes from the working tab.
    expect((await call("browser_tab_select", { tabId: workingId })).isError).toBeFalsy();
    expect((await call("browser_tab_close", { tabId: restrictedId })).text).toBe(`Closed tab ${restrictedId}`);
    expect(await snapshot()).toContain("Fixture form");
  });

  describe("robustness", () => {
    const status = () => domText("#status");
    let snap = "";

    beforeAll(async () => {
      // Playwright auto-dismisses dialogs unless someone listens; a no-op listener
      // leaves them open like in a normal browser.
      page.on("dialog", () => {});
      await call("browser_navigate", { url: `${siteUrl}/actions.html`, snapshot: false });
    });

    beforeEach(async () => {
      snap = await snapshot();
    });

    it("reports a confirm dialog instead of hanging, then accepts or dismisses it", async () => {
      const started = Date.now();
      const clicked = await call("browser_click", { element: "Delete", ref: ref(snap, /button "Delete"/) });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(clicked.isError, clicked.text).toBeFalsy();
      expect(clicked.text).toContain('A JavaScript confirm dialog is open: "Delete item?"');

      // While the dialog is open other page tools explain what to do.
      const blocked = await call("browser_snapshot");
      expect(blocked.isError).toBe(true);
      expect(blocked.text).toContain("browser_handle_dialog");

      const accepted = await call("browser_handle_dialog", { accept: true });
      expect(accepted.text).toContain('Accepted the confirm dialog "Delete item?"');
      expect(await status()).toBe("Deleted");

      await call("browser_click", { element: "Delete", ref: ref(snap, /button "Delete"/) });
      await call("browser_handle_dialog", { accept: false });
      expect(await status()).toBe("Kept");
    });

    it("handles alert and prompt dialogs", async () => {
      await call("browser_click", { element: "Save", ref: ref(snap, /button "Save"/) });
      await call("browser_handle_dialog", { accept: true });
      expect(await status()).toBe("Alerted");

      const asked = await call("browser_click", { element: "Ask name", ref: ref(snap, /button "Ask name"/) });
      expect(asked.text).toContain("prompt dialog");
      await call("browser_handle_dialog", { accept: true, promptText: "Ada" });
      expect(await status()).toBe("Hello Ada");
    });

    it("refuses to click a covered element and names what covers it", async () => {
      const result = await call("browser_click", { element: "Buy now", ref: ref(snap, /button "Buy now"/) });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/covered by button "Accept cookies" \[ref=e\d+\] inside dialog "Cookie consent" \[ref=e\d+\]/);
      expect(await status()).not.toBe("Covered clicked");

      await call("browser_click", { element: "Accept cookies", ref: ref(snap, /button "Accept cookies"/) });
      await call("browser_click", { element: "Buy now", ref: ref(snap, /button "Buy now"/) });
      expect(await status()).toBe("Covered clicked");
    });

    it("refuses to click a disabled element", async () => {
      const result = await call("browser_click", { element: "Disabled", ref: ref(snap, /button "Disabled action"/) });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("is disabled");
    });

    it("names icon-only buttons", async () => {
      expect(snap).toMatch(/button "Settings" \[ref=/);
      expect(snap).toMatch(/button "Search" \[ref=/);
      await call("browser_click", { element: "Search", ref: ref(snap, /button "Search"/) });
      expect(await status()).toBe("Search opened");
    });

    it("reports tabs opened by a click", async () => {
      const result = await call("browser_click", { element: "Help", ref: ref(snap, /link "Open help in new tab"/) });
      expect(result.text).toMatch(/New tab opened: \[(\d+)\]/);
      const newId = Number(/New tab opened: \[(\d+)\]/.exec(result.text)![1]);
      // Still connected to the original tab.
      expect(result.text).toContain("- Page Title: Fixture actions");
      await call("browser_tab_close", { tabId: newId });
    });

    it("does not report a delayed navigation as a failed click", async () => {
      const result = await call("browser_click", { element: "Delayed login", ref: ref(snap, /button "Delayed login"/) });
      expect(result.isError, result.text).toBeFalsy();
      const waited = await call("browser_wait_for", { text: "Async content ready", timeout: 5 });
      expect(waited.isError, waited.text).toBeFalsy();
      expect(waited.text).toContain("- Page Title: Second page");
      await call("browser_navigate", { url: `${siteUrl}/actions.html`, snapshot: false });
    });

    it("fills a whole form in one call", async () => {
      const result = await call("browser_fill_form", {
        fields: [
          { name: "Full name", type: "textbox", ref: ref(snap, /textbox "Full name"/), value: "Ada Lovelace" },
          { name: "Birthday", type: "textbox", ref: ref(snap, /textbox "Birthday"/), value: "1815-12-10" },
          { name: "Newsletter", type: "checkbox", ref: ref(snap, /checkbox "Newsletter"/), value: "false" },
          { name: "I agree", type: "checkbox", ref: ref(snap, /checkbox "I agree"/), value: "true" },
          { name: "Pro", type: "radio", ref: ref(snap, /radio "Pro"/), value: "true" },
          { name: "Size", type: "combobox", ref: ref(snap, /combobox "Size"/), value: "Large" },
          { name: "Volume", type: "slider", ref: ref(snap, /slider "Volume"/), value: "7" },
        ],
      });
      expect(result.isError, result.text).toBeFalsy();
      expect(result.text).toContain("Filled 7 fields");
      expect(await page.inputValue("#name")).toBe("Ada Lovelace");
      expect(await page.inputValue("#birthday")).toBe("1815-12-10");
      expect(await page.isChecked("#news")).toBe(false);
      expect(await page.isChecked("#agree")).toBe(true);
      expect(await page.isChecked("#pro")).toBe(true);
      expect(await page.inputValue("#size")).toBe("Large");
      expect(await page.inputValue("#volume")).toBe("7");
    });

    it("reports which field failed", async () => {
      const result = await call("browser_fill_form", {
        fields: [
          { name: "Full name", type: "textbox", ref: ref(snap, /textbox "Full name"/), value: "Grace" },
          { name: "Ghost", type: "textbox", ref: "e999999", value: "x" },
        ],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('Field "Ghost" failed');
      expect(result.text).toContain("Filled so far: Full name");
    });

    it("types into masked inputs key by key and reports the resulting value", async () => {
      const result = await call("browser_type", {
        element: "Phone",
        ref: ref(snap, /textbox "Phone"/),
        text: "5551234567",
        slowly: true,
      });
      expect(await page.inputValue("#phone")).toBe("(555) 123-4567");
      expect(result.text).toContain('the field now contains "(555) 123-4567"');
    });

    it("explains pages extensions cannot read", async () => {
      const opened = await call("browser_tab_new", {});
      expect(opened.isError).toBeFalsy();
      expect(opened.text).toContain("can't be read or controlled by extensions");
      const read = await call("browser_snapshot");
      expect(read.isError).toBe(true);
      expect(read.text).toContain("Navigate to a website first");
      const tabs = (await call("browser_tab_list")).text;
      const blankId = Number(/\[(\d+)\][^\n]*\(connected/.exec(tabs)![1]);
      // Closing the connected tab hands the session to another tab instead of dropping it.
      const closed = await call("browser_tab_close", { tabId: blankId });
      expect(closed.text).toContain(`Closed tab ${blankId}; now connected to tab`);
      expect(await snapshot()).toContain("Fixture actions");
    });

    it("navigates away from a page the debugger cannot control", async () => {
      const restricted = await call("browser_navigate", { url: "chrome://version", snapshot: false });
      expect(restricted.isError, restricted.text).toBeFalsy();
      const back = await call("browser_navigate", { url: `${siteUrl}/actions.html` });
      expect(back.isError, back.text).toBeFalsy();
      expect(back.text).toContain("- Page Title: Fixture actions");
    });

    it("answers other tools while a long wait is running", async () => {
      const started = Date.now();
      const waiting = call("browser_wait", { time: 3 });
      const found = await call("browser_find", { text: "Delete" });
      expect(found.isError, found.text).toBeFalsy();
      expect(Date.now() - started).toBeLessThan(1_500);
      await waiting;
    });

    it("keeps action replies short", async () => {
      const result = await call("browser_click", { element: "Search", ref: ref(snap, /button "Search"/) });
      expect(result.text.length).toBeLessThan(300);
      expect(result.text).not.toContain("Page Snapshot");
    });
  });
});
