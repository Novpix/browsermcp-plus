# Changelog

## Unreleased

### Fixed

- A page that retitled itself while a handed-over tab showed its note cut
  that blink short, so the note could stay away for two seconds. The note now
  stays for its whole blink; the page's new title comes back with the next.
- Chrome profile paths are built with the platform's own separators, so the
  tests pass on Windows too.

## 0.7.2

Agents work in the background: the tab you are looking at stays in front.

### Fixed

- Giving back a taken tab the user had switched to, to watch, moved it to its
  own window and left the AI group's window showing an agent's tab. It now
  stays where the user is looking at it (the agent is told so).
- Taking the tab a window shows (the user is looking at it) from another
  window moved it into the AI group and left that window showing another tab.
  It now stays there, in front; it still is the agent's to work in.
- A link the agent opened in a new tab (`target=_blank`) came to the front.
  It now opens behind: the window shows again what it showed. Links the user
  clicks open as usual.
- Moving and grouping tabs (opening agent tabs, taking, giving back, putting
  the AI group back at the right) restore any window that came to show a
  moved tab, so no Chrome version can shift the user's screen this way.

### Docs

- A disclaimer in the README (agents act as you; no warranty, no liability)
  and a security policy (`SECURITY.md`) for reporting vulnerabilities.

## 0.7.1

The user can watch an agent, stop it with a click, and hand it a tab.

### Added

- **Watch, or step in.** Looking at an agent's tab, scrolling it or moving the
  mouse changes nothing. A real click or key in the page pauses the agent
  there ("Paused · listening" / "Durdum · seni dinliyorum"): its next action in
  that tab is refused with a request to ask the user, and `browser_tab_select`
  resumes it. The agent's own input and the page's synthetic events do not count.
- `browser_tab_take` / `browser_tab_release`: work in one of the user's open
  tabs, only when they ask, without them touching it. Nothing reloads (fields,
  sign-in, scroll stay), the tab moves into the AI group, and one quiet
  notification has a **Give back** button (also in the popup). It is never
  closed: it goes back to its window and place when released or when the
  agent ends; an agent whose tab the user took back is told so.
- The AI group stays at the right end of the tab strip; new agent tabs open at
  its end; it moves back, calmly, after the user opens tabs to its right.

### Changed

- A handed-over tab blinks until the user clicks or types in it (or presses
  Done/Keep), even while they look at it; note, blinking and badge go together.

### Fixed

- A handed-over tab the agent took back with `browser_tab_select` became
  nobody's once the agent opened another tab ("the user's — hands off", and
  `browser_tab_handoff` refused it). It is the agent's again, back in the group.


## 0.7.0

Agents see every frame, read whole pages, and show — quietly — where they work.

### Added

- **Frames from other sites.** Every frame runs the page agent; frames from
  another origin (payment forms, embedded sign-ins, captchas, chat boxes)
  appear in the snapshot under their `iframe`, nested ones too, with refs like
  `f12e3` that click, type, select and the rest use as usual. Closed shadow
  roots are read as well.
- `browser_get_text`: the page's (or one element's) text as Markdown —
  headings, paragraphs, lists, tables, code, links — in full and in pages.
- Action reports say what changed on the page since the agent's last snapshot
  (`+` added, `~` changed, `-` removed), so a click rarely needs a new snapshot.
- `browser_snapshot` continues a long snapshot with `offset`.
- When a page opens a tab or popup, the agent moves to it (and back when it closes).
- `browser_screenshot` of one element (`ref`) or the whole page (`fullPage`).
- `browser_get_file` (PDFs, images, any file, with the browser's logins: images
  inline, everything saved locally), `browser_download` and `browser_downloads`.
- `browser_get_console_logs` also lists uncaught exceptions and failed network
  requests (HTTP 4xx/5xx, network errors).
- One **AI** tab group per profile for every agent's tabs; tabs the user keeps
  or is handed leave it.
- A quiet overlay on the page an agent works in: a soft edge glow and a corner
  label with the agent's name and what it is doing (in Turkish in a Turkish
  browser). No layout change, no clicks taken, not in screenshots or snapshots,
  `prefers-reduced-motion` respected.
- `browser_tab_handoff`: leave a tab to the user with a note. The tab stays
  open, says "Your turn: …", blinks its title and icon until the user switches
  to it, and the toolbar icon counts tabs waiting; a background window asks
  for attention once. The popup lists them under "Waiting for you".
