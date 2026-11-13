export type ShortcutId =
  | "translate"
  | "rewrite"
  | "assistant"
  | "next"
  | "previous"
  | "accept"
  | "dismiss"
  | "undo"
  | "close";

export type Shortcuts = Record<ShortcutId, string>;

export const SHORTCUT_ACTIONS: {
  id: ShortcutId;
  label: string;
  default: string;
}[] = [
  { id: "translate", label: "Translate", default: "ctrl+shift+KeyL" },
  { id: "rewrite", label: "Rewrite", default: "ctrl+shift+KeyK" },
  { id: "assistant", label: "Open assistant", default: "ctrl+shift+KeyY" },
  { id: "next", label: "Next correction", default: "alt+ArrowDown" },
  { id: "previous", label: "Previous correction", default: "alt+ArrowUp" },
  { id: "accept", label: "Accept correction", default: "alt+Enter" },
  { id: "dismiss", label: "Dismiss correction", default: "alt+Backspace" },
  { id: "undo", label: "Undo grammai edit", default: "alt+KeyZ" },
  { id: "close", label: "Close", default: "Escape" },
];

const MODIFIER_ORDER = ["ctrl", "shift", "alt", "meta"] as const;

const KEY_LABELS: Record<string, string> = {
  keya: "A",
  keyb: "B",
  keyc: "C",
  keyd: "D",
  keye: "E",
  keyf: "F",
  keyg: "G",
  keyh: "H",
  keyi: "I",
  keyj: "J",
  keyk: "K",
  keyl: "L",
  keym: "M",
  keyn: "N",
  keyo: "O",
  keyp: "P",
  keyq: "Q",
  keyr: "R",
  keys: "S",
  keyt: "T",
  keyu: "U",
  keyv: "V",
  keyw: "W",
  keyx: "X",
  keyy: "Y",
  keyz: "Z",
  arrowdown: "↓",
  arrowup: "↑",
  arrowleft: "←",
  arrowright: "→",
  enter: "Enter",
  backspace: "Backspace",
  escape: "Esc",
  space: "Space",
  tab: "Tab",
  delete: "Delete",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
};

function isMac() {
  return (
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
  );
}

function normalizeKey(key: string): string {
  if (!key) return "";
  if (/^key[a-z]$/.test(key)) return key;
  if (/^digit[0-9]$/.test(key)) return key;
  if (["arrowdown", "arrowup", "arrowleft", "arrowright"].includes(key)) return key;
  if (["enter", "backspace", "escape", "esc", "space", "tab", "delete"].includes(key))
    return key === "esc" ? "escape" : key;
  if (["home", "end", "pageup", "pagedown"].includes(key)) return key;
  if (/^[a-z]$/.test(key)) return `key${key}`;
  if (/^[0-9]$/.test(key)) return `digit${key}`;
  if (key === "down") return "arrowdown";
  if (key === "up") return "arrowup";
  if (key === "left") return "arrowleft";
  if (key === "right") return "arrowright";
  return key;
}

/** Normalize a human-typed or stored combo to canonical lower-case form. */
export function normalizeCombo(input: string): string {
  const tokens = input
    .toLowerCase()
    .split("+")
    .map((token) => token.trim())
    .filter(Boolean);
  const modifiers = new Set<string>();
  let key = "";
  for (const token of tokens) {
    if (token === "control" || token === "ctrl") modifiers.add("ctrl");
    else if (token === "cmd" || token === "command" || token === "meta")
      modifiers.add("meta");
    else if ((MODIFIER_ORDER as readonly string[]).includes(token))
      modifiers.add(token);
    else if (!key) key = token;
  }
  key = normalizeKey(key);
  if (!key) return "";
  return [...MODIFIER_ORDER.filter((mod) => modifiers.has(mod)), key].join("+");
}

/** Canonical combo produced by a KeyboardEvent, or null for bare modifiers. */
export function comboFromEvent(event: KeyboardEvent): string | null {
  const modifierOnly =
    event.key === "Shift" ||
    event.key === "Control" ||
    event.key === "Alt" ||
    event.key === "Meta";
  if (modifierOnly) return null;
  const mac = isMac();
  const parts: string[] = [];
  // Chrome users expect Command to act like Control for these accelerators on macOS.
  if (event.ctrlKey || (mac && event.metaKey)) parts.push("ctrl");
  if (event.shiftKey) parts.push("shift");
  if (event.altKey) parts.push("alt");
  if (event.metaKey && !mac) parts.push("meta");
  const code = event.code || "";
  let key = "";
  if (/^Key[A-Z]$/.test(code)) key = code.toLowerCase();
  else if (/^Digit[0-9]$/.test(code)) key = code.toLowerCase();
  else if (code) key = code.toLowerCase();
  else key = event.key.toLowerCase();
  key = normalizeKey(key);
  if (!key) return null;
  return [...parts, key].join("+");
}

/** Human-readable combo for the current platform. */
export function formatCombo(combo: string): string {
  const normalized = normalizeCombo(combo);
  if (!normalized) return "";
  const parts = normalized.split("+");
  const key = parts.pop() ?? "";
  let out = "";
  for (const part of parts) {
    if (part === "ctrl") out += isMac() ? "⌘" : "Ctrl+";
    else if (part === "shift") out += "⇧";
    else if (part === "alt") out += isMac() ? "⌥" : "Alt+";
    else if (part === "meta") out += isMac() ? "⌃" : "Meta+";
  }
  if (/^digit[0-9]$/.test(key)) out += key.slice(5);
  else if (KEY_LABELS[key]) out += KEY_LABELS[key];
  else out += key;
  return out;
}

export function defaultShortcuts(): Shortcuts {
  const result = {} as Shortcuts;
  for (const action of SHORTCUT_ACTIONS) result[action.id] = action.default;
  return result;
}

export function sanitizeShortcuts(value: Partial<Shortcuts> | undefined): Shortcuts {
  const result = defaultShortcuts();
  if (!value) return result;
  const used = new Set<string>();
  for (const action of SHORTCUT_ACTIONS) {
    const normalized = normalizeCombo(value[action.id] ?? "");
    if (normalized && !used.has(normalized)) {
      result[action.id] = normalized;
      used.add(normalized);
    }
  }
  return result;
}

export function matchesCombo(event: KeyboardEvent, combo: string): boolean {
  const target = normalizeCombo(combo);
  if (!target) return false;
  return comboFromEvent(event) === target;
}

/** Return the action bound to this event, or null. Defaults to the first match. */
export function shortcutForEvent(
  event: KeyboardEvent,
  shortcuts: Shortcuts,
): ShortcutId | null {
  if (event.isComposing || event.repeat) return null;
  for (const action of SHORTCUT_ACTIONS) {
    if (matchesCombo(event, shortcuts[action.id])) return action.id;
  }
  return null;
}
