import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";

/** 宿主创建覆盖窗时注入的会话编号与屏幕序号。 */
declare global {
  interface Window { __QINGBOX_CAPTURE__?: { session: number; screen: number } }
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

/** 每屏独立的选区交互；快照、窗口吸附与标注仍由后续任务接入。 */
export function CaptureOverlay() {
  const context = window.__QINGBOX_CAPTURE__;
  const [selection, setSelection] = useState<Rect | null>(null);
  const drag = useRef<Drag | null>(null);

  function begin(event: ReactMouseEvent, kind: Drag["kind"], handle = "") {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const start = pointOf(event);
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
      setSelection((rect) => rect && rect.width >= 2 && rect.height >= 2 ? rect : null);
    }
    function blur() { end(); }
    function handleKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      if (isTauri() && context) void invoke("capture_cancel", { session: context.session });
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
    <main className={`capture-overlay${visible ? " has-selection" : ""}`} aria-label="截图" onMouseDown={(event) => begin(event, "draw")}>
      <p className="capture-hint">{visible ? "拖动选区移动 · 拖动边角调整 · Esc 取消" : "拖动选择区域 · Esc 取消"}</p>
      {visible && (
        <>
          <div className="capture-selection" aria-label="截图选区" style={{ left: selection.x, top: selection.y, width: selection.width, height: selection.height }} onMouseDown={(event) => begin(event, "move")}>
            {handles.map(([handle, name]) => (
              <span key={handle} className={`capture-handle capture-handle-${handle}`} aria-label={`调整选区：${name}`} onMouseDown={(event) => begin(event, "resize", handle)} />
            ))}
          </div>
          <output className="capture-size" aria-label="选区尺寸" style={{ left: clamp(selection.x, window.innerWidth - 130), top: selection.y >= 32 ? selection.y - 30 : selection.y + 8 }}>
            {Math.round(selection.width)} × {Math.round(selection.height)}
          </output>
        </>
      )}
    </main>
  );
}
