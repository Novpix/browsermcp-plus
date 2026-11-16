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
  /** `expect`: text the caller looks for; a page still loading gets a moment to show it (Plus extension). */
  browser_snapshot: { payload: { expect?: string }; result: string };
  // Page actions: the Plus extension answers with an ActionReport, the
  // original extension with nothing.
  browser_navigate: { payload: { url: string }; result: ActionResult };
  browser_go_back: { payload: Record<string, never>; result: ActionResult };
  browser_go_forward: { payload: Record<string, never>; result: ActionResult };
  browser_wait: { payload: { time: number }; result: unknown };
  browser_press_key: { payload: { key: string }; result: ActionResult };
  browser_click: { payload: ElementRef; result: ActionResult };
  browser_hover: { payload: ElementRef; result: ActionResult };
  browser_type: {
    payload: ElementRef & { text: string; submit: boolean; slowly?: boolean };
    result: ActionResult;
  };
  browser_select_option: {
    payload: ElementRef & { values: string[] };
    result: ActionResult;
  };
  browser_drag: {
    payload: {
      startElement: string;
      startRef: string;
      endElement: string;
      endRef: string;
    };
    result: ActionResult;
  };
  /** Base64 encoded PNG. `ref` and `fullPage` need the Plus extension (capability element_screenshot). */
  browser_screenshot: { payload: { ref?: string; fullPage?: boolean }; result: string };
  browser_get_console_logs: {
    payload: Record<string, never>;
    result: ConsoleEntry[];
  };

  // Browser MCP Plus extension only (announced through `hello` capabilities).
  browser_upload_file: { payload: ElementRef & { paths: string[] }; result: ActionResult };
  browser_evaluate: {
    payload: { function: string; ref?: string; element?: string };
    result: EvaluateResult;
  };
  browser_scroll: {
    payload: { ref?: string; element?: string; deltaX?: number; deltaY?: number };
    result: ActionResult;
  };
  browser_handle_dialog: { payload: { accept: boolean; promptText?: string }; result: ActionResult };
  /** Which agent sessions are alive, so the extension frees the tabs of the others. */
  sessions_update: { payload: { sessions: SessionIdentity[] }; result: unknown };
  browser_fill_form: { payload: { fields: FormField[] }; result: ActionResult };
  browser_tab_list: { payload: Record<string, never>; result: TabInfo[] };
  browser_tab_new: { payload: { url?: string }; result: TabInfo };
  browser_tab_select: { payload: { tabId: number }; result: TabInfo };
  browser_tab_close: { payload: { tabId?: number }; result: TabInfo | null };
  /** Leaves a tab to the user (it stays open, out of the agents' group) with a note. */
  browser_tab_handoff: { payload: { tabId?: number; note: string }; result: TabInfo };
  /** The page's readable text (or one element's), frames included. */
  /** Takes a tab of the user's to work in, as it is (no reload); it stays theirs. */
  browser_tab_take: { payload: { tabId: number; note: string }; result: TabInfo };
  /** Gives a taken tab back to where it was. */
  browser_tab_release: { payload: { tabId?: number }; result: TabInfo | null };
  browser_get_text: {
    payload: { ref?: string; selector?: string; links?: boolean };
    result: { text: string; url: string; title: string };
  };
  /** A file the page shows or links to, fetched with the browser's logins. */
  browser_get_file: { payload: { url?: string; ref?: string }; result: FileResult };
  browser_downloads: { payload: { limit?: number }; result: DownloadInfo[] };
  browser_download: { payload: { url: string }; result: DownloadInfo };
  /**
   * Tells the extension which Chrome profile it runs in (it remembers it), and
   * hands it the tab opened for an agent while opening that profile.
   */
  profile_set: { payload: ProfileSetPayload; result: unknown };
};

export type ProfileSetPayload = {
  profile: { directory: string; name: string; userDataDir: string };
  adopt?: { tabId: number; sessionId: string; sessionName: string };
};

