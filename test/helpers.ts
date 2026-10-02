import net from "node:net";

import { WebSocket } from "ws";

import { EXTENSION_ORIGIN } from "../src/config";

/**
 * A port that is free on both IPv4 and IPv6: clients connect to `localhost`,
 * which may resolve to either family.
 */
export async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    // The dual-stack wildcard covers 0.0.0.0 and :: at once; fall back to IPv4.
    const port = (await ephemeralPort("::")) || (await ephemeralPort("0.0.0.0"));
    if (port && (await isFree(port, "127.0.0.1")) && (await isFree(port, "::1"))) return port;
  }
  throw new Error("Could not find a free port");
}

function ephemeralPort(host: string): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(0));
    server.listen(0, host, () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function isFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (error: NodeJS.ErrnoException) =>
      resolve(error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT"),
    );
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

type Handler = (payload: any) => unknown | Promise<unknown>;

/**
 * Stands in for the browser extension: connects like the extension does and
 * answers requests from a handler table. Throwing from a handler sends an error.
 */
export class FakeExtension {
  readonly received: { type: string; payload: unknown }[] = [];
  ws!: WebSocket;

  constructor(
    public handlers: Record<string, Handler> = {},
    /** Capabilities announced in `hello`, like the Browser MCP Plus extension; none = original extension. */
    private readonly capabilities?: string[],
  ) {}

  connect(port: number, origin: string | undefined = EXTENSION_ORIGIN): Promise<this> {
    this.ws = new WebSocket(`ws://localhost:${port}`, origin ? { origin } : {});
    this.ws.on("open", () => {
      if (!this.capabilities) return;
      this.ws.send(
        JSON.stringify({
          type: "hello",
          payload: { name: "browsermcp-plus", version: "test", capabilities: this.capabilities },
        }),
      );
    });
    this.ws.on("message", async (data) => {
      const { id, type, payload } = JSON.parse(data.toString());
      this.received.push({ type, payload });
      const handler = this.handlers[type];
      let response: { requestId: string; result?: unknown; error?: string };
      try {
        if (!handler) throw new Error(`Unhandled message ${type}`);
        response = { requestId: id, result: await handler(payload) };
      } catch (error) {
        response = { requestId: id, error: (error as Error).message };
      }
      this.ws.send(JSON.stringify({ type: "messageResponse", payload: response }));
    });
    this.ws.on("error", () => {});
    return new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve(this));
      this.ws.once("close", () => reject(new Error("closed before open")));
      this.ws.once("unexpected-response", (_req, res) =>
        reject(new Error(`HTTP ${res.statusCode}`)),
      );
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.once("close", () => resolve());
      if (this.ws.readyState === WebSocket.CONNECTING) this.ws.terminate();
      else this.ws.close();
    });
  }
}

/** A fake page whose snapshot can be changed by the test. */
export function fakePage(initial = { url: "https://example.com/", title: "Example" }) {
  const page = { ...initial, snapshot: '- button "Sign in" [ref=s1e3]' };
  const handlers: Record<string, Handler> = {
    getUrl: () => page.url,
    getTitle: () => page.title,
    browser_snapshot: () => page.snapshot,
    browser_navigate: ({ url }: { url: string }) => {
      page.url = url;
    },
    browser_go_back: () => undefined,
    browser_go_forward: () => undefined,
    browser_click: () => undefined,
    browser_hover: () => undefined,
    browser_type: () => undefined,
    browser_select_option: () => undefined,
    browser_drag: () => undefined,
    browser_press_key: () => undefined,
    browser_wait: () => undefined,
    browser_screenshot: () => "iVBORw0KGgo=",
    browser_get_console_logs: () => [{ type: "log", message: "hello" }],
  };
  return { page, handlers };
}

export function waitUntil(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (condition()) return resolve();
      if (Date.now() > deadline) return reject(new Error("waitUntil timed out"));
      setTimeout(tick, 20);
    };
    tick();
  });
}
