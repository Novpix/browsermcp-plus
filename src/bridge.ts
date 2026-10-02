import { execFileSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer } from "ws";

import {
  EXTENSION_ORIGIN,
  NO_CONNECTION_MESSAGE,
  TAKEOVER_ACK_CODE,
  TAKEOVER_HEADER,
} from "./config";
import { log } from "./log";
import { ExtensionConnection } from "./protocol";

export type BridgeOptions = {
  port: number;
  /** Origins allowed to connect as the extension. */
  allowedOrigins?: string[];
  /** Ask a running Browser MCP server (>= 0.2) to hand over the port. */
  takeover?: boolean;
  /**
   * Terminate whatever process listens on the port if it does not respond to
   * a takeover request (e.g. Browser MCP <= 0.1.x). Off by default.
   */
  killExisting?: boolean;
  /** How often to retry binding while in standby. */
  standbyRetryMs?: number;
};

export type BridgeState = "starting" | "active" | "standby" | "closed";

/**
 * Hosts we listen on. The extension connects to `ws://localhost:<port>`, and
 * browsers may resolve `localhost` to either address family.
 */
const LOOPBACK_HOSTS = ["127.0.0.1", "::1"] as const;

const IGNORABLE_BIND_ERRORS = new Set(["EADDRNOTAVAIL", "EAFNOSUPPORT"]);

/**
 * Owns the local WebSocket endpoint the browser extension connects to.
 */
export class ExtensionBridge {
  private readonly options: Required<BridgeOptions>;
  private readonly wss = new WebSocketServer({ noServer: true });
  private servers: http.Server[] = [];
  private connection: ExtensionConnection | undefined;
  private connectionWaiters = new Set<() => void>();
  private standbyTimer: NodeJS.Timeout | undefined;
  private standbyReason = "";
  private _state: BridgeState = "starting";

  constructor(options: BridgeOptions) {
    this.options = {
      allowedOrigins: [EXTENSION_ORIGIN],
      takeover: true,
      killExisting: false,
      standbyRetryMs: 2_000,
      ...options,
    };
  }

  get state(): BridgeState {
    return this._state;
  }

  get port(): number {
    return this.options.port;
  }

  get isConnected(): boolean {
    return !!this.connection?.isOpen;
  }

  /**
   * Starts listening. Never throws because the port is busy: in that case the
   * bridge goes into standby and keeps retrying, so the MCP server itself can
   * still start and report a useful error from tool calls.
   */
  async start(): Promise<void> {
    if (await this.tryListen()) return;

    if (this.options.takeover && (await requestTakeover(this.port))) {
      log.info(`Took over port ${this.port} from another Browser MCP server`);
      if (await this.retryListen(3_000)) return;
    }

    if (this.options.killExisting) {
      const killed = killPortOwners(this.port);
      if (killed.length > 0) {
        log.info(`Terminated process(es) ${killed.join(", ")} on port ${this.port}`);
        if (await this.retryListen(5_000)) return;
      }
    }

    this.enterStandby(
      `Port ${this.port} is in use by another process, so the browser extension cannot reach this server. ` +
        `If it is an older Browser MCP server (0.1.x), update or stop it, or restart this server with --kill-existing.`,
    );
  }

