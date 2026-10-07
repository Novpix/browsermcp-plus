import { execFileSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer } from "ws";

import {
  DEFAULT_ALLOWED_ORIGINS,
  NO_CONNECTION_MESSAGE,
  SESSION_HEADER,
  SESSION_NAME_HEADER,
  SESSIONS_UPDATE_DELAY_MS,
  TAKEOVER_ACK_CODE,
  TAKEOVER_HEADER,
} from "./config";
import { HUB_EXTENSION_STATUS, HubClient, type ExtensionStatus } from "./hub-client";
import { log } from "./log";
import {
  ExtensionConnection,
  SessionChannel,
  type Channel,
  type MessageType,
  type SessionIdentity,
} from "./protocol";

export type BridgeOptions = {
  port: number;
  /** This server's agent session. */
  session?: SessionIdentity;
  /** Origins allowed to connect as the extension. */
  allowedOrigins?: string[];
  /**
   * Share the browser with a server that is already running (join it as
   * another session, or ask an older version to hand over the port).
   */
  takeover?: boolean;
  /**
   * Terminate whatever process listens on the port if it is not a
   * browsermcp-plus server (e.g. Browser MCP <= 0.1.x). Off by default.
   */
  killExisting?: boolean;
  /** How often to retry while in standby. */
  standbyRetryMs?: number;
};

/**
 * hub: owns the port; the extension and other sessions connect to it.
 * client: reaches the extension through the hub.
 * standby: the port is held by something else; retrying.
 */
export type BridgeState = "starting" | "hub" | "client" | "standby" | "closed";

/**
 * Hosts we listen on. The extension connects to `ws://localhost:<port>`, and
 * browsers may resolve `localhost` to either address family.
 */
const LOOPBACK_HOSTS = ["127.0.0.1", "::1"] as const;

const IGNORABLE_BIND_ERRORS = new Set(["EADDRNOTAVAIL", "EAFNOSUPPORT"]);

type SessionClient = { ws: WebSocket; session: SessionIdentity };

/**
 * Connects this server's agent session to the browser extension.
 *
 * The first server to start becomes the hub: it owns the local WebSocket
 * endpoint the extension connects to. Servers started later (other agents)
 * join the hub and send their requests through it, tagged with their session
 * id, so every agent works in its own tab. When the hub exits, one of the
 * others takes its place and the extension reconnects to it.
 */
export class ExtensionBridge {
  private readonly options: Required<BridgeOptions>;
  private readonly wss = new WebSocketServer({ noServer: true });
  private servers: http.Server[] = [];
  private connection: ExtensionConnection | undefined;
  private hubClient: HubClient | undefined;
  private readonly clients = new Map<string, SessionClient>();
  private connectionWaiters = new Set<() => void>();
  private standbyTimer: NodeJS.Timeout | undefined;
  private sessionsTimer: NodeJS.Timeout | undefined;
  private standbyReason = "";
  private electing = false;
  private _state: BridgeState = "starting";

  constructor(options: BridgeOptions) {
    this.options = {
      allowedOrigins: DEFAULT_ALLOWED_ORIGINS,
      takeover: true,
      killExisting: false,
      standbyRetryMs: 2_000,
      session: { id: "default", name: "default" },
      ...options,
    };
  }

  get state(): BridgeState {
    return this._state;
  }

  get port(): number {
    return this.options.port;
  }

  get session(): SessionIdentity {
    return this.options.session;
  }

  /** Whether this server can currently reach the extension. */
  get isConnected(): boolean {
    if (this._state === "client") return !!this.hubClient?.extensionConnected;
    return !!this.connection?.isOpen;
  }

  /** Sessions connected to this hub besides its own. */
  get clientSessions(): SessionIdentity[] {
    return [...this.clients.values()].map((c) => c.session);
  }

