// 哈希分页：同时列出 MD5、SHA-1、SHA-256、SHA-512、SM3；填写密钥时计算 HMAC。
import { useDeferredValue, useMemo, useState } from "react";
import { errorMessage, parseBytes, type ByteFormat } from "../lib/bytes.ts";
import { hashAll, type HashRow } from "../lib/hash.ts";
import { formatOptions, ResultRow, Segmented, Select, TextInput, useDraftSaver } from "../ui.tsx";

import { CodeEditor } from "../CodeEditor.tsx";
import { ToolBar } from "../ToolBar.tsx";

export interface HashDraft { input: string; inputFormat: ByteFormat; key: string; keyFormat: ByteFormat; upper: boolean }
export const HASH_DEFAULTS: HashDraft = { input: "", inputFormat: "text", key: "", keyFormat: "text", upper: false };

const FORMATS = formatOptions(["text", "hex", "base64"]);

export function HashTab({ initial }: { initial: HashDraft }) {
  const [draft, setDraft] = useState(initial);
  useDraftSaver("draft.hash", draft);
  const deferred = useDeferredValue(draft);
  const result = useMemo((): { rows: HashRow[] } | { error: string } | null => {
    if (!deferred.input) return null;
    try {
      const message = parseBytes(deferred.input, deferred.inputFormat, "输入内容");
      const key = deferred.key ? parseBytes(deferred.key, deferred.keyFormat, "HMAC 密钥") : null;
      return { rows: hashAll(message, key, deferred.upper) };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  }, [deferred]);
  const update = (patch: Partial<HashDraft>) => setDraft((current) => ({ ...current, ...patch }));

  return <div className="workbench hash-workbench">
    <div className="editor-stack">
      <CodeEditor label="输入" primary value={draft.input} onChange={(input) => update({ input })} />
    <div className="options-bar">
      <Select label="输入格式" value={draft.inputFormat} options={FORMATS} onChange={(inputFormat) => update({ inputFormat })} />
      <TextInput label="HMAC 密钥" value={draft.key} placeholder="可选" onChange={(key) => update({ key })}
        extra={<Select label="密钥格式" hideLabel value={draft.keyFormat} options={FORMATS} onChange={(keyFormat) => update({ keyFormat })} />} />
      <Segmented label="输出大小写" value={draft.upper ? "upper" : "lower"} options={[{ value: "lower", label: "小写" }, { value: "upper", label: "大写" }]} onChange={(value) => update({ upper: value === "upper" })} />
    </div>
      <div className="results hash-results" aria-label="哈希结果">
        {!result ? <p className="empty-hint">MD5 · SHA-1 · SHA-256 · SHA-512 · SM3</p>
          : "error" in result ? <ResultRow label="无法计算" error={result.error} />
          : result.rows.map((row) => <ResultRow key={row.id} label={row.label} value={row.value} />)}
      </div>
    </div>
    <ToolBar onPaste={(input) => update({ input })} onClear={() => update({ input: "" })}
      output={result && "rows" in result ? result.rows.map((row) => `${row.label}: ${row.value}`).join("\n") : undefined}>
      <span className="toolbar-note">点击单项复制</span>

    </ToolBar>
  </div>;
}
