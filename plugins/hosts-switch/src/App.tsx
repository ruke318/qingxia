import { useEffect, useRef, useState } from "react";
import { qingbox, type HostsGroup, type HostsSnapshot } from "../../../packages/plugin-sdk/src/index";
import { HostsEditor } from "./HostsEditor";

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
type Draft = Pick<HostsGroup, "name" | "content">;

export default function App() {
  const [snapshot, setSnapshot] = useState<HostsSnapshot | null>(null);
  const [selected, setSelected] = useState("");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [tab, setTab] = useState<"groups" | "system">("groups");
  const [busy, setBusy] = useState(true);
  const pending = useRef(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [shortcutOpen, setShortcutOpen] = useState(false);
  const [shortcut, setShortcut] = useState("");
  const group = snapshot?.groups.find((item) => item.id === selected);
  const draft = group ? drafts[group.id] ?? group : null;
  const dirty = !!group && !!draft && (group.name !== draft.name || group.content !== draft.content);

  useEffect(() => {
    let active = true;
    void qingbox.view.ready().catch((failure) => { if (active) { setFeedback(message(failure)); setError(true); } });
    void qingbox.hosts.get().then((value) => {
      if (active) { setSnapshot(value); setSelected(value.groups[0]?.id ?? ""); }
    }).catch((failure) => { if (active) { setFeedback(message(failure)); setError(true); } })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (!shortcutOpen && !deleting && tab === "groups") saveCurrent();
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (shortcutOpen) setShortcutOpen(false);
      else if (deleting) setDeleting(false);
      else void qingbox.view.back();
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [shortcutOpen, deleting, tab, group, draft, snapshot, busy]);

  async function refresh() {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try {
      const value = await qingbox.hosts.get();
      setSnapshot(value); setFeedback("已读取最新系统 hosts"); setError(false);
      setSelected((id) => value.groups.some((item) => item.id === id) ? id : value.groups[0]?.id ?? "");
    } catch (failure) { setFeedback(message(failure)); setError(true); }
    finally { pending.current = false; setBusy(false); }
  }

  async function save(groups: HostsGroup[], focus?: string, clearDraft?: string) {
    if (!snapshot || pending.current) return;
    pending.current = true; setBusy(true); setError(false); setFeedback("正在保存，需要时请完成系统授权…");
    try {
      const value = await qingbox.hosts.save(groups, snapshot.version);
      setSnapshot(value); setFeedback(value.notice ?? "已保存"); setDeleting(false);
      setSelected((id) => focus ?? (value.groups.some((item) => item.id === id) ? id : value.groups[0]?.id ?? ""));
      if (clearDraft) setDrafts((previous) => { const next = { ...previous }; delete next[clearDraft]; return next; });
      setDrafts((previous) => Object.fromEntries(Object.entries(previous).filter(([id, draft]) => {
        const saved = value.groups.find((item) => item.id === id);
        return saved && (saved.name !== draft.name || saved.content !== draft.content);
      })));
    } catch (failure) { setFeedback(message(failure)); setError(true); }
    finally { pending.current = false; setBusy(false); }
  }

  function saveCurrent() {
    if (!snapshot || !group || !draft || !dirty || busy) return;
    void save(snapshot.groups.map((item) => item.id === group.id ? { ...item, ...draft } : item));
  }

  function createGroup() {
    if (!snapshot) return;
    const id = crypto.randomUUID();
    const names = new Set(snapshot.groups.map((item) => item.name));
    let number = snapshot.groups.length + 1;
    while (names.has(`新分组 ${number}`)) number += 1;
    void save([...snapshot.groups, { id, name: `新分组 ${number}`, content: "", enabled: false }], id);
  }

  function updateDraft(next: Partial<Draft>) {
    if (group && draft) setDrafts((previous) => ({ ...previous, [group.id]: { name: draft.name, content: draft.content, ...next } }));
    setDeleting(false);
  }

  async function openShortcut() {
    try { setShortcut(await qingbox.shortcuts.get() ?? ""); setShortcutOpen(true); }
    catch (failure) { setFeedback(message(failure)); setError(true); }
  }

  async function saveShortcut() {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try { await qingbox.shortcuts.set(shortcut || null); setShortcutOpen(false); setFeedback("插件快捷键已保存"); setError(false); }
    catch (failure) { setFeedback(message(failure)); setError(true); }
    finally { pending.current = false; setBusy(false); }
  }

  const enabled = snapshot?.groups.filter((item) => item.enabled).length ?? 0;
  return <main className="hosts-plugin">
    <div className="workspace">
      <aside className="sidebar">
        <div className="sidebar-heading"><span>我的分组</span><button className="add-button" aria-label="新建分组" title="新建分组" disabled={busy || !snapshot} onClick={() => { setTab("groups"); createGroup(); }}>＋</button></div>
        <ul className="group-list" aria-label="Hosts 分组">
          <li className={`group-row${tab === "system" ? " selected" : ""}`}><button className="group-name system-link" aria-pressed={tab === "system"} onClick={() => setTab("system")}><span>系统 hosts</span><small>只读</small></button></li>
          {snapshot?.groups.map((item) => {
            const changed = drafts[item.id] && (drafts[item.id].name !== item.name || drafts[item.id].content !== item.content);
            return <li key={item.id} className={`group-row${tab === "groups" && selected === item.id ? " selected" : ""}`}>
              <button className="group-name" aria-pressed={tab === "groups" && selected === item.id} onClick={() => { setTab("groups"); setSelected(item.id); setDeleting(false); }}><span>{drafts[item.id]?.name || item.name}</span><small>{changed ? "未保存" : item.enabled ? "已启用" : "未启用"}</small></button>
              <button className="switch" role="switch" aria-label={`启用${item.name}`} aria-checked={item.enabled} disabled={busy} title={item.enabled ? "保存最新内容并停用" : "保存最新内容并启用"} onClick={() => void save(snapshot.groups.map((current) => current.id === item.id ? { ...current, ...drafts[current.id], enabled: !current.enabled } : current))}><span /></button>
            </li>;
          })}
        </ul>
        <p className="sidebar-note">可同时启用多个分组</p>
      </aside>
      {tab === "system" ? <section className="system-view" aria-label="系统完整 hosts">
        <div className="system-heading"><span>/etc/hosts</span><span>当前系统实际内容 · 只读</span></div>
        <HostsEditor key="system" readOnly value={snapshot?.systemHosts ?? ""} />
      </section> : group && draft ? <section className="group-editor" aria-label="编辑分组">
        <div className="editor-heading"><input aria-label="分组名称" maxLength={60} value={draft.name} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} onChange={(event) => updateDraft({ name: event.target.value })} /><span className={`state-label${group.enabled ? " on" : ""}`} title={dirty ? "有未保存的修改" : undefined}>{group.enabled ? "已启用" : "未启用"}</span>
          <button className="icon-button delete-button" aria-label="删除当前分组" title="删除分组" disabled={busy} onClick={() => setDeleting(!deleting)}><svg viewBox="0 0 20 20"><path d="M4 5h12M8 5V3h4v2M6 5l1 12h6l1-12M9 8v6m2-6v6" /></svg></button>
          <button className="primary-button save-button" aria-label="保存当前分组" title="保存当前分组（⌘S）" aria-keyshortcuts="Meta+S Control+S" disabled={busy || !dirty} onClick={saveCurrent}>保存</button>
          {deleting && <div className="delete-confirm" role="dialog" aria-label="确认删除分组"><span>删除此分组？</span><button className="text-button" disabled={busy} onClick={() => setDeleting(false)}>取消</button><button className="danger-button" disabled={busy} onClick={() => void save(snapshot!.groups.filter((item) => item.id !== group.id), undefined, group.id)}>删除分组</button></div>}
        </div>
        <HostsEditor key={group.id} value={draft.content} onChange={(content) => updateDraft({ content })} />
      </section> : <section className="empty-state"><span className="empty-symbol" aria-hidden="true">#</span><strong>{busy ? "正在读取…" : "添加第一个分组"}</strong><p>把不同环境的域名分别放进分组，<br />需要时打开对应开关。</p><button className="primary-button" disabled={busy || !snapshot} onClick={createGroup}>新建分组</button></section>}
    </div>
    {!busy && snapshot && !snapshot.synced && <div className="sync-notice">系统内容已变化，可在“系统 hosts”查看；重新切换开关后应用分组。</div>}
    <div className={`feedback${error ? " error" : ""}`} role={error ? "alert" : "status"}>{feedback || "⌘S 保存当前分组；已启用分组保存后立即应用"}</div>
    <footer className="footer"><span><i className={enabled ? "status-dot enabled" : "status-dot"} />已启用 {enabled} 个分组</span><span className="backup-note" title="首次原始备份始终保留，切换备份自动轮换；内容不变时不新增备份">备份最多保留 6 份</span>
      <button className="icon-button" aria-label="刷新系统 hosts" title="刷新系统 hosts" disabled={busy} onClick={() => void refresh()}><svg viewBox="0 0 20 20"><path d="M16 8a6.2 6.2 0 1 0 .2 4M16 3.5V8h-4.5" /></svg></button>
      <button className="icon-button" aria-label="插件快捷键设置" title="插件快捷键" disabled={busy} onClick={() => void openShortcut()}><svg viewBox="0 0 20 20"><path d="M4 6h12M4 14h12" /><circle cx="7" cy="6" r="2" /><circle cx="13" cy="14" r="2" /></svg></button>
    </footer>
    {shortcutOpen && <div className="shortcut-scrim"><section className="shortcut-panel" role="dialog" aria-modal="true" aria-labelledby="shortcut-title"><div className="shortcut-heading"><h2 id="shortcut-title">插件快捷键</h2><button className="icon-button" aria-label="关闭快捷键设置" onClick={() => setShortcutOpen(false)}>×</button></div><p>在任意应用中直接打开 Hosts 切换。</p><input aria-label="Hosts 全局快捷键" autoFocus readOnly value={shortcut} placeholder="按下组合键" onKeyDown={(event) => {
      if (event.key === "Tab" || event.key === "Escape") return;
      event.preventDefault();
      if (["Meta", "Control", "Alt", "Shift"].includes(event.key)) return;
      const modifiers = [event.metaKey ? "Super" : "", event.ctrlKey ? "Control" : "", event.altKey ? "Alt" : "", event.shiftKey ? "Shift" : ""].filter(Boolean);
      if (!modifiers.length) { if (["Backspace", "Delete"].includes(event.key)) setShortcut(""); return; }
      const key = event.code.startsWith("Key") ? event.code.slice(3) : event.code.startsWith("Digit") ? event.code.slice(5) : event.code === "Space" ? "Space" : event.key;
      setShortcut([...modifiers, key].join("+"));
    }} /><div className="shortcut-actions"><button className="text-button" disabled={busy} onClick={() => setShortcut("")}>清除</button><button className="primary-button" disabled={busy} onClick={() => void saveShortcut()}>保存快捷键</button></div></section></div>}
  </main>;
}
