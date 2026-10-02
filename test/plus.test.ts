import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { PLUS_ORIGIN } from "../src/config";
import { PLUS_MESSAGES } from "../src/protocol";
import { createServer } from "../src/server";
import { formatEvaluateResult } from "../src/tools/plus";
import { FakeExtension, fakePage, freePort, waitUntil } from "./helpers";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function setup({ plus }: { plus: boolean }) {
  const port = await freePort();
  const server = await createServer({ version: "test", port, connectWaitMs: 200 });
  cleanups.push(() => server.close());
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.mcp.connect(b)]);
  cleanups.push(() => client.close());

  const { page, handlers } = fakePage();
  const tabs = [
    { id: 1, windowId: 1, title: "Example", url: "https://example.com/", active: true, connected: true },
    { id: 2, windowId: 1, title: "Docs", url: "https://docs.example.com/", active: false, connected: false },
  ];
  Object.assign(handlers, {
    browser_upload_file: () => undefined,
    browser_evaluate: () => ({ type: "object", value: { answer: 42 } }),
    browser_scroll: () => undefined,
    browser_tab_list: () => tabs,
    browser_tab_new: ({ url }: { url?: string }) => ({ ...tabs[0], id: 3, url: url ?? "about:blank" }),
    browser_tab_select: ({ tabId }: { tabId: number }) => ({ ...tabs[1], id: tabId, connected: true }),
    browser_tab_close: () => tabs[1],
  });
  const extension = new FakeExtension(handlers, plus ? [...PLUS_MESSAGES] : undefined);
  await extension.connect(port, plus ? PLUS_ORIGIN : undefined);
  cleanups.push(() => extension.close());
  await waitUntil(() => server.bridge.isConnected);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: { type: string; text?: string }[];
      isError?: boolean;
    };
    return { ...result, text: result.content.map((c) => c.text ?? "").join("\n") };
  };
  return { call, extension, page };
}

describe("Browser MCP Plus tools", () => {
  it("explain that the original extension does not support them", async () => {
    const { call, extension } = await setup({ plus: false });
    const started = Date.now();
    const result = await call("browser_tab_list");
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Browser MCP Plus extension/);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(extension.received.map((m) => m.type)).not.toContain("browser_tab_list");
  });

  it("upload resolves and validates paths before sending them", async () => {
    const { call, extension } = await setup({ plus: true });
    const dir = await mkdtemp(path.join(os.tmpdir(), "bmcp-"));
    const file = path.join(dir, "avatar.png");
    await writeFile(file, "x");

    const ok = await call("browser_file_upload", { element: "Avatar", ref: "s1e2", paths: [file] });
    expect(ok.isError).toBeFalsy();
    expect(ok.text).toContain("Uploaded avatar.png");
    expect(extension.received).toContainEqual({
      type: "browser_upload_file",
      payload: { element: "Avatar", ref: "s1e2", paths: [file] },
    });

    const missing = await call("browser_file_upload", {
      element: "Avatar",
      ref: "s1e2",
      paths: [path.join(dir, "nope.png"), dir],
    });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("nope.png does not exist");
    expect(missing.text).toContain(`${dir} is not a file`);
  });

  it("evaluate returns the serialised result", async () => {
    const { call, extension } = await setup({ plus: true });
    const result = await call("browser_evaluate", { function: "() => ({answer: 42})" });
    expect(JSON.parse(result.text)).toEqual({ answer: 42 });
    expect(extension.received.at(-1)).toEqual({
      type: "browser_evaluate",
      payload: { function: "() => ({answer: 42})" },
    });
  });

  it("scroll requires a delta or a ref", async () => {
    const { call } = await setup({ plus: true });
    expect((await call("browser_scroll", {})).isError).toBe(true);
    const ok = await call("browser_scroll", { deltaY: 600 });
    expect(ok.text).toContain("Scrolled by 0, 600");
  });

  it("tab tools format and forward ids", async () => {
    const { call, extension } = await setup({ plus: true });
    const list = await call("browser_tab_list");
    expect(list.text).toBe(
      [
        "- [1] Example — https://example.com/ (connected, active)",
        "- [2] Docs — https://docs.example.com/",
      ].join("\n"),
    );
    await call("browser_tab_new", { url: "example.org" });
    expect(extension.received).toContainEqual({
      type: "browser_tab_new",
      payload: { url: "https://example.org" },
    });
    const selected = await call("browser_tab_select", { tabId: 2 });
    expect(selected.text).toContain("Switched to tab 2");
    const closed = await call("browser_tab_close", {});
    expect(closed.text).toContain("now connected to tab 2");
  });
});

describe("formatEvaluateResult", () => {
  it.each([
    [{ type: "undefined" }, "undefined"],
    [{ type: "string", value: "hi" }, "hi"],
    [{ type: "number", value: 3 }, "3"],
    [{ type: "number", unserializableValue: "NaN" }, "NaN"],
    [{ type: "function", description: "() => 1" }, "() => 1"],
  ])("%j", (input, expected) => {
    expect(formatEvaluateResult(input)).toBe(expected);
  });
});