- `browser_tab_list` lists windows and, with `allProfiles`, every profile; each
  tab says whose it is (yours, another agent's, the user's, handed over).

### Changed

- **The debugger only attaches to act.** Reading and navigating go through
  content scripts and webNavigation; Chrome's "is debugging" bar shows while an
  agent clicks, types or takes a screenshot and leaves after 20 idle seconds.
- Agents may only use their own tabs and tabs the user connected; they close
  only their own tabs. They never type into password fields (they hand the tab
  over instead), and `browser_evaluate` refuses a password field as its element.
- Same-site links are shown as paths in the snapshot (shorter).
- A dialog a page opens by itself is reported at once instead of timing out;
  `browser_handle_dialog` closes it by reloading.
- Searching a page that has just loaded waits briefly while it is still
  fetching or building (e.g. an editor from a CDN).
- Agent tabs are remembered across extension reloads, so they still close
  with their agent.
- New permissions: `downloads`, `tabGroups`, `webRequest`. Chrome 120 or later.


## 0.6.0

Agents clean up after themselves, and can work in any Chrome profile.

### Added

- **Tabs close when the agent is done.** Tabs opened for an agent, and the
  tabs its pages open, close when its session ends: right away when the
  server exits normally, after 10 s when it dies without a word and no server
  comes back. Tabs you connected never close. **Keep this tab** in the popup
  (or **Keep** next to a tab) hands a tab to you: it stays open and the agent
  lets go of it.
- **Chrome profiles.** `browser_profiles` lists the profiles from Chrome's
  `Local State` (folder, name, Google account) and which ones are connected;
  `browser_profile_select` switches the agent to another profile and opens a
  Chrome window for it if needed. Every profile's extension connects to the
  hub, which tells them apart by the profile's account, or by a one-time page
  it opens in a profile without one (the extension remembers the answer).
  New options: `--profile`, `--chrome-user-data-dir`, `--chrome-path`.
- The extension connects to the server by itself, so agents can start without
  a connected tab (turn off "Let agents open tabs of their own" in the popup
  for the old behaviour). **Stop all** now keeps agents out until **Resume**.

### Changed

- No more tab groups: agent tabs are marked by the agent's initials on the
  extension icon. The `tabGroups` permission is gone; `identity`,
  `identity.email` (the profile's account) and `webNavigation` (tabs a page
  opens) are new.
- Tabs a page opens are attributed to the tab that really opened them; for an
  agent working in a background tab they were missing from action reports.
- Servers only join a hub that marks itself as browsermcp-plus 0.6+, so they
  no longer join another program on the port (e.g. Tabrein MCP). The hub
  refuses Tabrein MCP sessions and extensions that are not Browser MCP Plus,
  and logs such rejections once instead of every second.
- The extension backs off up to 5 s between reconnection attempts.


## 0.5.0

Several agents can now use the browser at the same time, each in its own tab.

### Added

- **Multi-agent.** The first server becomes the hub; servers started later
  (other Claude Code sessions, other MCP clients) join it instead of taking
  over the port. Each request carries its agent session, and each session
  works in a tab of its own: a free connected tab if there is one, otherwise
  a new tab next to them, grouped and labelled with the agent's name (the
  project folder, or `--session-name`). Tabs of different agents run in
  parallel; an agent cannot select or close another agent's tab. When an
  agent exits its tab is freed for the next one; when the hub exits another
  server takes its place and the extension reconnects.
- **Background tabs work at full speed.** Chrome stops processing input in
  hidden tabs and throttles their timers ~100x (measured: clicks never
  arrived, 5 s each). Tabs an agent works in now get focus emulation, and
  waiting/measuring moved from the page to the extension, so a background
  agent clicks and types as fast as one in the active tab (~125 ms).
- **New popup.** Shows the server state, how many agents are connected and
  working, every agent's tab, last action, activity and last error (click
  to jump to its tab), and which connected tabs are free.
- `npm run test:real`: a regression test in a real, visible Chromium, which
  Playwright-launched browsers cannot reproduce.

### Changed

- `browser_tab_select` no longer brings the tab to the front, so agents don't
  steal the user's focus; `browser_tab_list` shows tabs used by other agents.
- `--no-takeover` now means "don't share the browser with a running server".

## 0.4.1

### Fixed

- `browser_wait` ran inside the extension, which handles requests one at a
  time, so any tool called during a long wait timed out with "did not
  answer". Waiting now happens in the server, and plain reads (URL, title,
  tab list, console) never queue behind a running action.

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
