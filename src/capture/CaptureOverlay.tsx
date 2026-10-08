import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { renderSelection } from "./export";

/** 宿主创建覆盖窗时注入：会话编号、屏幕序号、显示器编号、物理像素比例，以及本屏冻结快照的地址（没有快照时为 null）。 */
declare global {
  interface Window { __QINGBOX_CAPTURE__?: { session: number; screen: number; display?: number; scale?: number; image?: string | null } }
}

type Point = { x: number; y: number };
type Rect = Point & { width: number; height: number };
type Drag = { start: Point } & (
  | { kind: "draw" }
  | { kind: "move"; original: Rect }
  | { kind: "resize"; original: Rect; handle: string }
);
const handles = [
  ["nw", "左上角"], ["n", "上边"], ["ne", "右上角"], ["e", "右边"],
  ["se", "右下角"], ["s", "下边"], ["sw", "左下角"], ["w", "左边"],
] as const;
const clamp = (value: number, maximum: number) => Math.max(0, Math.min(value, maximum));
const pointOf = (event: { clientX: number; clientY: number }): Point => ({
  x: clamp(event.clientX, window.innerWidth), y: clamp(event.clientY, window.innerHeight),
});

const TOOLBAR_HEIGHT = 38;
const GAP = 8;

/** 工具栏位置：默认在选区下方右对齐；下方放不下放上方，上下都放不下放在选区内底部。 */
export function toolbarPosition(rect: Rect, viewport = { width: window.innerWidth, height: window.innerHeight }) {
  const bottom = rect.y + rect.height;
  const top = viewport.height - bottom >= TOOLBAR_HEIGHT + GAP * 2 ? bottom + GAP
    : rect.y >= TOOLBAR_HEIGHT + GAP * 2 ? rect.y - TOOLBAR_HEIGHT - GAP
    : bottom - TOOLBAR_HEIGHT - GAP;
  const right = Math.min(Math.max(GAP, viewport.width - (rect.x + rect.width)), viewport.width - GAP - 120);
  return { top, right };
}

