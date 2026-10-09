import { useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errorMessage, fileSize, recordTime, type RecordContext } from "./recording";

type CardAction = "play" | "copy" | "reveal" | "delete" | "close";

/** 录完的操作卡片：录像已自动保存到桌面；点任一操作或关闭后卡片消失，操作失败时保留并显示原因。 */
export function RecordCard({ context }: { context: RecordContext }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(action: CardAction) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try { await invoke("record_card_action", { action }); }
    catch (failure) { setError(errorMessage(failure)); setBusy(false); }
  }

  const actions: [CardAction, string, ReactNode][] = [
    ["play", "播放", <path key="i" d="M7 5.5v9l7.5-4.5z" />],
    ["copy", "复制", <><rect key="r" x="7" y="7" width="9.5" height="10" rx="1.6" /><path key="p" d="M13 7V5.2A1.7 1.7 0 0011.3 3.5H5.2A1.7 1.7 0 003.5 5.2v7.1A1.7 1.7 0 005.2 14H7" /></>],
    ["reveal", "访达", <path key="i" d="M3.5 6.5a1.5 1.5 0 011.5-1.5h3l1.5 1.8H15a1.5 1.5 0 011.5 1.5v6.2A1.5 1.5 0 0115 16H5a1.5 1.5 0 01-1.5-1.5z" />],
    ["delete", "删除", <path key="i" d="M4.5 6h11M8 6V4.5h4V6M6 6l.7 9.5h6.6L14 6" />],
  ];
  return <main className="record-card">
    {/* 预加载元数据并跳到开头，显示第一帧作为缩略图 */}
    <video className="record-card-thumb" src={context.video} muted preload="metadata" aria-hidden="true"
      onLoadedMetadata={(event) => { event.currentTarget.currentTime = Math.min(0.1, event.currentTarget.duration || 0); }} />
    <div className="record-card-body">
      <div className="record-card-heading">
        <strong>已保存到桌面</strong>
        <button className="record-card-close" aria-label="关闭" title="关闭" disabled={busy} onClick={() => { void act("close"); }}>×</button>
      </div>
      <p className="record-card-name" title={context.path}>{context.name}</p>
      <p className="record-card-meta">{recordTime(context.duration ?? 0)} · {fileSize(context.size ?? 0)}</p>
      {context.warning && <p className="record-card-warning">{context.warning}</p>}
      {error && <p className="record-error" role="alert">{error}</p>}
      <div className="record-card-actions">
        {actions.map(([action, label, icon]) => <button key={action} className={action === "delete" ? "record-card-delete" : undefined} aria-label={label} disabled={busy} onClick={() => { void act(action); }}>
          <svg viewBox="0 0 20 20" aria-hidden="true">{icon}</svg>{label}
        </button>)}
      </div>
    </div>
  </main>;
}
