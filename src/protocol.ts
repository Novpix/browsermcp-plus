import { WebSocket, type RawData } from "ws";

import { EXTENSION_NO_TAB_ERROR, NO_CONNECTION_MESSAGE } from "./config";

/**
 * Wire protocol spoken with the Browser MCP extension.
 *
 * Request:  { id, type, payload }
 * Response: { type: "messageResponse", payload: { requestId, result?, error? } }
 */

type ElementRef = { element: string; ref: string };

/** Every message the extension understands, with its payload and result type. */
export type ExtensionMessages = {
  getUrl: { payload: undefined; result: string };
  getTitle: { payload: undefined; result: string };
  browser_snapshot: { payload: Record<string, never>; result: string };
  browser_navigate: { payload: { url: string }; result: unknown };
  browser_go_back: { payload: Record<string, never>; result: unknown };
  browser_go_forward: { payload: Record<string, never>; result: unknown };
  browser_wait: { payload: { time: number }; result: unknown };
  browser_press_key: { payload: { key: string }; result: unknown };
  browser_click: { payload: ElementRef; result: unknown };
  browser_hover: { payload: ElementRef; result: unknown };
  browser_type: {
    payload: ElementRef & { text: string; submit: boolean };
    result: unknown;
  };
  browser_select_option: {
    payload: ElementRef & { values: string[] };
    result: unknown;
  };
  browser_drag: {
    payload: {
      startElement: string;
      startRef: string;
      endElement: string;
      endRef: string;
    };
    result: unknown;
  };
  /** Base64 encoded PNG. */
  browser_screenshot: { payload: Record<string, never>; result: string };
  browser_get_console_logs: {
    payload: Record<string, never>;
    result: unknown[];
  };
};

export type MessageType = keyof ExtensionMessages;
export type Payload<T extends MessageType> = ExtensionMessages[T]["payload"];
export type Result<T extends MessageType> = ExtensionMessages[T]["result"];

export const MESSAGE_RESPONSE_TYPE = "messageResponse";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | undefined;
};

/**
 * Request/response channel over a single extension WebSocket.
 *
 * One `message` listener serves every in-flight request, and all pending
 * requests are rejected as soon as the socket closes, so callers never hang
 * until their timeout on a dead connection.
 */
export class ExtensionConnection {
  private readonly pending = new Map<string, Pending>();
  private nextId = 0;
  private closed = false;

  constructor(readonly ws: WebSocket) {
    ws.on("message", (data) => this.onMessage(data));
    ws.on("close", () => this.onClose());
    ws.on("error", () => this.onClose());
  }

  get isOpen(): boolean {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  request<T extends MessageType>(
    type: T,
    payload: Payload<T>,
    timeoutMs: number,
  ): Promise<Result<T>> {
    if (!this.isOpen) {
      return Promise.reject(new Error(NO_CONNECTION_MESSAGE));
    }
    const id = `${Date.now().toString(36)}-${(this.nextId++).toString(36)}`;
    return new Promise<Result<T>>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(
                new Error(
                  `Browser extension did not answer "${type}" within ${timeoutMs} ms`,
                ),
              );
            }, timeoutMs)
          : undefined;
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.ws.send(JSON.stringify({ id, type, payload }), (error) => {
        if (error) this.settle(id, { error: error.message });
      });
    });
  }

  close() {
    this.onClose();
    if (
      this.ws.readyState === WebSocket.OPEN ||
      this.ws.readyState === WebSocket.CONNECTING
    ) {
      this.ws.close();
    }
  }

  private onMessage(data: RawData) {
    let message: unknown;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!isResponse(message)) return;
    const { requestId, result, error } = message.payload;
    this.settle(requestId, { result, error });
  }

  private settle(id: string, outcome: { result?: unknown; error?: unknown }) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (outcome.error) {
      entry.reject(new Error(translateExtensionError(String(outcome.error))));
    } else {
      entry.resolve(outcome.result);
    }
  }

  private onClose() {
    if (this.closed) return;
    this.closed = true;
    const error = new Error(
      "Browser extension disconnected before answering. " + NO_CONNECTION_MESSAGE,
    );
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }
}

function isResponse(message: unknown): message is {
  type: typeof MESSAGE_RESPONSE_TYPE;
  payload: { requestId: string; result?: unknown; error?: unknown };
} {
  if (typeof message !== "object" || message === null) return false;
  const { type, payload } = message as { type?: unknown; payload?: unknown };
  return (
    type === MESSAGE_RESPONSE_TYPE &&
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as { requestId?: unknown }).requestId === "string"
  );
}

function translateExtensionError(error: string): string {
  return error === EXTENSION_NO_TAB_ERROR ? NO_CONNECTION_MESSAGE : error;
}
