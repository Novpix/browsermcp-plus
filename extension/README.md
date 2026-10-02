# Browser MCP Plus extension

The open-source Chromium extension of browsermcp-plus. It speaks the same
WebSocket protocol as the original Browser MCP extension, so every existing
tool works, and adds what that closed extension cannot do:

| Tool | What it does |
| --- | --- |
| `browser_file_upload` | Upload local files, either into an `<input type=file>` or through a button that opens the file chooser (the OS dialog is intercepted, never shown) |
| `browser_evaluate` | Run JavaScript in the page's own world, optionally with an element from the snapshot |
| `browser_scroll` | Mouse-wheel scrolling by pixels, or scroll an element into view |
| `browser_tab_list` / `browser_tab_new` / `browser_tab_select` / `browser_tab_close` | Work across tabs |

## Install (unpacked)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this `extension/` folder (or the unzipped
   `browsermcp-plus-extension-*.zip` from a release).
3. **Disable the original Browser MCP extension** — both would compete for the
   same server connection.
4. Open the tab you want to automate, click the toolbar icon (or press
   <kbd>Alt</kbd>+<kbd>J</kbd>) and press **Connect**. The icon shows an `ON`
   badge on the connected tab.

The extension ID is pinned by the manifest `key`
(`kjcoeimgiimkjbeeblldadmlebheajgb`) and allowed by the server by default.

## How it works

- `background.js` keeps a WebSocket to `ws://localhost:9009` (configurable in
  the popup) while a tab is connected, reconnecting automatically; a keepalive
  and a periodic alarm keep the MV3 service worker from going stale.
- Pointer and keyboard input is dispatched with the debugger API
  (`Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Input.insertText`,
  intercepted HTML5 drags), so pages receive trusted events. Chrome shows its
  "is debugging this browser" bar while a tab is connected.
- `content/agent.js` runs in the extension's isolated world. It builds the
  accessibility snapshot (roles, names, states, values, links, same-origin
  iframes, open shadow DOM) and keeps refs stable across snapshots.
- On connect the extension sends a `hello` message listing its extra
  capabilities; the server only routes the extra tools to extensions that
  announced them.

## Tests

`npm run test:e2e` (from the repository root) loads this extension into
Playwright's Chromium, connects it to the built server and exercises every
tool against fixture pages.
