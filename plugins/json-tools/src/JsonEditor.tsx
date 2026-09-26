import { useEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { json } from "@codemirror/lang-json";
import { xml } from "@codemirror/lang-xml";
import { tags } from "@lezer/highlight";
import { qingbox } from "../../../packages/plugin-sdk/src/index";
import { formatJson, looseFormatJson } from "./format-json";
import { detectMarkup, formatMarkup } from "./format-markup";

const colors = HighlightStyle.define([
  { tag: tags.propertyName, color: "#526e99" },
  { tag: tags.string, color: "#568466" },
  { tag: tags.number, color: "#a0713f" },
  { tag: [tags.bool, tags.null], color: "#9670a0" },
  { tag: [tags.punctuation, tags.bracket, tags.angleBracket], color: "#7c838c" },
  { tag: tags.tagName, color: "#526e99" },
  { tag: tags.attributeName, color: "#a0713f" },
  { tag: tags.attributeValue, color: "#568466" },
  { tag: tags.comment, color: "#9aa3ad" },
]);

// 内容以 `<` 开头时切换为标记语言高亮，HTML 与 XML 共用 XML 语法。
const language = new Compartment();
const jsonLanguage = json();
const xmlLanguage = xml();
const languageFor = (value: string) => detectMarkup(value) ? xmlLanguage : jsonLanguage;

interface Props {
  value: string;
  onChange: (value: string) => void;
  onNormalize: (unwrappedLayers: number) => void;
}

export function JsonEditor({ value, onChange, onNormalize }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const callbacks = useRef({ onChange, onNormalize });
  callbacks.current = { onChange, onNormalize };
  const initialValue = useRef(value);

  useEffect(() => {
    if (!container.current) return;
    const view = new EditorView({
      parent: container.current,
      state: EditorState.create({
        doc: initialValue.current,
        extensions: [
          lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(), history(),
          indentOnInput(), bracketMatching(), language.of(languageFor(initialValue.current)), syntaxHighlighting(colors),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.contentAttributes.of({ "aria-label": "JSON 编辑内容", spellcheck: "false", autocapitalize: "off", autocorrect: "off" }),
          placeholder("粘贴 JSON、HTML 或 XML，自动格式化…"),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            paste(event, current) {
              const selection = current.state.selection;
              if (selection.ranges.length !== 1 || selection.main.from !== 0 || selection.main.to !== current.state.doc.length) return false;
              const pasted = event.clipboardData?.getData("text/plain");
              if (pasted === undefined) return false;
              let inserted = pasted;
              let layers: number | null = null;
              const markup = detectMarkup(pasted);
              if (markup) {
                inserted = formatMarkup(pasted, markup);
                layers = 0;
              } else try {
                const document = formatJson(pasted);
                inserted = document.formatted;
                layers = document.unwrappedLayers;
              } catch {
                // 有误的对象或数组只按括号排版，内容不改，错误位置由状态栏显示；其他文本保留原文。
                if (/^\s*[{[]/.test(pasted)) { inserted = looseFormatJson(pasted); layers = 0; }
              }
              event.preventDefault();
              current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: inserted }, selection: { anchor: 0 }, userEvent: "input.paste" });
              if (layers !== null) callbacks.current.onNormalize(layers);
              return true;
            },
          }),
          EditorView.theme({ "&": { height: "100%" }, ".cm-scroller": { overflow: "auto" } }),
        ],
      }),
    });
    editor.current = view;
    view.focus();
    // 宿主只能聚焦 iframe；每次重新显示时，若页面内没有其他焦点（如快捷键弹层），把焦点交还编辑器。
    const stopShown = qingbox.events.on("view.shown", () => {
      if (!document.activeElement || document.activeElement === document.body) view.focus();
    });
    return () => { stopShown(); editor.current = null; view.destroy(); };
  }, []);

  useEffect(() => {
    const view = editor.current;
    if (!view) return;
    if (view.state.doc.toString() !== value) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    const next = languageFor(value);
    if (language.get(view.state) !== next) view.dispatch({ effects: language.reconfigure(next) });
  }, [value]);

  return <div className="editor" ref={container} />;
}