/** What happened during a page action, reported by the Plus extension. */
export type ActionReport = {
  url: string;
  title: string;
  /** The action started a top-level navigation. */
  navigated: boolean;
  /** A JavaScript dialog is open and blocks the page. */
  dialog?: { type: string; message: string; defaultPrompt?: string };
  /** Tabs the page opened during the action (target=_blank, window.open). */
  newTabs?: TabInfo[];
  /** Action-specific outcome, e.g. a field's value after typing. */
  value?: unknown;
  /** The page opened a tab and the agent now works in it. */
  switchedTo?: TabInfo;
  /** Downloads the action started. */
  downloads?: { id: number; url: string; filename: string }[];
  /**
   * What changed on the page since the agent's last snapshot ("+ added",
   * "~ changed", "- removed" snapshot lines); empty: nothing visible changed.
   */
  changes?: string[];
  /** Changes left out of `changes`. */
  moreChanges?: number;
};

export type ConsoleEntry = { type: string; timestamp?: number; message?: string };

export type FileResult = {
  url: string;
  base64: string;
  mimeType: string;
  size: number;
  /** The Content-Disposition header, which may name the file. */
  disposition?: string;
};

export type DownloadInfo = {
  id: number;
  url: string;
  /** Where the file is (being) saved. */
  path: string;
  state: "in_progress" | "interrupted" | "complete";
  bytes: number;
  totalBytes: number;
  mimeType: string;
  startTime: string;
  error?: string;
  danger?: string;
};

export type ActionResult = ActionReport | undefined;

export type FormField = {
  name: string;
  type: "textbox" | "searchbox" | "spinbutton" | "checkbox" | "radio" | "switch" | "combobox" | "listbox" | "slider";
  ref: string;
  value: string;
};

export function isActionReport(value: unknown): value is ActionReport {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ActionReport).url === "string" &&
    typeof (value as ActionReport).navigated === "boolean"
  );
}

export type TabInfo = {
  id: number;
  windowId: number;
  title: string;
  url: string;
  active: boolean;
  /** This agent's tab. */
  connected: boolean;
  /** Name of the other agent working in this tab, if any. */
  agent?: string;
  /**
   * Whose tab it is: you (you opened or work in it), another agent, the user
   * (connected for agents, or not), or the user after an agent handed it over.
   */
  owner?: "you" | "agent" | "user" | "user-connected" | "handed-off" | "taken";
  /** The note of a handed-over (or taken) tab, and who left it. */
  note?: string;
  handedOffBy?: string;
  /** In the agents' tab group. */
  grouped?: boolean;
  /** In the window the user is using. */
  focusedWindow?: boolean;
  /** The user clicked or typed in it while you worked: you are paused there until browser_tab_select. */
  userSteppedIn?: boolean;
};

/** An agent session: one MCP server process, usually one Claude Code session. */
export type SessionIdentity = { id: string; name: string };

export type EvaluateResult = {
  type: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
};

/** Messages only the Browser MCP Plus extension understands. */
export const PLUS_MESSAGES = new Set<MessageType>([
  "browser_upload_file",
  "browser_evaluate",
  "browser_scroll",
  "browser_tab_list",
  "browser_tab_new",
  "browser_tab_select",
  "browser_tab_close",
  "browser_handle_dialog",
  "browser_fill_form",
  "sessions_update",
  "profile_set",
  "browser_get_text",
  "browser_get_file",
  "browser_downloads",
  "browser_download",
  "browser_tab_handoff",
  "browser_tab_take",
  "browser_tab_release",
]);

/** Sent by the Browser MCP Plus extension right after connecting. */
export type ExtensionInfo = {
  name: string;
  version: string;
  capabilities: string[];
  /** Random id the extension keeps per profile: tells reconnects from other profiles. */
  installId?: string;
  /** The Google account signed in to the extension's profile (chrome.identity). */
  account?: { email?: string; id?: string };
  /** The profile the hub told this extension earlier. */
  profile?: { directory?: string; userDataDir?: string; name?: string; email?: string };
};