  /**
   * Becomes the hub, or joins the running hub. Never throws because the port
   * is busy: in that case the bridge goes into standby and keeps retrying, so
   * the MCP server itself can still start and report a useful error from
   * tool calls.
   */
  async start(): Promise<void> {
    if (await this.tryListen()) return;

    if (this.options.takeover) {
      if (await this.tryJoin()) return;
      // Not a hub that accepts sessions: an older browsermcp-plus (<= 0.4).
      if (await requestTakeover(this.port)) {
        log.info(`Took over port ${this.port} from an older browsermcp-plus server`);
        if (await this.retryListen(3_000)) return;
      }
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

  /** This session's way to the extension, waiting up to `timeoutMs` for it to connect. */
  async getChannel(timeoutMs: number): Promise<Channel> {
    if (this._state === "closed") throw new Error("browsermcp-plus is shutting down");
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this._state === "hub" && this.connection?.isOpen) {
        return new SessionChannel(this.connection, this.session);
      }
      if (this._state === "client" && this.hubClient) {
        if (await this.hubClient.waitForExtension(Math.max(0, deadline - Date.now()))) return this.hubClient;
      } else {
        await this.waitForChange(Math.max(0, deadline - Date.now()));
      }
      if (Date.now() >= deadline) break;
    }
    if (this._state === "standby") throw new Error(this.standbyReason);
    throw new Error(NO_CONNECTION_MESSAGE);
  }

  async close(): Promise<void> {
    if (this._state === "closed") return;
    this._state = "closed";
    clearInterval(this.standbyTimer);
    clearTimeout(this.sessionsTimer);
    this.hubClient?.close();
    this.connection?.close();
    this.connection = undefined;
    for (const client of this.wss.clients) client.terminate();
    await Promise.all([closeWss(this.wss), this.closeServers()]);
    this.notifyChange();
  }

