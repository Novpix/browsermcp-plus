// Page agent injected into the connected tab's isolated world.
//
// It builds the accessibility snapshot the model works from, owns the
// ref -> element map behind it, and performs the DOM-level parts of actions.
// Pointer and keyboard input itself is dispatched by the background worker
// through the debugger API so pages receive trusted events.
(() => {
  if (globalThis.__bmcp) return;

  const MAX_TEXT = 200;
  const MAX_NAME = 120;

  // Refs are stable: an element keeps its ref across snapshots for as long as
  // it stays in the document, so refs from earlier results remain usable.
  let counter = 0;
  const refs = new Map(); // ref -> WeakRef<Element>
  const refOf = new WeakMap(); // Element -> ref

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

  function isHidden(el, style) {
    if (el.hidden || el.getAttribute("aria-hidden") === "true") return true;
    if (style.display === "none") return true;
    if (style.visibility === "hidden" || style.visibility === "collapse") return true;
    if (el.tagName === "INPUT" && el.type === "hidden") return true;
    return false;
  }

  function childNodesOf(node) {
    if (node.shadowRoot) return [...node.shadowRoot.childNodes];
    if (node.tagName === "SLOT") {
      const assigned = node.assignedNodes({ flatten: true });
      if (assigned.length) return assigned;
    }
    if (node.tagName === "IFRAME" || node.tagName === "FRAME") {
      let doc = null;
      try {
        doc = node.contentDocument;
      } catch {
        doc = null;
      }
      return doc?.body ? [doc.body] : [];
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
      ref = `e${++counter}`;
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
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    if (isHidden(el, style)) return [];

    const role = roleOf(el);
    if (role === "iframe") {
      let sameOrigin = true;
      try {
        sameOrigin = !!el.contentDocument;
      } catch {
        sameOrigin = false;
      }
      const item = { role, name: nameOf(el, role), attrs: sameOrigin ? [] : ["cross-origin"], ref: newRef(el) };
      item.children = sameOrigin ? merge(childNodesOf(el).flatMap(build)) : [];
      return [item];
    }

    if (!role) return childNodesOf(el).flatMap(build);

    const item = {
      role,
      name: nameOf(el, role),
      attrs: stateOf(el, role),
      ref: newRef(el),
      value: valueOf(el, role),
      children: [],
    };
    if (role === "link") {
      const href = el.getAttribute("href");
      if (href) {
        try {
          item.url = new URL(href, el.ownerDocument.baseURI).href;
        } catch {
          item.url = href;
        }
      }
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
      let line = `${pad}- ${item.role}`;
      if (item.name) line += ` ${JSON.stringify(item.name)}`;
      for (const attr of item.attrs) line += ` [${attr}]`;
      line += ` [ref=${item.ref}]`;
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

  function snapshot() {
    pruneRefs();
    const root = document.body || document.documentElement;
    if (!root) return "";
    const lines = [];
    render(merge(build(root)), 0, lines);
    return lines.join("\n");
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
    let x = rect.left + rect.width / 2;
    let y = rect.top + rect.height / 2;
    // Translate through same-origin iframes up to the top-level viewport.
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

  /** Sets a value the way frameworks (React, Vue) observe it: native setter + input/change events. */
  function setValue(ref, value) {
    const el = element(ref);
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

  function viewport() {
    return { width: window.innerWidth, height: window.innerHeight };
  }

  // Counts DOM mutations so the extension can tell when the page has settled.
  // The waiting itself happens in the extension, whose timers are not
  // throttled like a background tab's.
  let mutationCount = 0;
  new MutationObserver((records) => {
    mutationCount += records.length;
  }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });

  function mutations() {
    return mutationCount;
  }

  globalThis.__bmcp = {
    snapshot, element, check, prepareTarget, center: centerOf, blocker, dragPoints, editKind, setValue,
    selectContent, fieldValue, isChecked, isNativeSelect, selectOptions, isFileInput, scrollIntoView, viewport,
    mutations,
  };
})();
