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
 *   hub -> client: { type: "extension", payload: { connected, info? } }
 *   client -> hub: { id, type, payload, timeoutMs } (a request for the extension)
 */
export const HUB_EXTENSION_STATUS = "extension";

export type ExtensionStatus = { connected: boolean; info?: ExtensionInfo };

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

/**
 * A server that is not the hub reaches the extension through the hub: this is
 * its connection to the hub, usable as a Channel by the tools.
 */
export class HubClient implements Channel {
  private readonly pending = new Map<string, Pending>();
  private nextId = 0;
  private closed = false;
  private status: ExtensionStatus = { connected: false };
  private statusWaiters = new Set<() => void>();
  private announce!: () => void;

  /** Resolves once the hub has told us the extension's status. */
  readonly ready: Promise<void>;

  constructor(
    private readonly ws: WebSocket,
    private readonly onClose: () => void,
  ) {
    this.ready = new Promise((resolve) => (this.announce = resolve));
    ws.on("message", (data) => this.onMessage(data));
    ws.on("close", () => this.handleClose());
    ws.on("error", () => this.handleClose());
  }

  get info() {
    return this.status.info;
  }

  get isOpen() {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  get extensionConnected() {
    return this.isOpen && this.status.connected;
  }

  supports(type: MessageType) {
    return !PLUS_MESSAGES.has(type) || !!this.status.info?.capabilities.includes(type);
  }

  /** Waits up to `timeoutMs` for the hub to report a connected extension. */
  async waitForExtension(timeoutMs: number): Promise<boolean> {
    if (this.extensionConnected) return true;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.statusWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.statusWaiters.add(done);
    });
    return this.extensionConnected;
  }

  request<T extends MessageType>(type: T, payload: Payload<T>, timeoutMs: number): Promise<Result<T>> {
    if (!this.isOpen) return Promise.reject(new Error(NO_CONNECTION_MESSAGE));
    const id = `c${(this.nextId++).toString(36)}`;
    return new Promise<Result<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser extension did not answer "${type}" within ${timeoutMs} ms`));
      }, timeoutMs + 1_000);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.ws.send(JSON.stringify({ id, type, payload, timeoutMs }));
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
      this.status = message.payload;
      this.announce();
      for (const waiter of this.statusWaiters) waiter();
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
    const wasOpen = !this.closed;
    this.closed = true;
    const error = new Error("Lost the connection to the browsermcp-plus hub. Retry the tool call.");
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.statusWaiters) waiter();
    if (wasOpen) this.onClose();
  }
}

function isStatus(message: unknown): message is { type: typeof HUB_EXTENSION_STATUS; payload: ExtensionStatus } {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === HUB_EXTENSION_STATUS &&
    typeof (message as { payload?: { connected?: unknown } }).payload?.connected === "boolean"
  );
}
