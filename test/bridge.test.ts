import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

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

/** A Chrome user data directory whose Local State lists `profiles`. */
async function chromeDir(profiles: Record<string, { name: string; user_name?: string; gaia_id?: string }>, lastUsed?: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bmcp-chrome-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const profile = { info_cache: profiles, last_used: lastUsed, profiles_order: Object.keys(profiles) };
  await writeFile(path.join(dir, "Local State"), JSON.stringify({ profile }));
  return dir;
}

async function eventually(condition: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("eventually timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const getUrl = (bridge: ExtensionBridge) => bridge.getChannel(1_000).then((c) => c.request("getUrl", undefined, 1_000));

describe("Chrome profiles", () => {
  it("tells profiles apart and sends each session to the profile it works in", async () => {
    const port = await freePort();
    const dir = await chromeDir(
      {
        Default: { name: "Personal", user_name: "me@example.com", gaia_id: "111" },
        "Profile 2": { name: "Work", user_name: "work@example.com", gaia_id: "222" },
      },
      "Profile 2",
    );
    const hub = await startBridge(port, { session: { id: "aaa", name: "shop" }, chromeUserDataDir: dir });
    const personal = new FakeExtension({ getUrl: () => "https://personal.example/" }, [], {
      installId: "i-personal",
      account: { email: "me@example.com", id: "111" },
    });
    const work = new FakeExtension({ getUrl: () => "https://work.example/" }, [], {
      installId: "i-work",
      account: { email: "WORK@example.com" },
    });
    cleanups.push(() => personal.close(), () => work.close());
    await personal.connect(port);
    await work.connect(port);
    await eventually(async () => (await hub.profileView()).browsers.filter((b) => b.profile).length === 2);

    // Without a choice: the profile Chrome used last, and then that one for good.
    expect(await getUrl(hub)).toBe("https://work.example/");
    expect((await hub.profileView()).current).toBe("Profile 2");

    const second = await startBridge(port, { session: { id: "bbb", name: "blog" }, chromeUserDataDir: dir });
    expect(second.state).toBe("client");
    await expect(second.selectProfile("me@example.com")).resolves.toMatchObject({ opened: false });
    expect(await getUrl(second)).toBe("https://personal.example/");
    expect(personal.sessions).toEqual(["bbb"]);
    expect(work.sessions).toEqual(["aaa"]);
    const view = await second.profileView();
    expect(view).toMatchObject({ current: "Default", chosen: true });
    expect(view.profiles.map((p) => p.directory)).toEqual(["Default", "Profile 2"]);
  });

  it("opens a profile it cannot identify and learns which connection runs there", async () => {
    const port = await freePort();
    const dir = await chromeDir({ Default: { name: "Personal", user_name: "me@example.com" }, "Profile 5": { name: "Shop" } });
    const launched: [string, string][] = [];
    const told: unknown[] = [];
    // Stands in for Chrome: the profile's extension connects and reports the page it was opened with.
    const launchProfile = async (directory: string, url: string) => {
      launched.push([directory, url]);
      const extension = new FakeExtension(
        { profile_set: (payload: unknown) => told.push(payload), getUrl: () => "https://shop.example/" },
        ["profile_set"],
        { installId: "i-shop" },
      );
      cleanups.push(() => extension.close());
      await extension.connect(port);
      extension.emit("profile_claim", { token: url.split("/").pop(), tabId: 42 });
    };
    await startBridge(port, { session: { id: "aaa", name: "shop" }, chromeUserDataDir: dir, launchProfile });
    const personal = new FakeExtension({ getUrl: () => "https://personal.example/" }, [], { account: { email: "me@example.com" } });
    cleanups.push(() => personal.close());
    await personal.connect(port);

    // A joined session asks; the hub opens the profile.
    const client = await startBridge(port, {
      session: { id: "bbb", name: "blog" },
      chromeUserDataDir: dir,
      launchProfile: () => Promise.reject(new Error("only the hub opens profiles")),
    });
    await expect(client.selectProfile("Shop")).resolves.toMatchObject({ opened: true });
    expect(launched).toEqual([["Profile 5", expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/browsermcp-plus\/profile\/[\w-]{16,}$/)]]);
    // The extension remembers its profile and hands the opened tab to the session.
    expect(told).toEqual([
      { profile: { directory: "Profile 5", name: "Shop", userDataDir: dir }, adopt: { tabId: 42, sessionId: "bbb", sessionName: "blog" } },
    ]);
    expect(await getUrl(client)).toBe("https://shop.example/");

    // The page the profile was opened with explains itself if the extension is missing.
    const page = await fetch(launched[0][1]);
    expect(page.headers.get("x-browsermcp-plus-hub")).toBe("1");
    expect(await page.text()).toContain("not installed or not turned on in this profile");
  });

  it("does not quietly work in another profile when the chosen one cannot be opened", async () => {
    const port = await freePort();
    const dir = await chromeDir({ Default: { name: "Personal", user_name: "me@example.com" }, "Profile 5": { name: "Shop" } });
    const hub = await startBridge(port, {
      chromeUserDataDir: dir,
      launchProfile: () => Promise.reject(new Error("Could not find Google Chrome.")),
    });
    const personal = new FakeExtension({ getUrl: () => "https://personal.example/" }, [], { account: { email: "me@example.com" } });
    cleanups.push(() => personal.close());
    await personal.connect(port);
    await waitUntil(() => hub.isConnected);

    await expect(hub.selectProfile("Profile 5")).rejects.toThrow("Could not find Google Chrome.");
    await expect(hub.getChannel(100)).rejects.toThrow(/Chrome profile "Profile 5" is not open/);
    await expect(hub.selectProfile("nobody")).rejects.toThrow(/No Chrome profile matches "nobody"/);
  });

  it("starts in the profile given with --profile", async () => {
    const port = await freePort();
    const dir = await chromeDir({ Default: { name: "Personal", user_name: "me@example.com" }, "Profile 2": { name: "Work", user_name: "work@example.com" } }, "Default");
    const hub = await startBridge(port, { chromeUserDataDir: dir, profile: "Work" });
    for (const [email, url] of [["me@example.com", "https://personal.example/"], ["work@example.com", "https://work.example/"]]) {
      const extension = new FakeExtension({ getUrl: () => url }, [], { account: { email } });
      cleanups.push(() => extension.close());
      await extension.connect(port);
    }
    expect(await getUrl(hub)).toBe("https://work.example/");
  });

  it("a reconnecting extension replaces its previous connection", async () => {
    const port = await freePort();
    const hub = await startBridge(port);
    const first = new FakeExtension({}, [], { installId: "same" });
    const again = new FakeExtension({ getUrl: () => "https://again.example/" }, [], { installId: "same" });
    const other = new FakeExtension({}, [], { installId: "other" });
    cleanups.push(() => first.close(), () => again.close(), () => other.close());
    await first.connect(port);
    await other.connect(port);
    await eventually(async () => (await hub.profileView()).browsers.every((b) => b.ready));
    await again.connect(port);
    await waitUntil(() => first.ws.readyState === WebSocket.CLOSED);
    await eventually(async () => (await hub.profileView()).browsers.length === 2);
    expect(other.ws.readyState).toBe(WebSocket.OPEN);
  });
});

describe("sharing the port", () => {
  it("does not join another program's hub on the same port", async () => {
    const port = await freePort();
    // Accepts every WebSocket, like a Tabrein MCP hub would.
    const foreign = http.createServer((_req, res) => res.writeHead(426).end());
    const wss = new WebSocketServer({ server: foreign });
    const joins: unknown[] = [];
    wss.on("connection", (_ws, req) => req.headers["x-browsermcp-session"] && joins.push(req.headers));
    await new Promise<void>((resolve) => foreign.listen(port, "127.0.0.1", resolve));
    cleanups.push(() => new Promise((resolve) => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      foreign.close(resolve);
    }));

    const bridge = await startBridge(port);
    expect(bridge.state).toBe("standby");
    await expect(bridge.getChannel(50)).rejects.toThrow(/not browsermcp-plus 0\.6 or newer \(for example Tabrein MCP/);
    expect(joins).toEqual([]);
  });

  it("refuses Tabrein MCP sessions", async () => {
    const port = await freePort();
    const hub = await startBridge(port);
    expect(await upgradeStatus(port, { "x-browsermcp-session": "t1", "x-tabrein-hub-revision": "3" })).toBe(409);
    expect(hub.clientSessions).toEqual([]);
  });

  it("turns away other extensions using the same origin, and names their profile", async () => {
    const port = await freePort();
    const dir = await chromeDir({ "Profile 3": { name: "Shop", user_name: "shop@example.com" } });
    const hub = await startBridge(port, { chromeUserDataDir: dir });
    const tabrein = new FakeExtension({}, ["browser_snapshot"], {
      name: "tabrein",
      version: "1.2.2",
      profile: { email: "shop@example.com" },
    });
    cleanups.push(() => tabrein.close());
    await tabrein.connect(port);
    await waitUntil(() => tabrein.ws.readyState === WebSocket.CLOSED);
    await eventually(async () => (await hub.profileView()).foreign.length === 1);
    expect(hub.isConnected).toBe(false);
    expect((await hub.profileView()).foreign).toEqual([{ name: "tabrein", version: "1.2.2", profile: "Profile 3" }]);
  });

  it("a hub that exits tells the extension at once that its session ended", async () => {
    const port = await freePort();
    const hub = new ExtensionBridge({ port, session: { id: "aaa", name: "shop" } });
    await hub.start();
    const updates: unknown[] = [];
    const extension = new FakeExtension(
      { sessions_update: (payload: { sessions: unknown[] }) => updates.push(payload.sessions) },
      ["sessions_update"],
    );
    cleanups.push(() => extension.close());
    await extension.connect(port);
    const second = await startBridge(port, { session: { id: "bbb", name: "blog" } });
    await waitUntil(() => second.isConnected);

    const before = updates.length;
    await hub.close();
    expect(updates.length).toBe(before + 1);
    expect(updates.at(-1)).toEqual([{ id: "bbb", name: "blog" }]);
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
