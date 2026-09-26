// 文本工作区：沿用轻匣的 CodeMirror 编辑内核，原生编辑快捷键只作用于编辑内容。
import { useEffect, useRef } from "react";
import { Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, drawSelection, keymap, lineNumbers, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";

interface Props {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  hint?: string;
  primary?: boolean;
  readOnly?: boolean;
}

export function CodeEditor({ label, value, onChange, hint = "输入", primary, readOnly = false }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const change = useRef(onChange);
  change.current = onChange;
  const initial = useRef(value);
  const attributes = useRef(new Compartment());

  useEffect(() => {
    if (!container.current) return;
    const view = new EditorView({
      parent: container.current,
      state: EditorState.create({
        doc: initial.current,
        extensions: [
          lineNumbers(), drawSelection(), EditorView.lineWrapping,
          history(), keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorState.readOnly.of(readOnly), placeholder(hint),
          attributes.current.of(EditorView.contentAttributes.of({})),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !readOnly) change.current?.(update.state.doc.toString());
          }),
        ],
      }),
    });
    editor.current = view;
    return () => { editor.current = null; view.destroy(); };
  }, [readOnly, hint]);

  useEffect(() => {
    editor.current?.dispatch({ effects: attributes.current.reconfigure(EditorView.contentAttributes.of({
      "aria-label": label, "aria-readonly": String(readOnly), spellcheck: "false", autocorrect: "off", autocapitalize: "off",
      ...(primary ? { "data-primary": "" } : {}),
    })) });
  }, [label, primary, readOnly, hint]);

  useEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== value) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        annotations: readOnly ? Transaction.addToHistory.of(false) : Transaction.userEvent.of("input"),
      });
    }
  }, [value, readOnly, hint]);

  return <div className={`code-editor${readOnly ? " output-editor" : ""}`} ref={container} />;
}