  /** Returns the open connection, waiting up to `timeoutMs` for the extension to connect. */
  async getConnection(timeoutMs: number): Promise<ExtensionConnection> {
    if (this.connection?.isOpen) return this.connection;
    if (this._state === "closed") throw new Error("Browser MCP server is shutting down");

    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.connectionWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.connectionWaiters.add(done);
    });

    if (this.connection?.isOpen) return this.connection;
    if (this._state === "standby") throw new Error(this.standbyReason);
    throw new Error(NO_CONNECTION_MESSAGE);
  }

  async close(): Promise<void> {
    if (this._state === "closed") return;
    this._state = "closed";
    clearInterval(this.standbyTimer);
    this.connection?.close();
    this.connection = undefined;
    for (const client of this.wss.clients) client.terminate();
    await Promise.all([closeWss(this.wss), this.closeServers()]);
    for (const waiter of this.connectionWaiters) waiter();
  }

  private async tryListen(): Promise<boolean> {
    if (this._state === "closed") return false;
    // Some systems (macOS) let us bind 127.0.0.1 even while another process
    // holds the wildcard address on the same port, which would silently steal
    // the extension from it. Probe the wildcard first to detect that case.
    if (await isWildcardTaken(this.port)) return false;
    const servers: http.Server[] = [];
    for (const host of LOOPBACK_HOSTS) {
      const server = http.createServer((_req, res) => {
        res.writeHead(426, { "content-type": "text/plain" });
        res.end("Browser MCP: WebSocket endpoint\n");
      });
      server.on("upgrade", (req, socket, head) =>
        this.onUpgrade(req, socket, head),
      );
      const error = await listen(server, this.port, host);
      if (!error) {
        servers.push(server);
        continue;
      }
      if (host !== LOOPBACK_HOSTS[0] && IGNORABLE_BIND_ERRORS.has(error.code ?? "")) {
        log.debug(`Skipping ${host}: ${error.code}`);
        continue;
      }
      await Promise.all(servers.map(closeServer));
      if (error.code !== "EADDRINUSE") {
        log.error(`Cannot listen on ${host}:${this.port}:`, error.message);
      }
      return false;
    }
    this.servers = servers;
    this._state = "active";
    clearInterval(this.standbyTimer);
    this.standbyTimer = undefined;
    log.info(`Waiting for the browser extension on ws://localhost:${this.port}`);
    return true;
  }

  private async retryListen(totalMs: number): Promise<boolean> {
    const deadline = Date.now() + totalMs;
    do {
      if (await this.tryListen()) return true;
      await sleep(100);
    } while (Date.now() < deadline);
    return false;
  }

  private enterStandby(reason: string) {
    if (this._state === "closed") return;
    this._state = "standby";
    this.standbyReason = reason;
    log.info(reason);
    clearInterval(this.standbyTimer);
    let busy = false;
    this.standbyTimer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        if (await this.tryListen()) log.info(`Port ${this.port} is free again; resumed`);
      } finally {
        busy = false;
      }
    }, this.options.standbyRetryMs);
    this.standbyTimer.unref();
  }

  private onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer) {
    const origin = req.headers.origin;

    if (req.headers[TAKEOVER_HEADER] && origin === undefined) {
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onTakeover(ws));
      return;
    }

    if (!origin || !this.options.allowedOrigins.includes(origin)) {
      log.info(`Rejected WebSocket connection from origin ${origin ?? "(none)"}`);
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => this.onExtension(ws));
  }

  private onExtension(ws: WebSocket) {
    // The extension drives a single tab; a new connection supersedes the old one.
    this.connection?.close();
    const connection = new ExtensionConnection(ws);
    this.connection = connection;
    log.info("Browser extension connected");
    ws.on("close", () => {
      if (this.connection === connection) {
        this.connection = undefined;
        log.info("Browser extension disconnected");
      }
    });
    for (const waiter of this.connectionWaiters) waiter();
  }

  private async onTakeover(ws: WebSocket) {
    log.info("Another Browser MCP server requested the port; handing it over");
    this.connection?.close();
    this.connection = undefined;
    for (const client of this.wss.clients) {
      if (client !== ws) client.terminate();
    }
    // Acknowledge first so the frame is not lost when our sockets are torn down;
    // the requester keeps retrying the bind until we have released the port.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      ws.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.close(TAKEOVER_ACK_CODE, "released");
    });
    await this.closeServers();
    this.enterStandby(
      "Another Browser MCP server (started by a different MCP client) took over the browser connection. " +
        "This server resumes automatically once that one exits.",
    );
  }

  private async closeServers() {
    const servers = this.servers;
    this.servers = [];
    await Promise.all(servers.map(closeServer));
  }
}

/** Asks the server currently bound to `port` to release it. */
async function requestTakeover(port: number): Promise<boolean> {
  for (const host of ["127.0.0.1", "[::1]"]) {
    const acknowledged = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://${host}:${port}`, {
        headers: { [TAKEOVER_HEADER]: "1" },
      });
      const timer = setTimeout(() => {
        ws.terminate();
        resolve(false);
      }, 3_000);
      ws.on("close", (code) => {
        clearTimeout(timer);
        resolve(code === TAKEOVER_ACK_CODE);
      });
      ws.on("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    if (acknowledged) return true;
  }
  return false;
}

/** Terminates the processes listening on `port`, never this process. Returns their PIDs. */
export function killPortOwners(port: number): number[] {
  const pids = findListeningPids(port).filter((pid) => pid !== process.pid);
  const killed: number[] = [];
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
      killed.push(pid);
    } catch (error) {
      log.error(`Could not terminate PID ${pid}:`, (error as Error).message);
    }
  }
  return killed;
}

function findListeningPids(port: number): number[] {
  try {
    if (process.platform === "win32") {
      const output = execFileSync("netstat", ["-ano", "-p", "TCP"], {
        encoding: "utf8",
        windowsHide: true,
      });
      return parseNetstatPids(output, port);
    }
    const output = execFileSync(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return uniquePids(output.split(/\s+/));
  } catch {
    // lsof exits with 1 when nothing matches; netstat may be unavailable.
    return [];
  }
}

export function parseNetstatPids(output: string, port: number): number[] {
  const pids: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    // Proto  Local Address  Foreign Address  State  PID
    if (columns.length < 5 || columns[3] !== "LISTENING") continue;
    if (columns[1].endsWith(`:${port}`)) pids.push(columns[4]);
  }
  return uniquePids(pids);
}

function uniquePids(values: string[]): number[] {
  const pids = values.map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
  return [...new Set(pids)];
}

async function isWildcardTaken(port: number): Promise<boolean> {
  for (const host of ["::", "0.0.0.0"]) {
    const probe = net.createServer();
    const error = await listen(probe, port, host);
    if (!error) {
      await new Promise((resolve) => probe.close(resolve));
      return false;
    }
    if (error.code === "EADDRINUSE") return true;
    // e.g. IPv6 disabled: try the IPv4 wildcard instead.
  }
  return false;
}

function listen(
  server: net.Server,
  port: number,
  host: string,
): Promise<NodeJS.ErrnoException | undefined> {
  return new Promise((resolve) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      resolve(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(undefined);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ port, host, exclusive: true });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function closeWss(wss: WebSocketServer): Promise<void> {
  return new Promise((resolve) => wss.close(() => resolve()));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
