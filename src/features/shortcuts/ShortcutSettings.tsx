import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { isDesktop, listShortcuts, onShortcutRecorded, onShortcutsChanged, saveShortcutBinding, setShortcutRecording } from "../../lib/bridge";
import type { ShortcutRow } from "../../lib/types";
import { SettingsIcon } from "../../components/SettingsIcon";
import { recordFromEvent, sameShortcut, shortcutKeys, shortcutText } from "./shortcut-keys";
import "./shortcuts.css";

type Note = { text: string; error: boolean };

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** 冲突提示中的名称：多命令插件带上命令标题。 */
function rowLabel(row: ShortcutRow, rows: ShortcutRow[]) {
  if (row.group === "轻匣") return row.title;
  return rows.filter((item) => item.id.split(":")[0] === row.id.split(":")[0]).length > 1 ? `${row.group} · ${row.title}` : row.group;
}

/** 设置页“快捷键”栏：列出唤起、全屏与全部已安装插件命令的快捷键，逐行录制、保存。 */
export function ShortcutSettings() {
  const [rows, setRows] = useState<ShortcutRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 未保存的草稿；空字符串表示清除
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, Note>>({});
  const [recording, setRecording] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const recordingRef = useRef<string | null>(null);
  recordingRef.current = recording;

  const setDraft = (id: string, value: string | undefined) => setDrafts((current) => {
    const next = { ...current };
    if (value === undefined) delete next[id]; else next[id] = value;
    return next;
  });
  const setNote = (id: string, note: Note | undefined) => setNotes((current) => {
    const next = { ...current };
    if (note === undefined) delete next[id]; else next[id] = note;
    return next;
  });

  useEffect(() => {
    let active = true;
    const load = () => listShortcuts()
      .then((items) => { if (active) { setRows(items); setLoadError(null); } })
      .catch((error) => { if (active) setLoadError(`读取快捷键失败：${errorMessage(error)}`); })
      .finally(() => { if (active) setLoading(false); });
    void load();
    const disposers: (() => void)[] = [];
    void Promise.all([
      // 其他入口保存或插件重载后刷新；正在编辑的行保留草稿
      onShortcutsChanged(() => void load()),
      // 录制时按下已注册的全局快捷键，系统不会把按键交给页面，由宿主回报组合
      onShortcutRecorded((shortcut) => {
        const id = recordingRef.current;
        if (id) { setDraft(id, shortcut); setNote(id, undefined); }
      }),
    ]).then((callbacks) => { if (active) disposers.push(...callbacks); else callbacks.forEach((dispose) => dispose()); });
    return () => {
      active = false;
      disposers.forEach((dispose) => dispose());
      // 无条件结束录制：卸载与聚焦可能在同一批更新中发生，recordingRef 不一定是最新值
      void setShortcutRecording(false);
    };
  }, []);

  function holderOf(row: ShortcutRow, value: string) {
    return rows.find((item) => item.id !== row.id && item.active && sameShortcut(item.active, value));
  }

  function startRecording(row: ShortcutRow) {
    recordingRef.current = row.id;
    setRecording(row.id);
    void setShortcutRecording(true);
  }

  function stopRecording(row: ShortcutRow) {
    if (recordingRef.current !== row.id) return;
    recordingRef.current = null;
    setRecording(null);
    void setShortcutRecording(false);
  }

  function handleKeyDown(row: ShortcutRow, event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey) return;
    event.preventDefault();
    if (event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      setDraft(row.id, undefined);
      setNote(row.id, undefined);
      event.currentTarget.blur();
      return;
    }
    const result = recordFromEvent(event.nativeEvent);
    if (!result) return;
    if ("error" in result) { setNote(row.id, { text: result.error, error: true }); return; }
    if ("clear" in result) {
      if (row.defaultValue) { setNote(row.id, { text: "这一项不能清除，可以恢复默认", error: true }); return; }
      setDraft(row.id, "");
    } else {
      setDraft(row.id, result.shortcut);
    }
    setNote(row.id, undefined);
  }

  async function save(row: ShortcutRow, value: string | null) {
    stopRecording(row);
    setSaving(row.id);
    setNote(row.id, undefined);
    try {
      setRows(await saveShortcutBinding(row.id, value));
      setDraft(row.id, undefined);
      setNote(row.id, { text: value ? "已保存" : "已清除", error: false });
    } catch (error) {
      setNote(row.id, { text: errorMessage(error), error: true });
    } finally {
      setSaving(null);
    }
  }

  function renderRow(row: ShortcutRow, child = false) {
    const draft = drafts[row.id];
    const value = draft ?? row.saved ?? "";
    const dirty = draft !== undefined && !(draft === "" ? !row.saved : sameShortcut(draft, row.saved));
    const holder = dirty && draft ? holderOf(row, draft) : undefined;
    const note = notes[row.id];
    const busy = saving !== null;
    let status: Note | null = null;
    if (holder) status = { text: `已被「${rowLabel(holder, rows)}」使用`, error: true };
    else if (note) status = note;
    else if (!row.enabled) status = { text: row.saved ? "插件已停用，未生效" : "插件已停用", error: false };
    else if (row.error) status = { text: row.error, error: true };
    else if (row.saved && !sameShortcut(row.saved, row.active)) status = { text: "未生效", error: true };
    const canRestore = !!row.defaultValue && !sameShortcut(row.saved, row.defaultValue);
    const canSuggest = !!row.suggested && !sameShortcut(row.saved, row.suggested);
    const isFeatured = row.id === "launcher";
    return (
      <li className={`shortcut-row${child ? " shortcut-child" : ""}`} key={row.id}>
        <span className="shortcut-icon">{!child && <SettingsIcon name={row.id.split(":")[0]} />}</span>
        <span className="shortcut-title" title={rowLabel(row, rows)}>
          <span>{child || row.group === "轻匣" ? row.title : row.group}</span>
          {isFeatured && <small>随时打开搜索面板</small>}
          {row.scope === "panel" && <small className="shortcut-tag">面板内</small>}
        </span>
        <span className="shortcut-binding">
          {!status?.error && <span className="shortcut-status" role="status" title={status?.text}>{status?.text}</span>}
          {!dirty && row.enabled && (canRestore || canSuggest) && <span className="shortcut-options">
            {canRestore && <button type="button" disabled={busy} aria-label={`${rowLabel(row, rows)}恢复默认`} onClick={() => { stopRecording(row); setDraft(row.id, row.defaultValue ?? undefined); setNote(row.id, undefined); }}>恢复默认</button>}
            {canSuggest && row.suggested && <button type="button" disabled={busy} aria-label={`${rowLabel(row, rows)}使用建议快捷键 ${shortcutText(row.suggested)}`} onClick={() => { stopRecording(row); setDraft(row.id, row.suggested ?? undefined); setNote(row.id, undefined); }}>建议 {shortcutText(row.suggested)}</button>}
          </span>}
          <label className={`shortcut-field${recording === row.id ? " recording" : ""}${dirty ? " dirty" : ""}`} title={row.enabled ? "点击后按下新的组合键" : "插件已停用"}>
            <input
              className="shortcut-field-input"
              aria-label={`${rowLabel(row, rows)}快捷键`}
              readOnly
              disabled={!row.enabled || busy}
              value={value}
              onFocus={() => startRecording(row)}
              onBlur={() => stopRecording(row)}
              onKeyDown={(event) => handleKeyDown(row, event)}
            />
            <span className="shortcut-field-keys" aria-hidden="true">
              {recording === row.id && !dirty ? <em>按下组合键</em> : value ? shortcutKeys(value).map((key, index) => <kbd key={index}>{key}</kbd>) : <><em>未设置</em>{row.enabled && <span className="shortcut-add">+</span>}</>}
            </span>
          </label>
        </span>
        {status?.error && <span className="shortcut-status error" role="alert" title={status.text}>{status.text}</span>}
        {dirty && <span className="shortcut-actions">
          <button type="button" className="shortcut-primary" disabled={busy || !!holder} onClick={() => void save(row, draft || null)}>{saving === row.id ? "保存中…" : "保存"}</button>
          <button type="button" disabled={busy} onClick={() => { stopRecording(row); setDraft(row.id, undefined); setNote(row.id, undefined); }}>取消</button>
        </span>}
      </li>
    );
  }

  const launcher = rows.find((row) => row.id === "launcher");
  const common = rows.filter((row) => row.group === "轻匣" && row.id !== "launcher")
    .sort((left, right) => ["screenshot", "recording", "fullscreen"].indexOf(left.id) - ["screenshot", "recording", "fullscreen"].indexOf(right.id));
  // 按插件标识归组，避免同名插件的命令被合并。
  const plugins = new Map<string, ShortcutRow[]>();
  for (const row of rows.filter((item) => item.group !== "轻匣")) {
    const id = row.id.split(":")[0];
    plugins.set(id, [...(plugins.get(id) ?? []), row]);
  }

  return (
    <section className="shortcut-settings" aria-label="快捷键">
      <header className="shortcut-heading"><h2>快捷键</h2><p className="shortcut-intro">点击组合键修改，退格清除，Esc 取消</p></header>
      {!isDesktop && <p className="shortcut-load-error" role="alert">请在轻匣桌面应用内设置快捷键</p>}
      {loadError && <p className="shortcut-load-error" role="alert">{loadError}</p>}
      {loading && isDesktop && <p className="shortcut-intro" role="status">正在读取…</p>}
      {launcher && <ul className="shortcut-featured">{renderRow(launcher)}</ul>}
      {common.length > 0 && <section className="shortcut-group" aria-label="常用操作"><h3>常用操作</h3><ul>{common.map((row) => renderRow(row))}</ul></section>}
      {plugins.size > 0 && <section className="shortcut-group" aria-label="插件快捷键">
        <h3>插件快捷键</h3>
        <div className="shortcut-plugin-list">{[...plugins].map(([id, commands]) => commands.length === 1 ? <ul key={id}>{renderRow(commands[0])}</ul> : <details key={id} className="shortcut-plugin-group" open onToggle={(event) => {
          if (event.currentTarget.open) return;
          const current = commands.find((row) => row.id === recordingRef.current);
          if (current) stopRecording(current);
        }}>
          <summary><SettingsIcon name={id} /><span>{commands[0].group}</span><small>{commands.length} 个命令</small><svg className="shortcut-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4" /></svg></summary>
          <ul>{commands.map((row) => renderRow(row, true))}</ul>
        </details>)}</div>
      </section>}
      <p className="shortcut-footnote">同一组合只能绑定一个操作。全局快捷键可在任何应用中使用，「面板内」仅在轻匣打开时生效。</p>
    </section>
  );
}

export default ShortcutSettings;
