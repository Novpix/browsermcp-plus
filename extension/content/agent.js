// Page agent injected into the isolated world of every frame of the tabs
// agents use.
//
// It builds the accessibility snapshot the model works from, owns the
// ref -> element map behind it, performs the DOM-level parts of actions,
// extracts readable text and shows the "an agent is working here" overlay.
// Pointer and keyboard input itself is dispatched by the background worker
// through the debugger API so pages receive trusted events.
//
// Frames: a frame's snapshot includes the same-origin frames inside it; a
// cross-origin frame runs its own copy of this agent and shows up as a
// placeholder (`- <<frame:TOKEN>>`) the background fills with that frame's
// snapshot. Which <iframe> holds which frame is learnt with a postMessage
// handshake: the parent says hello, the child answers with its token.
(() => {
  if (globalThis.__bmcp) return;

  const MAX_TEXT = 200;
  const MAX_NAME = 120;
  const IS_TOP = window === window.top;
  /** This agent's id, which its parent frame learns in the handshake. */
  const TOKEN = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
  /** Same-origin frames are part of their parent's snapshot. */
  const SAME_ORIGIN_PARENT =
    !IS_TOP &&
    (() => {
      try {
        return !!window.parent.document;
      } catch {
        return false;
      }
    })();

  // Refs are stable: an element keeps its ref across snapshots for as long as
  // it stays in the document, so refs from earlier results remain usable.
  // Refs of subframes carry the frame ("f12e3"), set by the background.
  let prefix = "";
  let counter = 0;
  const refs = new Map(); // ref -> WeakRef<Element>
  const refOf = new WeakMap(); // Element -> ref

  function setPrefix(value) {
    if (!prefix && !counter) prefix = value;
  }

  const SKIPPED_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "BASE", "TITLE",
  ]);

  const TAG_ROLES = {
    ARTICLE: "article", ASIDE: "complementary", BLOCKQUOTE: "blockquote", BUTTON: "button",
    DIALOG: "dialog", DL: "list", FIELDSET: "group", FIGURE: "figure", FOOTER: "contentinfo",
    FORM: "form", H1: "heading", H2: "heading", H3: "heading", H4: "heading", H5: "heading",
    H6: "heading", HEADER: "banner", HR: "separator", LI: "listitem", MAIN: "main", MENU: "list",
    METER: "meter", NAV: "navigation", OL: "list", OPTGROUP: "group", OPTION: "option",
    P: "paragraph", PROGRESS: "progressbar", SUMMARY: "button", TABLE: "table", TBODY: "rowgroup",
    TD: "cell", TEXTAREA: "textbox", TFOOT: "rowgroup", TH: "columnheader", THEAD: "rowgroup",
    TR: "row", UL: "list",
  };

  /** Structure that carries no information of its own: its content is listed in its place. */
  const FLATTENED_ROLES = new Set(["rowgroup", "generic", "none", "presentation"]);
  /** Roles listed without a ref. */
  const UNREFERENCED_ROLES = new Set();

  /** Roles whose accessible name comes from their content. */
  const NAME_FROM_CONTENT = new Set([
    // Table cells are deliberately absent: their content is listed as children.
    "button", "checkbox", "heading", "link", "menuitem", "menuitemcheckbox", "menuitemradio",
    "option", "radio", "switch", "tab", "tooltip", "treeitem",
  ]);

  /** Roles rendered as a single line: their descendants are not listed. */
  const LEAF_ROLES = new Set([
    "button", "checkbox", "heading", "img", "link", "menuitem", "menuitemcheckbox",
    "menuitemradio", "meter", "option", "progressbar", "radio", "searchbox", "separator",
    "slider", "spinbutton", "switch", "tab", "textbox",
  ]);

  const INPUT_ROLES = {
    button: "button", checkbox: "checkbox", file: "button", image: "button", number: "spinbutton",
    radio: "radio", range: "slider", reset: "button", search: "searchbox", submit: "button",
  };

  function collapse(text) {
    // SVG elements expose objects (e.g. SVGAnimatedString) for some properties.
    return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  }

  function clip(text, max) {
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }

  function textOf(el) {
    return clip(collapse(el.innerText ?? el.textContent), MAX_NAME);
  }

  /** Text of a <label>, leaving out the control it wraps (e.g. a select's options). */
  function labelText(label, control) {
    if (!label.contains(control)) return textOf(label);
    let text = "";
    const walk = (node) => {
      if (node === control) return;
      if (node.nodeType === Node.TEXT_NODE) text += ` ${node.textContent}`;
      else if (node.nodeType === Node.ELEMENT_NODE && !SKIPPED_TAGS.has(node.tagName)) node.childNodes.forEach(walk);
    };
    label.childNodes.forEach(walk);
    return clip(collapse(text), MAX_NAME);
  }

  function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit && explicit.trim() && !/^(none|presentation)$/.test(explicit.trim())) {
      return explicit.trim().split(/\s+/)[0];
    }
    if (explicit) return null;
    const tag = el.tagName;
    if (tag === "A" || tag === "AREA") return el.hasAttribute("href") ? "link" : null;
    if (tag === "INPUT") {
      if (el.type === "hidden") return null;
      return INPUT_ROLES[el.type] || "textbox";
    }
    if (tag === "SELECT") return el.multiple || el.size > 1 ? "listbox" : "combobox";
    if (tag === "IMG") return el.getAttribute("alt") === "" ? null : "img";
    if (tag === "SVG" || tag === "svg") {
      return el.getAttribute("aria-label") || el.querySelector(":scope > title") ? "img" : null;
    }
    if (tag === "SECTION") return el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") ? "region" : null;
    if (tag === "IFRAME" || tag === "FRAME") return "iframe";
    if (TAG_ROLES[tag]) return TAG_ROLES[tag];
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return "textbox";
    return null;
  }

  function nameOf(el, role) {
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const doc = el.ownerDocument;
      const name = labelledBy
        .split(/\s+/)
        .map((id) => doc.getElementById(id))
        .filter(Boolean)
        .map(textOf)
        .join(" ");
      if (collapse(name)) return clip(collapse(name), MAX_NAME);
    }
    const ariaLabel = collapse(el.getAttribute("aria-label"));
    if (ariaLabel) return clip(ariaLabel, MAX_NAME);

    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      if (tag === "INPUT" && ["button", "submit", "reset"].includes(el.type)) {
        return el.value || (el.type === "submit" ? "Submit" : el.type === "reset" ? "Reset" : "");
      }
      if (tag === "INPUT" && el.type === "image") return el.alt || el.value || "Submit";
      const labels = el.labels ? [...el.labels].map((label) => labelText(label, el)).join(" ") : "";
      if (collapse(labels)) return clip(collapse(labels), MAX_NAME);
      return collapse(el.getAttribute("placeholder") || el.title);
    }
    if (tag === "IMG" || tag === "AREA") return collapse(el.alt || el.title);
    if (tag === "svg" || tag === "SVG") return collapse(el.querySelector(":scope > title")?.textContent);
    if (tag === "FIELDSET") {
      const legend = el.querySelector(":scope > legend");
      if (legend) return textOf(legend);
    }
    if (tag === "TABLE") {
      const caption = el.querySelector(":scope > caption");
      if (caption) return textOf(caption);
    }
    if (tag === "IFRAME") return collapse(el.title || el.name);
    if (NAME_FROM_CONTENT.has(role)) return textOf(el) || collapse(el.title) || nameFromDescendants(el);
    return collapse(el.title);
  }

  /** Icon-only buttons and links: use a labelled image or icon inside them. */
  function nameFromDescendants(el) {
    const labelled = el.querySelector("[aria-label], img[alt], svg title, [title]");
    if (!labelled) return "";
    if (labelled.tagName === "title") return clip(collapse(labelled.textContent), MAX_NAME);
    return clip(
      collapse(labelled.getAttribute("aria-label") || labelled.getAttribute("alt") || labelled.getAttribute("title")),
      MAX_NAME,
    );
  }

  /**
   * Hidden from the user: display:none, visibility:hidden, aria-hidden. Uses
   * the browser's own checkVisibility, much cheaper than getComputedStyle
   * per element; display:contents boxes have no box of their own but their
   * children may well be visible.
   */
  function isHidden(el) {
    if (el === overlay?.host) return true;
    if (el.getAttribute("aria-hidden") === "true") return true;
    if (el.tagName === "INPUT" && el.type === "hidden") return true;
    if (el.checkVisibility) {
      if (el.checkVisibility({ visibilityProperty: true })) return false;
      const style = el.ownerDocument.defaultView.getComputedStyle(el);
      return style.display !== "contents";
    }
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    return el.hidden || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse";
  }

  /** Open and closed shadow roots (content scripts may read closed ones). */
  function shadowOf(node) {
    if (node.shadowRoot) return node.shadowRoot;
    if (!node.localName?.includes("-")) return null;
    try {
      return chrome.dom?.openOrClosedShadowRoot(node) ?? null;
    } catch {
      return null;
    }
  }

  /** The document inside a frame element, if this frame may read it. */
  function frameDocument(frame) {
    try {
      return frame.contentDocument;
    } catch {
      return null;
    }
  }

  function childNodesOf(node) {
    const shadow = shadowOf(node);
    if (shadow) return [...shadow.childNodes];
    if (node.tagName === "SLOT") {
      const assigned = node.assignedNodes({ flatten: true });
      if (assigned.length) return assigned;
    }
    if (node.tagName === "IFRAME" || node.tagName === "FRAME") {
      const doc = frameDocument(node);
      // A frameset document's body is the <frameset>.
      const root = doc?.body ?? doc?.documentElement;
      return root ? [root] : [];
    }
    return [...node.childNodes];
  }

  function stateOf(el, role) {
    const attrs = [];
    if (role === "heading") {
      const level = el.getAttribute("aria-level") || /^H(\d)$/.exec(el.tagName)?.[1];
      if (level) attrs.push(`level=${level}`);
    }
    const checked =
      el.getAttribute("aria-checked") ??
      (el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio")
        ? el.indeterminate
          ? "mixed"
          : String(el.checked)
        : null);
    if (checked === "true") attrs.push("checked");
    if (checked === "mixed") attrs.push("checked=mixed");
    if (el.disabled || el.getAttribute("aria-disabled") === "true") attrs.push("disabled");
    const expanded = el.getAttribute("aria-expanded");
    if (expanded === "true") attrs.push("expanded");
    if (expanded === "false") attrs.push("expanded=false");
    if (el.getAttribute("aria-pressed") === "true") attrs.push("pressed");
    if ((el.tagName === "OPTION" && el.selected) || el.getAttribute("aria-selected") === "true") {
      attrs.push("selected");
    }
    if (el.tagName === "INPUT" && el.type === "file") {
      attrs.push(el.multiple ? "file-input multiple" : "file-input");
    }
    if (el.tagName === "TEXTAREA") attrs.push("multiline");
    if (el.required || el.getAttribute("aria-required") === "true") attrs.push("required");
    return attrs;
  }

  function valueOf(el, role) {
    if (el.tagName === "INPUT") {
      if (["checkbox", "radio", "button", "submit", "reset", "image"].includes(el.type)) return null;
      if (el.type === "file") {
        return el.files?.length ? [...el.files].map((f) => f.name).join(", ") : null;
      }
      if (!el.value) return null;
      return el.type === "password" ? "•".repeat(Math.min(el.value.length, 8)) : el.value;
    }
    if (el.tagName === "TEXTAREA") return el.value || null;
    if (el.tagName === "SELECT" && !el.multiple) return el.selectedOptions[0]?.textContent?.trim() || null;
    if (role === "textbox" && el.isContentEditable) return clip(collapse(el.innerText), MAX_TEXT) || null;
    if (role === "progressbar" || role === "meter" || role === "slider") {
      return el.getAttribute("aria-valuenow") ?? (el.value != null ? String(el.value) : null);
    }
    return null;
  }

  function newRef(el) {
    let ref = refOf.get(el);
    if (!ref) {
      ref = `${prefix}e${++counter}`;
      refOf.set(el, ref);
      refs.set(ref, new WeakRef(el));
    }
    return ref;
  }

  function pruneRefs() {
    for (const [ref, weak] of refs) {
      const el = weak.deref();
      if (!el || !el.isConnected) refs.delete(ref);
    }
  }

  /** Builds snapshot items for a DOM node: { text } or { role, name, ... children }. */
  function build(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = collapse(node.textContent);
      return text ? [{ text }] : [];
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return [];
    const el = node;
    if (SKIPPED_TAGS.has(el.tagName)) return [];
    if (isHidden(el)) return [];

    const role = roleOf(el);
    if (role === "iframe") {
      const item = { role, name: nameOf(el, role), attrs: [], ref: newRef(el) };
      if (frameDocument(el)) {
        item.children = merge(childNodesOf(el).flatMap(build));
      } else {
        // Another origin: its own agent fills this in.
        crossOriginFrames.add(el);
        item.children = [{ frame: frameTokens.get(el) ?? "?" }];
      }
      return [item];
    }

    if (!role || FLATTENED_ROLES.has(role)) return childNodesOf(el).flatMap(build);

    const item = {
      role,
      name: nameOf(el, role),
      attrs: stateOf(el, role),
      ref: UNREFERENCED_ROLES.has(role) ? null : newRef(el),
      value: valueOf(el, role),
      children: [],
    };
    if (role === "link") {
      const href = el.getAttribute("href");
      if (href) item.url = shortUrl(href, el.ownerDocument.baseURI);
    }
    if (el.tagName === "SELECT") {
      item.children = [...el.options].map((option) => ({
        role: "option",
        name: clip(collapse(option.textContent), MAX_NAME),
        attrs: option.selected ? ["selected"] : [],
        ref: newRef(option),
        children: [],
      }));
    } else if (!LEAF_ROLES.has(role)) {
      item.children = merge(childNodesOf(el).flatMap(build));
    }
    return [item];
  }

  /** Links to this page's origin are shown as a path: shorter, and just as usable. */
  function shortUrl(href, base) {
    try {
      const url = new URL(href, base);
      return url.origin === location.origin && url.protocol.startsWith("http") ? url.pathname + url.search + url.hash : url.href;
    } catch {
      return href;
    }
  }

  /** Joins adjacent text items so inline markup does not split sentences. */
  function merge(items) {
    const out = [];
    for (const item of items) {
      const last = out[out.length - 1];
      if (item.text !== undefined && last && last.text !== undefined) {
        last.text = `${last.text} ${item.text}`;
      } else {
        out.push(item.text !== undefined ? { text: item.text } : item);
      }
    }
    for (const item of out) if (item.text !== undefined) item.text = clip(item.text, MAX_TEXT);
    return out;
  }

  const NEEDS_QUOTES = /^[\s\-?:,\[\]{}#&*!|>'"%@`]|[:#]\s|\s$|^$/;

  function scalar(text) {
    return NEEDS_QUOTES.test(text) ? JSON.stringify(text) : text;
  }

  function render(items, indent, lines) {
    const pad = "  ".repeat(indent);
    for (const item of items) {
      if (item.text !== undefined) {
        lines.push(`${pad}- text: ${scalar(item.text)}`);
        continue;
      }
      if (item.frame !== undefined) {
        lines.push(`${pad}- <<frame:${item.frame}>>`);
        continue;
      }
      let line = `${pad}- ${item.role}`;
      if (item.name) line += ` ${JSON.stringify(item.name)}`;
      for (const attr of item.attrs) line += ` [${attr}]`;
      if (item.ref) line += ` [ref=${item.ref}]`;
      const children = item.children || [];
      const onlyText = children.length === 1 && children[0].text !== undefined && !item.url;
      if (item.value != null && item.value !== "") {
        lines.push(`${line}: ${scalar(String(item.value))}`);
        if (children.length) render(children, indent + 1, lines);
      } else if (onlyText) {
        lines.push(`${line}: ${scalar(children[0].text)}`);
      } else if (children.length || item.url) {
        lines.push(`${line}:`);
        if (item.url) lines.push(`${pad}  - /url: ${scalar(item.url)}`);
        render(children, indent + 1, lines);
      } else {
        lines.push(line);
      }
    }
  }

  /** The last snapshot handed out, and the DOM's mutation count then: the baseline for changes(). */
  let lastSnapshot = null;

  function snapshot() {
    pruneRefs();
    crossOriginFrames.clear();
    const root = document.body || document.documentElement;
    const lines = [];
    if (root) render(merge(build(root)), 0, lines);
    const text = lines.join("\n");
    lastSnapshot = { text, mutations: mutationCount };
    return text;
  }

  /**
   * What changed since the last snapshot, as "+ added", "~ changed" and
   * "- removed" lines (elements matched by their stable refs, text by
   * content); null without a snapshot to compare with. Untouched DOM is
   * answered without building a snapshot.
   */
  function changes(max = 40) {
    if (!lastSnapshot) return null;
    if (mutationCount === lastSnapshot.mutations) return { lines: [], more: 0 };
    const before = lastSnapshot.text;
    return diffSnapshots(before, snapshot(), max);
  }

  function diffSnapshots(before, after, max) {
    const index = (text) => {
      const byRef = new Map();
      const texts = new Map();
      for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("- /url:")) continue;
        const ref = /\[ref=([^\]]+)\]/.exec(line)?.[1];
        if (ref) byRef.set(ref, line);
        else texts.set(line, (texts.get(line) ?? 0) + 1);
      }
      return { byRef, texts };
    };
    const old = index(before);
    const now = index(after);
    const lines = [];
    for (const [ref, line] of now.byRef) {
      const was = old.byRef.get(ref);
      if (was === undefined) lines.push(`+ ${line.slice(2)}`);
      else if (was !== line) lines.push(`~ ${line.slice(2)}`);
    }
    for (const [line, count] of now.texts) if (count > (old.texts.get(line) ?? 0)) lines.push(`+ ${line.slice(2)}`);
    for (const [ref, line] of old.byRef) if (!now.byRef.has(ref)) lines.push(`- ${line.slice(2)}`);
    for (const [line, count] of old.texts) if (count > (now.texts.get(line) ?? 0)) lines.push(`- ${line.slice(2)}`);
    return { lines: lines.slice(0, max), more: Math.max(0, lines.length - max) };
  }

  /** What the background needs to stitch this frame into its parent's snapshot. */
  function frameSnapshot() {
    if (SAME_ORIGIN_PARENT) return { token: TOKEN, inlined: true };
    if (!IS_TOP && (window.innerWidth === 0 || window.innerHeight === 0)) return { token: TOKEN, text: "" };
    return { token: TOKEN, text: snapshot() };
  }

  // --- Frame handshake ------------------------------------------------------

  /** Cross-origin frame elements seen in the last snapshot (some live in shadow roots). */
  const crossOriginFrames = new Set();
  const frameTokens = new WeakMap(); // frame element -> child agent's token
  const tokenFrames = new Map(); // token -> WeakRef<frame element>
  const asked = new Map(); // child WindowProxy -> frame element, while waiting for an answer

  addEventListener(
    "message",
    (event) => {
      const data = event.data;
      if (!data || typeof data !== "object" || typeof data.__bmcp !== "string") return;
      if (data.__bmcp === "hello" && event.source && event.source !== window) {
        try {
          event.source.postMessage({ __bmcp: "child", token: TOKEN, to: data.from }, "*");
        } catch {
          // the asking window is gone
        }
      } else if (data.__bmcp === "child" && data.to === TOKEN) {
        const frame = asked.get(event.source);
        if (!frame) return;
        asked.delete(event.source);
        frameTokens.set(frame, data.token);
        tokenFrames.set(data.token, new WeakRef(frame));
      }
    },
    true,
  );

  /** Every cross-origin frame element in this document and the same-origin frames inside it. */
  function allCrossOriginFrames() {
    const found = new Set(crossOriginFrames);
    const visit = (doc) => {
      for (const frame of doc.querySelectorAll("iframe, frame")) {
        const inner = frameDocument(frame);
        if (inner) visit(inner);
        else found.add(frame);
      }
    };
    visit(document);
    return [...found].filter((f) => f.isConnected);
  }

  /** Says hello to the cross-origin frames whose agent is not known yet. Returns how many. */
  function probe() {
    let asking = 0;
    for (const frame of allCrossOriginFrames()) {
      const win = frame.contentWindow;
      const token = frameTokens.get(frame);
      if (!win || (token && tokenFrames.get(token)?.deref() === frame && !asked.has(win))) continue;
      asked.set(win, frame);
      win.postMessage({ __bmcp: "hello", from: TOKEN }, "*");
      asking++;
    }
    return asking;
  }

  /** Offset of a child frame's viewport in this frame's viewport, optionally scrolling it into view. */
  function frameOffset(token, scroll = false) {
    const frame = tokenFrames.get(token)?.deref();
    if (!frame || !frame.isConnected) {
      throw new Error("The frame this element is in is no longer on the page. Take a new snapshot.");
    }
    if (scroll) frame.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    const rect = frame.getBoundingClientRect();
    const style = frame.ownerDocument.defaultView.getComputedStyle(frame);
    const point = toTopViewport(
      frame,
      rect.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft),
      rect.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop),
    );
    return { ...point, width: frame.clientWidth, height: frame.clientHeight };
  }

  /** What would receive a click at (x, y) instead of the child frame, or null. */
  function frameBlocker(token, x, y) {
    const frame = tokenFrames.get(token)?.deref();
    if (!frame) return null;
    const hit = deepHit(document, x, y);
    return !hit || hit === frame || composedContains(frame, hit) ? null : describeBlocker(hit);
  }

  /** The element at (x, y), looking into shadow roots and same-origin frames. */
  function deepHit(doc, x, y) {
    let hit = deepElementFromPoint(doc, x, y);
    while (hit && (hit.tagName === "IFRAME" || hit.tagName === "FRAME")) {
      const inner = frameDocument(hit);
      if (!inner) break;
      const rect = hit.getBoundingClientRect();
      x -= rect.left + hit.clientLeft;
      y -= rect.top + hit.clientTop;
      const inside = deepElementFromPoint(inner, x, y);
      if (!inside) break;
      hit = inside;
    }
    return hit;
  }

  function info() {
    return { token: TOKEN, inlined: SAME_ORIGIN_PARENT, url: location.href };
  }

  function element(ref) {
    const el = refs.get(ref)?.deref();
    if (!el) {
      throw new Error(
        `Element ref "${ref}" not found in the current page snapshot. Take a new snapshot and use a ref from it.`,
      );
    }
    if (!el.isConnected) {
      throw new Error(`Element "${ref}" is no longer on the page. Take a new snapshot.`);
    }
    return el;
  }

  function boxOf(el) {
    // Inline elements wrapping across lines have a bounding box with a gap in the middle.
    const rects = [...el.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    return rects[0] || el.getBoundingClientRect();
  }

  function isDisabled(el) {
    return !!(el.disabled || el.closest?.("[aria-disabled='true'], fieldset:disabled") || el.getAttribute?.("aria-disabled") === "true");
  }

  /** Whether `node` is `ancestor` or inside it, crossing shadow-root boundaries. */
  function composedContains(ancestor, node) {
    for (let n = node; n; n = n.parentNode || n.host) {
      if (n === ancestor) return true;
    }
    return false;
  }

  function deepElementFromPoint(doc, x, y) {
    let hit = doc.elementFromPoint(x, y);
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  }

  function receivesPointer(el, hit) {
    if (!hit) return true;
    if (composedContains(el, hit) || composedContains(hit, el)) return true;
    // Clicking a control's <label> (e.g. a styled checkbox) acts on the control.
    if (el.labels && [...el.labels].some((label) => composedContains(label, hit))) return true;
    return false;
  }

  function describeNode(n, role) {
    const name = nameOf(n, role);
    return `${role}${name ? ` ${JSON.stringify(name)}` : ""} [ref=${newRef(n)}]`;
  }

  /** Short description of whatever covers an element, with refs the agent can act on. */
  function describeBlocker(hit) {
    let described = "";
    for (let n = hit; n && n.nodeType === Node.ELEMENT_NODE; n = n.parentElement || n.getRootNode().host) {
      const role = roleOf(n);
      if (role && !described) {
        described = describeNode(n, role);
        if (role === "dialog" || role === "alertdialog") return described;
      } else if (role === "dialog" || role === "alertdialog") {
        // Name the overlay too: dismissing it is usually what unblocks the click.
        return `${described} inside ${describeNode(n, role)}`;
      }
      if (n === n.ownerDocument.body) break;
    }
    if (described) return described;
    const label = collapse(hit.innerText).slice(0, 60);
    return `<${hit.tagName.toLowerCase()}>${label ? ` "${label}"` : ""} [ref=${newRef(hit)}]`;
  }

  /** Validates a click target and scrolls it into view; position and coverage are checked by the caller. */
  function prepareTarget(ref, check = true) {
    const el = element(ref);
    if (check && isDisabled(el)) throw new Error(`Element "${ref}" is disabled.`);
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    return true;
  }

  /** What would receive a click at the element's centre instead of it, or null. */
  function blocker(ref) {
    const el = element(ref);
    const box = boxOf(el);
    const hit = deepElementFromPoint(el.ownerDocument, box.left + box.width / 2, box.top + box.height / 2);
    return receivesPointer(el, hit) ? null : describeBlocker(hit);
  }

  /** Both drag endpoints, measured after a single scroll so neither goes stale. */
  function dragPoints(startRef, endRef) {
    const start = element(startRef);
    const end = element(endRef);
    start.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    if (!inViewport(end)) {
      end.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    }
    return { from: centerOf(startRef), to: centerOf(endRef) };
  }

  function inViewport(el) {
    const rect = el.getBoundingClientRect();
    const win = el.ownerDocument.defaultView;
    return rect.top >= 0 && rect.left >= 0 && rect.bottom <= win.innerHeight && rect.right <= win.innerWidth;
  }

  function centerOf(ref) {
    const el = element(ref);
    const rect = boxOf(el);
    if (rect.width === 0 && rect.height === 0) {
      throw new Error(`Element "${ref}" has no visible size and cannot be interacted with.`);
    }
    return toTopViewport(el, rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  /** The element's box in this frame's viewport (for element screenshots). */
  function boxIn(ref) {
    const el = element(ref);
    el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) throw new Error(`Element "${ref}" has no visible size.`);
    return { ...toTopViewport(el, rect.left, rect.top), width: rect.width, height: rect.height };
  }

  /** Translates a point in `el`'s document through same-origin iframes to this frame's viewport. */
  function toTopViewport(el, x, y) {
    let win = el.ownerDocument.defaultView;
    while (win && win !== window && win.frameElement) {
      const frame = win.frameElement;
      const frameRect = frame.getBoundingClientRect();
      const frameStyle = frame.ownerDocument.defaultView.getComputedStyle(frame);
      x += frameRect.left + parseFloat(frameStyle.borderLeftWidth) + parseFloat(frameStyle.paddingLeft);
      y += frameRect.top + parseFloat(frameStyle.borderTopWidth) + parseFloat(frameStyle.paddingTop);
      win = frame.ownerDocument.defaultView;
    }
    return { x, y };
  }

  /** Input types whose value cannot be typed character by character. */
  const DIRECT_VALUE_TYPES = new Set(["date", "datetime-local", "month", "week", "time", "color", "range"]);

  /** How a field should be edited: "text" (focus + type), "direct" (set value) or an error. */
  function editKind(ref) {
    const el = element(ref);
    if (isPassword(el)) {
      throw new Error(
        `Element "${ref}" is a password field. Agents never type or read passwords: hand the tab to the user with browser_tab_handoff (e.g. note "sign-in needed") and let them enter it.`,
      );
    }
    if (isDisabled(el)) throw new Error(`Element "${ref}" is disabled.`);
    if (el.readOnly) throw new Error(`Element "${ref}" is read-only.`);
    if (el.tagName === "INPUT") {
      if (DIRECT_VALUE_TYPES.has(el.type)) return "direct";
      if (["checkbox", "radio", "file", "button", "submit", "reset", "image", "hidden"].includes(el.type)) {
        throw new Error(`Element "${ref}" is a ${el.type} input; use ${el.type === "file" ? "browser_file_upload" : "browser_click"}.`);
      }
      return "text";
    }
    if (el.tagName === "TEXTAREA" || el.isContentEditable) return "text";
    throw new Error(`Element "${ref}" is not editable.`);
  }

  function isPassword(el) {
    return el.tagName === "INPUT" && (el.type === "password" || el.autocomplete === "current-password" || el.autocomplete === "new-password");
  }

  /** Refuses elements agents must not read or change through evaluate. */
  function guardSecret(ref) {
    if (isPassword(element(ref))) throw new Error(`Element "${ref}" is a password field; agents do not read or change passwords.`);
    return true;
  }

  /** Sets a value the way frameworks (React, Vue) observe it: native setter + input/change events. */
  function setValue(ref, value) {
    const el = element(ref);
    if (isPassword(el)) throw new Error(`Element "${ref}" is a password field; let the user enter it.`);
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    if (el.value !== String(value)) throw new Error(`Element "${ref}" did not accept the value ${JSON.stringify(value)} (now ${JSON.stringify(el.value)}).`);
    return el.value;
  }

  /** Focuses an editable element and selects its content so typing replaces it. Returns whether it had content. */
  function selectContent(ref) {
    const el = element(ref);
    const doc = el.ownerDocument;
    if (doc.activeElement !== el && !el.contains(doc.activeElement)) el.focus();
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const hadContent = el.value.length > 0;
      try {
        el.select();
      } catch {
        // select() is unsupported for some types; typing will append in that case.
      }
      return hadContent;
    }
    const range = doc.createRange();
    range.selectNodeContents(el);
    const selection = doc.defaultView.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return collapse(el.innerText).length > 0;
  }

  /** Current value of a field, masked for passwords. */
  function fieldValue(ref) {
    const el = element(ref);
    if (el.tagName === "INPUT" && el.type === "password") return "•".repeat(Math.min(el.value.length, 8));
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return el.value;
    return clip(collapse(el.innerText), MAX_TEXT);
  }

  function isChecked(ref) {
    const el = element(ref);
    if (el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio")) return el.checked;
    return el.getAttribute("aria-checked") === "true" || el.getAttribute("aria-pressed") === "true";
  }

  function isNativeSelect(ref) {
    return element(ref).tagName === "SELECT";
  }

  function selectOptions(ref, values) {
    const el = element(ref);
    if (el.tagName !== "SELECT") throw new Error(`Element "${ref}" is not a <select>.`);
    const wanted = values.map(String);
    const matched = [];
    for (const option of el.options) {
      const hit =
        wanted.includes(option.value) || wanted.includes(collapse(option.textContent));
      if (hit) matched.push(option);
    }
    if (!matched.length) {
      const available = [...el.options].map((o) => collapse(o.textContent)).join(", ");
      throw new Error(`No option matches ${JSON.stringify(values)}. Available: ${available}`);
    }
    if (!el.multiple && matched.length > 1) matched.length = 1;
    for (const option of el.options) option.selected = matched.includes(option);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return matched.map((o) => collapse(o.textContent));
  }

  function check(ref) {
    element(ref);
    return true;
  }

  function isFileInput(ref) {
    const el = element(ref);
    return el.tagName === "INPUT" && el.type === "file";
  }

  function scrollIntoView(ref) {
    element(ref).scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  }

  /** The address of the file an element shows or links to (image, link, embed, video). */
  function resourceOf(ref) {
    const el = element(ref);
    const url = el.currentSrc || el.src || el.href || el.data || el.getAttribute("src") || el.getAttribute("href");
    if (!url) throw new Error(`Element "${ref}" does not show or link to a file.`);
    return new URL(url, el.ownerDocument.baseURI).href;
  }

  function viewport() {
    return { width: window.innerWidth, height: window.innerHeight };
  }

  // Counts DOM mutations so the extension can tell when the page has settled.
  // The waiting itself happens in the extension, whose timers are not
  // throttled like a background tab's.
  let mutationCount = 0;
  let lastMutation = 0;
  new MutationObserver((records) => {
    mutationCount += records.length;
    lastMutation = Date.now();
  }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });

  function mutations() {
    return mutationCount;
  }

  /** Milliseconds since the DOM last changed (Infinity if it never did). */
  function quietFor() {
    return lastMutation ? Date.now() - lastMutation : Infinity;
  }

  // --- Readable text -----------------------------------------------------------

  const BLOCK_TAGS = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "CENTER", "DD", "DETAILS", "DIALOG", "DIV", "DL", "DT",
    "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "HEADER", "HGROUP", "LI", "MAIN", "NAV", "OL",
    "P", "SECTION", "SUMMARY", "UL", "BODY", "FRAMESET",
  ]);

  /**
   * The text a person reads on the page (or in one element), as light
   * Markdown: headings, paragraphs, lists, tables, code and links. Nothing is
   * clipped; the server pages through it. Form values are left out.
   */
  function readText({ ref, selector, links = true } = {}) {
    let root;
    if (ref) root = element(ref);
    else if (selector) {
      root = document.querySelector(selector);
      if (!root) throw new Error(`Nothing on the page matches the selector ${JSON.stringify(selector)}.`);
    } else root = document.body || document.documentElement;
    const blocks = [];
    let line = "";
    const flush = () => {
      const text = line.replace(/[ \t\u00a0]+/g, " ").trim();
      if (text) blocks.push(text);
      line = "";
    };
    const block = (text) => {
      flush();
      if (text) blocks.push(text);
    };
    const visibleText = (el) => collapse(el.innerText ?? el.textContent);

    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        line += node.textContent.replace(/\s+/g, " ");
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node;
      const tag = el.tagName;
      if (SKIPPED_TAGS.has(tag) || isHidden(el)) return;
      if (tag === "BR") return flush();
      if (tag === "HR") return block("---");
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "OPTION") return;
      if (tag === "IMG") {
        if (el.alt) line += ` [image: ${collapse(el.alt)}] `;
        return;
      }
      if (tag === "IFRAME" || tag === "FRAME") {
        if (frameDocument(el)) childNodesOf(el).forEach(walk);
        else block(`[[bmcp-frame:${frameTokens.get(el) ?? "?"}]]`);
        return;
      }
      if (/^H[1-6]$/.test(tag)) return block(`${"#".repeat(Number(tag[1]))} ${visibleText(el)}`);
      if (tag === "PRE") return block("```\n" + (el.innerText ?? el.textContent).replace(/\n+$/, "") + "\n```");
      if (tag === "TABLE") return block(tableText(el));
      if (tag === "A" && links) {
        const href = el.getAttribute("href");
        const text = visibleText(el);
        if (href && text && !href.startsWith("javascript:")) {
          line += ` [${text}](${shortUrl(href, el.ownerDocument.baseURI)}) `;
          return;
        }
      }
      if (tag === "LI") {
        flush();
        const start = blocks.length;
        childNodesOf(el).forEach(walk);
        flush();
        if (blocks.length > start) blocks[start] = `- ${blocks[start]}`;
        return;
      }
      const isBlock = BLOCK_TAGS.has(tag) || tag === "TR";
      if (isBlock) flush();
      childNodesOf(el).forEach(walk);
      if (isBlock) flush();
    };

    walk(root);
    flush();
    return { text: blocks.join("\n"), url: location.href, title: document.title };
  }

  function tableText(table) {
    const rows = [...table.rows].filter((row) => !isHidden(row));
    if (!rows.length) return collapse(table.innerText);
    const cells = (row) => [...row.cells].map((cell) => collapse(cell.innerText).replace(/\|/g, "\\|"));
    const lines = rows.map((row) => `| ${cells(row).join(" | ")} |`);
    if ([...rows[0].cells].every((cell) => cell.tagName === "TH")) {
      lines.splice(1, 0, `|${" --- |".repeat(rows[0].cells.length)}`);
    }
    const caption = table.caption ? `${collapse(table.caption.innerText)}\n` : "";
    return caption + lines.join("\n");
  }

  function frameText(options) {
    if (SAME_ORIGIN_PARENT) return { token: TOKEN, inlined: true };
    return { token: TOKEN, ...readText(options) };
  }

  // --- "An agent is working here" overlay -------------------------------------

  const WORDS = {
    tr: {
      reading: "okuyor", typing: "yazıyor", clicking: "tıklıyor", opening: "sayfayı açıyor", scrolling: "kaydırıyor",
      looking: "bakıyor", uploading: "dosya yüklüyor", running: "çalışıyor", handoff: "Sende",
      paused: "Durdum · seni dinliyorum",
    },
    en: {
      reading: "reading", typing: "typing", clicking: "clicking", opening: "opening the page", scrolling: "scrolling",
      looking: "looking", uploading: "uploading a file", running: "working", handoff: "Your turn",
      paused: "Paused · listening",
    },
  };
  const LANG = (navigator.language || "en").toLowerCase().startsWith("tr") ? "tr" : "en";
  const OVERLAY_CSS = `
    :host { all: initial; }
    .glow, .label { opacity: 0; transition: opacity .45s ease; }
    .on .glow, .on .label { opacity: 1; }
    .glow {
      position: fixed; inset: 0; pointer-events: none;
      box-shadow: inset 0 0 0 1px rgba(10, 132, 255, .45), inset 0 0 22px rgba(10, 132, 255, .22), inset 0 0 64px rgba(10, 132, 255, .10);
    }
    .handoff .glow, .paused .glow { display: none; }
    .label {
      position: fixed; right: 14px; bottom: 14px; max-width: min(320px, calc(100vw - 28px));
      display: flex; align-items: center; gap: 7px; padding: 6px 12px 6px 10px; box-sizing: border-box;
      font: 500 12px/16px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
      letter-spacing: .01em; color: #f5f5f7; background: rgba(29, 29, 31, .74);
      -webkit-backdrop-filter: saturate(180%) blur(20px); backdrop-filter: saturate(180%) blur(20px);
      border: .5px solid rgba(255, 255, 255, .16); border-radius: 999px; box-shadow: 0 6px 20px rgba(0, 0, 0, .18);
    }
    .text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: #0a84ff; box-shadow: 0 0 6px rgba(10, 132, 255, .7); }
    .handoff .dot { background: #ff9f0a; box-shadow: 0 0 6px rgba(255, 159, 10, .7); }
    .paused .dot { background: #f5f5f7; box-shadow: none; }
    @media (prefers-reduced-motion: reduce) { .glow, .label { transition: none; } }
  `;
  let overlay = null;

  function ensureOverlay() {
    if (!IS_TOP) return null;
    if (overlay?.host.isConnected) return overlay;
    const host = document.createElement("div");
    // Fixed and out of the flow: no layout change, no clicks taken.
    host.style.cssText =
      "all: initial !important; position: fixed !important; inset: 0 !important; pointer-events: none !important; z-index: 2147483647 !important; contain: strict !important;";
    const root = host.attachShadow({ mode: "closed" });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(OVERLAY_CSS);
      root.adoptedStyleSheets = [sheet];
    } catch {
      const style = document.createElement("style");
      style.textContent = OVERLAY_CSS;
      root.append(style);
    }
    const box = document.createElement("div");
    const glow = document.createElement("div");
    glow.className = "glow";
    const label = document.createElement("div");
    label.className = "label";
    const dot = document.createElement("span");
    dot.className = "dot";
    const text = document.createElement("span");
    text.className = "text";
    label.append(dot, text);
    box.append(glow, label);
    root.append(box);
    (document.documentElement || document).appendChild(host);
    overlay = { host, box, text, timer: null, handoff: false, paused: false };
    return overlay;
  }

  // Real user input (not the page's own synthetic events) goes to the
  // background, which tells it from the agent's input by time: a click or key
  // in an agent's tab pauses the agent there; in a handed-over tab it ends
  // the handover. Looking, scrolling and moving the mouse are not input here,
  // and neither are a modifier alone or a shortcut (Cmd+Tab out of Chrome
  // begins with a keydown of Meta in the page the user leaves; Cmd+C copies),
  // keys that scroll the page itself, a press on a scrollbar, a right click,
  // or anything in a tab the user cannot see. On a focused control the same
  // keys act (Space presses a button, arrows change a select), so they count.
  const MODIFIERS = new Set(["Shift", "Control", "Alt", "AltGraph", "Meta", "OS", "Fn", "FnLock", "Hyper", "Super", "CapsLock", "NumLock", "ScrollLock", "Dead", "Unidentified"]);
  const SCROLL_KEYS = new Set([" ", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"]);
  const editable = (el) => el instanceof Element && (el.isContentEditable || el.matches("input, textarea, select"));
  const onPage = (el) => !(el instanceof Element) || el === document.documentElement || el === document.body;
  const stepsIn = (event) => {
    if (document.visibilityState !== "visible") return false;
    const target = event.composedPath?.()[0] ?? event.target;
    if (event.type === "keydown") {
      const key = event.key ?? "";
      if (MODIFIERS.has(key) || /^F\d{1,2}$/.test(key)) return false;
      // Shortcuts (switch window or tab, copy, find, zoom…) leave the page as it is; paste, cut and undo in a field do not.
      if ((event.metaKey || event.ctrlKey) && !(editable(target) && /^[vxz]$/i.test(key))) return false;
      return !(SCROLL_KEYS.has(key) && onPage(target));
    }
    if (event.button !== 0) return false;
    const root = document.documentElement;
    if (root && (event.clientX >= root.clientWidth || event.clientY >= root.clientHeight)) return false;
    if (target instanceof Element && target !== root && target !== document.body) {
      const box = target.getBoundingClientRect();
      const x = event.clientX - box.left - target.clientLeft;
      const y = event.clientY - box.top - target.clientTop;
      if ((target.clientWidth && x > target.clientWidth) || (target.clientHeight && y > target.clientHeight)) return false;
    }
    return true;
  };
  let lastInputReport = 0;
  const reportInput = (event) => {
    if (!event.isTrusted || !stepsIn(event)) return;
    const now = Date.now();
    if (now - lastInputReport < 250) return;
    lastInputReport = now;
    chrome.runtime.sendMessage({ cmd: "userInput", kind: event.type === "keydown" ? "key" : "click", at: now }).catch(() => {});
  };
  addEventListener("pointerdown", reportInput, true);
  addEventListener("keydown", reportInput, true);

  /** Shows that `agent` is working here and what it is doing; fades out when it stops. */
  function activity(agent, kind) {
    const o = ensureOverlay();
    if (!o || o.handoff || o.paused) return false;
    o.text.textContent = `${agent} · ${WORDS[LANG][kind] ?? kind}`;
    o.box.className = "on";
    clearTimeout(o.timer);
    o.timer = setTimeout(() => (o.box.className = ""), 2_500);
    return true;
  }

  /**
   * The agent left this tab to the user with a note: the label stays and the
   * tab's title and icon alternate with the note (about once a second) until
   * the user clicks or types in the page, or presses Done/Keep in the popup;
   * the background then calls handoffClear. Looking at the tab does not stop it.
   */
  function handoffNotice(agent, note) {
    const o = ensureOverlay();
    if (!o) return false;
    clearTimeout(o.timer);
    o.paused = false;
    o.handoff = true;
    o.text.textContent = `${WORDS[LANG].handoff}: ${note}${agent ? ` — ${agent}` : ""}`;
    o.box.className = "on handoff";
    startBlink(`🔑 ${WORDS[LANG].handoff}: ${note}`);
    return true;
  }

  /** The handover is over (the user acted, kept it, or the agent took it back). */
  function handoffClear() {
    stopBlink();
    if (!overlay?.handoff) return true;
    overlay.handoff = false;
    overlay.box.className = "";
    return true;
  }

  /** The user stepped in while the agent worked here: it waits for them. */
  function paused() {
    const o = ensureOverlay();
    if (!o) return false;
    clearTimeout(o.timer);
    o.paused = true;
    o.text.textContent = WORDS[LANG].paused;
    o.box.className = "on paused";
    return true;
  }

  /** The agent carries on here. */
  function pauseClear() {
    if (!overlay?.paused) return true;
    overlay.paused = false;
    overlay.box.className = "";
    return true;
  }

  // Title and icon alternation for a tab that waits for the user.
  const MARK_ICON =
    "data:image/svg+xml," +
    encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="#ff9f0a"/><circle cx="16" cy="16" r="5" fill="#fff"/></svg>');
  let blinker = null;

  function startBlink(marker) {
    stopBlink();
    const state = { marker, pageTitle: document.title, on: false, icon: null };
    // The page may retitle itself meanwhile (a new message count, a step):
    // remember its latest title so it comes back intact. While the note
    // shows, it stays: the page's title comes back with the next blink (once
    // a blink, so a page that insists on its title does not fight us).
    state.watch = new MutationObserver(() => {
      const title = document.title;
      if (title === state.marker) return;
      state.pageTitle = title;
      if (state.on && !state.kept) {
        state.kept = true;
        document.title = state.marker;
      }
    });
    state.watch.observe(document.head || document.documentElement, { subtree: true, childList: true, characterData: true });
    const flip = () => {
      state.on = !state.on;
      state.kept = false;
      document.title = state.on ? state.marker : state.pageTitle;
      if (state.on) {
        state.icon = document.createElement("link");
        state.icon.rel = "icon";
        state.icon.href = MARK_ICON;
        (document.head || document.documentElement).appendChild(state.icon);
      } else {
        state.icon?.remove();
        state.icon = null;
      }
    };
    flip();
    state.timer = setInterval(flip, 1_000);
    blinker = state;
  }

  function stopBlink() {
    if (!blinker) return;
    const state = blinker;
    blinker = null;
    clearInterval(state.timer);
    state.watch.disconnect();
    state.icon?.remove();
    if (document.title === state.marker) document.title = state.pageTitle;
  }

  /** Keeps the overlay out of screenshots. */
  function overlayHidden(hidden) {
    if (overlay) overlay.host.style.setProperty("display", hidden ? "none" : "block", "important");
    return true;
  }

  globalThis.__bmcp = {
    snapshot, frameSnapshot, element, check, prepareTarget, center: centerOf, blocker, dragPoints, editKind, setValue,
    selectContent, fieldValue, isChecked, isNativeSelect, selectOptions, isFileInput, scrollIntoView, viewport,
    mutations, quietFor, changes, setPrefix, probe, frameOffset, frameBlocker, info, boxIn, readText, frameText, resourceOf, guardSecret,
    activity, handoffNotice, handoffClear, paused, pauseClear, overlayHidden,
  };
})();
