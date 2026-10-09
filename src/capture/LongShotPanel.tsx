import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** 面板在选区的哪一侧，工具栏靠向选区一侧对齐。 */
export type LongSide = "right" | "left" | "inside";

declare global {
  interface Window { __QINGBOX_LONG__?: { session: number; side?: LongSide } }
}

type Progress = { height: number; thumbnail: string | null; state: "scrolling" | "lost" | "limited" | "error"; message: string | null };
type Result = { width: number; height: number; url: string };
type Action = "copy" | "save";

const errorText = (failure: unknown) => failure instanceof Error ? failure.message : String(failure);

/** 长截图面板：上方是与选区等高的实时预览，下方是取消、保存、复制；保存或复制时才合成整张长图。 */
export function LongShotPanel({ session, side = "right" }: { session: number; side?: LongSide }) {
  const [progress, setProgress] = useState<Progress>({ height: 0, thumbnail: null, state: "scrolling", message: null });
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true, unlisten: (() => void) | undefined;
    void listen<Progress>("long-progress", (event) => {
      if (!active) return;
      // 只在没有新缩略图时沿用上一张
      setProgress((current) => ({ ...event.payload, thumbnail: event.payload.thumbnail ?? current.thumbnail }));
    }, { target: { kind: "WebviewWindow", label: `longshot-${session}` } }).then((dispose) => { if (active) unlisten = dispose; else dispose(); });
    return () => { active = false; unlisten?.(); };
  }, [session]);

  const ready = Boolean(result || progress.height);

  async function act(action: Action) {
    if (busy || !ready) return;
    setBusy(true);
    setError(null);
    try {
      // 第一次保存或复制时停止截取并合成；保存取消后再操作直接用已合成的长图
      if (!result) setResult(await invoke<Result>("capture_long_finish"));
      await invoke<boolean>("capture_long_export", { action });
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    void invoke("capture_long_cancel").catch((failure) => setError(errorText(failure)));
  }

  const latest = useRef({ act, cancel });
  latest.current = { act, cancel };
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (event.isComposing) return;
      if (event.key === "Escape") { event.preventDefault(); latest.current.cancel(); }
      else if (event.key === "Enter") { event.preventDefault(); void latest.current.act("copy"); }
      else if (event.key.toLowerCase() === "s" && event.metaKey) { event.preventDefault(); void latest.current.act("save"); }
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  const image = result?.url ?? progress.thumbnail;
  const notice = error ?? (result ? null
    : progress.state === "error" ? progress.message ?? "截取失败"
    : progress.state === "lost" ? "滚动太快，请往回滚一点"
    : progress.state === "limited" ? "已达到最大高度"
    : null);
  return <main className={`long-panel ${side}`}>
    <div className="long-panel-preview">
      {image ? <img src={image} alt={result ? "长截图预览" : "长截图拼接进度"} draggable={false} />
        : <p>在选区内上下滚动<br />新内容会自动拼接</p>}
      {busy && <span className="long-panel-status" role="status">合成中…</span>}
      {!busy && notice && <span className={`long-panel-status${error || progress.state === "error" ? " error" : " warning"}`} role={error ? "alert" : "status"}>{notice}</span>}
    </div>
    <footer className="long-panel-toolbar">
      <button type="button" aria-label="取消长截图" title="取消（Esc）" onClick={cancel}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" /></svg>
      </button>
      <button type="button" aria-label="保存长截图" title="保存（⌘S）" disabled={busy || !ready} onClick={() => { void act("save"); }}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v10M6 9l4 4 4-4M4 16h12" /></svg>
      </button>
      <button type="button" className="done" aria-label="复制长截图" title="复制（回车）" disabled={busy || !ready} onClick={() => { void act("copy"); }}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="7" width="9.5" height="10" rx="1.6" /><path d="M13 7V5.2A1.7 1.7 0 0011.3 3.5H5.2A1.7 1.7 0 003.5 5.2v7.1A1.7 1.7 0 005.2 14H7" /></svg>
      </button>
    </footer>
  </main>;
}
