// 对称加密分页：AES、DES、3DES、SM4；输入变化后立即计算。
import { useDeferredValue, useMemo, useState } from "react";
import { errorMessage, formatBytes, parseBytes, type ByteFormat } from "../lib/bytes.ts";
import { checkSizes, SYM_ALGORITHMS, SYM_PADDINGS, symmetricCrypt, type SymAlgorithm, type SymMode, type SymPadding } from "../lib/symmetric.ts";
import { formatOptions, Segmented, Select, TextInput, useDraftSaver } from "../ui.tsx";

import { CodeEditor } from "../CodeEditor.tsx";
import { ToolBar } from "../ToolBar.tsx";

export interface SymmetricDraft {
  algorithm: SymAlgorithm; mode: SymMode; direction: "encrypt" | "decrypt";
  padding: SymPadding;
  key: string; keyFormat: ByteFormat; iv: string; ivFormat: ByteFormat;
  input: string; plainFormat: ByteFormat; cipherFormat: ByteFormat;
}
export const SYMMETRIC_DEFAULTS: SymmetricDraft = {
  algorithm: "aes-128", mode: "cbc", direction: "encrypt", key: "", keyFormat: "text", iv: "", ivFormat: "text",
  input: "", plainFormat: "text", cipherFormat: "base64",
  padding: "pkcs7",
};

/** 读入草稿后校正取值，避免不存在的算法或模式组合。 */
export function sanitizeSymmetric(draft: SymmetricDraft): SymmetricDraft {
  const algorithm = SYM_ALGORITHMS.find((item) => item.id === draft.algorithm) ?? SYM_ALGORITHMS[0];
  return { ...draft, algorithm: algorithm.id, mode: algorithm.modes.includes(draft.mode) ? draft.mode : "cbc", padding: SYM_PADDINGS.some((item) => item.value === draft.padding) ? draft.padding : "pkcs7", cipherFormat: draft.cipherFormat === "text" ? "base64" : draft.cipherFormat };
}

const MODE_LABELS: Record<SymMode, string> = { cbc: "CBC", ecb: "ECB", gcm: "GCM" };
const ALL_FORMATS = formatOptions(["text", "hex", "base64"]);
const BINARY_FORMATS = formatOptions(["hex", "base64"]);

function byteCount(value: string, format: ByteFormat): string {
  try { return `${parseBytes(value, format, "").length} 字节`; } catch { return "格式有误"; }
}

export function SymmetricTab({ initial }: { initial: SymmetricDraft }) {
  const [draft, setDraft] = useState(initial);
  useDraftSaver("draft.symmetric", draft);
  const update = (patch: Partial<SymmetricDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const algorithm = SYM_ALGORITHMS.find((item) => item.id === draft.algorithm)!;
  const encrypt = draft.direction === "encrypt";
  const deferred = useDeferredValue(draft);

  const result = useMemo((): { value: string } | { error: string } | null => {
    const { input, key, iv, keyFormat, ivFormat, algorithm, mode, padding, plainFormat, cipherFormat } = deferred;
    if (!input) return null;
    try {
      const keyBytes = parseBytes(key, keyFormat, "密钥");
      const ivBytes = mode === "ecb" ? new Uint8Array() : parseBytes(iv, ivFormat, "IV");
      const sizeError = checkSizes(algorithm, mode, keyBytes.length, ivBytes.length);
      if (sizeError) return { error: sizeError };
      const isEncrypt = deferred.direction === "encrypt";
      const data = parseBytes(input, isEncrypt ? plainFormat : cipherFormat, isEncrypt ? "明文" : "密文");
      const output = symmetricCrypt({ algorithm, mode, padding, encrypt: isEncrypt, key: keyBytes, iv: ivBytes, data });
      return { value: formatBytes(output, isEncrypt ? cipherFormat : plainFormat) };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  }, [deferred]);

  const switchAlgorithm = (id: SymAlgorithm) => {
    const modes = SYM_ALGORITHMS.find((item) => item.id === id)!.modes;
    setDraft((current) => ({ ...current, algorithm: id, mode: modes.includes(current.mode) ? current.mode : "cbc" }));
  };
  const inputFormat = encrypt ? "plainFormat" : "cipherFormat";
  const outputFormat = encrypt ? "cipherFormat" : "plainFormat";

  return <div className="workbench">
    <div className="editor-stack">
      <CodeEditor label={encrypt ? "明文" : "密文"} primary value={draft.input} onChange={(input) => update({ input })} />
    <div className="parameter-area">
      <div className="field-row">
      <Select label="算法" hideLabel value={draft.algorithm} options={SYM_ALGORITHMS.map((item) => ({ value: item.id, label: item.label }))} onChange={switchAlgorithm} />
      <Segmented label="加密或解密" value={draft.direction} options={[{ value: "encrypt", label: "加密" }, { value: "decrypt", label: "解密" }]} onChange={(direction) => update({ direction })} />
        <Select label="模式" value={draft.mode} options={algorithm.modes.map((mode) => ({ value: mode, label: MODE_LABELS[mode] }))} onChange={(mode) => update({ mode })} />
        {draft.mode !== "gcm" && <Select label="填充" value={draft.padding} options={SYM_PADDINGS} onChange={(padding) => update({ padding })} />}
        <Select label="输入格式" value={draft[inputFormat]} options={encrypt ? ALL_FORMATS : BINARY_FORMATS} onChange={(value) => update({ [inputFormat]: value })} />
        <Select label="输出格式" value={draft[outputFormat]} options={encrypt ? BINARY_FORMATS : ALL_FORMATS} onChange={(value) => update({ [outputFormat]: value })} />
        {draft.mode === "gcm" && <span className="field-note">NoPadding · 密文末尾附 16 字节认证标签</span>}
        {draft.mode !== "gcm" && draft.padding === "zero" && <span className="field-note">解密会移除末尾的零字节</span>}
      </div>
      <TextInput label="密钥" value={draft.key} placeholder="密钥" onChange={(key) => update({ key })}
        extra={<><small className="byte-count">{byteCount(draft.key, draft.keyFormat)}</small><Select label="密钥格式" hideLabel value={draft.keyFormat} options={ALL_FORMATS} onChange={(keyFormat) => update({ keyFormat })} /></>} />
      {draft.mode !== "ecb" && <TextInput label="IV" value={draft.iv} placeholder={draft.mode === "gcm" ? "GCM 推荐 12 字节" : "CBC 需要一个分组长度"} onChange={(iv) => update({ iv })}
        extra={<><small className="byte-count">{byteCount(draft.iv, draft.ivFormat)}</small><Select label="IV 格式" hideLabel value={draft.ivFormat} options={ALL_FORMATS} onChange={(ivFormat) => update({ ivFormat })} /></>} />}
    </div>
      <div className="output-pane">
        <CodeEditor label="加解密结果" readOnly value={result && "value" in result ? result.value : ""} hint="输出" />
        {result && "error" in result && <div className="editor-error" role="alert">{result.error}</div>}
      </div>
    </div>
    <ToolBar onPaste={(input) => update({ input })} onClear={() => update({ input: "" })} output={result && "value" in result ? result.value : undefined}>

    </ToolBar>
  </div>;
}
