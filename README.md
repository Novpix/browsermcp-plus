# browsermcp-plus

**Let AI apps drive your own browser — including file uploads, tabs and JavaScript.**

browsermcp-plus is an [MCP](https://modelcontextprotocol.io) server and an
open-source Chrome extension. Claude, Cursor, VS Code, Windsurf and any other
MCP client can click, type, upload files and read pages in your real Chrome,
in any of your profiles: you stay logged in, nothing runs in the cloud, and
sites see a normal browser. Agents work in tabs of their own, which close when
they are done.

It started as a hardened fork of [Browser MCP](https://github.com/BrowserMCP/mcp)
and stays compatible with its extension. [Türkçe README](README.tr.md)

> **Use at your own risk.** Agents act in your browser, signed in as you, and
> can do anything you can do there. Read the [disclaimer](#disclaimer) before
> you use it.

## What's different from Browser MCP

| | Browser MCP | browsermcp-plus |
| --- | --- | --- |
| File upload | ✗ | ✓ file inputs *and* "choose file" buttons, no OS dialog |
| `alert` / `confirm` dialogs | freeze the extension | reported and handled |
| Tokens per click on a large page | whole page (~14k on Wikipedia) | short report (~30) |
| Forms | one call per field | `browser_fill_form` |
| Run JavaScript, tabs, scrolling | ✗ | ✓ |
| Extension source | closed | open source ([`extension/`](extension/)) |
| Server reachable from the network | yes, all interfaces | loopback only |
| Any web page can connect to the server | yes | no, origin allowlist |
| Several agents at once | each new client kills the previous one | every agent in its own tab, in parallel |
| Tabs the agent opened | stay open | close when the agent is done (unless you keep them) |
| Chrome profiles | the one you connected | lists them; agents switch profile (`browser_profile_select`) |
| Frames from other sites (payment forms, embedded sign-ins, chat boxes) | invisible | read, clicked and typed into like the page |
| Reading a long email or article | links only | `browser_get_text`: the full text as Markdown, in pages |
| Chrome's "is debugging" bar | on while a tab is connected | only while an agent clicks or types |
| Builds from its own repository, tests, CI | ✗ | ✓ unit + real-browser end-to-end tests |

## Install

**1. Extension** — download `browsermcp-plus-extension-*.zip` from the
[latest release](https://github.com/Novpix/browsermcp-plus/releases/latest)
and unzip it, then in Chrome (or Edge, Brave, Arc…):

1. open `chrome://extensions` and enable **Developer mode**,
2. click **Load unpacked** and choose the unzipped folder,
3. if you have the original Browser MCP extension, disable it.

Install it in every Chrome profile agents should be able to use; each
profile's copy connects on its own.

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

**3. Done** — the extension connects to the server by itself, and agents open
tabs of their own (in the background, so they don't steal your focus). To let
agents use a tab you have open, click the extension icon
(<kbd>Alt</kbd>+<kbd>J</kbd>) in it and press **Connect**; the icon shows `ON`.

## Tools

| Tool | Description |
| --- | --- |
| `browser_navigate` | Open a URL (`example.com` → `https://example.com`) |
| `browser_go_back` / `browser_go_forward` / `browser_reload` | History and reload |
| `browser_snapshot` | Accessibility snapshot with element refs, frames from other sites and closed shadow DOM included (one subtree with `ref`, the rest of a long one with `offset`) |
| `browser_find` | Find elements by text without loading the whole snapshot |
| `browser_get_text` | The page's (or one element's) text as Markdown — headings, lists, tables, links — in full, in pages |
| `browser_click` / `browser_hover` | Act on an element from the snapshot |
| `browser_type` | Type into an element (key by key for masked inputs), optionally pressing Enter |
| `browser_fill_form` | Fill many fields — text, checkboxes, radios, dropdowns, sliders, dates — in one call |
| `browser_select_option` | Choose dropdown values |
| `browser_drag` | Drag one element onto another (incl. HTML5 drag and drop) |
| `browser_press_key` | Keys and shortcuts (`Enter`, `PageDown`, `Control+a`, …) |
| `browser_file_upload` | Upload local files through a file input or a "choose file" button |
| `browser_handle_dialog` | Accept or dismiss `alert` / `confirm` / `prompt` dialogs |
| `browser_evaluate` | Run JavaScript in the page, optionally on a snapshot element |
| `browser_scroll` | Scroll by pixels or scroll an element into view |
| `browser_tab_list` / `_new` / `_select` / `_close` | Work across tabs and windows (`allProfiles` lists every profile); the list says whose each tab is |
| `browser_tab_handoff` | Leave a tab to the user with a note (sign-in, captcha, approval, a result) |
| `browser_tab_take` / `browser_tab_release` | Work in one of the user's open tabs, as it is, when they ask; give it back |
| `browser_get_file` | A PDF, image or any file the browser can reach, with its logins: images inline, every file saved locally |
| `browser_download` / `browser_downloads` | Download with the browser; list downloads and where they are saved |
| `browser_profiles` | List the Chrome profiles (folder, name, Google account) and which ones are connected |
| `browser_profile_select` | Work in another profile; opens a Chrome window for it if needed |
| `browser_wait` / `browser_wait_for` | Wait for time, or for text to appear/disappear |
| `browser_get_console_logs` | Console messages, uncaught errors and failed network requests |
| `browser_screenshot` | PNG of the viewport, one element (`ref`) or the whole page (`fullPage`) |

Actions (click, type, …) answer with a short report — URL, title, whether a new
page loaded, open dialogs, downloads, and what changed on the page since the
agent's last snapshot (`+ added`, `~ changed`, `- removed` lines) — instead of
the whole page, which keeps agents fast and their context small. When the page
opens a tab (a link to a new tab, a popup), the agent moves to it, and back
when it closes. Pass `snapshot: true` when you want the page right away. Clicks
on disabled or covered elements fail with an explanation instead of silently
hitting the overlay. Agents never type into password fields: they hand the tab
to the user.

Tools carry MCP annotations (`readOnlyHint`, `destructiveHint`) so clients can
skip confirmation for read-only ones. With the original Browser MCP extension
everything except upload, forms, dialogs, evaluate, scroll, tabs and profiles
works.

## Options

```
--port <number>            WebSocket port (default 9009)
--session-name <name>      agent name shown in the browser (default: current folder)
--profile <name>           Chrome profile to start in: folder, name or account email
                           (default: the profile Chrome used last)
--chrome-user-data-dir <p> Chrome's user data directory (default: Google Chrome's)
--chrome-path <path>       Chrome executable used to open profiles (default: Google Chrome)
--allow-origin <origin...> extra extension origins allowed to connect
--no-takeover              don't share the browser with a running server
--kill-existing            terminate a non-cooperating process on the port
--request-timeout <ms>     timeout for a single browser action (default 30000)
--snapshot-max-chars <n>   truncate large snapshots (default 80000, 0 = never)
--action-snapshots         include the page snapshot in every action result
--verbose                  debug logging on stderr
```

## Several agents at once

Every Claude Code session (or other MCP client) that starts browsermcp-plus is
an agent with its own tab, and agents work in parallel:

- An agent takes a free tab you connected, or opens a background tab of its
  own. Agent tabs sit in one tab group, **AI**, per profile however many agents
  work; your own tabs are never in it. A tab's agent shows by its initials on
  the extension icon (the project folder, or `--session-name`).
- **Agents work behind your back, literally.** Nothing they do changes the tab
  you are looking at, in any window: opening tabs, taking and giving back yours,
  moving the AI group, links their pages open in new tabs (those open behind).
  No tool needs its tab in front — clicks, typing and screenshots work in
  background tabs — so to watch, switch to the tab yourself.
- **You see it working.** The page an agent works in gets a thin, soft glow at
  its edges and a small label in the corner — the agent's name and what it is
  doing (reading, typing, clicking). It never takes clicks, moves the layout or
  shows in screenshots and snapshots, follows `prefers-reduced-motion`, and
  fades when the agent stops.
- **Tabs close when the agent is done.** The tabs opened for an agent, and the
  tabs its pages open (links to new tabs, popups), close when its session
  ends. If the server dies without saying so, they close after 10 seconds
  unless a server comes back. Tabs you connected never close; to keep a tab an
  agent opened, click the extension icon in it and press **Keep this tab** (or
  **Keep** in the list): the agent lets go of it and it stays yours.
- **Watch, or step in.** Switching to an agent's tab, scrolling it or moving
  the mouse over it changes nothing: the agent carries on. Clicking or typing
  in the page pauses the agent there ("Paused · listening"): its next action in
  that tab is refused with a request to ask you, and it resumes with
  `browser_tab_select` once you have told it what you want. The agent's own
  input and the page's synthetic events never count.
- **When you have to do something** (sign in, a captcha, an approval, a result
  to look at), the agent hands the tab to you with `browser_tab_handoff`: it
  leaves the group, never closes, says "Your turn: …" in its corner, and its
  title and icon blink until you click or type in the page (or press Done in
  the popup) — looking at it does not stop it. The toolbar icon counts tabs
  waiting for you; a window in the background asks for attention once. An
  agent that takes the tab back (`browser_tab_select`) owns it again.
- **"Continue in that tab."** `browser_tab_take` lets an agent work in one of
  your open tabs without you touching it: nothing reloads (fields, sign-in and
  scroll stay), the tab moves into the AI group, and Chrome tells you once,
  with a **Give back** button (also in the popup). It stays yours: never
  closed, and back in its old window and place when the agent is done
  (`browser_tab_release`). Agents take a tab only when you ask them to. A tab
  you are looking at stays in front: in another window it stays there instead
  of moving into the group, and one you went to watch stays where you are.
- The AI group stays at the right end of the tab strip; new agent tabs open at
  its end, and if you open tabs to its right it moves back, calmly.
- An agent cannot touch another agent's tab, nor your tabs unless you connect
  them; `browser_tab_list` says whose each tab is.
- The first server is the hub the extensions connect to; the others join it.
  If the hub exits, another server takes its place automatically.
- The extension popup shows every agent, its tabs, what it is doing and its
  last error. **Stop all** releases every tab (agent tabs stay open as yours)
  and keeps agents out until you press **Resume**.

## Chrome profiles

Each Chrome profile runs its own copy of the extension, and all of them
connect to the hub. The server reads Chrome's `Local State` to list the
profiles and recognises each extension by the profile's Google account; a
profile without an account is recognised the first time
`browser_profile_select` opens it (the server opens a one-time page in the
profile, which its extension reports back), and the extension remembers it.

An agent works in the profile Chrome used last until it picks another with
`browser_profile_select` (folder such as `Profile 3`, profile name or account
email). If the profile has no window, Chrome opens one, and the agent gets
its tab there. `--profile` sets the starting profile.

The port is shared with nothing else: a hub only lets browsermcp-plus 0.6+
servers join (it marks its responses with `x-browsermcp-plus-hub`), turns away
other extensions that connect with the same id (such as a Tabrein build), and
refuses Tabrein MCP sessions. If another program holds the port, the server
waits in standby and says which.

## Frames, reading and the debugger

Every frame runs the page agent. A frame from another site (a payment form, an
embedded sign-in, a captcha, a chat box) shows in the snapshot under its
`iframe`, and its elements have refs like `f12e3` that click, type and the
other tools use as usual: Chrome routes the input to the frame. Closed shadow
roots are read too.

Reading — snapshots, `browser_find`, `browser_get_text`, console and network
errors, navigation — goes through content scripts and never needs the
debugger, so Chrome's "is debugging this browser" bar only shows while an
agent clicks, types or takes a screenshot, and goes away after 20 idle
seconds. A JavaScript dialog the page opens on its own is reported at once;
since no debugger saw it open, `browser_handle_dialog` closes it by reloading.

## Security model

- The server listens on `127.0.0.1` / `::1` only.
- Only the extension origins may connect, so web pages you visit cannot talk to
  the server or impersonate the extension.
- The extension connects to the local server by itself, so a program that
  takes the port can drive your browser. Turn off "Let agents open tabs of
  their own" in the popup's settings to make it connect only while you have a
  tab connected, or press **Stop all**.
- The extension acts only in the tabs you connect and the tabs it opens for
  agents; Chrome shows its "is debugging this browser" bar while it does.
- Agents never type into or read password fields (`browser_type` and
  `browser_fill_form` refuse, the snapshot masks them, `browser_evaluate`
  refuses a password field as its element); they hand the tab to you.
- Page content returned by the tools is untrusted input for the model.

## Development

```sh
npm install
npm run check     # typecheck + unit tests + build
npm run test:e2e  # Chromium + extension end to end (single, multi-agent, profiles)
npm run test:real # background tabs in a real, visible Chromium (needs a display)
npm run bench     # tool latency and snapshot size on a large page (ROWS=150 for an ordinary one)
```

The wire protocol is documented in [`src/protocol.ts`](src/protocol.ts), the
extension in [`extension/README.md`](extension/README.md).

## Disclaimer

browsermcp-plus is a powerful tool. It gives AI agents control of your real
browser, signed in to your accounts. In the tabs it can reach, an agent can do
anything you could do: send messages and email, post in public, change account
settings, delete data, submit forms, buy things and make payments. AI models
make mistakes, and web pages can contain text written to mislead them
(prompt injection).

- **You are responsible for its use.** You choose the agents, the profiles
  and the sites, and you alone are responsible for every action taken through
  it, for complying with the terms of the sites you use it on, and for
  following the laws that apply to you.
- **Stay in control.** Watch what agents do and confirm anything that matters
  yourself. Do not use it with accounts or data you cannot afford to have
  changed, deleted or exposed.
- **No warranty, no liability.** The software is provided "as is", without
  warranty of any kind, express or implied. To the fullest extent permitted by
  law, Novpix LLC and the contributors are not liable for any damage, loss of
  data, financial loss, account suspension or other consequence arising from
  its use or from actions agents take with it. See sections 7 and 8 of the
  [Apache License 2.0](LICENSE).
- **Independent project.** browsermcp-plus is not affiliated with or endorsed
  by Google, Anthropic, the Browser MCP authors or any other company whose
  products it works with. Chrome is a trademark of Google LLC.

## License

Copyright 2026 Novpix LLC. Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE) — based on
[Browser MCP](https://github.com/BrowserMCP/mcp), which was adapted from
[Playwright MCP](https://github.com/microsoft/playwright-mcp). Not affiliated
with the Browser MCP authors.
