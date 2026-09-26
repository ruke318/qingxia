import { useEffect, useRef, useState } from "react";
import { qingbox } from "../../../packages/plugin-sdk/src/index";
import { JsonEditor } from "./JsonEditor";
import { copyJson, formatJson, JsonFormatError } from "./format-json";
import { compactMarkup, detectMarkup, formatMarkup } from "./format-markup";

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

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
  const edited = useRef(false);
  const markup = detectMarkup(value);
  const label = markup ? markup.toUpperCase() : "JSON";

  useEffect(() => {
    let active = true;
    void qingbox.view.ready().catch((failure) => { if (active) setFeedback(message(failure)); });
    void qingbox.storage.get<string>("draft").then((draft) => {
      if (active && !edited.current && typeof draft === "string") setValue(draft);
    }).catch((failure) => { if (active) setFeedback(`草稿读取失败：${message(failure)}`); }).finally(() => { if (active) setLoaded(true); });
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

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.key !== "Escape") return;
      event.preventDefault();
      if (settingsOpen) setSettingsOpen(false);
      else void qingbox.view.back().catch((failure) => setFeedback(message(failure)));
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [settingsOpen]);

  const disabled = copying || !value.trim();
  return <main className="json-plugin">
    <JsonEditor value={value} onChange={(next) => { edited.current = true; setValue(next); setFeedback(null); }} onNormalize={(layers) => setFeedback(layers ? "已去转义并格式化" : "已自动格式化")} />
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