/** 每屏独立的选区交互；快照、窗口吸附与标注仍由后续任务接入。 */
export function CaptureOverlay() {
  const context = window.__QINGBOX_CAPTURE__;
  const scale = context?.scale ?? window.devicePixelRatio ?? 1;
  const [selection, setSelection] = useState<Rect | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<"copy" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const drag = useRef<Drag | null>(null);

  /** 复制或保存选区；成功后宿主结束会话并关闭覆盖窗，失败时保留选区并显示原因。 */
  async function exportAs(action: "copy" | "save") {
    if (!selection || selection.width <= 0 || selection.height <= 0 || busy || drag.current) return;
    if (!context?.image) { setError("没有截图画面，无法导出"); return; }
    setBusy(action);
    setError(null);
    try {
      const png = await renderSelection(context.image, selection, window.innerWidth);
      await invoke("capture_export", png, { headers: { "x-capture-session": String(context.session), "x-capture-action": action } });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(null);
    }
  }
  // 键盘处理挂在 window 上，经 ref 取最新的导出函数
  const exportRef = useRef(exportAs);
  exportRef.current = exportAs;

  function begin(event: ReactMouseEvent, kind: Drag["kind"], handle = "") {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const start = pointOf(event);
    setError(null);
    setDragging(true);
    if (kind === "draw") {
      drag.current = { kind, start };
      setSelection({ ...start, width: 0, height: 0 });
    } else if (selection) {
      drag.current = { kind, start, original: selection, handle };
    }
  }

  useEffect(() => {
    function update(event: MouseEvent) {
      const current = drag.current;
      if (!current) return;
      const point = pointOf(event);
      if (current.kind === "move") {
        const { original, start } = current;
        setSelection({
          ...original,
          x: clamp(original.x + point.x - start.x, window.innerWidth - original.width),
          y: clamp(original.y + point.y - start.y, window.innerHeight - original.height),
        });
        return;
      }
      let left = current.start.x, right = point.x, top = current.start.y, bottom = point.y;
      if (current.kind === "resize") {
        const { original, start, handle } = current;
        left = original.x; right = original.x + original.width;
        top = original.y; bottom = original.y + original.height;
        if (handle.includes("w")) left = clamp(left + point.x - start.x, window.innerWidth);
        if (handle.includes("e")) right = clamp(right + point.x - start.x, window.innerWidth);
        if (handle.includes("n")) top = clamp(top + point.y - start.y, window.innerHeight);
        if (handle.includes("s")) bottom = clamp(bottom + point.y - start.y, window.innerHeight);
      }
      setSelection({ x: Math.min(left, right), y: Math.min(top, bottom), width: Math.abs(right - left), height: Math.abs(bottom - top) });
    }
    function end(event?: MouseEvent) {
      if (!drag.current) return;
      if (event) update(event);
      drag.current = null;
      setDragging(false);
      setSelection((rect) => rect && rect.width >= 2 && rect.height >= 2 ? rect : null);
    }
    function blur() { end(); }
    function handleKey(event: KeyboardEvent) {
      if (event.isComposing) return;
      const command = event.metaKey && !event.ctrlKey && !event.altKey;
      if (event.key === "Enter" || (command && event.key.toLowerCase() === "c")) {
        event.preventDefault();
        void exportRef.current("copy");
      } else if (command && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void exportRef.current("save");
      } else if (event.key === "Escape") {
        event.preventDefault();
        if (isTauri() && context) void invoke("capture_cancel", { session: context.session });
      }
    }
    window.addEventListener("mousemove", update);
    window.addEventListener("mouseup", end);
    window.addEventListener("blur", blur);
    window.addEventListener("keydown", handleKey);
    return () => {
      drag.current = null;
      window.removeEventListener("mousemove", update);
      window.removeEventListener("mouseup", end);
      window.removeEventListener("blur", blur);
      window.removeEventListener("keydown", handleKey);
    };
  }, [context]);

  const visible = selection && selection.width > 0 && selection.height > 0;
  return (
    <>
    {context?.image && <img className="capture-snapshot" src={context.image} alt="" draggable={false} />}
    <main className={`capture-overlay${visible ? " has-selection" : ""}`} aria-label="截图" onMouseDown={(event) => begin(event, "draw")}>
      <p className="capture-hint">{visible ? "回车复制 · ⌘S 保存 · Esc 取消" : "拖动选择区域 · Esc 取消"}</p>
      {visible && (
        <>
          <div className="capture-selection" aria-label="截图选区" style={{ left: selection.x, top: selection.y, width: selection.width, height: selection.height }} onMouseDown={(event) => begin(event, "move")} onDoubleClick={() => void exportAs("copy")}>
            {handles.map(([handle, name]) => (
              <span key={handle} className={`capture-handle capture-handle-${handle}`} aria-label={`调整选区：${name}`} onMouseDown={(event) => begin(event, "resize", handle)} />
            ))}
          </div>
          <output className="capture-size" aria-label="选区尺寸" style={{ left: clamp(selection.x, window.innerWidth - 130), top: selection.y >= 32 ? selection.y - 30 : selection.y + 8 }}>
            {/* 显示截出图片的实际像素，Retina 屏为逻辑尺寸的两倍 */}
            {Math.round(selection.width * scale)} × {Math.round(selection.height * scale)}
          </output>
          {!dragging && (
            <div className="capture-toolbar" role="toolbar" aria-label="截图操作" style={toolbarPosition(selection)} onMouseDown={(event) => event.stopPropagation()}>
              <button type="button" aria-label="取消" title="取消（Esc）" disabled={busy !== null} onClick={() => { if (isTauri() && context) void invoke("capture_cancel", { session: context.session }); }}>
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" /></svg>
              </button>
              <button type="button" aria-label="保存" title="保存到“图片/轻匣截图”（⌘S）" disabled={busy !== null} onClick={() => void exportAs("save")}>
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v10M6 9l4 4 4-4M4 16h12" /></svg>
              </button>
              <button type="button" className="capture-done" aria-label="完成" title="复制到剪贴板（回车）" disabled={busy !== null} onClick={() => void exportAs("copy")}>
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10.5l4 4 8-9" /></svg>
                <span>{busy === "copy" ? "复制中…" : busy === "save" ? "保存中…" : "完成"}</span>
              </button>
              {error && <p className="capture-error" role="alert">{error}</p>}
            </div>
          )}
        </>
      )}
    </main>
    </>
  );
}
