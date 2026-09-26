import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getSettings, hideLauncher, isDesktop, nextQueryRequestId, onLauncherFocus, onSettingsChanged, onShowSettings, openPath, openSettings, queryFiles, resizeLauncher, saveShortcut, listPluginCommands, openPlugin, onPluginError, onPluginOpened, onPluginsChanged, leavePlugin, onPluginLoad, onPluginClosed } from "./lib/bridge";
import type { AppSettings, PluginCommand, PluginResult, SearchResult } from "./lib/types";
import { FileIcon } from "./components/FileIcon";
import { ApplicationIcon } from "./components/ApplicationIcon";
import { PluginIcon } from "./components/PluginIcon";
import { PluginManager } from "./features/plugins/PluginManager";
import { PluginFrame } from "./features/plugins/PluginFrame";
import { fileType } from "./lib/file-types";

function ShortcutSettings({ initial, onClose }: { initial: AppSettings; onClose: () => void }) {
  const [shortcut, setShortcut] = useState(initial.shortcut);
  const [status, setStatus] = useState<string | null>(initial.shortcutError);
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    setStatus(null);
    try {
      const next = await saveShortcut(shortcut.trim());
      setShortcut(next.shortcut);
      setStatus("快捷键已启用");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="settings-panel" aria-label="轻匣设置">
      <div className="settings-toolbar">
        <div className="settings-heading">
          <button className="icon-button" onClick={onClose} aria-label="返回主入口"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m12 5-5 5 5 5" /></svg></button>
          <h1>设置</h1>
        </div>
        {status && <p role="status" title={status} className={status.includes("失败") || status.includes("请") ? "setting-status error" : "setting-status"}>{status}</p>}
        <div className="shortcut-controls">
          <span className="shortcut-label">唤起快捷键</span>
          <label className="shortcut-recorder" title="点击后按下新的组合键">
            <input
              className="shortcut-input"
              aria-label="唤起快捷键"
              readOnly
              value={shortcut}
              onKeyDown={(event) => {
                if (event.key === "Tab") return;
                if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
                event.preventDefault();
                const parts = [event.metaKey ? "Super" : "", event.ctrlKey ? "Control" : "", event.altKey ? "Alt" : "", event.shiftKey ? "Shift" : ""]
                  .filter(Boolean);
                if (["Meta", "Control", "Alt", "Shift"].includes(event.key)) return;
                const key = event.code.startsWith("Key") ? event.code.slice(3) : event.code.startsWith("Digit") ? event.code.slice(5) : event.code === "Space" ? "Space" : event.key;
                if (parts.length) setShortcut([...parts, key].join("+"));
              }}
            />
            <span className="shortcut-keycaps" aria-hidden="true">{shortcut.split("+").map((key, index) => <kbd key={index}>{({ Super: "⌘", Command: "⌘", Control: "⌃", Alt: "⌥", Shift: "⇧", Space: "空格" } as Record<string, string>)[key] ?? key}</kbd>)}</span>
          </label>
          <button className="shortcut-save" aria-label="保存快捷键" disabled={saving} onClick={() => void submit()}>{saving ? "保存中…" : "保存"}</button>
        </div>
      </div>
      <PluginManager />
    </section>
  );
}

function ResultRow({ item, index, active, onClick }: { item: SearchResult; index: number; active: boolean; onClick: () => void }) {
  const type = item.kind === "plugin" ? { icon: "file" as const, label: "插件" } : fileType(item);
  return (
    <button id={`result-${index}`} role="option" aria-selected={active} tabIndex={-1} className={`result-row${active ? " active" : ""}`} onClick={onClick}>
      {item.kind === "plugin" ? <PluginIcon icon={item.icon} /> : item.kind === "application" ? <ApplicationIcon path={item.path} /> : <FileIcon kind={type.icon} />}
      <span className="result-copy"><strong title={item.name}>{item.name}</strong><small title={item.parent}>{item.parent}</small></span>
      <span className="result-kind" title={type.label}>{type.label}</span>
    </button>
  );
}

type View = "launcher" | "settings" | "plugin";
/** 当前插件实例：同一时间只有一个 iframe；shown 为 Rust 显示该实例的次数。 */
type ActivePlugin = { token: string; url: string; command?: string; shown: number };

