import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer } from "ws";

import {
  APP_NAME,
  DEFAULT_ALLOWED_ORIGINS,
  HUB_HEADER,
  HUB_PROTOCOL,
  HUB_SETTLE_MS,
  NO_CONNECTION_MESSAGE,
  PROFILE_CLAIM_PATH,
  PROFILE_OPEN_TIMEOUT_MS,
  SESSION_HEADER,
  SESSION_NAME_HEADER,
  SESSIONS_UPDATE_DELAY_MS,
  TABREIN_HUB_HEADER,
  TAKEOVER_ACK_CODE,
  TAKEOVER_HEADER,
} from "./config";
import {
  HUB_EXTENSION_STATUS,
  HUB_OPEN_PROFILE,
  HubClient,
  type BrowserSummary,
  type ForeignExtension,
  type HubStatus,
} from "./hub-client";
import { log } from "./log";
import {
  chromeLauncher,
  ChromeProfiles,
  defaultUserDataDir,
  findProfile,
  identifyProfile,
  type ChromeProfile,
  type ProfileHint,
  type ProfileLauncher,
} from "./profiles";
import {
  ExtensionConnection,
  SessionChannel,
  type Channel,
  type ExtensionEvent,
  type ExtensionInfo,
  type MessageType,
  type ProfileSetPayload,
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
  /** Chrome's user data directory, whose `Local State` lists the profiles. */
  chromeUserDataDir?: string;
  /** Chrome executable used to open profiles (default: Google Chrome). */
  chromePath?: string;
  /** Opens a Chrome profile at a URL; tests replace it. */
  launchProfile?: ProfileLauncher;
  /** Profile to work in until browser_profile_select picks another: folder, name or account email. */
  profile?: string;
};

/**
 * hub: owns the port; the extensions and other sessions connect to it.
 * client: reaches the extensions through the hub.
 * standby: the port is held by something else; retrying.
 */
export type BridgeState = "starting" | "hub" | "client" | "standby" | "closed";

/** What browser_profiles shows. */
export type ProfileView = {
  userDataDir: string;
  profiles: ChromeProfile[];
  browsers: BrowserSummary[];
  /** Profile this session works in (chosen, or settled on), if known. */
  current?: string;
  /** The session chose `current` itself (browser_profile_select or --profile). */
  chosen: boolean;
  foreign: ForeignExtension[];
};

/**
 * Hosts we listen on. The extension connects to `ws://localhost:<port>`, and
 * browsers may resolve `localhost` to either address family.
 */
const LOOPBACK_HOSTS = ["127.0.0.1", "::1"] as const;

const IGNORABLE_BIND_ERRORS = new Set(["EADDRNOTAVAIL", "EAFNOSUPPORT"]);

/** How long a turned-away extension is mentioned in browser_profiles. */
const FOREIGN_MEMORY_MS = 120_000;

const BROWSER_GONE_MESSAGE = "The browser extension of that Chrome profile disconnected. Retry the tool call.";

type SessionClient = { ws: WebSocket; session: SessionIdentity };

/** An extension connected to this hub: one Chrome profile. */
type Browser = {
  key: string;
  connection: ExtensionConnection;
  /** Chrome profile folder, once known. */
  profile?: string;
  /** Introduced itself (or turned out to be the original extension) and was identified. */
  ready: boolean;
};

/** A profile this hub opened, waiting for its extension to report back. */
type Claim = { directory: string; session: SessionIdentity; done: (error?: Error) => void };

/** The browser a session settled on without choosing a profile. */
type Pin = { key: string; installId?: string; profile?: string };

/**
 * Connects this server's agent session to the browser extensions.
 *
 * The first server to start becomes the hub: it owns the local WebSocket
 * endpoint the extensions connect to, one per Chrome profile. Servers started
 * later (other agents) join the hub and send their requests through it,
 * tagged with their session id and the browser they work in, so every agent
 * works in its own tab. When the hub exits, one of the others takes its place
 * and the extensions reconnect to it.
 */
