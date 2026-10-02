import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { NO_CONNECTION_MESSAGE } from "../src/config";
import { createServer, type ServerOptions } from "../src/server";
import { normalizeUrl } from "../src/tools/navigation";
import { FakeExtension, fakePage, freePort, waitUntil } from "./helpers";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function setup(options: Partial<ServerOptions> = {}, connectExtension = true) {
  const port = await freePort();
  const server = await createServer({ version: "test", port, connectWaitMs: 200, ...options });
  cleanups.push(() => server.close());

  const client = new Client({ name: "test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.mcp.connect(serverTransport)]);
  cleanups.push(() => client.close());

  const { page, handlers } = fakePage();
  const extension = new FakeExtension(handlers);
  if (connectExtension) {
    await extension.connect(port);
    cleanups.push(() => extension.close());
    await waitUntil(() => server.bridge.isConnected);
  }

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: { type: string; text?: string; data?: string; mimeType?: string }[];
      isError?: boolean;
    };
    return { ...result, text: result.content.map((c) => c.text ?? "").join("\n") };
  };

  return { server, client, extension, page, call, port };
}

describe("MCP server", () => {
  it("lists every tool with an input schema and annotations", async () => {
    const { client } = await setup({}, false);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "browser_click",
        "browser_drag",
        "browser_get_console_logs",
        "browser_go_back",
        "browser_go_forward",
        "browser_hover",
        "browser_navigate",
        "browser_press_key",
        "browser_reload",
        "browser_screenshot",
        "browser_select_option",
        "browser_snapshot",
        "browser_type",
        "browser_wait",
        "browser_wait_for",
      ].sort(),
    );
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.annotations).toBeDefined();
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.browser_snapshot.annotations?.readOnlyHint).toBe(true);
    expect(byName.browser_click.annotations?.destructiveHint).toBe(true);
  });

  it("navigate normalises the URL and returns a snapshot", async () => {
    const { call, extension } = await setup();
    const result = await call("browser_navigate", { url: "example.org/path" });
    expect(result.isError).toBeFalsy();
    expect(extension.received[0]).toEqual({
      type: "browser_navigate",
      payload: { url: "https://example.org/path" },
    });
    expect(result.text).toContain("Navigated to https://example.org/path");
    expect(result.text).toContain("- Page URL: https://example.org/path");
    expect(result.text).toContain('button "Sign in" [ref=s1e3]');
  });

  it("forwards element actions with the exact payload", async () => {
    const { call, extension } = await setup();
    await call("browser_click", { element: "Sign in button", ref: "s1e3" });
    await call("browser_type", { element: "Email", ref: "s1e4", text: "a@b.c" });
    await call("browser_select_option", { element: "Country", ref: "s1e5", values: ["TR"] });
    const drag = await call("browser_drag", {
      startElement: "Card",
      startRef: "s1e6",
      endElement: "Column",
      endRef: "s1e7",
    });
    expect(drag.isError).toBeFalsy();
    const actions = extension.received.filter((m) => m.type.startsWith("browser_") && m.type !== "browser_snapshot");
    expect(actions).toEqual([
      { type: "browser_click", payload: { element: "Sign in button", ref: "s1e3" } },
      { type: "browser_type", payload: { element: "Email", ref: "s1e4", text: "a@b.c", submit: false } },
      { type: "browser_select_option", payload: { element: "Country", ref: "s1e5", values: ["TR"] } },
      {
        type: "browser_drag",
        payload: { startElement: "Card", startRef: "s1e6", endElement: "Column", endRef: "s1e7" },
      },
    ]);
  });

  it("can skip the snapshot after actions", async () => {
    const { call, extension } = await setup({ actionSnapshots: false });
    const result = await call("browser_click", { element: "Sign in", ref: "s1e3" });
    expect(result.text).toBe('Clicked "Sign in"');
    expect(extension.received.map((m) => m.type)).toEqual(["browser_click"]);
  });

  it("truncates long snapshots when configured", async () => {
    const { call, page } = await setup({ snapshotMaxChars: 10 });
    page.snapshot = "x".repeat(100);
    const result = await call("browser_snapshot");
    expect(result.text).toContain("x".repeat(10) + "\n```");
    expect(result.text).not.toContain("x".repeat(11));
    expect(result.text).toContain("truncated to 10 of 100 characters");
  });

  it("reload re-navigates to the current URL", async () => {
    const { call, extension, page } = await setup();
    page.url = "https://example.com/current";
    await call("browser_reload");
    expect(extension.received).toContainEqual({
      type: "browser_navigate",
      payload: { url: "https://example.com/current" },
    });
  });

  it("wait_for resolves when text appears", async () => {
    const { call, page } = await setup();
    page.snapshot = "- text: Loading";
    setTimeout(() => (page.snapshot = "- text: Done"), 300);
    const result = await call("browser_wait_for", { text: "Done", textGone: "Loading" });
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain("Condition met");
  });

  it("wait_for reports a timeout as an error", async () => {
    const { call } = await setup();
    const result = await call("browser_wait_for", { text: "Never", timeout: 1 });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Timed out');
  });

  it("wait_for requires a condition", async () => {
    const { call } = await setup();
    const result = await call("browser_wait_for", {});
    expect(result.isError).toBe(true);
  });

  it("long waits outlive the default request timeout", async () => {
    const { call, extension } = await setup({ requestTimeoutMs: 100 });
    extension.handlers.browser_wait = () => new Promise((r) => setTimeout(r, 300));
    const result = await call("browser_wait", { time: 0.3 });
    expect(result.isError).toBeFalsy();
  });

  it("returns screenshots as PNG images", async () => {
    const { call } = await setup();
    const result = await call("browser_screenshot");
    expect(result.content[0]).toEqual({ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" });
  });

  it("formats console logs and handles an empty log", async () => {
    const { call, extension } = await setup();
    expect((await call("browser_get_console_logs")).text).toBe('{"type":"log","message":"hello"}');
    extension.handlers.browser_get_console_logs = () => [];
    expect((await call("browser_get_console_logs")).text).toBe("No console logs captured.");
  });

  it("reports a missing extension as a tool error, not a crash", async () => {
    const { call } = await setup({}, false);
    const result = await call("browser_snapshot");
    expect(result.isError).toBe(true);
    expect(result.text).toBe(NO_CONNECTION_MESSAGE);
  });

  it("surfaces extension errors as tool errors", async () => {
    const { call, extension } = await setup();
    extension.handlers.browser_click = () => {
      throw new Error("No tab is connected");
    };
    const result = await call("browser_click", { element: "x", ref: "y" });
    expect(result.isError).toBe(true);
    expect(result.text).toBe(NO_CONNECTION_MESSAGE);
  });

  it("rejects invalid arguments", async () => {
    const { call } = await setup();
    const result = await call("browser_wait", { time: -1 });
    expect(result.isError).toBe(true);
  });

  it("close() can be called repeatedly without recursing", async () => {
    const { server } = await setup({}, false);
    await Promise.all([server.close(), server.close()]);
    await server.close();
    expect(server.bridge.state).toBe("closed");
  });
});

describe("normalizeUrl", () => {
  it.each([
    ["example.com", "https://example.com"],
    ["  https://a.b/c ", "https://a.b/c"],
    ["http://x.y", "http://x.y"],
    ["localhost:3000/x", "http://localhost:3000/x"],
    ["127.0.0.1:8080", "http://127.0.0.1:8080"],
    ["//cdn.example.com/a", "https://cdn.example.com/a"],
    ["about:blank", "about:blank"],
    ["chrome://extensions", "chrome://extensions"],
    ["file:///tmp/a.html", "file:///tmp/a.html"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeUrl(input)).toBe(expected);
  });
});
