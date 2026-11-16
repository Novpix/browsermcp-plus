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

/** Header a server sends to join the running server (the hub) as another agent session. */
export const SESSION_HEADER = "x-browsermcp-session";
export const SESSION_NAME_HEADER = "x-browsermcp-session-name";

/**
 * Sent by a browsermcp-plus hub (0.6+) on every HTTP and WebSocket response, so
 * other servers only join a hub that speaks this protocol and not another
 * browser server holding the same port (e.g. Tabrein MCP, a fork of this one).
 */
export const HUB_HEADER = "x-browsermcp-plus-hub";
export const HUB_PROTOCOL = 1;

/** Join requests from Tabrein MCP servers carry this header; they cannot share our hub. */
export const TABREIN_HUB_HEADER = "x-tabrein-hub-revision";

/**
 * Opening a Chrome profile loads this hub URL in it; the profile's extension
 * sees the token and tells the hub which profile it runs in.
 */
export const PROFILE_CLAIM_PATH = "/browsermcp-plus/profile/";

/** How long browser_profile_select waits for a profile's extension after opening it. */
export const PROFILE_OPEN_TIMEOUT_MS = 20_000;

/**
 * How long the hub waits after a change before telling the extension which
 * sessions are alive; lets sessions rejoin after the hub moved without losing
 * their tabs.
 */
export const SESSIONS_UPDATE_DELAY_MS = 1_500;

/**
 * A new hub waits at least this long before its first sessions update, so the
 * sessions of a hub that exited can rejoin before the extension closes their tabs.
 */
export const HUB_SETTLE_MS = 3_000;

/** Close code used to acknowledge a takeover request. */
export const TAKEOVER_ACK_CODE = 4001;

export const NO_CONNECTION_MESSAGE =
  "No connection to the browser extension. Open Chrome with the Browser MCP Plus extension turned on: it connects by itself (unless it was paused or set to connected tabs only in its popup). With the original Browser MCP extension, click its toolbar icon and press 'Connect'.";