function Launcher({ view, settings, plugin, onSettings, onPlugin, onReturn }: { view: View; settings: AppSettings; plugin: ActivePlugin | null; onSettings: () => void; onPlugin: () => void; onReturn: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const [query, setQuery] = useState(() => localStorage.getItem("qingbox:last-search-query") ?? "");
  const [activation, setActivation] = useState(0);
  const [isComposing, setIsComposing] = useState(false);
  const [items, setItems] = useState<SearchResult[]>([]);
  const [commands, setCommands] = useState<PluginCommand[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [noticeHeight, setNoticeHeight] = useState(0);
  const requestRef = useRef(0);
  const selectedPath = useRef<string | null>(null);
  const lastQuery = useRef("");

  useEffect(() => {
    if (!isComposing) localStorage.setItem("qingbox:last-search-query", query);
  }, [query, isComposing]);

  useEffect(() => {
    let active = true;
    const disposers: (() => void)[] = [];
    void onPluginsChanged(() => { void listPluginCommands().then(setCommands); }).then((value) => { if (active) disposers.push(value); else value(); });
    void listPluginCommands().then((value) => { if (active) setCommands(value); }).catch((error) => { if (active) setNotice(String(error)); });
    void onPluginError((message) => { if (active) setNotice(message); }).then((value) => { if (active) disposers.push(value); else value(); });
    return () => { active = false; disposers.forEach((dispose) => dispose()); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void onLauncherFocus(() => {
      if (cancelled) return;
      requestRef.current = nextQueryRequestId();
      // 保留搜索内容，每次唤起仍刷新查询，避免同词重开时沿用过期请求。
      flushSync(() => {
        setIsComposing(false);
        setActivation((current) => current + 1);
      });
      inputRef.current?.focus();
      inputRef.current?.select();
    }).then((dispose) => {
      if (cancelled) dispose();
      else unlisten = dispose;
    });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const id = nextQueryRequestId();
    requestRef.current = id;
    if (view !== "launcher") return;
    if (isComposing || !query.trim()) {
      setItems([]);
      setNotice(null);
      lastQuery.current = "";
      selectedPath.current = null;
      return;
    }
    const refreshing = lastQuery.current === query.trim();
    lastQuery.current = query.trim();
    if (!refreshing) selectedPath.current = null;
    const timer = window.setTimeout(() => {
      if (cancelled || id !== requestRef.current) return;
      const term = query.trim().toLowerCase();
      const pathQuery = term.startsWith("/") || term.startsWith("~");
      const pluginItems: PluginResult[] = pathQuery ? [] : commands.filter((command) => [command.title, command.pluginName, ...command.keywords].some((text) => text.toLowerCase().includes(term)))
        .slice(0, 5).map((command) => ({ name: command.title, path: command.id, parent: command.pluginName, kind: "plugin", icon: command.icon }));
      setItems((current) => refreshing && current.length ? current : pluginItems);
      setNotice(null);
      if (!refreshing) setActiveIndex(0);
      void queryFiles(query.trim(), id).then((response) => {
        if (cancelled || response.requestId !== requestRef.current) return;
        const next = [...pluginItems, ...response.items].slice(0, 50);
        setItems(next);
        setNotice(pluginItems.length && !response.items.length ? null : response.notice ?? (next.length ? null : "没有找到匹配内容"));
        setActiveIndex(Math.max(0, next.findIndex((item) => item.path === selectedPath.current)));
      }).catch((error) => {
        if (cancelled || id !== requestRef.current) return;
        setItems(pluginItems);
        setNotice(error instanceof Error ? error.message : String(error));
      });
    }, 80);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (requestRef.current === id) requestRef.current = nextQueryRequestId();
    };
  }, [query, isComposing, commands, view, activation]);

  useEffect(() => {
    const element = noticeRef.current;
    if (!element) { setNoticeHeight(0); return; }
    const observer = new ResizeObserver(() => setNoticeHeight(element.offsetHeight));
    setNoticeHeight(element.offsetHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, [notice]);

  useEffect(() => {
    if (view !== "launcher") { void resizeLauncher(670); return; }
    if (isComposing) return;
    const expanded = items.length > 0 || notice !== null;
    void resizeLauncher(60 + Math.min(items.length, 8) * 58 + (expanded ? 32 : 0) + (notice ? Math.max(noticeHeight, 34) : 0));
  }, [items.length, notice, noticeHeight, isComposing, view, activation]);

  useEffect(() => {
    resultsRef.current?.querySelector<HTMLElement>(".result-row.active")?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, items]);

  // 从插件或设置返回搜索时，焦点回到主输入框（此前可能在插件 iframe 内）
  useEffect(() => {
    if (view === "launcher") inputRef.current?.focus();
  }, [view]);

  async function execute(item?: SearchResult, reveal = false) {
    const target = item ?? items[activeIndex];
    if (!target) return;
    try {
      if (target.kind === "plugin") {
        // 插件先于文件结果出现，回车后立即停止搜索视图的异步更新。
        onPlugin();
        await openPlugin(target.path);
        return;
      }
      await openPath(target.path, reveal);
      await hideLauncher();
    } catch (error) {
      if (target.kind === "plugin") onReturn();
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  function handleCompositionStart() {
    requestRef.current = nextQueryRequestId();
    setIsComposing(true);
    setItems([]);
    setNotice(null);
    setActiveIndex(0);
  }

  function handleCompositionEnd(event: React.CompositionEvent<HTMLInputElement>) {
    setQuery(event.currentTarget.value);
    setIsComposing(false);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (isComposing || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") { event.preventDefault(); if (view !== "launcher") onReturn(); else void hideLauncher(); return; }
    if (view !== "launcher") return;
    if (event.key === "ArrowDown" && items.length) { event.preventDefault(); const next = (activeIndex + 1) % items.length; selectedPath.current = items[next].path; setActiveIndex(next); return; }
    if (event.key === "ArrowUp" && items.length) { event.preventDefault(); const next = (activeIndex - 1 + items.length) % items.length; selectedPath.current = items[next].path; setActiveIndex(next); return; }
    if (event.key === "Tab" && items[activeIndex]?.kind === "directory" && !event.shiftKey) {
      event.preventDefault();
      setQuery(`${items[activeIndex].path.replace(/\/$/, "")}/`);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      void execute(undefined, event.metaKey);
      return;
    }
    if (event.metaKey && event.key === ",") { event.preventDefault(); void openSettings(); onSettings(); }
  }

  return (
    <main className={`launcher${view !== "launcher" || items.length || notice ? " expanded" : ""}`}>
      <div className="input-row" onMouseDown={(event) => {
        if (!isDesktop || event.button !== 0 || (event.target as HTMLElement).closest("input,button")) return;
        event.preventDefault();
        void getCurrentWindow().startDragging().catch((error) => {
          setNotice(`拖动窗口失败：${String(error)}`);
        });
      }}>
        <span className="search-icon" title="按住拖动窗口" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" /></svg></span>
        <input ref={inputRef} autoFocus autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} value={query} onChange={(event) => { if (view !== "launcher") onReturn(); setQuery(event.target.value); }} onCompositionStart={handleCompositionStart} onCompositionEnd={handleCompositionEnd} onKeyDown={handleKeyDown} placeholder="搜索插件、应用、文件或目录…" aria-label="搜索应用、文件或目录" role="combobox" aria-autocomplete="list" aria-controls={view === "launcher" && items.length ? "search-results" : undefined} aria-expanded={view === "launcher" && items.length > 0} aria-activedescendant={view === "launcher" && items.length ? `result-${activeIndex}` : undefined} />
        <button className="settings-trigger" onClick={() => { void openSettings(); onSettings(); }} aria-label="设置" aria-expanded={view === "settings"}>⌘,</button>
      </div>
      {view === "settings" && <div className="content-area"><ShortcutSettings initial={settings} onClose={onReturn} /></div>}
      {(view === "plugin" || plugin) && <div className="content-area plugin-content" aria-label="插件内容区域" hidden={view !== "plugin"}>
        {plugin && <PluginFrame key={plugin.token} token={plugin.token} url={plugin.url} command={plugin.command} shown={plugin.shown} />}
      </div>}
      {view === "launcher" && (items.length > 0 || notice) && (
        <div className="results-panel">
          {items.length > 0 && <div className="results" ref={resultsRef} id="search-results" role="listbox" aria-label="搜索结果">
            {items.map((item, index) => <ResultRow key={`${item.path}-${index}`} item={item} index={index} active={index === activeIndex} onClick={() => void execute(item)} />)}
          </div>}
          {notice && <p ref={noticeRef} className="search-notice" role="status">{notice}</p>}
          <div className="result-footer">
            {items.length > 0 && <><span>↑ ↓ 选择</span><span>↵ 打开</span>{items[activeIndex]?.kind !== "plugin" && <span>⌘↵ 访达</span>}{items[activeIndex]?.kind === "directory" && <span>Tab 补全</span>}</>}
            <span className="footer-escape">Esc 隐藏</span>
          </div>
        </div>
      )}
    </main>
  );
}

export default function App() {
  const [view, setView] = useState<View>("launcher");
  const [settings, setSettings] = useState<AppSettings>({ shortcut: "Alt+Space", shortcutError: null });
  const [plugin, setPlugin] = useState<ActivePlugin | null>(null);

  useEffect(() => {
    void getSettings().then(setSettings);
    let cancelled = false;
    const disposers: (() => void)[] = [];
    void Promise.all([
      onSettingsChanged((next) => { if (!cancelled) setSettings(next); }),
      onShowSettings(() => setView("settings")),
      // 新令牌到达即替换 iframe；显示与作废只认当前令牌
      onPluginLoad(({ token, url, command }) => setPlugin({ token, url, command, shown: 0 })),
      onPluginOpened((token) => {
        setView("plugin");
        setPlugin((current) => current?.token === token ? { ...current, shown: current.shown + 1 } : current);
      }),
      onPluginClosed((token) => setPlugin((current) => current?.token === token ? null : current)),
      onPluginError(() => setView("launcher")),
      onLauncherFocus(() => setView("launcher")),
    ]).then((callbacks) => {
      if (cancelled) callbacks.forEach((dispose) => dispose());
      else disposers.push(...callbacks);
    });
    return () => { cancelled = true; disposers.forEach((dispose) => dispose()); };
  }, []);

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.key !== "Escape") return;
      event.preventDefault();
      if (view === "launcher") void hideLauncher();
      else { void leavePlugin(); setView("launcher"); }
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [view]);

  return <Launcher view={view} settings={settings} plugin={plugin} onSettings={() => setView("settings")} onPlugin={() => setView("plugin")} onReturn={() => {
    void leavePlugin();
    setView("launcher");
  }} />;
}
