# Changelog

## 0.4.0

Faster, leaner and harder to get stuck. Measured against 0.3.0 with the same
benchmark (real Chromium, fixture page and Wikipedia):

| | 0.3.0 | 0.4.0 |
| --- | --- | --- |
| click / type / hover | ~308 ms | ~100 ms |
| click result on Wikipedia | ~13,900 tokens | ~30 tokens |
| filling a 5-field form | 5 tool calls | 1 call, ~170 ms |

### Changed

- Page actions return a short report (URL, title, whether a new page loaded,
  dialogs, new tabs) instead of the full page snapshot. Pass `snapshot: true`
  to any action, or start the server with `--action-snapshots`, to get it.
  Navigation tools still include the snapshot by default.
- Waiting after an action follows real navigation events instead of a fixed
  300 ms: actions that don't navigate return as soon as the DOM settles.
- Snapshots are truncated at 80,000 characters by default
  (`--snapshot-max-chars`), below the size MCP clients drop.

### Added

- `browser_fill_form`: fill text fields, checkboxes, radios, native dropdowns,
  sliders and date inputs in one call.
- `browser_handle_dialog`: `alert`, `confirm`, `prompt` and `beforeunload`
  dialogs are reported instead of freezing the extension.
- `browser_find`: search the page for text and get only the matching elements
  with their refs; `browser_snapshot` takes a `ref` to return one subtree.
- `browser_type` reports what the field actually holds and has a `slowly`
  option for masked inputs (phone, card, date).

### Fixed

- A click on an element covered by a banner or overlay, or on a disabled
  element, reported success; it now fails and names what covers it.
- A click whose page navigated a moment later could be reported as failed,
  inviting a double submit.
- Tabs opened by a click (`target=_blank`, `window.open`) went unnoticed.
- Date, time, colour and range inputs could not be typed into; React-style
  inputs got stale values.
- Icon-only buttons had no name; a `<label>` wrapping a `<select>` included
  the options in the field's name.
- One stuck request (e.g. an unresolved promise) blocked every later request.
- Pages that never finish loading (slow trackers) made navigation time out.
- Closing the connected tab with `browser_tab_close` could drop the whole
  connection; it now hands the session to the most recently used tab first.
- Pages extensions cannot read (`about:blank`, `chrome://`) give a clear
  message instead of Chrome's raw permission error.
- The extension could not navigate away from pages it cannot debug
  (`chrome://`, the Web Store), and selecting such a tab dropped the working
  one.

## 0.3.0

First release as **browsermcp-plus**, an independent project based on
Browser MCP (see NOTICE).

### Added

- Open-source Browser MCP Plus extension (`extension/`), wire compatible with
  the original Browser MCP extension, with trusted CDP input, an accessibility snapshot with stable
  refs, and extra capabilities announced through a `hello` handshake.
- Tools that need the Browser MCP Plus extension: `browser_file_upload` (file inputs
  and file-chooser buttons), `browser_evaluate`, `browser_scroll`,
  `browser_tab_list`, `browser_tab_new`, `browser_tab_select`,
  `browser_tab_close`. With the published extension they fail fast with an
  explanation instead of timing out.
- End-to-end test suite running the extension in Chromium (`npm run test:e2e`).
- Release assets: the extension as a zip and the server as a single
  dependency-free `browsermcp-plus.cjs`.

## 0.2.0

Hardening of Browser MCP 0.1.3 (also proposed upstream as BrowserMCP/mcp#205).
The server no longer depends on the private monorepo it was extracted from and
can be built, tested and published from this repository alone. It stays wire
compatible with the original Browser MCP extension (1.3.x).

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
