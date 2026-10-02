/**
 * Static configuration shared by the server and the browser extension.
 *
 * These values mirror what the published Browser MCP extension (v1.3.x)
 * expects. Changing them breaks compatibility with the extension.
 */

export const APP_NAME = "Browser MCP";

/** The extension always connects to `ws://localhost:<port>` on this port. */
export const DEFAULT_WS_PORT = 9009;

/**
 * The extension ships with a pinned `key` in its manifest, so its ID is the
 * same in every Chromium browser (Chrome, Edge, Brave, Arc, ...).
 */
export const EXTENSION_ID = "bjfgambnhccakkhmkepdoekmckoijdlc";
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;

/**
 * The open-source companion extension in `extension/`. It speaks the same
 * protocol plus extra messages (file upload, evaluate, tabs, scroll).
 */
export const COMPANION_EXTENSION_ID = "kjcoeimgiimkjbeeblldadmlebheajgb";
export const COMPANION_ORIGIN = `chrome-extension://${COMPANION_EXTENSION_ID}`;

export const DEFAULT_ALLOWED_ORIGINS = [EXTENSION_ORIGIN, COMPANION_ORIGIN];

/** Error string the extension returns when no tab has been connected. */
export const EXTENSION_NO_TAB_ERROR = "No tab is connected";

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
  "No connection to the Browser MCP extension. Click the Browser MCP icon in the browser toolbar and press 'Connect' on the tab you want to automate.";