export class ExtensionBridge {
  private readonly options: Required<Omit<BridgeOptions, "chromeUserDataDir" | "chromePath" | "launchProfile" | "profile">> &
    BridgeOptions;
  private readonly wss = new WebSocketServer({ noServer: true });
  private servers: http.Server[] = [];
  private readonly browsers = new Map<string, Browser>();
  private nextBrowserId = 0;
  private hubClient: HubClient | undefined;
  private readonly clients = new Map<string, SessionClient>();
  private readonly claims = new Map<string, Claim>();
  private readonly foreign = new Map<string, ForeignExtension & { seen: number }>();
  private readonly loggedOnce = new Set<string>();
  private connectionWaiters = new Set<() => void>();
  private standbyTimer: NodeJS.Timeout | undefined;
  private sessionsTimer: NodeJS.Timeout | undefined;
  private standbyReason = "";
  private electing = false;
  private hubSince = 0;
  private _state: BridgeState = "starting";
  private readonly launch: ProfileLauncher;
  readonly profiles: ChromeProfiles;
  /** Profile folder this session works in, chosen with browser_profile_select or --profile. */
  private selected: string | undefined;
  /** --profile, resolved against the profile list on first use. */
  private profileQuery: string | undefined;
  private pinned: Pin | undefined;

  constructor(options: BridgeOptions) {
    this.options = {
      allowedOrigins: DEFAULT_ALLOWED_ORIGINS,
      takeover: true,
      killExisting: false,
      standbyRetryMs: 2_000,
      session: { id: "default", name: "default" },
      ...options,
    };
    const userDataDir = options.chromeUserDataDir ?? defaultUserDataDir();
    this.profiles = new ChromeProfiles(userDataDir);
    this.launch = options.launchProfile ?? chromeLauncher({ userDataDir, chromePath: options.chromePath });
    this.profileQuery = options.profile;
    // Lets other servers tell this hub from another program on the same port.
    this.wss.on("headers", (headers) => headers.push(`${HUB_HEADER}: ${HUB_PROTOCOL}`));
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

  /** Whether this server can currently reach an extension. */
  get isConnected(): boolean {
    return this.reachable().length > 0;
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

    let holder: HubProbe = "none";
    if (this.options.takeover) {
      holder = await probeHub(this.port);
      if (holder === "plus" && (await this.tryJoin())) return;
      // Not a hub that accepts sessions: maybe an older browsermcp-plus (<= 0.4).
      if (holder !== "plus" && (await requestTakeover(this.port))) {
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

    this.enterStandby(this.portBusyReason(holder));
  }

  /** This session's way to the extension of the browser (profile) it works in. */
  async getChannel(timeoutMs: number): Promise<Channel> {
    if (this._state === "closed") throw new Error("browsermcp-plus is shutting down");
    const deadline = Date.now() + timeoutMs;
    const selected = await this.selectedProfile();
    for (;;) {
      const final = Date.now() >= deadline;
      const target = await this.choose(this.reachable(), selected, final);
      const channel = target && this.channelTo(target);
      if (channel) return channel;
      if (final) break;
      await this.waitForChange(Math.max(0, deadline - Date.now()));
    }
    if (this._state === "standby") throw new Error(this.standbyReason);
    if (selected && this.isConnected) {
      throw new Error(
        `Chrome profile "${selected}" is not open, or the Browser MCP Plus extension is not connected in it. ` +
          `Call browser_profile_select to open it again, or pick another profile.`,
      );
    }
    throw new Error(NO_CONNECTION_MESSAGE);
  }

  /**
   * Works in another Chrome profile from now on. Opens the profile (a Chrome
   * window, and a tab for this session) if its extension is not connected.
   */
  async selectProfile(query: string): Promise<{ profile: ChromeProfile; opened: boolean }> {
    const profile = findProfile(await this.profiles.list(), query);
    this.selected = profile.directory;
    this.profileQuery = undefined;
    this.pinned = undefined;
    if (this.reachable().some((b) => b.profile === profile.directory)) return { profile, opened: false };
    await this.openProfile(profile.directory);
    // A joined session learns the new mapping from the hub's next status.
    await this.waitUntil(() => this.reachable().some((b) => b.profile === profile.directory), 3_000);
    return { profile, opened: true };
  }

  /** The Chrome profiles and which of them are connected, for browser_profiles. */
  async profileView(): Promise<ProfileView> {
    const profiles = await this.profiles.list();
    const browsers = this.reachable();
    const selected = await this.selectedProfile().catch(() => undefined);
    const pinned = this.pinned && browsers.find((b) => matchesPin(b, this.pinned!));
    return {
      userDataDir: this.profiles.userDataDir,
      profiles,
      browsers,
      current: selected ?? pinned?.profile,
      chosen: !!selected,
      foreign: this._state === "client" ? (this.hubClient?.foreign ?? []) : this.foreignList(),
    };
  }

  async close(): Promise<void> {
    if (this._state === "closed") return;
    const wasHub = this._state === "hub";
    this._state = "closed";
    clearInterval(this.standbyTimer);
    clearTimeout(this.sessionsTimer);
    for (const claim of this.claims.values()) claim.done(new Error("browsermcp-plus is shutting down"));
    this.claims.clear();
    // Tell the extensions right away that this session ended, so they close its
    // tabs; the remaining sessions elect a new hub, which reports them.
    if (wasHub) await this.sendSessions(this.clientSessions, 1_000);
    this.hubClient?.close();
    for (const browser of this.browsers.values()) browser.connection.close();
    this.browsers.clear();
    for (const client of this.wss.clients) client.terminate();
    await Promise.all([closeWss(this.wss), this.closeServers()]);
    this.notifyChange();
  }

  // --- Choosing the browser to work in -----------------------------------

  /** Browsers this session can reach right now. */
  private reachable(): BrowserSummary[] {
    if (this._state === "hub") {
      return [...this.browsers.values()].filter((b) => b.connection.isOpen).map(summarize);
    }
    if (this._state === "client") return this.hubClient?.browsers ?? [];
    return [];
  }

  private async selectedProfile(): Promise<string | undefined> {
    if (this.selected || !this.profileQuery) return this.selected;
    this.selected = findProfile(await this.profiles.list(), this.profileQuery).directory;
    this.profileQuery = undefined;
    return this.selected;
  }

  /**
   * The chosen profile's browser; without a choice, the browser this session
   * already works in, else the profile Chrome used last (else the first).
   */
  private async choose(browsers: BrowserSummary[], selected: string | undefined, final: boolean) {
    if (selected) return browsers.find((b) => b.profile === selected);
    if (this.pinned) {
      const pinned = browsers.find((b) => matchesPin(b, this.pinned!));
      if (pinned) {
        this.pinned = pinOf(pinned);
        return pinned;
      }
      // It may be reconnecting; move to another profile only as a last resort.
      if (!final) return undefined;
    }
    if (!browsers.length) return undefined;
    // With several profiles, wait until each has said which one it is.
    if (browsers.length > 1 && browsers.some((b) => !b.ready) && !final) return undefined;
    const lastUsed = (await this.profiles.list()).find((p) => p.lastUsed)?.directory;
    const choice = browsers.find((b) => b.profile !== undefined && b.profile === lastUsed) ?? browsers[0];
    this.pinned = pinOf(choice);
    return choice;
  }

  private channelTo(target: BrowserSummary): Channel | undefined {
    if (this._state === "hub") {
      const browser = this.browsers.get(target.key);
      return browser?.connection.isOpen ? new SessionChannel(browser.connection, this.session) : undefined;
    }
    if (this._state === "client" && this.hubClient) return this.hubClient.channel(target.key);
    return undefined;
  }

  private async openProfile(directory: string): Promise<void> {
    if (this._state === "hub") return this.openProfileAsHub(directory, this.session);
    if (this._state === "client" && this.hubClient) {
      await this.hubClient.openProfile(directory, PROFILE_OPEN_TIMEOUT_MS + 5_000);
      return;
    }
    if (this._state === "standby") throw new Error(this.standbyReason);
    throw new Error("Not connected to the browser yet. Retry in a moment.");
  }

  private async waitUntil(condition: () => boolean, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (!condition() && Date.now() < deadline) await this.waitForChange(deadline - Date.now());
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
      const server = http.createServer((req, res) => this.onHttp(req, res));
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
    this.hubSince = Date.now();
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

  private portBusyReason(holder: HubProbe): string {
    if (holder === "other") {
      return (
        `Port ${this.port} is in use by another browser server that is not browsermcp-plus 0.6 or newer ` +
        `(for example Tabrein MCP, or an older browsermcp-plus or Browser MCP). Close or restart the agent sessions ` +
        `that run it; this server takes the port over as soon as it is free.`
      );
    }
    return (
      `Port ${this.port} is in use by another process, so the browser extension cannot reach this server. ` +
      `If it is an older Browser MCP server (0.1.x), update or stop it, or restart this server with --kill-existing.`
    );
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
        const resumed =
          (await this.tryListen()) ||
          (this.options.takeover && (await probeHub(this.port)) === "plus" && (await this.tryJoin()));
        if (resumed) log.info(`Reached the browser again on port ${this.port}; resumed`);
      } finally {
        busy = false;
      }
    }, this.options.standbyRetryMs);
    this.standbyTimer.unref();
  }

  private onHttp(req: http.IncomingMessage, res: http.ServerResponse) {
    res.setHeader(HUB_HEADER, String(HUB_PROTOCOL));
    if (req.method === "GET" && req.url?.startsWith(PROFILE_CLAIM_PATH)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(CLAIM_PAGE);
      return;
    }
    res.writeHead(426, { "content-type": "text/plain" });
    res.end("browsermcp-plus: WebSocket endpoint\n");
  }

  private onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer) {
    const origin = req.headers.origin;
    const sessionId = req.headers[SESSION_HEADER];

    if (origin === undefined && req.headers[TABREIN_HUB_HEADER] !== undefined) {
      // Tabrein MCP is a fork that speaks a different dialect; it cannot share our extensions.
      this.logOnce(
        "tabrein-session",
        "A Tabrein MCP server tried to share this browser; it cannot. Restart the agent sessions that still run Tabrein MCP.",
      );
      socket.end("HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n");
      return;
    }

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
      // Other extensions (e.g. Tabrein) retry every second: say it once.
      this.logOnce(`origin:${origin}`, `Rejected WebSocket connections from origin ${origin ?? "(none)"}`);
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => this.onExtension(ws));
  }

  private logOnce(key: string, message: string) {
    if (this.loggedOnce.has(key)) return log.debug(message);
    this.loggedOnce.add(key);
    log.info(message);
  }

  // --- Extensions (one per Chrome profile) ---------------------------------

  private onExtension(ws: WebSocket) {
    const connection = new ExtensionConnection(ws);
    const browser: Browser = { key: `b${(this.nextBrowserId++).toString(36)}`, connection, ready: false };
    this.browsers.set(browser.key, browser);
    const introduced = connection.ready.then(() => this.introduce(browser));
    connection.onEvent((event) => void introduced.then(() => this.onBrowserEvent(browser, event)));
    ws.on("close", () => {
      if (this.browsers.get(browser.key) !== browser) return;
      this.browsers.delete(browser.key);
      log.info(`Browser extension disconnected${browser.profile ? ` (Chrome profile "${browser.profile}")` : ""}`);
      this.browsersChanged();
    });
    this.browsersChanged();
  }

  /** After `hello`: turns away other extensions, replaces reconnects, finds the profile. */
  private async introduce(browser: Browser) {
    const { connection } = browser;
    if (!this.isCurrent(browser)) return;
    const info = connection.info;
    if (info && info.name !== APP_NAME) return this.turnAway(browser, info);

    // One connection per extension: a reconnect replaces the previous one.
    for (const other of [...this.browsers.values()]) {
      if (other === browser || !other.ready) continue;
      const same = info?.installId ? other.connection.info?.installId === info.installId : !info && !other.connection.info;
      if (!same) continue;
      this.browsers.delete(other.key);
      other.connection.close();
    }

    if (info) {
      const profiles = await this.profiles.list();
      browser.profile = identifyProfile(profiles, hintOf(info), this.profiles.userDataDir);
      if (!this.isCurrent(browser)) return;
    }
    browser.ready = true;
    if (browser.profile) this.assignProfile(browser, browser.profile);
    log.info(
      `Browser extension connected${info ? ` (${info.name} ${info.version})` : ""}` +
        (browser.profile ? ` in Chrome profile "${browser.profile}"` : info ? ", Chrome profile not known yet" : ""),
    );
    if (browser.profile && info?.profile?.directory !== browser.profile) void this.tellProfile(browser);
    this.browsersChanged();
    this.scheduleSessionsUpdate();
  }

  private isCurrent(browser: Browser) {
    return this.browsers.get(browser.key) === browser && browser.connection.isOpen;
  }

  private async turnAway(browser: Browser, info: ExtensionInfo) {
    this.browsers.delete(browser.key);
    browser.connection.ws.close(4003, "Only the Browser MCP Plus extension can connect");
    browser.connection.close();
    const profile = identifyProfile(await this.profiles.list(), hintOf(info), this.profiles.userDataDir);
    this.foreign.set(`${info.name}|${profile ?? ""}`, { name: info.name, version: info.version, profile, seen: Date.now() });
    this.logOnce(
      `foreign:${info.name}:${profile ?? ""}`,
      `Turned away the "${info.name}" ${info.version} extension${profile ? ` of Chrome profile "${profile}"` : ""}: ` +
        `it uses the same port. Turn it off in that profile and use Browser MCP Plus there.`,
    );
    this.browsersChanged();
  }

  private foreignList(): ForeignExtension[] {
    const recent = Date.now() - FOREIGN_MEMORY_MS;
    return [...this.foreign.values()].filter((f) => f.seen > recent).map(({ seen: _seen, ...rest }) => rest);
  }

  /** `browser` runs in profile `directory`; no other connection does. */
  private assignProfile(browser: Browser, directory: string) {
    for (const other of this.browsers.values()) {
      if (other !== browser && other.profile === directory) other.profile = undefined;
    }
    browser.profile = directory;
  }

  /** Lets the extension remember its profile (and adopt the tab opened for a session). */
  private async tellProfile(browser: Browser, adopt?: ProfileSetPayload["adopt"]) {
    if (!browser.profile || !browser.connection.supports("profile_set")) return;
    const profile = (await this.profiles.list()).find((p) => p.directory === browser.profile);
    const payload: ProfileSetPayload = {
      profile: { directory: browser.profile, name: profile?.name ?? browser.profile, userDataDir: this.profiles.userDataDir },
      ...(adopt ? { adopt } : {}),
    };
    await browser.connection.request("profile_set", payload, 5_000).catch((error: Error) => {
      log.debug("profile_set failed:", error.message);
    });
  }

  private async onBrowserEvent(browser: Browser, event: ExtensionEvent) {
    if (event.type !== "profile_claim") return;
    const { token, tabId } = (event.payload ?? {}) as { token?: unknown; tabId?: unknown };
    const claim = typeof token === "string" ? this.claims.get(token) : undefined;
    if (!claim) return;
    this.claims.delete(token as string);
    if (!this.isCurrent(browser)) return claim.done(new Error(BROWSER_GONE_MESSAGE));
    this.assignProfile(browser, claim.directory);
    log.info(`Chrome profile "${claim.directory}" reported back from the tab opened for "${claim.session.name}"`);
    const adopt =
      typeof tabId === "number" ? { tabId, sessionId: claim.session.id, sessionName: claim.session.name } : undefined;
    await this.tellProfile(browser, adopt);
    this.browsersChanged();
    claim.done();
  }

  /**
   * Opens Chrome profile `directory` at a hub URL with a one-time token and
   * waits for the profile's extension to report it: that tells which
   * connection runs in the profile, even without a Google account to match.
   */
  private async openProfileAsHub(directory: string, session: SessionIdentity): Promise<void> {
    const token = randomBytes(18).toString("base64url");
    const url = `http://127.0.0.1:${this.port}${PROFILE_CLAIM_PATH}${token}`;
    let timer: NodeJS.Timeout | undefined;
    const claimed = new Promise<void>((resolve, reject) => {
      this.claims.set(token, { directory, session, done: (error) => (error ? reject(error) : resolve()) });
      timer = setTimeout(() => {
        reject(
          new Error(
            `Opened Chrome profile "${directory}", but the Browser MCP Plus extension did not answer from it within ` +
              `${PROFILE_OPEN_TIMEOUT_MS / 1000} s. Make sure the extension is installed and turned on in that profile ` +
              `(chrome://extensions), then call browser_profile_select again.`,
          ),
        );
      }, PROFILE_OPEN_TIMEOUT_MS);
    });
    try {
      log.info(`Opening Chrome profile "${directory}" for "${session.name}"`);
      await this.launch(directory, url);
      await claimed;
    } finally {
      clearTimeout(timer);
      this.claims.delete(token);
    }
  }

  private browsersChanged() {
    this.broadcastStatus();
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

  /** Forwards a session's request to the extension it works in, and the answer back. */
  private async relay(client: SessionClient, raw: string) {
    let message: { id?: unknown; type?: unknown; payload?: unknown; timeoutMs?: unknown; target?: unknown };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof message.id !== "string" || typeof message.type !== "string") return;
    const timeoutMs = typeof message.timeoutMs === "number" ? message.timeoutMs : 30_000;
    let response: { requestId: string; result?: unknown; error?: string };
    try {
      let result: unknown;
      if (message.type === HUB_OPEN_PROFILE) {
        const directory = (message.payload as { directory?: unknown } | undefined)?.directory;
        if (typeof directory !== "string" || !directory) throw new Error("No profile given");
        await this.openProfileAsHub(directory, client.session);
        result = { ok: true };
      } else {
        const browser =
          typeof message.target === "string" ? this.browsers.get(message.target) : this.browsers.values().next().value;
        if (!browser?.connection.isOpen) {
          throw new Error(typeof message.target === "string" ? BROWSER_GONE_MESSAGE : NO_CONNECTION_MESSAGE);
        }
        result = await browser.connection.request(
          message.type as MessageType,
          message.payload as never,
          timeoutMs,
          client.session,
        );
      }
      response = { requestId: message.id, result };
    } catch (error) {
      response = { requestId: message.id, error: error instanceof Error ? error.message : String(error) };
    }
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify({ type: "messageResponse", payload: response }));
    }
  }

  private hubStatus(): HubStatus {
    const browsers = this.reachable();
    return { connected: browsers.length > 0, browsers, foreign: this.foreignList() };
  }

  private sendStatus(ws: WebSocket) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: HUB_EXTENSION_STATUS, payload: this.hubStatus() }));
    }
  }

  private broadcastStatus() {
    for (const client of this.clients.values()) this.sendStatus(client.ws);
  }

  /** Tells the extensions which sessions are alive so they close the others' tabs. */
  private scheduleSessionsUpdate() {
    clearTimeout(this.sessionsTimer);
    // A new hub first gives the sessions of the previous one time to rejoin.
    const delay = Math.max(SESSIONS_UPDATE_DELAY_MS, this.hubSince + HUB_SETTLE_MS - Date.now());
    this.sessionsTimer = setTimeout(() => {
      if (this._state !== "hub") return;
      void this.sendSessions([this.session, ...this.clientSessions], 5_000);
    }, delay);
    this.sessionsTimer.unref();
  }

  private async sendSessions(sessions: SessionIdentity[], timeoutMs: number) {
    const targets = [...this.browsers.values()].filter((b) => b.connection.isOpen && b.connection.supports("sessions_update"));
    await Promise.all(
      targets.map((b) =>
        b.connection.request("sessions_update", { sessions }, timeoutMs).catch((error: Error) => {
          log.debug("sessions_update failed:", error.message);
        }),
      ),
    );
  }

  // --- Joining a hub ------------------------------------------------------

  /** Connects to the running hub as another session. */
  private async tryJoin(): Promise<boolean> {
    if (this._state === "closed") return false;
    for (const host of ["127.0.0.1", "[::1]"]) {
      const socket = new WebSocket(`ws://${host}:${this.port}`, {
        headers: {
          [SESSION_HEADER]: this.session.id,
          [SESSION_NAME_HEADER]: encodeURIComponent(this.session.name),
        },
      });
      let isHub = false;
      socket.once("upgrade", (response) => (isHub = response.headers[HUB_HEADER] !== undefined));
      // Listen before the socket opens: the hub sends the extensions' status
      // right away, possibly in the same packet as the handshake.
      let joined = false;
      const client = new HubClient(socket, {
        onClose: () => {
          if (joined) void this.elect();
        },
        onStatus: () => {
          if (joined) this.notifyChange();
        },
      });
      const opened = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          socket.terminate();
          resolve(false);
        }, 2_000);
        socket.once("open", () => {
          clearTimeout(timer);
          resolve(true);
        });
        socket.once("unexpected-response", () => {
          clearTimeout(timer);
          socket.terminate();
          resolve(false);
        });
        socket.once("error", () => {
          clearTimeout(timer);
          resolve(false);
        });
      });
      if (!opened) continue;
      if (!isHub || (this._state as BridgeState) === "closed") {
        // Another program accepted the connection (e.g. a Tabrein MCP hub).
        client.close();
        return false;
      }
      joined = true;
      this.hubClient = client;
      this._state = "client";
      clearInterval(this.standbyTimer);
      this.standbyTimer = undefined;
      log.info(`Joined the browsermcp-plus server on port ${this.port} as agent "${this.session.name}"`);
      await Promise.race([client.ready, sleep(1_000)]);
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