  private waitForChange(timeoutMs: number) {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.connectionWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.connectionWaiters.add(done);
    });
  }

  private notifyChange() {
    for (const waiter of this.connectionWaiters) waiter();
  }

  // --- Becoming the hub ---------------------------------------------------

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
        res.end("browsermcp-plus: WebSocket endpoint\n");
      });
      server.on("upgrade", (req, socket, head) => this.onUpgrade(req, socket, head));
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
    this._state = "hub";
    clearInterval(this.standbyTimer);
    this.standbyTimer = undefined;
    log.info(`Waiting for the browser extension on ws://localhost:${this.port}`);
    this.notifyChange();
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
        if ((await this.tryListen()) || (this.options.takeover && (await this.tryJoin()))) {
          log.info(`Reached the browser again on port ${this.port}; resumed`);
        }
      } finally {
        busy = false;
      }
    }, this.options.standbyRetryMs);
    this.standbyTimer.unref();
  }

  private onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer) {
    const origin = req.headers.origin;
    const sessionId = req.headers[SESSION_HEADER];

    // Requests from other local servers carry no Origin; browsers always send one.
    if (origin === undefined && typeof sessionId === "string" && sessionId) {
      const raw = req.headers[SESSION_NAME_HEADER];
      const name = typeof raw === "string" ? safeDecode(raw) : sessionId;
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onSessionClient(ws, { id: sessionId, name }));
      return;
    }

    if (origin === undefined && req.headers[TAKEOVER_HEADER]) {
      // An older browsermcp-plus (<= 0.4) asking for the port. Sharing replaced
      // taking over; it waits in standby until this hub exits.
      log.info("An older browsermcp-plus server asked to take over the port; update it to share the browser.");
      socket.end("HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n");
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
    // One extension per browser; a new connection supersedes the old one.
    this.connection?.close();
    const connection = new ExtensionConnection(ws);
    this.connection = connection;
    log.info("Browser extension connected");
    ws.on("close", () => {
      if (this.connection === connection) {
        this.connection = undefined;
        log.info("Browser extension disconnected");
        this.broadcastStatus();
      }
    });
    void connection.ready.then(() => {
      if (this.connection !== connection) return;
      this.broadcastStatus();
      this.scheduleSessionsUpdate();
    });
    this.notifyChange();
  }

  // --- Hub side of other sessions -----------------------------------------

  private onSessionClient(ws: WebSocket, session: SessionIdentity) {
    this.clients.get(session.id)?.ws.close();
    const client = { ws, session };
    this.clients.set(session.id, client);
    log.info(`Agent session "${session.name}" joined`);
    this.sendStatus(ws);
    this.scheduleSessionsUpdate();

    ws.on("message", (data) => void this.relay(client, data.toString()));
    ws.on("close", () => {
      if (this.clients.get(session.id) !== client) return;
      this.clients.delete(session.id);
      log.info(`Agent session "${session.name}" left`);
      this.scheduleSessionsUpdate();
    });
  }

  /** Forwards a session's request to the extension and its answer back. */
  private async relay(client: SessionClient, raw: string) {
    let message: { id?: unknown; type?: unknown; payload?: unknown; timeoutMs?: unknown };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof message.id !== "string" || typeof message.type !== "string") return;
    const timeoutMs = typeof message.timeoutMs === "number" ? message.timeoutMs : 30_000;
    let response: { requestId: string; result?: unknown; error?: string };
    try {
      const connection = this.connection;
      if (!connection?.isOpen) throw new Error(NO_CONNECTION_MESSAGE);
      const result = await connection.request(
        message.type as MessageType,
        message.payload as never,
        timeoutMs,
        client.session,
      );
      response = { requestId: message.id, result };
    } catch (error) {
      response = { requestId: message.id, error: error instanceof Error ? error.message : String(error) };
    }
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify({ type: "messageResponse", payload: response }));
    }
  }

  private extensionStatus(): ExtensionStatus {
    const connection = this.connection;
    return connection?.isOpen ? { connected: true, info: connection.info } : { connected: false };
  }

  private sendStatus(ws: WebSocket) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: HUB_EXTENSION_STATUS, payload: this.extensionStatus() }));
    }
  }

  private broadcastStatus() {
    for (const client of this.clients.values()) this.sendStatus(client.ws);
  }

  /** Tells the extension which sessions are alive so it frees the others' tabs. */
  private scheduleSessionsUpdate() {
    clearTimeout(this.sessionsTimer);
    this.sessionsTimer = setTimeout(() => {
      const connection = this.connection;
      if (!connection?.isOpen || !connection.supports("sessions_update")) return;
      const sessions = [this.session, ...this.clientSessions];
      connection.request("sessions_update", { sessions }, 5_000).catch((error) => {
        log.debug("sessions_update failed:", error.message);
      });
    }, SESSIONS_UPDATE_DELAY_MS);
    this.sessionsTimer.unref();
  }

  // --- Joining a hub ------------------------------------------------------

  /** Connects to the running hub as another session. */
  private async tryJoin(): Promise<boolean> {
    if (this._state === "closed") return false;
    for (const host of ["127.0.0.1", "[::1]"]) {
      const ws = await new Promise<WebSocket | undefined>((resolve) => {
        const socket = new WebSocket(`ws://${host}:${this.port}`, {
          headers: {
            [SESSION_HEADER]: this.session.id,
            [SESSION_NAME_HEADER]: encodeURIComponent(this.session.name),
          },
        });
        const timer = setTimeout(() => {
          socket.terminate();
          resolve(undefined);
        }, 2_000);
        socket.once("open", () => {
          clearTimeout(timer);
          resolve(socket);
        });
        socket.once("unexpected-response", () => {
          clearTimeout(timer);
          socket.terminate();
          resolve(undefined);
        });
        socket.once("error", () => {
          clearTimeout(timer);
          resolve(undefined);
        });
      });
      if (!ws) continue;
      if ((this._state as BridgeState) === "closed") {
        ws.close();
        return false;
      }
      this.hubClient = new HubClient(ws, () => void this.elect());
      this._state = "client";
      clearInterval(this.standbyTimer);
      this.standbyTimer = undefined;
      log.info(`Joined the browsermcp-plus server on port ${this.port} as agent "${this.session.name}"`);
      await Promise.race([this.hubClient.ready, sleep(1_000)]);
      this.notifyChange();
      return true;
    }
    return false;
  }

  /** The hub went away: become the hub, or join whichever server did. */
  private async elect() {
    if (this.electing || this._state === "closed") return;
    this.electing = true;
    this.hubClient = undefined;
    this._state = "starting";
    try {
      for (let attempt = 0; this._state === "starting"; attempt++) {
        // Spread out so the remaining servers don't all race for the port at once.
        await sleep(50 + Math.random() * 250 + Math.min(attempt, 10) * 100);
        if (this._state !== "starting") break;
        if (await this.tryListen()) {
          log.info("The previous hub exited; this server is now the hub");
          break;
        }
        if (await this.tryJoin()) break;
        if (attempt === 20) {
          this.enterStandby(`Lost the browsermcp-plus hub on port ${this.port} and could not replace it.`);
          break;
        }
      }
    } finally {
      this.electing = false;
    }
  }

  private async closeServers() {
    const servers = this.servers;
    this.servers = [];
    await Promise.all(servers.map(closeServer));
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Asks an older server (<= 0.4) bound to `port` to release it. */
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
