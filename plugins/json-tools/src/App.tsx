import { useEffect, useMemo, useRef, useState } from "react";
import { qingbox } from "../../../packages/plugin-sdk/src/index";
import { JsonEditor, JsonViewer } from "./JsonEditor";
import { copyJson, formatJson, JsonFormatError } from "./format-json";
import { compactMarkup, detectMarkup, formatMarkup } from "./format-markup";
import { parseJson, query, stringify } from "./json-query";

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const HISTORY_LIMIT = 10;

interface QueryOutput { text: string; summary: string; error: boolean }

/** 对编辑器内容执行 JSONPath；内容为空、JSON 有误或表达式有误时返回原因。 */
function runQuery(source: string, expression: string): QueryOutput {
  if (!source.trim()) return { text: "", summary: "先在左侧输入 JSON", error: false };
  let root: unknown;
  try { root = parseJson(formatJson(source).compact); }
  catch { return { text: "", summary: "JSON 有误，修正后才能查询", error: true }; }
  try {
    const { values, definite } = query(root, expression);
    if (definite) return values.length ? { text: stringify(values[0]), summary: "找到 1 个值", error: false } : { text: "", summary: "没有找到", error: false };
    return { text: stringify(values), summary: `共 ${values.length} 条`, error: false };
  } catch (failure) { return { text: "", summary: message(failure), error: true }; }
}

function ShortcutSettings({ onClose }: { onClose: () => void }) {
  const [shortcut, setShortcut] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void qingbox.shortcuts.get().then((value) => { if (active) setShortcut(value ?? ""); }).catch((error) => { if (active) setStatus(message(error)); });
    return () => { active = false; };
  }, []);

  async function save() {
    setSaving(true);
    setStatus(null);
    try { await qingbox.shortcuts.set(shortcut || null); onClose(); }
    catch (error) { setStatus(message(error)); }
    finally { setSaving(false); }
  }

  return <div className="settings-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="shortcut-panel" role="dialog" aria-modal="true" aria-labelledby="shortcut-heading">
      <div className="shortcut-heading"><h2 id="shortcut-heading">快捷键</h2><button className="icon-button" onClick={onClose} aria-label="关闭设置">×</button></div>
      <p>在任何应用中，直接打开格式化编辑器。</p>
      <label htmlFor="plugin-shortcut">全局快捷键</label>
      <input id="plugin-shortcut" autoFocus value={shortcut} readOnly placeholder="点击后按下组合键" onKeyDown={(event) => {
        if (event.key === "Tab") return;
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
        event.preventDefault();
        if (["Meta", "Control", "Alt", "Shift"].includes(event.key)) return;
        const modifiers = [event.metaKey ? "Super" : "", event.ctrlKey ? "Control" : "", event.altKey ? "Alt" : "", event.shiftKey ? "Shift" : ""].filter(Boolean);
        if (!modifiers.length) { if (["Backspace", "Delete"].includes(event.key)) setShortcut(""); return; }
        const key = event.code.startsWith("Key") ? event.code.slice(3) : event.code.startsWith("Digit") ? event.code.slice(5) : event.code === "Space" ? "Space" : event.key;
        setShortcut([...modifiers, key].join("+"));
      }} />
      {status && <p className="shortcut-error" role="alert">{status}</p>}
      <div className="shortcut-actions"><button className="quiet-button" onClick={() => setShortcut("")}>清除</button><button className="save-button" disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : "保存"}</button></div>
    </section>
  </div>;
}

