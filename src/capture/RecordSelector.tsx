import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { toolbarPosition } from "./CaptureOverlay";
import { invoke } from "@tauri-apps/api/core";
import { errorMessage, loadRecordPreferences, saveRecordPreferences, useRecordStatus, type RecordContext, type RecordPreferences, type RecordRect, type RecordTarget } from "./recording";

type Point = { x: number; y: number };
type Drag = { kind: "draw" | "move" | "resize"; start: Point; original?: RecordRect; handle?: string };
/** 选区来源：单击窗口、单击空白处（整屏），或自由框选（`null`）。 */
type Picked = { kind: "window"; id: number } | { kind: "display" } | null;

const handles = [["nw", "左上角"], ["n", "上边"], ["ne", "右上角"], ["e", "右边"], ["se", "右下角"], ["s", "下边"], ["sw", "左下角"], ["w", "左边"]];
/** 按下到松开移动不超过这个距离视为单击。 */
const CLICK_SLOP = 4;
const clamp = (value: number, max: number) => Math.max(0, Math.min(value, max));
const pointOf = (event: { clientX: number; clientY: number }) => ({ x: clamp(event.clientX, innerWidth), y: clamp(event.clientY, innerHeight) });
const screenRect = (): RecordRect => ({ x: 0, y: 0, width: innerWidth, height: innerHeight });
const normalized = (a: Point, b: Point): RecordRect => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) });
const bounded = (value: RecordRect): RecordRect => {
  const x = clamp(value.x, innerWidth), y = clamp(value.y, innerHeight);
  return { x, y, width: Math.max(0, Math.min(innerWidth, value.x + value.width) - x), height: Math.max(0, Math.min(innerHeight, value.y + value.height) - y) };
};

