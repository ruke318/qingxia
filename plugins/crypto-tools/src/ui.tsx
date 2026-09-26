// 各分页共用的表单控件、结果行，以及复制与草稿保存的上下文。
import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { qingbox } from "../../../packages/plugin-sdk/src/index";
import { errorMessage, FORMAT_LABELS, type ByteFormat } from "./lib/bytes.ts";

export interface ToolContext {
  /** 复制文本到系统剪贴板，并在状态栏给出反馈。 */
  copy: (text: string, label: string) => void;
  /** 在状态栏显示提示；`error` 为真时标红。 */
  notify: (text: string, error?: boolean) => void;
}

export const Tool = createContext<ToolContext>({ copy: () => {}, notify: () => {} });
export const useTool = () => useContext(Tool);

/** 状态变化后延迟写入草稿；与上次保存（或刚读入）的内容相同时不写。 */
export function useDraftSaver(key: string, value: unknown) {
  const { notify } = useTool();
  const serialized = JSON.stringify(value);
  const saved = useRef(serialized);
  useEffect(() => {
    if (serialized === saved.current) return;
    const timer = window.setTimeout(() => {
      saved.current = serialized;
      void qingbox.storage.set(key, JSON.parse(serialized)).catch((error) => notify(`草稿保存失败：${errorMessage(error)}`, true));
    }, 350);
    return () => window.clearTimeout(timer);
  }, [key, serialized]);
}

export interface Option<T extends string> { value: T; label: string }

export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Option<T>[]; onChange: (value: T) => void }) {
  return <div className="segmented" role="radiogroup" aria-label={label}>
    {options.map((option) => <button key={option.value} type="button" role="radio" aria-checked={value === option.value} className={value === option.value ? "active" : ""} onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>;
}

export function Select<T extends string>({ label, value, options, onChange, hideLabel }: { label: string; value: T; options: Option<T>[]; onChange: (value: T) => void; hideLabel?: boolean }) {
  return <label className="select-field">
    {!hideLabel && <span>{label}</span>}
    <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value as T)}>
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  </label>;
}

export const formatOptions = (formats: ByteFormat[]): Option<ByteFormat>[] => formats.map((value) => ({ value, label: FORMAT_LABELS[value] }));

const inputProps = { autoComplete: "off", autoCorrect: "off", autoCapitalize: "off", spellCheck: false } as const;

export function TextArea({ label, value, onChange, placeholder, rows = 4, primary, extra, secret }: {
  label: string; value: string; onChange: (value: string) => void; placeholder?: string; rows?: number; primary?: boolean; extra?: ReactNode; secret?: boolean;
}) {
  return <div className="field">
    <div className="field-heading"><span>{label}</span>{extra}</div>
    <textarea {...inputProps} aria-label={label} rows={rows} value={value} placeholder={placeholder} data-primary={primary ? "" : undefined} data-secret={secret ? "" : undefined} onChange={(event) => onChange(event.target.value)} />
  </div>;
}

export function TextInput({ label, value, onChange, placeholder, extra }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; extra?: ReactNode }) {
  return <label className="text-field">
    <span>{label}</span>
    <input {...inputProps} aria-label={label} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    {extra}
  </label>;
}

/** 结果行：点击复制完整内容；出错时显示原因且不可点击。 */
export function ResultRow({ label, value, error, note }: { label: string; value?: string; error?: string; note?: string }) {
  const { copy } = useTool();
  if (error !== undefined || value === undefined) {
    return <div className="result-row failed" aria-label={`${label}：${error ?? ""}`}><span className="result-label">{label}</span><span className="result-error">{error}</span></div>;
  }
  return <button type="button" className="result-row" title="点击复制" aria-label={`复制 ${label}`} onClick={() => copy(value, label)}>
    <span className="result-label">{label}</span>
    <span className="result-body"><span className="result-value">{value || <em>（空）</em>}</span>{note && <small className="result-note">{note}</small>}</span>
    <span className="result-copy" aria-hidden="true">复制</span>
  </button>;
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const { copy } = useTool();
  return <button type="button" className="mini-button" disabled={!text.trim()} aria-label={`复制${label}`} onClick={() => copy(text, label)}>复制</button>;
}

/** 用读入的草稿覆盖默认值：只接受与默认值同类型的字段，防止旧版本或损坏的草稿破坏界面。 */
export function restore<T extends object>(defaults: T, saved: unknown): T {
  if (typeof saved !== "object" || saved === null || Array.isArray(saved)) return defaults;
  const result = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof T)[]) {
    const value = (saved as Record<string, unknown>)[key as string];
    const base = defaults[key];
    if (value === undefined || typeof value !== typeof base || Array.isArray(value) !== Array.isArray(base)) continue;
    result[key] = (typeof base === "object" && base !== null ? restore(base as object, value) : value) as T[keyof T];
  }
  return result;
}
