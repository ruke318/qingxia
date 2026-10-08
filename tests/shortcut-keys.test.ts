import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeShortcut, recordFromEvent, sameShortcut, shortcutKeys, shortcutText } from "../src/features/shortcuts/shortcut-keys.ts";

const key = (code: string, modifiers: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}, value = code) =>
  ({ key: value, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers });

test("组合与书写顺序、别名无关", () => {
  assert.ok(sameShortcut("Control+Super+F", "Super+Control+F"));
  assert.ok(sameShortcut("Shift+Alt+V", "Alt+Shift+V"));
  assert.ok(sameShortcut("cmd+ctrl+KeyF", "Super+Control+F"));
  assert.ok(sameShortcut("Option+Shift+Digit1", "Alt+Shift+1"));
  assert.ok(!sameShortcut("Super+Control+F", "Super+Control+Shift+F"), "修饰键集合不同即为不同组合");
  assert.ok(!sameShortcut("Super+F", "Super+G"));
  assert.ok(!sameShortcut(null, null), "空值不算相同组合");
});

test("规范形式与宿主一致", () => {
  assert.equal(normalizeShortcut("Control+Super+F"), "Super+Control+F");
  assert.equal(normalizeShortcut("shift+alt+v"), "Alt+Shift+V");
  assert.equal(normalizeShortcut("Alt+Space"), "Alt+Space");
  assert.equal(normalizeShortcut("Hyper+F"), null);
  assert.equal(normalizeShortcut(""), null);
});

test("按物理按键录制组合", () => {
  assert.deepEqual(recordFromEvent(key("KeyF", { metaKey: true, ctrlKey: true }, "f")), { shortcut: "Super+Control+F" });
  // ⌥ 会把 V 变成 √，仍按物理按键记录
  assert.deepEqual(recordFromEvent(key("KeyV", { altKey: true, shiftKey: true }, "◊")), { shortcut: "Alt+Shift+V" });
  assert.deepEqual(recordFromEvent(key("Slash", { metaKey: true }, "/")), { shortcut: "Super+Slash" });
  assert.deepEqual(recordFromEvent(key("Digit1", { ctrlKey: true }, "1")), { shortcut: "Control+1" });
  assert.equal(recordFromEvent(key("AltLeft", { altKey: true }, "Alt")), null, "只按修饰键时继续等待");
  assert.deepEqual(recordFromEvent(key("Backspace", {}, "Backspace")), { clear: true });
  assert.ok("error" in (recordFromEvent(key("KeyF", { shiftKey: true }, "F")) ?? {}), "只有 ⇧ 不能作为快捷键");
});

test("键帽显示", () => {
  assert.deepEqual(shortcutKeys("Control+Super+F"), ["⌘", "⌃", "F"]);
  assert.equal(shortcutText("Alt+Space"), "⌥空格");
  assert.equal(shortcutText("Super+Slash"), "⌘/");
});