export default function App() {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [copying, setCopying] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [expression, setExpression] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const historyIndex = useRef(-1);
  const queryInput = useRef<HTMLInputElement>(null);
  const edited = useRef(false);
  const markup = detectMarkup(value);
  const label = markup ? markup.toUpperCase() : "JSON";
  // 查询栏对 JSON 常驻，内容为 HTML、XML 时隐藏；有表达式时才显示结果面板。
  const showQuery = !markup;
  const result = useMemo(() => showQuery && expression.trim() ? runQuery(value, expression) : null, [showQuery, value, expression]);

  useEffect(() => {
    let active = true;
    void qingbox.view.ready().catch((failure) => { if (active) setFeedback(message(failure)); });
    void qingbox.storage.get<string>("draft").then((draft) => {
      if (active && !edited.current && typeof draft === "string") setValue(draft);
    }).catch((failure) => { if (active) setFeedback(`草稿读取失败：${message(failure)}`); }).finally(() => { if (active) setLoaded(true); });
    void qingbox.storage.get<string[]>("queryHistory").then((saved) => {
      if (active && Array.isArray(saved)) setHistory(saved.filter((item) => typeof item === "string").slice(0, HISTORY_LIMIT));
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      // HTML、XML 只做排版，不校验语法。
      if (!value.trim() || detectMarkup(value)) { setError(null); return; }
      try { formatJson(value); setError(null); }
      catch (failure) { setError(failure instanceof JsonFormatError ? failure.message : "无法解析这段 JSON"); }
    }, 120);
    return () => window.clearTimeout(timer);
  }, [value]);

  useEffect(() => {
    if (!loaded || !edited.current) return;
    const timer = window.setTimeout(() => {
      void qingbox.storage.set("draft", value).catch((failure) => setFeedback(`草稿保存失败：${message(failure)}`));
    }, 350);
    return () => window.clearTimeout(timer);
  }, [value, loaded]);

  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(null), 2600);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  async function copy(mode: "formatted" | "compact" | "escaped") {
    setCopying(true);
    try {
      let text: string;
      if (!markup) text = copyJson(value, mode);
      else if (mode === "formatted") text = formatMarkup(value, markup);
      else if (mode === "compact") text = compactMarkup(value, markup);
      else text = JSON.stringify(compactMarkup(value, markup));
      await qingbox.clipboard.writeText(text);
      setFeedback(mode === "formatted" ? `已复制格式化 ${label}` : mode === "compact" ? `已复制压缩 ${label}` : `已复制压缩转义 ${label}`);
    } catch (failure) { setFeedback(message(failure)); }
    finally { setCopying(false); }
  }

  /** 记入查询历史：最新的在前，去重，最多 10 条。 */
  function remember(text: string) {
    const trimmed = text.trim();
    if (!trimmed || history[0] === trimmed) return;
    const next = [trimmed, ...history.filter((item) => item !== trimmed)].slice(0, HISTORY_LIMIT);
    setHistory(next);
    void qingbox.storage.set("queryHistory", next).catch(() => {});
  }

  function focusQuery() {
    if (markup) { setFeedback("HTML、XML 不支持查询"); return; }
    queryInput.current?.focus();
    queryInput.current?.select();
  }

  /** 清空查询并回到编辑器，结果面板随之收起。 */
  function clearQuery() {
    if (result && !result.error) remember(expression);
    setExpression("");
    historyIndex.current = -1;
    document.querySelector<HTMLElement>(".cm-content")?.focus();
  }

  async function copyResult() {
    if (!result?.text) return;
    try { await qingbox.clipboard.writeText(result.text); remember(expression); setFeedback("已复制查询结果"); }
    catch (failure) { setFeedback(message(failure)); }
  }

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "f" && !settingsOpen) {
        event.preventDefault();
        focusQuery();
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (settingsOpen) setSettingsOpen(false);
      else if (event.target === queryInput.current && expression) clearQuery();
      else void qingbox.view.back().catch((failure) => setFeedback(message(failure)));
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  });

  function handleQueryKey(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") { event.preventDefault(); if (result && !result.error) remember(expression); return; }
    if (event.key === "Escape") return;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const next = historyIndex.current + (event.key === "ArrowUp" ? 1 : -1);
    if (next >= history.length) return;
    historyIndex.current = Math.max(next, -1);
    setExpression(next < 0 ? "" : history[next]);
  }

  const disabled = copying || !value.trim();
  return <main className="json-plugin">
    <div className="workspace">
      <JsonEditor value={value} onChange={(next) => { edited.current = true; setValue(next); setFeedback(null); }} onNormalize={(layers) => setFeedback(layers ? "已去转义并格式化" : "已自动格式化")} />
      {result && <section className="query-result" aria-label="查询结果">
        <div className="result-heading"><span className={result.error ? "result-summary invalid" : "result-summary"} role="status">{result.summary}</span><button disabled={!result.text} onClick={() => void copyResult()}>复制结果</button></div>
        <JsonViewer value={result.text} label="查询结果（只读）" />
      </section>}
    </div>
    {showQuery && <div className="query-bar">
      <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="5.5" /><path d="m13.2 13.2 3.8 3.8" /></svg>
      <input ref={queryInput} value={expression} aria-label="JSONPath 查询" spellCheck={false} autoComplete="off" autoCorrect="off" autoCapitalize="off"
        placeholder="⌘F 查询 JSONPath，如 data.list[*].id、..name、list[?(@.age > 18)]" onKeyDown={handleQueryKey}
        onBlur={() => { if (result && !result.error) remember(expression); }}
        onChange={(event) => { historyIndex.current = -1; setExpression(event.target.value); }} />
      <span className="query-hint">↑↓ 历史 · Esc 清空</span>
    </div>}
    <div className={`editor-status${error ? " invalid" : ""}`} role="status" aria-live="polite">
      <span className="status-dot" /><span className="status-message">{error ?? feedback ?? (value.trim() ? (markup ? `${label} 内容` : "有效 JSON") : "支持 JSON、转义 JSON、HTML 与 XML")}</span><span className="line-count">{value.split("\n").length} 行</span>
      <button className="icon-button settings-button" title="插件快捷键" aria-label="插件快捷键设置" onClick={() => setSettingsOpen(true)}><svg viewBox="0 0 20 20"><path d="M4 6h12M4 14h12" /><circle cx="7" cy="6" r="2" /><circle cx="13" cy="14" r="2" /></svg></button>
    </div>
    <footer className="copy-actions">
      <button disabled={disabled} onClick={() => void copy("formatted")} title="复制格式化后的内容"><svg viewBox="0 0 20 20"><rect x="7" y="7" width="9" height="10" rx="2" /><path d="M12 7V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h3" /></svg><span>复制</span></button>
      <button disabled={disabled} onClick={() => void copy("compact")} title="移除结构之间的空白后复制"><span className="action-symbol" aria-hidden="true">{ "{}" }</span><span>压缩复制</span></button>
      <button disabled={disabled} onClick={() => void copy("escaped")} title="压缩后转义为 JSON 字符串，包含外层双引号"><span className="action-symbol quoted" aria-hidden="true">{ '"{}"' }</span><span>压缩转义复制</span></button>
    </footer>
    {settingsOpen && <ShortcutSettings onClose={() => setSettingsOpen(false)} />}
  </main>;
}
