import { useEffect, useRef, useState } from "react";
import { qingbox, type ClipboardCategory, type ClipboardRecord } from "../../../packages/plugin-sdk/src/index";

const names: Record<ClipboardCategory, string> = { all: "全部", text: "文本", image: "图片", file: "文件" };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const shortcutLabel = (value: string) => value.replace(/Super|Command/g, "⌘").replace(/Control/g, "⌃").replace(/Alt/g, "⌥").replace(/Shift/g, "⇧").replaceAll("+", "");
const sizeLabel = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const dateLabel = (value: number) => new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

function Icon({ kind }: { kind: ClipboardCategory }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true">{kind === "all" ? <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></> : kind === "text" ? <path d="M5 6h14M5 12h14M5 18h9" /> : kind === "image" ? <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8" cy="8" r="1.5" /><path d="m4 18 6-6 4 3 3-4 4 5" /></> : <><path d="M7 3h7l5 5v13H5V3h2m7 0v6h5M8 13h8M8 17h5" /></>}</svg>;
}

export default function App() {
  const [kind, setKind] = useState<ClipboardCategory>("all");
  const [items, setItems] = useState<ClipboardRecord[]>([]);
  const [counts, setCounts] = useState({ text: 0, image: 0, file: 0 });
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [copying, setCopying] = useState(false);
  const copyingRef = useRef(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [shortcut, setShortcut] = useState("");
  const [shortcutDraft, setShortcutDraft] = useState("");
  const [shortcutOpen, setShortcutOpen] = useState(false);
  const [savingShortcut, setSavingShortcut] = useState(false);
  const rows = useRef(new Map<number, HTMLButtonElement>());

  useEffect(() => {
    void qingbox.view.ready().catch((failure) => { setFeedback(message(failure)); setError(true); });
    void qingbox.shortcuts.get().then((value) => setShortcut(value ?? "")).catch((failure) => { setFeedback(message(failure)); setError(true); });
  }, []);

  useEffect(() => {
    let active = true;
    let pending = false;
    let revision: number | undefined;
    async function load() {
      if (pending) return;
      pending = true;
      try {
        const value = await qingbox.clipboard.list(kind, revision);
        if (!active) return;
        revision = value.revision;
        if (value.items) setItems(value.items);
        setCounts(value.counts); setNotice(value.notice);
      } catch (failure) { if (active) { setFeedback(message(failure)); setError(true); } }
      finally { pending = false; if (active) setLoading(false); }
    }
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 1000);
    const visible = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("focus", visible);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); window.removeEventListener("focus", visible); };
  }, [kind, refresh]);

  async function copy(item: ClipboardRecord) {
    if (copyingRef.current) return;
    copyingRef.current = true; setCopying(true); setSelected(item.id); setCopied(null); setError(false);
    try {
      await qingbox.clipboard.copy(item.id);
      setCopied(item.id); setFeedback(`已复制${names[item.kind]}，切回应用粘贴即可`); setRefresh((value) => value + 1);
    } catch (failure) { setFeedback(message(failure)); setError(true); }
    finally { copyingRef.current = false; setCopying(false); }
  }

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") { event.preventDefault(); if (shortcutOpen) setShortcutOpen(false); else void qingbox.view.back(); return; }
      if (shortcutOpen || !items.length || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const current = items.findIndex((item) => item.id === selected);
        const next = current < 0 ? 0 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        setSelected(items[next].id);
        const row = rows.current.get(items[next].id);
        row?.focus({ preventScroll: true }); row?.scrollIntoView({ block: "nearest" });
      }
      if (event.key === "Enter" && !(event.target instanceof Element && event.target.closest(".category-tabs,.shortcut-trigger"))) {
        event.preventDefault(); void copy(items.find((item) => item.id === selected) ?? items[0]);
      }
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [items, selected, shortcutOpen]);

  function changeKind(next: ClipboardCategory) {
    if (kind === next) return;
    setKind(next); setItems([]); setLoading(true); setSelected(null); setCopied(null); setFeedback(""); setError(false);
  }

  async function saveShortcut() {
    if (savingShortcut) return;
    setSavingShortcut(true);
    try { await qingbox.shortcuts.set(shortcutDraft || null); setShortcut(shortcutDraft); setShortcutOpen(false); setFeedback("快捷键已保存"); setError(false); }
    catch (failure) { setFeedback(message(failure)); setError(true); }
    finally { setSavingShortcut(false); }
  }

  return <main className="clipboard-plugin">
    <header className="clipboard-toolbar">
      <div className="category-tabs" role="tablist" aria-label="剪贴板分类">{(Object.keys(names) as ClipboardCategory[]).map((value) => <button key={value} role="tab" aria-selected={kind === value} aria-controls="clipboard-records" onClick={() => changeKind(value)}><Icon kind={value} /><span>{names[value]}</span><small>{value === "all" ? counts.text + counts.image + counts.file : counts[value]}</small></button>)}</div>
      <button className="shortcut-trigger" aria-label="剪贴板快捷键设置" title="设置全局快捷键" onClick={() => { setShortcutDraft(shortcut); setShortcutOpen(true); }}><span>{shortcut ? shortcutLabel(shortcut) : "设置快捷键"}</span><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6h14M3 14h14" /><circle cx="7" cy="6" r="2" /><circle cx="13" cy="14" r="2" /></svg></button>
    </header>
    <section id="clipboard-records" className={`records ${kind === "image" ? "image-records" : ""}`} aria-label={`${names[kind]}历史`} aria-busy={loading}>
      {!items.length ? <div className="empty-state"><Icon kind={kind} /><strong>{loading ? "正在读取…" : `还没有${kind === "all" ? "剪贴板" : names[kind]}记录`}</strong><p>{kind === "all" ? "复制文字、图片或文件后，就会出现在这里。" : kind === "file" ? "在访达中复制文件后，就会出现在这里。" : kind === "image" ? "复制图片或截图到剪贴板后，就会出现在这里。" : "在任意应用中复制文字，就会出现在这里。"}</p></div> : items.map((item) => <button key={item.id} ref={(element) => { if (element) rows.current.set(item.id, element); else rows.current.delete(item.id); }} className={`record${selected === item.id ? " selected" : ""}${copied === item.id ? " copied" : ""}`} aria-label={`复制${names[item.kind]}：${item.preview.slice(0, 80)}`} aria-pressed={selected === item.id} disabled={copying} onClick={() => void copy(item)}>
        {item.kind === "image" ? <div className="image-preview">{item.thumbnail && <img src={item.thumbnail} alt={`剪贴板图片，${item.width} × ${item.height}`} loading="lazy" />}</div> : item.kind === "file" ? <div className="file-preview"><span className="file-icon"><Icon kind="file" /></span><div><strong>{item.files.length > 1 ? `${item.files[0]?.split("/").pop()} 等 ${item.files.length} 项` : item.preview}</strong><p>{item.files.join("\n")}</p></div></div> : <pre className="text-preview">{item.preview}</pre>}
        <div className="record-meta">{kind === "all" && <span>{names[item.kind]}</span>}<span>{dateLabel(item.createdAt)}</span>{item.kind === "image" && <span>{item.width} × {item.height}</span>}<span className="record-detail">{copied === item.id ? "✓ 已复制" : item.kind === "file" ? `${item.files.length} 项` : sizeLabel(item.bytes)}</span></div>
      </button>)}
    </section>
    <footer className={`clipboard-footer${error ? " error" : ""}`}><span role={error ? "alert" : "status"}>{copying ? "正在复制…" : feedback || notice || "点击记录复制 · ↑↓ 选择 · 回车复制"}</span><span className="history-limit">最近 200 条 · 仅存本机</span></footer>
    {shortcutOpen && <div className="shortcut-scrim"><section className="shortcut-panel" role="dialog" aria-modal="true" aria-labelledby="shortcut-title"><div className="shortcut-heading"><h2 id="shortcut-title">剪贴板快捷键</h2><button aria-label="关闭快捷键设置" onClick={() => setShortcutOpen(false)}>×</button></div><p>在任意应用中直接呼出剪贴板。</p><input aria-label="剪贴板全局快捷键" autoFocus readOnly value={shortcutDraft} placeholder="按下组合键" onKeyDown={(event) => {
      if (event.key === "Tab" || event.key === "Escape") return;
      event.preventDefault();
      if (["Meta", "Control", "Alt", "Shift"].includes(event.key)) return;
      const modifiers = [event.metaKey ? "Super" : "", event.ctrlKey ? "Control" : "", event.altKey ? "Alt" : "", event.shiftKey ? "Shift" : ""].filter(Boolean);
      if (!modifiers.length) { if (["Backspace", "Delete"].includes(event.key)) setShortcutDraft(""); return; }
      const key = event.code.startsWith("Key") ? event.code.slice(3) : event.code.startsWith("Digit") ? event.code.slice(5) : event.code === "Space" ? "Space" : event.key;
      setShortcutDraft([...modifiers, key].join("+"));
    }} /><div className="shortcut-actions"><button className="text-button" disabled={savingShortcut} onClick={() => setShortcutDraft("")}>清除</button><button className="save-button" disabled={savingShortcut} onClick={() => void saveShortcut()}>保存快捷键</button></div></section></div>}
  </main>;
}
