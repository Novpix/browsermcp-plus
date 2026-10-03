/**
 * Static configuration shared by the server and the browser extensions.
 *
 * The server works with both the Browser MCP Plus extension in `extension/`
 * and the original Browser MCP extension (v1.3.x); the protocol values below
 * must not change or the original extension stops working.
 */

export const APP_NAME = "browsermcp-plus";

export const REPOSITORY_URL = "https://github.com/Novpix/browsermcp-plus";

/** The extension always connects to `ws://localhost:<port>` on this port. */
export const DEFAULT_WS_PORT = 9009;

/**
 * The original Browser MCP extension. Like ours, it pins its ID with a manifest
 * `key`, so the ID is the same in every Chromium browser.
 */
export const EXTENSION_ID = "bjfgambnhccakkhmkepdoekmckoijdlc";
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;

/**
 * The open-source Browser MCP Plus extension in `extension/`. It speaks the same
 * protocol plus extra messages (file upload, evaluate, tabs, scroll).
 */
export const PLUS_EXTENSION_ID = "kjcoeimgiimkjbeeblldadmlebheajgb";
export const PLUS_ORIGIN = `chrome-extension://${PLUS_EXTENSION_ID}`;

export const DEFAULT_ALLOWED_ORIGINS = [EXTENSION_ORIGIN, PLUS_ORIGIN];

/** Error string the extension returns when no tab has been connected. */
export const EXTENSION_NO_TAB_ERROR = "No tab is connected";

/**
 * Snapshots longer than this are truncated (~20k tokens). MCP clients drop
 * oversized tool results (Claude Code: 25k tokens); browser_find and
 * browser_snapshot with a ref reach the rest.
 */
export const DEFAULT_SNAPSHOT_MAX_CHARS = 80_000;

/** Default timeout for a single request to the extension. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * How long a tool call waits for the extension to (re)connect before failing.
 * The extension retries its WebSocket connection once per second.
 */
export const DEFAULT_CONNECT_WAIT_MS = 5_000;

/** Header a newer server instance sends to ask the current one to hand over the port. */
export const TAKEOVER_HEADER = "x-browsermcp-takeover";

/** Close code used to acknowledge a takeover request. */
export const TAKEOVER_ACK_CODE = 4001;

export const NO_CONNECTION_MESSAGE =
  "No connection to the browser extension. Click the Browser MCP Plus (or Browser MCP) icon in the browser toolbar and press 'Connect' on the tab you want to automate.";
