import { WebSocket, type RawData } from "ws";

import { NO_CONNECTION_MESSAGE } from "./config";
import {
  isResponse,
  PLUS_MESSAGES,
  type Channel,
  type ExtensionInfo,
  type MessageType,
  type Payload,
  type Result,
} from "./protocol";

/**
 * Hub <-> session client messages (besides `messageResponse`):
 *   hub -> client: { type: "extension", payload: HubStatus }
 *   client -> hub: { id, type, payload, timeoutMs, target } (a request for the
 *     extension in browser `target`), or { id, type: "hub_open_profile", ... }
 */
export const HUB_EXTENSION_STATUS = "extension";

/** Asks the hub to open a Chrome profile for the asking session. */
export const HUB_OPEN_PROFILE = "hub_open_profile";

/** One connected extension, i.e. one Chrome profile. */
export type BrowserSummary = {
  /** The hub's id for this connection. */
  key: string;
  /** Chrome profile folder ("Profile 3"), when known. */
  profile?: string;
  info?: ExtensionInfo;
  /** The extension has introduced itself, or turned out to be the original extension. */
  ready: boolean;
};

/** Another extension (e.g. Tabrein) that tried to connect and was turned away. */
export type ForeignExtension = { name: string; version: string; profile?: string };

export type HubStatus = {
  connected: boolean;
  browsers: BrowserSummary[];
  foreign?: ForeignExtension[];
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

/**
 * A server that is not the hub reaches the extensions through the hub: this is
 * its connection to the hub. It hands out a Channel per connected browser.
 */
export class HubClient {
  private readonly pending = new Map<string, Pending>();
  private nextId = 0;
  private closed = false;
  private status: HubStatus = { connected: false, browsers: [] };
  private statusWaiters = new Set<() => void>();
  private announce!: () => void;

  /** Resolves once the hub has told us which browsers are connected. */
  readonly ready: Promise<void>;

  constructor(
    private readonly ws: WebSocket,
    private readonly events: { onClose: () => void; onStatus: () => void },
  ) {
    this.ready = new Promise((resolve) => (this.announce = resolve));
    ws.on("message", (data) => this.onMessage(data));
    ws.on("close", () => this.handleClose());
    ws.on("error", () => this.handleClose());
  }

  get isOpen() {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  /** Browsers connected to the hub. */
  get browsers(): BrowserSummary[] {
    return this.isOpen ? this.status.browsers : [];
  }

  get foreign(): ForeignExtension[] {
    return this.status.foreign ?? [];
  }

  get extensionConnected() {
    return this.browsers.length > 0;
  }

  /** A way to one browser's extension through the hub. */
  channel(key: string): Channel {
    return new HubChannel(this, key);
  }

  find(key: string): BrowserSummary | undefined {
    return this.browsers.find((b) => b.key === key);
  }

  /** Resolves when `condition` holds for the hub's status, or after `timeoutMs`. */
  async waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!condition() && Date.now() < deadline && this.isOpen) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.statusWaiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, deadline - Date.now());
        this.statusWaiters.add(done);
      });
    }
    return condition();
  }

  openProfile(directory: string, timeoutMs: number): Promise<unknown> {
    return this.send(HUB_OPEN_PROFILE, { directory }, timeoutMs);
  }

  send(type: string, payload: unknown, timeoutMs: number, target?: string): Promise<unknown> {
    if (!this.isOpen) return Promise.reject(new Error(NO_CONNECTION_MESSAGE));
    const id = `c${(this.nextId++).toString(36)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser extension did not answer "${type}" within ${timeoutMs} ms`));
      }, timeoutMs + 1_000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, type, payload, timeoutMs, ...(target ? { target } : {}) }));
    });
  }

  close() {
    this.closed = true;
    this.ws.close();
  }

  private onMessage(data: RawData) {
    let message: unknown;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (isStatus(message)) {
      this.status = { ...message.payload, browsers: message.payload.browsers ?? [] };
      this.announce();
      for (const waiter of this.statusWaiters) waiter();
      this.events.onStatus();
      return;
    }
    if (!isResponse(message)) return;
    const { requestId, result, error } = message.payload;
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    if (error) entry.reject(new Error(String(error)));
    else entry.resolve(result);
  }

  private handleClose() {
    if (this.closed && this.pending.size === 0) {
      // Never opened, or closed on purpose.
      for (const waiter of this.statusWaiters) waiter();
      return;
    }
    const wasOpen = !this.closed;
    this.closed = true;
    const error = new Error("Lost the connection to the browsermcp-plus hub. Retry the tool call.");
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.statusWaiters) waiter();
    if (wasOpen) this.events.onClose();
  }
}

/** Requests for one browser, relayed by the hub. */
class HubChannel implements Channel {
  readonly ready: Promise<void>;

  constructor(
    private readonly client: HubClient,
    private readonly key: string,
  ) {
    // Plus-only tools are checked against the extension's `hello`.
    this.ready = client.waitFor(() => !!client.find(key)?.ready, 1_500).then(() => undefined);
  }

  get info() {
    return this.client.find(this.key)?.info;
  }

  supports(type: MessageType) {
    return !PLUS_MESSAGES.has(type) || !!this.info?.capabilities.includes(type);
  }

  request<T extends MessageType>(type: T, payload: Payload<T>, timeoutMs: number): Promise<Result<T>> {
    return this.client.send(type, payload, timeoutMs, this.key) as Promise<Result<T>>;
  }
}

function isStatus(message: unknown): message is { type: typeof HUB_EXTENSION_STATUS; payload: HubStatus } {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === HUB_EXTENSION_STATUS &&
    typeof (message as { payload?: { connected?: unknown } }).payload?.connected === "boolean"
  );
}
