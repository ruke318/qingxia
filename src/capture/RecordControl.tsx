import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errorMessage, recordTime, useRecordStatus, type RecordContext } from "./recording";

export function RecordControl({ context }: { context: RecordContext }) {
  const { status, pollError } = useRecordStatus(context.session);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const pending = useRef(false);
  const reason = error ?? status?.error ?? pollError;
  const finalizing = stopping || status?.phase === "finalizing";
  const canStop = status?.phase === "recording" || status?.phase === "finalizing";
  async function stop() {
    if (pending.current || !canStop || (finalizing && !reason)) return;
    pending.current = true; setBusy(true); setError(null); setStopping(true);
    try { await invoke("record_stop", { session: context.session }); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { pending.current = false; setBusy(false); }
  }
  const label = reason && canStop ? "重试结束" : "停止录制";
  return <main className="record-control">
    <span className="record-indicator" aria-hidden="true" />
    <time>{recordTime(status?.elapsed ?? 0)}</time>
    <span className={`record-control-state${reason ? " error" : ""}`} title={reason ?? undefined} role={reason ? "alert" : undefined}>{reason ?? (finalizing ? "完成中…" : status?.phase === "recording" ? "录制中" : "准备中…")}</span>
    <button className="record-stop" aria-label={label} title={reason ? "结束录制并保存已录内容" : "停止录制（再按录屏快捷键也可停止）"} disabled={busy || !canStop || (finalizing && !reason)} onClick={() => { void stop(); }}>
      <span className="record-stop-icon" aria-hidden="true" />{reason && canStop ? "重试" : "停止"}
    </button>
  </main>;
}
