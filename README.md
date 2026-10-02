# browsermcp-plus

**Let AI apps drive your own browser — including file uploads, tabs and JavaScript.**

browsermcp-plus is an [MCP](https://modelcontextprotocol.io) server and an
open-source Chrome extension. Claude, Cursor, VS Code, Windsurf and any other
MCP client can click, type, upload files and read pages in the tab you
connect, using your real browser profile: you stay logged in, nothing runs in
the cloud, and sites see a normal browser.

It started as a hardened fork of [Browser MCP](https://github.com/BrowserMCP/mcp)
and stays compatible with its extension. [Türkçe README](README.tr.md)

## What's different from Browser MCP

| | Browser MCP | browsermcp-plus |
| --- | --- | --- |
| File upload | ✗ | ✓ file inputs *and* "choose file" buttons, no OS dialog |
| Run JavaScript, tabs, scrolling | ✗ | ✓ |
| Extension source | closed | open source ([`extension/`](extension/)) |
| Server reachable from the network | yes, all interfaces | loopback only |
| Any web page can connect to the server | yes | no, origin allowlist |
| Starting a second client | `kill -9` on the port | cooperative hand-over, then resume |
| Builds from its own repository, tests, CI | ✗ | ✓ unit + real-browser end-to-end tests |

## Install

**1. Extension** — download `browsermcp-plus-extension-*.zip` from the
[latest release](https://github.com/Novpix/browsermcp-plus/releases/latest)
and unzip it, then in Chrome (or Edge, Brave, Arc…):

1. open `chrome://extensions` and enable **Developer mode**,
2. click **Load unpacked** and choose the unzipped folder,
3. if you have the original Browser MCP extension, disable it.

**2. Server** — add it to your MCP client. Either run it straight from GitHub
(needs Node.js 18+ and git):

```json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": ["-y", "github:Novpix/browsermcp-plus"]
    }
  }
}
```

or download `browsermcp-plus.cjs` from the release — a single file with no
dependencies — and point the client at it:

```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["/path/to/browsermcp-plus.cjs"]
    }
  }
}
```

Claude Code: `claude mcp add browser -- npx -y github:Novpix/browsermcp-plus`

**3. Connect** — open the tab you want to automate, click the extension icon
(<kbd>Alt</kbd>+<kbd>J</kbd>) and press **Connect**. The icon shows `ON`.

## Tools

| Tool | Description |
| --- | --- |
| `browser_navigate` | Open a URL (`example.com` → `https://example.com`) |
| `browser_go_back` / `browser_go_forward` / `browser_reload` | History and reload |
| `browser_snapshot` | Accessibility snapshot with element refs |
| `browser_click` / `browser_hover` | Act on an element from the snapshot |
| `browser_type` | Type into an element, optionally pressing Enter |
| `browser_select_option` | Choose dropdown values |
| `browser_drag` | Drag one element onto another (incl. HTML5 drag and drop) |
| `browser_press_key` | Keys and shortcuts (`Enter`, `PageDown`, `Control+a`, …) |
| `browser_file_upload` | Upload local files through a file input or a "choose file" button |
| `browser_evaluate` | Run JavaScript in the page, optionally on a snapshot element |
| `browser_scroll` | Scroll by pixels or scroll an element into view |
| `browser_tab_list` / `_new` / `_select` / `_close` | Work across tabs |
| `browser_wait` / `browser_wait_for` | Wait for time, or for text to appear/disappear |
| `browser_get_console_logs` | Read the page console |
| `browser_screenshot` | PNG of the visible viewport |

Tools carry MCP annotations (`readOnlyHint`, `destructiveHint`) so clients can
skip confirmation for read-only ones. With the original Browser MCP extension
everything except upload, evaluate, scroll and tabs works.

## Options

```
--port <number>            WebSocket port (default 9009)
--allow-origin <origin...> extra extension origins allowed to connect
--no-takeover              don't ask a running server to hand over the port
--kill-existing            terminate a non-cooperating process on the port
--request-timeout <ms>     timeout for a single browser action (default 30000)
--snapshot-max-chars <n>   truncate large snapshots (0 = never, default)
--no-action-snapshots      don't append a snapshot to action results
--verbose                  debug logging on stderr
```

## Several MCP clients

Only one server can talk to the extension at a time. When another client
starts the server, the new instance asks the running one to hand over the port;
the older one waits and takes over again once the newer one exits.

## Security model

- The server listens on `127.0.0.1` / `::1` only.
- Only the extension origins may connect, so web pages you visit cannot talk to
  the server or impersonate the extension.
- The extension acts only on the tab you connect; Chrome shows its
  "is debugging this browser" bar while it does.
- Page content returned by the tools is untrusted input for the model.

## Development

```sh
npm install
npm run check     # typecheck + unit tests + build
npm run test:e2e  # real Chromium + extension end to end
```

The wire protocol is documented in [`src/protocol.ts`](src/protocol.ts), the
extension in [`extension/README.md`](extension/README.md).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE) — based on
[Browser MCP](https://github.com/BrowserMCP/mcp), which was adapted from
[Playwright MCP](https://github.com/microsoft/playwright-mcp). Not affiliated
with the Browser MCP authors.
