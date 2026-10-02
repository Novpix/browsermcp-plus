// Key definitions for CDP Input.dispatchKeyEvent.

const NAMED = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  Insert: { code: "Insert", keyCode: 45 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  " ": { code: "Space", keyCode: 32, text: " " },
  Shift: { code: "ShiftLeft", keyCode: 16 },
  Control: { code: "ControlLeft", keyCode: 17 },
  Alt: { code: "AltLeft", keyCode: 18 },
  Meta: { code: "MetaLeft", keyCode: 91 },
};
for (let i = 1; i <= 12; i++) NAMED[`F${i}`] = { code: `F${i}`, keyCode: 111 + i };

const ALIASES = {
  Space: " ", Esc: "Escape", Return: "Enter", Del: "Delete", Up: "ArrowUp", Down: "ArrowDown",
  Left: "ArrowLeft", Right: "ArrowRight", Ctrl: "Control", Cmd: "Meta", Command: "Meta",
  Option: "Alt",
};

const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

/** Editing commands Chrome needs explicitly for shortcuts sent via CDP (notably on macOS). */
const COMMANDS = { a: "selectAll", c: "copy", v: "paste", x: "cut", z: "undo" };

function describeKey(key) {
  const name = ALIASES[key] ?? key;
  if (NAMED[name]) return { key: name, ...NAMED[name] };
  if ([...name].length === 1) {
    const upper = name.toUpperCase();
    let code = "";
    if (/[a-z]/i.test(name)) code = `Key${upper}`;
    else if (/[0-9]/.test(name)) code = `Digit${name}`;
    const keyCode = /[a-z0-9]/i.test(name) ? upper.charCodeAt(0) : 0;
    return { key: name, code, keyCode, text: name };
  }
  throw new Error(
    `Unknown key "${key}". Use a single character or a key name such as Enter, Tab, Escape, ArrowDown, PageDown, F5, optionally with modifiers like "Control+a".`,
  );
}

/**
 * Turns "Enter", "a" or "Control+Shift+Tab" into the CDP key events to send.
 */
export function keyEvents(combo) {
  const parts = combo === "+" ? ["+"] : combo.split("+").filter(Boolean);
  if (!parts.length) throw new Error("Empty key");
  const mainKey = parts.pop();
  const modifiers = parts.map((m) => ALIASES[m] ?? m);
  let bits = 0;
  for (const modifier of modifiers) {
    if (!(modifier in MODIFIER_BITS)) throw new Error(`Unknown modifier "${modifier}"`);
    bits |= MODIFIER_BITS[modifier];
  }
  const main = describeKey(mainKey);
  const events = [];
  let held = 0;
  for (const modifier of modifiers) {
    held |= MODIFIER_BITS[modifier];
    const d = describeKey(modifier);
    events.push({ type: "rawKeyDown", key: d.key, code: d.code, windowsVirtualKeyCode: d.keyCode, modifiers: held });
  }
  const printable = main.text && !(bits & (MODIFIER_BITS.Control | MODIFIER_BITS.Meta | MODIFIER_BITS.Alt));
  const down = {
    type: printable ? "keyDown" : "rawKeyDown",
    key: bits & MODIFIER_BITS.Shift && main.text?.length === 1 ? main.key.toUpperCase() : main.key,
    code: main.code,
    windowsVirtualKeyCode: main.keyCode,
    modifiers: bits,
  };
  if (printable) {
    const text = bits & MODIFIER_BITS.Shift ? main.text.toUpperCase() : main.text;
    down.text = text;
    down.unmodifiedText = main.text;
  }
  const command = bits & (MODIFIER_BITS.Control | MODIFIER_BITS.Meta) ? COMMANDS[main.key.toLowerCase()] : undefined;
  if (command) down.commands = [command];
  events.push(down);
  events.push({ type: "keyUp", key: down.key, code: main.code, windowsVirtualKeyCode: main.keyCode, modifiers: bits });
  for (const modifier of modifiers.reverse()) {
    held &= ~MODIFIER_BITS[modifier];
    const d = describeKey(modifier);
    events.push({ type: "keyUp", key: d.key, code: d.code, windowsVirtualKeyCode: d.keyCode, modifiers: held });
  }
  return events;
}