function summarize(browser: Browser): BrowserSummary {
  return {
    key: browser.key,
    ...(browser.profile ? { profile: browser.profile } : {}),
    ...(browser.connection.info ? { info: browser.connection.info } : {}),
    ready: browser.ready,
  };
}

function pinOf(browser: BrowserSummary): Pin {
  return { key: browser.key, installId: browser.info?.installId, profile: browser.profile };
}

/** Same extension, even after it reconnected (new key) or was identified (new profile). */
function matchesPin(browser: BrowserSummary, pin: Pin) {
  return (
    browser.key === pin.key ||
    (!!pin.installId && browser.info?.installId === pin.installId) ||
    (!!pin.profile && browser.profile === pin.profile)
  );
}

function hintOf(info: ExtensionInfo): ProfileHint {
  return {
    directory: info.profile?.directory,
    userDataDir: info.profile?.userDataDir,
    // Other extensions (Tabrein) send the account as profile.email.
    email: info.account?.email ?? info.profile?.email,
    gaiaId: info.account?.id,
  };
}

/** Shown in the tab a profile is opened with, until its extension takes the tab over. */
const CLAIM_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Browser MCP Plus</title>
<style>body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:34rem;margin:15vh auto;padding:0 1rem;color:#24292f}h1{font-size:1.2rem}</style>
</head><body><h1>Browser MCP Plus</h1>
<p>An AI agent is opening this Chrome profile. The Browser MCP Plus extension takes this tab over in a moment.</p>
<p>If this page stays, the extension is not installed or not turned on in this profile: open <code>chrome://extensions</code>, turn on Developer mode, choose <b>Load unpacked</b> and pick the extension folder.</p>
</body></html>
`;

type HubProbe = "plus" | "other" | "none";

/** Who holds the port: a browsermcp-plus hub, some other server, or nobody answering HTTP. */
async function probeHub(port: number): Promise<HubProbe> {
  for (const host of ["127.0.0.1", "::1"]) {
    const result = await new Promise<HubProbe>((resolve) => {
      const req = http.get({ host, port, path: "/", timeout: 1_000 }, (res) => {
        res.resume();
        resolve(res.headers[HUB_HEADER] !== undefined ? "plus" : "other");
      });
      req.on("timeout", () => {
        req.destroy();
        resolve("other");
      });
      req.on("error", () => resolve("none"));
    });
    if (result !== "none") return result;
  }
  return "none";
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