/** A message the extension sends on its own (not an answer), e.g. `profile_claim`. */
export type ExtensionEvent = { type: string; payload: unknown };

/** How long to wait for a `hello` before assuming the original extension. */
const HELLO_WAIT_MS = 1_000;

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
  private _info: ExtensionInfo | undefined;
  private announce!: () => void;
  private readonly listeners = new Set<(event: ExtensionEvent) => void>();

  /** Resolves once the extension has introduced itself, or after a short grace period. */
  readonly ready: Promise<void>;

  constructor(readonly ws: WebSocket) {
    this.ready = new Promise((resolve) => {
      this.announce = resolve;
      setTimeout(resolve, HELLO_WAIT_MS).unref();
    });
    ws.on("message", (data) => this.onMessage(data));
    ws.on("close", () => this.onClose());
    ws.on("error", () => this.onClose());
  }

  /** Present when the Browser MCP Plus extension is connected. */
  get info(): ExtensionInfo | undefined {
    return this._info;
  }

  supports(type: MessageType): boolean {
    return !PLUS_MESSAGES.has(type) || !!this._info?.capabilities.includes(type);
  }

  get isOpen(): boolean {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  /** Calls `listener` for messages the extension sends on its own. */
  onEvent(listener: (event: ExtensionEvent) => void) {
    this.listeners.add(listener);
  }

  request<T extends MessageType>(
    type: T,
    payload: Payload<T>,
    timeoutMs: number,
    session?: SessionIdentity,
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
      const routing = session ? { sessionId: session.id, sessionName: session.name } : {};
      this.ws.send(JSON.stringify({ id, type, payload, ...routing }), (error) => {
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
    if (isHello(message)) {
      this._info = message.payload;
      this.announce();
      return;
    }
    if (isEvent(message)) {
      for (const listener of this.listeners) listener(message);
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

/** What tools talk to: the extension, on behalf of one agent session. */
export interface Channel {
  readonly info: ExtensionInfo | undefined;
  readonly ready: Promise<void>;
  supports(type: MessageType): boolean;
  request<T extends MessageType>(type: T, payload: Payload<T>, timeoutMs: number): Promise<Result<T>>;
}

/** The hub's own session, talking to the extension directly. */
export class SessionChannel implements Channel {
  constructor(
    private readonly connection: ExtensionConnection,
    private readonly session: SessionIdentity,
  ) {}

  get info() {
    return this.connection.info;
  }

  get ready() {
    return this.connection.ready;
  }

  supports(type: MessageType) {
    return this.connection.supports(type);
  }

  request<T extends MessageType>(type: T, payload: Payload<T>, timeoutMs: number) {
    return this.connection.request(type, payload, timeoutMs, this.session);
  }
}

export function isResponse(message: unknown): message is {
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

/** Messages the extension may send unprompted. */
const EVENT_TYPES = new Set(["profile_claim"]);

function isEvent(message: unknown): message is ExtensionEvent {
  return (
    typeof message === "object" &&
    message !== null &&
    EVENT_TYPES.has((message as { type?: unknown }).type as string)
  );
}

export function isHello(message: unknown): message is { type: "hello"; payload: ExtensionInfo } {
  if (typeof message !== "object" || message === null) return false;
  const { type, payload } = message as { type?: unknown; payload?: Partial<ExtensionInfo> };
  return (
    type === "hello" &&
    typeof payload === "object" &&
    payload !== null &&
    typeof payload.name === "string" &&
    Array.isArray(payload.capabilities)
  );
}

function translateExtensionError(error: string): string {
  return error === EXTENSION_NO_TAB_ERROR ? NO_CONNECTION_MESSAGE : error;
}
