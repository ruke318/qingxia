import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { isDesktop, listShortcuts, onShortcutRecorded, onShortcutsChanged, saveShortcutBinding, setShortcutRecording } from "../../lib/bridge";
import type { ShortcutRow } from "../../lib/types";
import { recordFromEvent, sameShortcut, shortcutKeys, shortcutText } from "./shortcut-keys";
import "./shortcuts.css";

type Note = { text: string; error: boolean };

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** 冲突提示中的名称：多命令插件带上命令标题。 */
function rowLabel(row: ShortcutRow, rows: ShortcutRow[]) {
  if (row.group === "轻匣") return row.title;
  return rows.filter((item) => item.group === row.group).length > 1 ? `${row.group} · ${row.title}` : row.group;
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
    setRecording(row.id);
    void setShortcutRecording(true);
  }

  function stopRecording(row: ShortcutRow) {
    if (recordingRef.current !== row.id) return;
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

  function renderRow(row: ShortcutRow) {
    const draft = drafts[row.id];
    const value = draft ?? row.saved ?? "";
    const dirty = draft !== undefined && !(draft === "" ? !row.saved : sameShortcut(draft, row.saved));
    const holder = dirty && draft ? holderOf(row, draft) : undefined;
    const note = notes[row.id];
    const busy = saving !== null;
    let status: Note | null = null;
    if (holder) status = { text: `已被「${rowLabel(holder, rows)}」使用`, error: true };
    else if (note) status = note;
    else if (recording === row.id) status = { text: dirty ? "点保存生效，Esc 取消" : "请按下组合键", error: false };
    else if (!row.enabled) status = { text: row.saved ? "插件已停用，未生效" : "插件已停用", error: false };
    else if (row.error) status = { text: row.error, error: true };
    else if (row.saved && !sameShortcut(row.saved, row.active)) status = { text: "未生效", error: true };
    return (
      <li className="shortcut-row" key={row.id}>
        <span className="shortcut-title" title={rowLabel(row, rows)}>
          <span>{row.group === "轻匣" ? row.title : row.group}</span>
          {row.group !== "轻匣" && rowLabel(row, rows) !== row.group && <small>{row.title}</small>}
          {row.scope === "panel" && <small className="shortcut-tag">面板内</small>}
        </span>
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
            {value ? shortcutKeys(value).map((key, index) => <kbd key={index}>{key}</kbd>) : <em>{recording === row.id ? "按下组合键" : "未设置"}</em>}
          </span>
        </label>
        <span className={`shortcut-status${status?.error ? " error" : ""}`} role={status?.error ? "alert" : "status"} title={status?.text}>{status?.text}</span>
        <span className="shortcut-actions">
          {dirty ? <>
            <button type="button" className="shortcut-primary" disabled={busy || !!holder} onClick={() => void save(row, draft || null)}>{saving === row.id ? "保存中…" : "保存"}</button>
            <button type="button" disabled={busy} onClick={() => { setDraft(row.id, undefined); setNote(row.id, undefined); }}>取消</button>
          </> : row.enabled && <>
            {row.defaultValue && !sameShortcut(row.saved, row.defaultValue) && <button type="button" disabled={busy} onClick={() => setDraft(row.id, row.defaultValue ?? undefined)}>恢复默认</button>}
            {row.suggested && !sameShortcut(row.saved, row.suggested) && <button type="button" disabled={busy} title="插件建议的快捷键" onClick={() => setDraft(row.id, row.suggested ?? undefined)}>建议 {shortcutText(row.suggested)}</button>}
            {!row.defaultValue && row.saved && <button type="button" disabled={busy} onClick={() => void save(row, null)}>清除</button>}
          </>}
        </span>
      </li>
    );
  }

  // 分为“轻匣”与“插件”两组；插件行以插件名为名称，多命令插件再标出命令
  const groups: [string, ShortcutRow[]][] = [
    ["轻匣", rows.filter((row) => row.group === "轻匣")],
    ["插件", rows.filter((row) => row.group !== "轻匣")],
  ].filter(([, items]) => items.length > 0) as [string, ShortcutRow[]][];

  return (
    <section className="shortcut-settings" aria-label="快捷键">
      <p className="shortcut-intro">全局快捷键在任何应用中都能使用，「面板内」只在轻匣面板打开时生效。同一组合只能用于一项，插件内部的快捷键不在此列。</p>
      {!isDesktop && <p className="shortcut-load-error" role="alert">请在轻匣桌面应用内设置快捷键</p>}
      {loadError && <p className="shortcut-load-error" role="alert">{loadError}</p>}
      {loading && isDesktop && <p className="shortcut-intro" role="status">正在读取…</p>}
      {groups.map(([group, items]) => (
        <section className="shortcut-group" key={group} aria-label={group}>
          <h3>{group}</h3>
          <ul>{items.map(renderRow)}</ul>
        </section>
      ))}
    </section>
  );
}

export default ShortcutSettings;
