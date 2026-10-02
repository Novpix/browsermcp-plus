# Changelog

## Unreleased

### Added

- Open-source companion extension (`extension/`), wire compatible with the
  published one, with trusted CDP input, an accessibility snapshot with stable
  refs, and extra capabilities announced through a `hello` handshake.
- Tools that need the companion extension: `browser_file_upload` (file inputs
  and file-chooser buttons), `browser_evaluate`, `browser_scroll`,
  `browser_tab_list`, `browser_tab_new`, `browser_tab_select`,
  `browser_tab_close`. With the published extension they fail fast with an
  explanation instead of timing out.
- End-to-end test suite running the extension in Chromium (`npm run test:e2e`).

## 0.2.0

The server no longer depends on the private monorepo it was extracted from and
can be built, tested and published from this repository alone. It stays wire
compatible with the published Browser MCP extension (1.3.x).

### Security

- The WebSocket endpoint listens on loopback (`127.0.0.1`, `::1`) only. It
  previously listened on all interfaces, exposing browser control to the LAN.
- Only the Browser MCP extension origin may connect (`--allow-origin` adds
  more). Previously any web page could open `ws://localhost:9009`, impersonate
  the extension and feed fabricated page content to the model.
- Startup no longer runs `kill -9` on whatever process owns the port.

### Fixed

- `server.close()` called itself recursively, overflowing the stack when the
  MCP client disconnected.
- Port cleanup used a `cmd`-only `FOR` loop on Windows and always failed.
- Requests to a disconnected extension waited for the full 30 s timeout; they
  now fail immediately, and the stale connection is cleared.
- Tool calls made right after the extension reconnects no longer fail: they
  wait briefly for the connection.
- `browser_wait` longer than 30 s always timed out.
- `browser_drag` was implemented (and supported by the extension) but never
  registered.
- A server holding the port on the wildcard address could be shadowed on macOS.

### Added

- Cooperative port takeover: a newly started server asks the running one to
  hand over the port; the old one waits in standby and resumes when the new one
  exits. If a non-cooperating process holds the port, the server still starts
  and reports the problem from tool calls instead of crashing.
- `browser_reload` and `browser_wait_for` (wait for text to appear/disappear).
- MCP tool annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`).
- URL normalisation for `browser_navigate` (`example.com` → `https://example.com`).
- CLI options: `--port`, `--allow-origin`, `--no-takeover`, `--kill-existing`,
  `--request-timeout`, `--snapshot-max-chars`, `--no-action-snapshots`,
  `--verbose`.
- Test suite (vitest) and CI on Linux, macOS and Windows.

### Changed

- Upgraded to `@modelcontextprotocol/sdk` 1.31 and zod 4; dropped
  `zod-to-json-schema`.
- `browser_press_key` now returns a page snapshot like the other actions.
