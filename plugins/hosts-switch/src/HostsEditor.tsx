import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, drawSelection, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

const hostsLanguage = StreamLanguage.define({
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

interface Props {
  value: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
}

export function HostsEditor({ value, readOnly = false, onChange }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const callback = useRef(onChange);
  callback.current = onChange;
  const initialValue = useRef(value);

  useEffect(() => {
    if (!container.current) return;
    const view = new EditorView({
      parent: container.current,
      state: EditorState.create({
        doc: initialValue.current,
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
          }),
        ],
      }),
    });
    editor.current = view;
    return () => { editor.current = null; view.destroy(); };
  }, [readOnly]);

  useEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== value) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value, readOnly]);

  return <div className={`hosts-editor${readOnly ? " system-editor" : ""}`} ref={container} />;
}
