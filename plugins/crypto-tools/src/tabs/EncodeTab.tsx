// 编码分页：选择格式后实时转换，上下两个编辑区共用固定工具栏。
import { useDeferredValue, useMemo, useState } from "react";
import { CODECS } from "../lib/encode.ts";
import { errorMessage } from "../lib/bytes.ts";
import { Segmented, Select, useDraftSaver } from "../ui.tsx";
import { CodeEditor } from "../CodeEditor.tsx";
import { ToolBar } from "../ToolBar.tsx";

export interface EncodeDraft { input: string; mode: "encode" | "decode"; codec: string }
export const ENCODE_DEFAULTS: EncodeDraft = { input: "", mode: "encode", codec: "base64" };

export function EncodeTab({ initial }: { initial: EncodeDraft }) {
  const [draft, setDraft] = useState(initial);
  useDraftSaver("draft.encode", draft);
  const input = useDeferredValue(draft.input);
  const codec = CODECS.find((item) => item.id === draft.codec) ?? CODECS[0];
  const result = useMemo(() => {
    if (!input) return { value: "" };
    try { return { value: codec[draft.mode === "decode" ? "decode" : "encode"](input) }; }
    catch (error) { return { error: errorMessage(error) }; }
  }, [input, codec, draft.mode]);
  const update = (patch: Partial<EncodeDraft>) => setDraft((current) => ({ ...current, ...patch }));

  return <div className="workbench">
    <div className="editor-stack">
      <CodeEditor label={draft.mode === "encode" ? "原文" : "待解码内容"} primary value={draft.input} onChange={(input) => update({ input })} />
      <div className="transform-bar">
      <Select label="结果格式" hideLabel value={codec.id} options={CODECS.map(({ id, label }) => ({ value: id, label }))} onChange={(codec) => update({ codec })} />
      <Segmented label="编码或解码" value={draft.mode} options={[{ value: "encode", label: "编码" }, { value: "decode", label: "解码" }]} onChange={(mode) => update({ mode })} />
      </div>
      <div className="output-pane">
        <CodeEditor label="编码结果" readOnly value={result.value ?? ""} hint="输出" />
        {result.error && <div className="editor-error" role="alert">{result.error}</div>}
      </div>
    </div>
    <ToolBar onPaste={(input) => update({ input })} onClear={() => update({ input: "" })} output={input ? result.value : undefined}>

    </ToolBar>
  </div>;
}
