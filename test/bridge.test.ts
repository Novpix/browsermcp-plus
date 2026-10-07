import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { ExtensionBridge, parseNetstatPids } from "../src/bridge";
import { NO_CONNECTION_MESSAGE } from "../src/config";
import { FakeExtension, freePort, waitUntil } from "./helpers";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function startBridge(port: number, options: Partial<ConstructorParameters<typeof ExtensionBridge>[0]> = {}) {
  const bridge = new ExtensionBridge({ port, standbyRetryMs: 100, ...options });
  cleanups.push(() => bridge.close());
  await bridge.start();
  return bridge;
}

async function connectExtension(port: number, origin?: string) {
  const extension = new FakeExtension();
  cleanups.push(() => extension.close());
  return extension.connect(port, origin);
}

function upgradeStatus(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.on("open", () => {
      ws.close();
      resolve(101);
    });
    ws.on("error", () => resolve(-1));
  });
}

describe("ExtensionBridge", () => {
  it("listens on loopback only", async () => {
    const port = await freePort();
    await startBridge(port);
    const external = Object.values((await import("node:os")).networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal);
    if (!external) return; // offline CI runner
    const reachable = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, external.address);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    expect(reachable).toBe(false);
  });

  it("accepts the extension origin", async () => {
    const port = await freePort();
    const bridge = await startBridge(port);
    await connectExtension(port);
    await waitUntil(() => bridge.isConnected);
  });

  it("rejects web pages and clients without an origin", async () => {
    const port = await freePort();
    const bridge = await startBridge(port);
    expect(await upgradeStatus(port, { origin: "https://evil.example" })).toBe(403);
    expect(await upgradeStatus(port, { origin: "chrome-extension://someotherextension" })).toBe(403);
    expect(await upgradeStatus(port, {})).toBe(403);
    expect(bridge.isConnected).toBe(false);
  });

  it("does not honour takeover requests coming from a browser page", async () => {
    const port = await freePort();
    const bridge = await startBridge(port);
    const status = await upgradeStatus(port, {
      origin: "https://evil.example",
      "x-browsermcp-takeover": "1",
    });
    expect(status).toBe(403);
    expect(bridge.state).toBe("hub");
  });

  it("accepts extra origins when configured", async () => {
    const port = await freePort();
    const bridge = await startBridge(port, {
      allowedOrigins: ["chrome-extension://devbuild"],
    });
    await connectExtension(port, "chrome-extension://devbuild");
    await waitUntil(() => bridge.isConnected);
  });

  it("a new extension connection supersedes the previous one", async () => {
    const port = await freePort();
    const bridge = await startBridge(port);
    const first = await connectExtension(port);
    await connectExtension(port);
    await waitUntil(() => first.ws.readyState === WebSocket.CLOSED);
    expect(bridge.isConnected).toBe(true);
  });

  it("getChannel waits for an extension that connects late", async () => {
    const port = await freePort();
    const bridge = await startBridge(port);
    const pending = bridge.getChannel(3_000);
    const late = new Promise((r) => setTimeout(r, 200)).then(() => connectExtension(port));
    await expect(pending).resolves.toBeDefined();
    await late;
  });

  it("getChannel fails with guidance when nothing connects", async () => {
    const port = await freePort();
    const bridge = await startBridge(port);
    await expect(bridge.getChannel(100)).rejects.toThrow(NO_CONNECTION_MESSAGE);
  });

  it("a second server joins the hub and its requests carry its own session", async () => {
    const port = await freePort();
    const hub = await startBridge(port, { session: { id: "aaa", name: "shop" } });
    const extension = new FakeExtension({ getUrl: () => "https://example.com/" });
    cleanups.push(() => extension.close());
    await extension.connect(port);
    await waitUntil(() => hub.isConnected);

    const second = await startBridge(port, { session: { id: "bbb", name: "blog" } });
    expect(hub.state).toBe("hub");
    expect(second.state).toBe("client");
    await waitUntil(() => second.isConnected);
    expect(hub.clientSessions).toEqual([{ id: "bbb", name: "blog" }]);

    const [viaHub, viaClient] = await Promise.all([
      hub.getChannel(1_000).then((c) => c.request("getUrl", undefined, 1_000)),
      second.getChannel(1_000).then((c) => c.request("getUrl", undefined, 1_000)),
    ]);
    expect(viaHub).toBe("https://example.com/");
    expect(viaClient).toBe("https://example.com/");
    expect([...extension.sessions].sort()).toEqual(["aaa", "bbb"]);
  });

  it("tells the extension which sessions are alive", async () => {
    const port = await freePort();
    await startBridge(port, { session: { id: "aaa", name: "shop" } });
    const updates: unknown[] = [];
    const extension = new FakeExtension(
      { sessions_update: (payload: { sessions: unknown[] }) => updates.push(payload.sessions) },
      ["sessions_update"],
    );
    cleanups.push(() => extension.close());
    await extension.connect(port);
    const second = await startBridge(port, { session: { id: "bbb", name: "blog" } });
    await waitUntil(() => updates.length > 0, 5_000);
    expect(updates.at(-1)).toEqual([
      { id: "aaa", name: "shop" },
      { id: "bbb", name: "blog" },
    ]);

    await second.close();
    await waitUntil(() => (updates.at(-1) as unknown[]).length === 1, 5_000);
    expect(updates.at(-1)).toEqual([{ id: "aaa", name: "shop" }]);
  });

  it("when the hub exits another server takes its place", async () => {
    const port = await freePort();
    const hub = new ExtensionBridge({ port, session: { id: "aaa", name: "shop" } });
    await hub.start();
    const second = await startBridge(port, { session: { id: "bbb", name: "blog" } });
    expect(second.state).toBe("client");

    await hub.close();
    await waitUntil(() => second.state === "hub", 5_000);
    const extension = new FakeExtension({ getUrl: () => "https://after.example/" });
    cleanups.push(() => extension.close());
    await extension.connect(port);
    const channel = await second.getChannel(2_000);
    await expect(channel.request("getUrl", undefined, 1_000)).resolves.toBe("https://after.example/");
    expect(extension.sessions).toEqual(["bbb"]);
  });

  it("rejects take-over requests from older versions instead of giving up the port", async () => {
    const port = await freePort();
    const hub = await startBridge(port);
    expect(await upgradeStatus(port, { "x-browsermcp-takeover": "1" })).toBe(409);
    expect(hub.state).toBe("hub");
  });

  it("goes into standby, without killing anything, when a foreign process holds the port", async () => {
    const port = await freePort();
    const foreign = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => foreign.listen(port, "127.0.0.1", resolve));
    cleanups.push(() => new Promise((resolve) => foreign.close(resolve)));

    const bridge = await startBridge(port);
    expect(bridge.state).toBe("standby");
    expect(foreign.listening).toBe(true);
    await expect(bridge.getChannel(50)).rejects.toThrow(/in use by another process/);

    await new Promise((resolve) => foreign.close(resolve));
    await waitUntil(() => bridge.state === "hub");
  });

  it("detects a legacy server holding the wildcard address instead of shadowing it", async () => {
    const port = await freePort();
    // Browser MCP <= 0.1.x listens on all interfaces.
    const legacy = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => legacy.listen(port, resolve));
    cleanups.push(() => new Promise((resolve) => legacy.close(resolve)));

    const bridge = await startBridge(port, { takeover: false });
    expect(bridge.state).toBe("standby");
    expect(legacy.listening).toBe(true);
  });

  it("does not join or take over when sharing is disabled", async () => {
    const port = await freePort();
    const older = await startBridge(port);
    const newer = await startBridge(port, { takeover: false });
    expect(older.state).toBe("hub");
    expect(newer.state).toBe("standby");
  });

  it("close() is idempotent", async () => {
    const port = await freePort();
    const bridge = await startBridge(port);
    await Promise.all([bridge.close(), bridge.close()]);
    expect(bridge.state).toBe("closed");
  });
});

describe("parseNetstatPids", () => {
  it("returns PIDs listening on the exact port", () => {
    const output = [
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    0.0.0.0:9009           0.0.0.0:0              LISTENING       4242",
      "  TCP    [::]:9009              [::]:0                 LISTENING       4242",
      "  TCP    0.0.0.0:19009          0.0.0.0:0              LISTENING       77",
      "  TCP    127.0.0.1:51000        127.0.0.1:9009         ESTABLISHED     88",
    ].join("\r\n");
    expect(parseNetstatPids(output, 9009)).toEqual([4242]);
  });
});
