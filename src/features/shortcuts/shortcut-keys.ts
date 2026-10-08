// 快捷键文本的规范化、录制与显示。规范形式与宿主 src-tauri/src/shortcuts.rs 的 format 一致：
// 修饰键按 ⌘⌃⌥⇧ 排列，字母、数字去掉 Key、Digit 前缀，其余按键沿用 KeyboardEvent.code，如 "Super+Control+F"、"Alt+Slash"。

const MODIFIER_ORDER = ["Super", "Control", "Alt", "Shift"] as const;
const MODIFIER_ALIASES: Record<string, (typeof MODIFIER_ORDER)[number]> = {
  super: "Super", command: "Super", cmd: "Super", meta: "Super",
  control: "Control", ctrl: "Control",
  alt: "Alt", option: "Alt",
  shift: "Shift",
};

/** 规范化后比较：修饰键集合与按键相同即为同一组合，与书写顺序、别名无关。无法识别时返回 `null`。 */
export function normalizeShortcut(text: string | null | undefined): string | null {
  const parts = (text ?? "").split("+").map((part) => part.trim());
  const key = parts.pop();
  if (!key) return null;
  const modifiers = new Set<string>();
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()];
    if (!modifier) return null;
    modifiers.add(modifier);
  }
  const bare = key.replace(/^Key(?=[A-Za-z]$)/, "").replace(/^Digit(?=\d$)/, "");
  return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), bare.length === 1 ? bare.toUpperCase() : bare].join("+");
}

export function sameShortcut(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeShortcut(a);
  return left !== null && left === normalizeShortcut(b);
}

export type RecordResult = { shortcut: string } | { clear: true } | { error: string } | null;

/** 把按键事件转成组合；只按修饰键时返回 `null`，单独按退格或删除表示清除。 */
export function recordFromEvent(event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): RecordResult {
  if (["Meta", "Control", "Alt", "Shift", "CapsLock", "Fn"].includes(event.key)) return null;
  if (!event.metaKey && !event.ctrlKey && !event.altKey) {
    if (!event.shiftKey && ["Backspace", "Delete"].includes(event.key)) return { clear: true };
    return { error: "快捷键需要包含 ⌘、⌃ 或 ⌥" };
  }
  const modifiers = [event.metaKey && "Super", event.ctrlKey && "Control", event.altKey && "Alt", event.shiftKey && "Shift"].filter(Boolean);
  // 按物理按键记录：⌥、⇧ 会改变 event.key 产生的字符
  const key = event.code.replace(/^Key(?=[A-Z]$)/, "").replace(/^Digit(?=\d$)/, "");
  if (!key) return { error: "无法识别这个按键" };
  return { shortcut: [...modifiers, key].join("+") };
}

const KEY_LABELS: Record<string, string> = {
  Super: "⌘", Control: "⌃", Alt: "⌥", Shift: "⇧", Space: "空格", Enter: "↩", Backspace: "⌫", Delete: "⌦", Tab: "⇥", Escape: "Esc",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
  Slash: "/", Backslash: "\\", Comma: ",", Period: ".", Semicolon: ";", Quote: "'", Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
};

/** 显示用的键帽文字，如 `["⌘", "⌃", "F"]`。 */
export function shortcutKeys(text: string): string[] {
  const normalized = normalizeShortcut(text) ?? text;
  return normalized.split("+").map((key) => KEY_LABELS[key] ?? key.replace(/^Numpad/, "小键盘 "));
}

/** 连在一起的简短写法，如 `⌘⌃F`，用于按钮和提示文字。 */
export function shortcutText(text: string): string {
  return shortcutKeys(text).join("");
}
