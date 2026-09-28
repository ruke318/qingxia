import { useEffect, useRef } from "react";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, drawSelection, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { qingbox } from "../../../packages/plugin-sdk/src/index";

const hostsLanguage = StreamLanguage.define({
  // 声明行注释符号，⌘/ 才能注释和取消注释
  languageData: { commentTokens: { line: "#" } },
  startState: () => ({ first: true }),
  token(stream, state) {
    if (stream.sol()) state.first = true;
    if (stream.eatSpace()) return null;
    if (stream.peek() === "#") { stream.skipToEnd(); return "comment"; }
    stream.eatWhile(/[^\s#]/);
    const token = state.first ? "number" : "string";
    state.first = false;
    return token;
  },
});
const colors = HighlightStyle.define([
  { tag: tags.number, class: "hosts-ip" },
  { tag: tags.string, class: "hosts-domain" },
  { tag: tags.comment, class: "hosts-comment" },
]);

/** 编辑位置：选区两端与顶部可见行的文档偏移。 */
export interface EditorPosition { anchor: number; head: number; top: number }

interface Props {
  value: string;
  readOnly?: boolean;
  position?: EditorPosition;
  onChange?: (value: string) => void;
  onPosition?: (position: EditorPosition) => void;
}

export function HostsEditor({ value, readOnly = false, position, onChange, onPosition }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const callback = useRef(onChange);
  callback.current = onChange;
  const positionCallback = useRef(onPosition);
  positionCallback.current = onPosition;
  const initialValue = useRef(value);
  const initialPosition = useRef(position);

  useEffect(() => {
    if (!container.current) return;
    const length = initialValue.current.length;
    const clamp = (offset: number) => Math.min(Math.max(offset, 0), length);
    const start = initialPosition.current;
    const view = new EditorView({
      parent: container.current,
      state: EditorState.create({
        doc: initialValue.current,
        selection: start ? EditorSelection.single(clamp(start.anchor), clamp(start.head)) : undefined,
        extensions: [
          hostsLanguage, syntaxHighlighting(colors), drawSelection(), history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly),
          EditorView.contentAttributes.of({
            "aria-label": readOnly ? "系统完整 hosts 内容（只读）" : "分组 hosts 内容",
            "aria-readonly": String(readOnly), role: "textbox", tabindex: "0",
            spellcheck: "false", autocorrect: "off", autocapitalize: "off", autocomplete: "off",
          }),
          placeholder("# 一行一个 IP，可填写多个域名\n127.0.0.1   example.test\n::1         ipv6.test"),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callback.current?.(update.state.doc.toString());
            if (update.docChanged || update.selectionSet) report();
          }),
        ],
      }),
    });
    function report() {
      const { anchor, head } = view.state.selection.main;
      const top = view.lineBlockAtHeight(Math.max(view.scrollDOM.scrollTop - view.documentPadding.top, 0)).from;
      positionCallback.current?.({ anchor, head, top });
    }
    // 滚动到上次顶部可见行；插件在隐藏状态下加载时无法滚动，首次显示后再补一次。
    const restore = () => { if (start) view.dispatch({ effects: EditorView.scrollIntoView(clamp(start.top), { y: "start" }) }); };
    restore();
    let restored = false;
    const stop = qingbox.events.on("view.shown", () => {
      if (!restored) { restored = true; restore(); }
      if (!readOnly && !container.current?.ownerDocument.activeElement?.closest("input,textarea,button,[contenteditable]")) view.focus();
    });
    view.scrollDOM.addEventListener("scroll", report, { passive: true });
    editor.current = view;
    return () => { stop(); editor.current = null; view.destroy(); };
  }, [readOnly]);

  useEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== value) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value, readOnly]);

  return <div className={`hosts-editor${readOnly ? " system-editor" : ""}`} ref={container} />;
}
