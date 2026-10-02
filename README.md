<a href="https://browsermcp.io">
  <img src="./.github/images/banner.png" alt="Browser MCP banner">
</a>

<h3 align="center">Browser MCP</h3>

<p align="center">
  Automate your browser with AI.
  <br />
  <a href="https://browsermcp.io"><strong>Website</strong></a>
  •
  <a href="https://docs.browsermcp.io"><strong>Docs</strong></a>
</p>

## About

Browser MCP is an MCP server + Chrome extension that allows you to automate your browser using AI applications like VS Code, Claude, Cursor, and Windsurf.

- ⚡ Fast: automation happens locally on your machine, without network latency.
- 🔒 Private: your browser activity stays on your device.
- 👤 Logged in: uses your existing browser profile and sessions.
- 🥷🏼 Stealth: uses your real browser fingerprint, avoiding basic bot detection.

## Setup

1. Install the [Browser MCP extension](https://chromewebstore.google.com/detail/browser-mcp-automate-your/bjfgambnhccakkhmkepdoekmckoijdlc).
2. Add the server to your MCP client:

   ```json
   {
     "mcpServers": {
       "browsermcp": {
         "command": "npx",
         "args": ["@browsermcp/mcp@latest"]
       }
     }
   }
   ```

3. Click the extension icon on the tab you want to automate and press **Connect**.

## Tools

| Tool | Description |
| --- | --- |
| `browser_navigate` | Open a URL (`example.com` → `https://example.com`) |
| `browser_go_back` / `browser_go_forward` | History navigation |
| `browser_reload` | Reload the current page |
| `browser_snapshot` | Accessibility snapshot with element refs |
| `browser_click` / `browser_hover` | Act on an element from the snapshot |
| `browser_type` | Type into an element, optionally pressing Enter |
| `browser_select_option` | Choose dropdown values |
| `browser_drag` | Drag one element onto another |
| `browser_press_key` | Press a key (`Enter`, `Escape`, `PageDown`, …) |
| `browser_wait` | Wait a number of seconds |
| `browser_wait_for` | Wait until text appears or disappears |
| `browser_get_console_logs` | Read the page console |
| `browser_screenshot` | PNG of the visible viewport |

Tools carry MCP annotations so clients can skip confirmation for read-only tools.

### Companion extension

The open-source [companion extension](extension/) speaks the same protocol and
unlocks extra tools that the published extension cannot support:

| Tool | Description |
| --- | --- |
| `browser_file_upload` | Upload local files via a file input or the button that opens the file chooser |
| `browser_evaluate` | Run JavaScript in the page, optionally on a snapshot element |
| `browser_scroll` | Scroll by pixels or scroll an element into view |
| `browser_tab_list` / `_new` / `_select` / `_close` | Tab management |

With the published extension these tools return an error explaining that they
need the companion extension.

## Options

```
--port <number>            WebSocket port (the published extension always uses 9009)
--allow-origin <origin...> extra origins allowed to connect as the extension
--no-takeover              don't ask a running server to hand over the port
--kill-existing            terminate a non-cooperating process on the port
--request-timeout <ms>     timeout for a single browser action (default 30000)
--snapshot-max-chars <n>   truncate large snapshots (0 = never, default)
--no-action-snapshots      don't append a snapshot to action results
--verbose                  debug logging on stderr
```

## Multiple MCP clients

Only one server can talk to the extension at a time. When a second client starts
the server, the new instance asks the running one to hand over the port. The
older instance switches to standby and takes over again once the newer one
exits. If the port is held by something that does not cooperate (for example a
0.1.x server), the server still starts and its tools explain the problem; pass
`--kill-existing` to terminate that process instead.

## Security model

- The WebSocket endpoint listens on loopback only.
- Connections are accepted only from the extension's origin
  (`chrome-extension://bjfgambnhccakkhmkepdoekmckoijdlc`), so web pages you
  visit cannot connect to the server and impersonate the extension.
- Local processes running as your user are trusted, as with any local MCP server.
- Page content returned by the tools is untrusted input for the model.

## Development

```sh
npm install
npm run check     # typecheck + tests + build
npm run test:e2e  # real Chromium + companion extension (needs a Playwright Chromium)
npm run inspector # try the server in the MCP Inspector
```

The extension's wire protocol is documented in [`src/protocol.ts`](src/protocol.ts).

## Credits

Browser MCP was adapted from the [Playwright MCP server](https://github.com/microsoft/playwright-mcp) in order to automate the user's browser rather than creating new browser instances.