/** 录屏选区：与截图相同，鼠标下的窗口高亮，单击选中窗口、单击空白处录整屏、拖动自由框选。 */
export function RecordSelector({ context }: { context: RecordContext }) {
  const [rect, setRect] = useState<RecordRect | null>(null);
  const [picked, setPicked] = useState<Picked>(null);
  const [hover, setHover] = useState<RecordRect | null>(null);
  const [preferences, setPreferences] = useState<RecordPreferences>(() => loadRecordPreferences());
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const startAccepted = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState(false);
  const { status, pollError } = useRecordStatus(context.session);
  const scale = context.scale ?? window.devicePixelRatio ?? 1;
  const windows = context.windows ?? [];

  // 原生启动失败会回到选区阶段：恢复操作并显示原因，可以调整选项后重试
  useEffect(() => {
    if (startAccepted.current && status?.phase === "selecting" && status.error) {
      startAccepted.current = false; busyRef.current = false; setBusy(false); setError(status.error);
    }
  }, [status]);

  const windowAt = (point: Point) => windows.find((item) => point.x >= item.x && point.x < item.x + item.width && point.y >= item.y && point.y < item.y + item.height);

  function updatePreferences(change: Partial<RecordPreferences>) {
    setPreferences((current) => {
      const next = { ...current, ...change };
      saveRecordPreferences(next);
      return next;
    });
  }

  async function cancel() {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null);
    try { await invoke("record_cancel", { session: context.session }); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { busyRef.current = false; setBusy(false); }
  }

  async function start() {
    if (busyRef.current || drag.current || !rect || rect.width <= 0 || rect.height <= 0 || context.display === undefined) return;
    busyRef.current = true; startAccepted.current = false; setBusy(true); setError(null);
    const kind: RecordTarget["kind"] = picked?.kind === "window" && preferences.windowOnly ? "window" : picked?.kind === "display" ? "display" : "region";
    const target: RecordTarget = { kind, display: context.display, ...(kind === "window" && picked?.kind === "window" ? { window: picked.id } : {}), rect };
    const { windowOnly: _windowOnly, ...options } = preferences;
    try { await invoke("record_start", { session: context.session, target, options }); startAccepted.current = true; }
    catch (failure) { setError(errorMessage(failure)); busyRef.current = false; setBusy(false); }
  }

  function begin(event: ReactMouseEvent, kind: Drag["kind"], handle?: string) {
    if (event.button !== 0 || busyRef.current) return;
    event.preventDefault(); event.stopPropagation();
    drag.current = { kind, start: pointOf(event), original: rect ?? undefined, handle };
    setDragging(true); setHover(null); setError(null);
    if (kind === "draw") { setRect(null); setPicked(null); }
  }

  const latest = useRef({ cancel, windowAt, rect });
  latest.current = { cancel, windowAt, rect };
  useEffect(() => {
    function update(event: MouseEvent) {
      const current = drag.current, point = pointOf(event);
      if (!current) {
        // 还没有选区：高亮鼠标下的窗口，不在窗口上时高亮整屏
        if (!latest.current.rect && !busyRef.current) {
          const hit = latest.current.windowAt(point);
          setHover(hit ? bounded(hit) : screenRect());
        }
        return;
      }
      if (current.kind === "draw") setRect(normalized(current.start, point));
      else if (current.original) {
        // 移动或调整后改为自由区域
        setPicked(null);
        const original = current.original, dx = point.x - current.start.x, dy = point.y - current.start.y;
        if (current.kind === "move") setRect({ ...original, x: clamp(original.x + dx, innerWidth - original.width), y: clamp(original.y + dy, innerHeight - original.height) });
        else {
          let left = original.x, top = original.y, right = left + original.width, bottom = top + original.height;
          if (current.handle?.includes("w")) left = clamp(left + dx, innerWidth);
          if (current.handle?.includes("e")) right = clamp(right + dx, innerWidth);
          if (current.handle?.includes("n")) top = clamp(top + dy, innerHeight);
          if (current.handle?.includes("s")) bottom = clamp(bottom + dy, innerHeight);
          setRect(normalized({ x: left, y: top }, { x: right, y: bottom }));
        }
      }
    }
    function end(event: MouseEvent) {
      const current = drag.current;
      if (!current) return;
      const point = pointOf(event);
      const click = current.kind === "draw" && Math.hypot(point.x - current.start.x, point.y - current.start.y) <= CLICK_SLOP;
      // 先按松开位置更新选区，再结束拖动
      if (!click) update(event);
      drag.current = null; setDragging(false); setHover(null);
      if (click) {
        // 单击：选中鼠标下的窗口，空白处为整屏
        const hit = latest.current.windowAt(point);
        setRect(hit ? bounded(hit) : screenRect());
        setPicked(hit ? { kind: "window", id: hit.id } : { kind: "display" });
        return;
      }
      if (current.kind === "draw") setRect((value) => value && value.width >= 2 && value.height >= 2 ? value : null);
    }
    function blur() { drag.current = null; setDragging(false); }
    function key(event: KeyboardEvent) {
      if (event.isComposing) return;
      if (event.key === "Escape") { event.preventDefault(); void latest.current.cancel(); }
    }
    window.addEventListener("mousemove", update); window.addEventListener("mouseup", end); window.addEventListener("blur", blur); window.addEventListener("keydown", key);
    return () => { window.removeEventListener("mousemove", update); window.removeEventListener("mouseup", end); window.removeEventListener("blur", blur); window.removeEventListener("keydown", key); };
  }, []);

  const valid = rect && rect.width > 0 && rect.height > 0 && context.display !== undefined;
  const highlight = !rect && !dragging ? hover : null;
  const shownError = error ?? (busy ? null : status?.error) ?? pollError;
  const pickedWindow = picked?.kind === "window" ? windows.find((item) => item.id === picked.id) : undefined;
  const hint = !rect ? "单击选择窗口 · 拖动框选区域 · 单击空白处录整屏 · Esc 取消"
    : pickedWindow ? (preferences.windowOnly ? `只录“${pickedWindow.name}”` : `录制“${pickedWindow.name}”所在区域`)
    : picked?.kind === "display" ? "录制整块屏幕" : "录制框选区域";
  const toggles: [keyof RecordPreferences, string, string, ReactNode][] = [
    ["systemAudio", "系统声音", "录制电脑播放的声音", <path key="i" d="M3.5 8h3l4-3v10l-4-3h-3zM13.5 7.5a3.5 3.5 0 010 5M15.5 5.5a6.3 6.3 0 010 9" />],
    ["microphone", "麦克风", "录制麦克风的声音，首次使用时系统会请求授权", <path key="i" d="M10 3a2.4 2.4 0 00-2.4 2.4v4.2a2.4 2.4 0 004.8 0V5.4A2.4 2.4 0 0010 3zM5.5 9.6a4.5 4.5 0 009 0M10 14.1V17" />],
    ["showClicks", "点击高亮", "鼠标点击处显示圆圈", <><circle key="c" cx="10" cy="10" r="6.5" /><circle key="d" cx="10" cy="10" r="2" /></>],
  ];
  return <main className="record-selector">
    {context.image && <img className="record-snapshot" src={context.image} alt="" />}
    <div className={`record-overlay${rect || highlight ? " has-selection" : ""}`} aria-label="录屏框选层" onMouseDown={(event) => begin(event, "draw")}>
      <p className="capture-hint">{hint}</p>
      {highlight && <div className="record-hover" aria-label="录屏窗口高亮" style={{ left: highlight.x, top: highlight.y, width: highlight.width, height: highlight.height }}>
        <span className="record-size">{Math.round(highlight.width * scale)} × {Math.round(highlight.height * scale)}</span>
      </div>}
      {rect && <div className="record-selection" aria-label="录屏选区" style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }} onMouseDown={(event) => begin(event, "move")}>
        <span className="record-size" aria-label="录屏选区尺寸">{Math.round(rect.width * scale)} × {Math.round(rect.height * scale)}</span>
        {!busy && handles.map(([handle, name]) => <span key={handle} className={`record-handle record-handle-${handle}`} aria-label={`调整录屏选区：${name}`} onMouseDown={(event) => begin(event, "resize", handle)} />)}
      </div>}
      {rect && !dragging && <div className="record-toolbar" role="toolbar" aria-label="录屏操作" style={toolbarPosition(rect)} onMouseDown={(event) => event.stopPropagation()}>
        {toggles.map(([key, label, title, icon]) => <button key={key} type="button" aria-label={label} title={title} aria-pressed={preferences[key]} disabled={busy} onClick={() => updatePreferences({ [key]: !preferences[key] })}>
          <svg viewBox="0 0 20 20" aria-hidden="true">{icon}</svg><span>{label}</span>
        </button>)}
        {pickedWindow && <button type="button" aria-label="只录这个窗口" title="被遮挡或移动也照录；它弹出的菜单录不进去，系统声音只含该应用" aria-pressed={preferences.windowOnly} disabled={busy} onClick={() => updatePreferences({ windowOnly: !preferences.windowOnly })}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3.5" y="4.5" width="13" height="11" rx="1.5" /><path d="M3.5 7.5h13" /></svg><span>只录此窗口</span>
        </button>}
        <span className="record-separator" />
        <button type="button" aria-label="取消录屏" title="取消（Esc）" disabled={busy} onClick={() => { void cancel(); }}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" /></svg></button>
        <button type="button" className="record-start" aria-label="开始录制" disabled={!valid || busy} onClick={() => { void start(); }}><span className="record-dot" />{busy ? "准备中…" : "开始录制"}</button>
        {shownError && <p className="record-error" role="alert">{shownError}</p>}
      </div>}
      {!rect && shownError && <p className="record-error record-floating-error" role="alert">{shownError}</p>}
    </div>
  </main>;
}
