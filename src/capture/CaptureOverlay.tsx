import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { loadImage, renderSelection } from "./export";
import { bounds, COLORS, drawAnnotations, FONT, hitTest, normalize, snapAngle, TEXT_FONT_FAMILY, translate, type Annotation, type Size, type Tool } from "./annotations";
import { loadStyles, saveStyles, type ToolStyle, type ToolStyles } from "./styles";

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
/** 标注拖拽：新画一个，或移动已有的。 */
type Stroke = { start: Point; shift: boolean } & ({ kind: "draw"; item: Annotation } | { kind: "move"; id: number; before: Annotation[] });
type TextEdit = { id: number | null; x: number; y: number; value: string; color: string; size: Size };
type History = { items: Annotation[]; past: Annotation[][]; future: Annotation[][] };

const handles = [
  ["nw", "左上角"], ["n", "上边"], ["ne", "右上角"], ["e", "右边"],
  ["se", "右下角"], ["s", "下边"], ["sw", "左下角"], ["w", "左边"],
] as const;
const clamp = (value: number, maximum: number) => Math.max(0, Math.min(value, maximum));
const pointOf = (event: { clientX: number; clientY: number }): Point => ({
  x: clamp(event.clientX, window.innerWidth), y: clamp(event.clientY, window.innerHeight),
});

const TOOLBAR_HEIGHT = 38;
const TOOLBAR_WIDTH = 540;
const GAP = 8;

/** 工具栏位置：默认在选区下方右对齐；下方放不下放上方，上下都放不下放在选区内底部。 */
export function toolbarPosition(rect: Rect, viewport = { width: window.innerWidth, height: window.innerHeight }) {
  const bottom = rect.y + rect.height;
  const top = viewport.height - bottom >= TOOLBAR_HEIGHT + GAP * 2 ? bottom + GAP
    : rect.y >= TOOLBAR_HEIGHT + GAP * 2 ? rect.y - TOOLBAR_HEIGHT - GAP
    : bottom - TOOLBAR_HEIGHT - GAP;
  const right = Math.min(Math.max(GAP, viewport.width - (rect.x + rect.width)), Math.max(GAP, viewport.width - GAP - TOOLBAR_WIDTH));
  return { top, right };
}

const TOOLS: [Tool, string, ReactNode][] = [
  ["rect", "矩形", <rect key="i" x="3.5" y="5" width="13" height="10" rx="1" />],
  ["line", "直线", <path key="i" d="M3.5 13.5c2-3 3.5-3 5 0s3 3 4.5 0 2.5-3 3.5-1" />],
  ["arrow", "箭头", <path key="i" d="M4.5 15.5L15 5M9.5 5H15v5.5" />],
  ["pen", "画笔", <path key="i" d="M4 15c2.5-.5 3.5-6 6.5-7s3 3.5 5.5 2.5" />],
  ["text", "文字", <path key="i" d="M5 5h10M10 5v11M8 16h4" />],
  ["step", "步骤序号", <><circle key="c" cx="10" cy="10" r="6.5" /><path key="n" d="M9 8.2l1.4-1V13" /></>],
  ["blur", "蒙层", <><rect key="r" x="3.5" y="5" width="13" height="10" rx="2" /><path key="l" d="M6.5 8.5h7M6.5 11.5h4.5" opacity="0.45" /></>],
  ["cover", "实色遮盖", <path key="i" className="filled" d="M3.5 6h13v8h-13z" />],
];
const SIZE_NAMES = ["细", "中", "粗"] as const;

/** 每屏独立的截图覆盖窗：选区、标注、复制与保存。 */
export function CaptureOverlay() {
  const context = window.__QINGBOX_CAPTURE__;
  const scale = context?.scale ?? window.devicePixelRatio ?? 1;
  const [selection, setSelection] = useState<Rect | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<"copy" | "save" | "pin" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool | null>(null);
  // 每个工具单独的颜色、粗细与线型，保存在本机
  const [styles, setStyles] = useState<ToolStyles>(() => loadStyles());
  const [doc, setDoc] = useState<History>({ items: [], past: [], future: [] });
  const [draft, setDraft] = useState<Annotation | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [text, setText] = useState<TextEdit | null>(null);
  const [snapshot, setSnapshot] = useState<HTMLImageElement | null>(null);
  const drag = useRef<Drag | null>(null);
  const stroke = useRef<Stroke | null>(null);
  const nextId = useRef(1);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  // 按 Esc 放弃文字时，输入框移除引起的失焦不再保存
  const discardText = useRef(false);
  const annotations = doc.items;
  // 开始标注后固定选区，避免标注与画面错位
  const locked = tool !== null || annotations.length > 0;

  // 蒙层预览与导出都要读取快照像素，以匿名 CORS 方式单独加载
  useEffect(() => {
    if (!context?.image) return;
    let active = true;
    loadImage(context.image).then((image) => { if (active) setSnapshot(image); }).catch(() => {});
    return () => { active = false; };
  }, [context?.image]);

  /** 提交一次修改，可撤销。 */
  function commit(next: Annotation[], before = annotations) {
    setDoc((current) => ({ items: next, past: [...current.past, before], future: [] }));
  }
  function undo() {
    setSelected(null);
    setDoc((current) => current.past.length ? { items: current.past[current.past.length - 1], past: current.past.slice(0, -1), future: [current.items, ...current.future] } : current);
  }
  function redo() {
    setSelected(null);
    setDoc((current) => current.future.length ? { items: current.future[0], past: [...current.past, current.items], future: current.future.slice(1) } : current);
  }

  /** 结束文字编辑：有内容则保存，空白则删除。 */
  function finishText(edit = text) {
    if (!edit) return;
    setText(null);
    const value = edit.value.replace(/\s+$/, "");
    const rest = annotations.filter((item) => item.id !== edit.id);
    if (!value) { if (edit.id !== null) commit(rest); return; }
    const item: Annotation = { kind: "text", id: edit.id ?? nextId.current++, x: edit.x, y: edit.y, text: value, color: edit.color, size: edit.size };
    commit(edit.id === null ? [...annotations, item] : annotations.map((current) => current.id === edit.id ? item : current));
  }

  /** 复制或保存选区；成功后宿主结束会话并关闭覆盖窗，失败时保留选区并显示原因。 */
  async function exportAs(action: "copy" | "save" | "pin") {
    if (!selection || selection.width <= 0 || selection.height <= 0 || busy || drag.current || stroke.current) return;
    if (!context?.image) { setError("没有截图画面，无法导出"); return; }
    let items = annotations;
    if (text) {
      // 导出前先保存正在输入的文字
      const value = text.value.replace(/\s+$/, "");
      items = annotations.filter((item) => item.id !== text.id);
      if (value) items = [...items, { kind: "text", id: text.id ?? nextId.current++, x: text.x, y: text.y, text: value, color: text.color, size: text.size }];
      finishText();
    }
    setBusy(action);
    setError(null);
    try {
      const image = snapshot ?? await loadImage(context.image);
      const png = await renderSelection(image, selection, window.innerWidth, items);
      const headers: Record<string, string> = { "x-capture-session": String(context.session), "x-capture-action": action };
      // 贴图出现在原选区位置
      if (action === "pin") headers["x-capture-rect"] = [selection.x, selection.y, selection.width, selection.height].join(",");
      await invoke("capture_export", png, { headers });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(null);
    }
  }
  // 键盘处理挂在 window 上，经 ref 取最新的状态与函数
  const latest = useRef({ exportAs, undo, redo, selected, annotations, commit, setSelected });
  latest.current = { exportAs, undo, redo, selected, annotations, commit, setSelected };

  function begin(event: ReactMouseEvent, kind: Drag["kind"], handle = "") {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (locked) return;
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

  /** 选区内按下：选中已有标注拖动，或用当前工具新画一个。 */
  function beginStroke(event: ReactMouseEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (text) { finishText(); return; }
    const point = pointOf(event);
    setError(null);
    const hit = hitTest(annotations, point.x, point.y);
    if (hit !== null) {
      const item = annotations.find((current) => current.id === hit);
      if (tool === "text" && item?.kind === "text") {
        setSelected(null);
        setText({ id: item.id, x: item.x, y: item.y, value: item.text, color: item.color, size: item.size });
        return;
      }
      setSelected(hit);
      stroke.current = { kind: "move", id: hit, before: annotations, start: point, shift: false };
      setDragging(true);
      return;
    }
    setSelected(null);
    if (!tool) return;
    const { color, size, wavy } = styles[tool];
    if (tool === "text") {
      setText({ id: null, x: point.x, y: point.y - FONT[size] * 0.15, value: "", color, size });
      return;
    }
    const id = nextId.current++;
    if (tool === "step") { commit([...annotations, { kind: "step", id, x: point.x, y: point.y, color, size }]); return; }
    const item: Annotation = tool === "arrow" ? { kind: "arrow", id, x1: point.x, y1: point.y, x2: point.x, y2: point.y, color, size }
      : tool === "line" ? { kind: "line", id, x1: point.x, y1: point.y, x2: point.x, y2: point.y, color, size, wavy }
      : tool === "pen" ? { kind: "pen", id, points: [[point.x, point.y]], color, size }
      : { kind: tool, id, x: point.x, y: point.y, width: 0, height: 0, color, size };
    stroke.current = { kind: "draw", item, start: point, shift: event.shiftKey };
    setDraft(item);
    setDragging(true);
  }

  useEffect(() => {
    function updateStroke(event: MouseEvent) {
      const current = stroke.current;
      if (!current) return false;
      const point = pointOf(event);
      if (current.kind === "move") {
        const dx = point.x - current.start.x, dy = point.y - current.start.y;
        setDoc((doc) => ({ ...doc, items: current.before.map((item) => item.id === current.id ? translate(item, dx, dy) : item) }));
        return true;
      }
      const item = current.item;
      let next: Annotation;
      if (item.kind === "arrow" || item.kind === "line") {
        const [x2, y2] = event.shiftKey ? snapAngle(item.x1, item.y1, point.x, point.y) : [point.x, point.y];
        next = { ...item, x2, y2 };
      } else if (item.kind === "pen") {
        next = { ...item, points: [...item.points, [point.x, point.y]] };
      } else if (item.kind === "rect" || item.kind === "blur" || item.kind === "cover") {
        next = { ...item, ...normalize(current.start.x, current.start.y, point.x, point.y) };
      } else return true;
      current.item = next;
      setDraft(next);
      return true;
    }
    function endStroke(event?: MouseEvent) {
      const current = stroke.current;
      if (!current) return false;
      if (event) updateStroke(event);
      stroke.current = null;
      setDragging(false);
      if (current.kind === "move") {
        setDoc((doc) => {
          const moved = doc.items.some((item, index) => item !== current.before[index]);
          return moved ? { items: doc.items, past: [...doc.past, current.before], future: [] } : doc;
        });
        return true;
      }
      setDraft(null);
      const item = current.item;
      const box = bounds(item);
      const meaningful = item.kind === "pen" ? item.points.length > 1 : box.width >= 3 || box.height >= 3;
      if (meaningful) setDoc((doc) => ({ items: [...doc.items, item], past: [...doc.past, doc.items], future: [] }));
      return true;
    }
    function update(event: MouseEvent) {
      if (updateStroke(event)) return;
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
      if (endStroke(event)) return;
      if (!drag.current) return;
      if (event) update(event);
      drag.current = null;
      setDragging(false);
      setSelection((rect) => rect && rect.width >= 2 && rect.height >= 2 ? rect : null);
    }
    function blur() { end(); }
    function handleKey(event: KeyboardEvent) {
      // 文字输入框自行处理按键
      if (event.isComposing || (event.target as HTMLElement | null)?.tagName === "TEXTAREA") return;
      const { exportAs, undo, redo, selected, annotations, commit, setSelected } = latest.current;
      const command = event.metaKey && !event.ctrlKey && !event.altKey;
      const key = event.key.toLowerCase();
      if (event.key === "Enter" || (command && key === "c" && !event.shiftKey)) {
        event.preventDefault();
        void exportAs("copy");
      } else if (command && key === "s") {
        event.preventDefault();
        void exportAs("save");
      } else if (command && key === "z") {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
      } else if ((event.key === "Backspace" || event.key === "Delete") && selected !== null) {
        event.preventDefault();
        commit(annotations.filter((item) => item.id !== selected));
        setSelected(null);
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
      stroke.current = null;
      window.removeEventListener("mousemove", update);
      window.removeEventListener("mouseup", end);
      window.removeEventListener("blur", blur);
      window.removeEventListener("keydown", handleKey);
    };
  }, [context]);

  // 标注预览：与导出共用绘制函数，限制在选区内；选中的标注加虚线框
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.round(window.innerWidth * ratio), height = Math.round(window.innerHeight * ratio);
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const paint = canvas.getContext("2d");
    if (!paint) return;
    paint.setTransform(1, 0, 0, 1, 0, 0);
    paint.clearRect(0, 0, width, height);
    if (!selection) return;
    paint.setTransform(ratio, 0, 0, ratio, 0, 0);
    paint.save();
    paint.beginPath();
    paint.rect(selection.x, selection.y, selection.width, selection.height);
    paint.clip();
    const visible = annotations.filter((item) => item.id !== text?.id);
    drawAnnotations(paint, draft ? [...visible, draft] : visible, snapshot, snapshot ? snapshot.naturalWidth / window.innerWidth : 1);
    paint.restore();
    const item = annotations.find((current) => current.id === selected);
    if (item) {
      const box = bounds(item);
      paint.setLineDash([4, 3]);
      paint.lineWidth = 1;
      paint.strokeStyle = "#65c7ff";
      paint.strokeRect(box.x - 4, box.y - 4, box.width + 8, box.height + 8);
    }
  }, [annotations, draft, selection, selected, snapshot, text?.id]);

  useEffect(() => { textRef.current?.focus(); }, [text?.id, text === null]);

  const selectedItem = annotations.find((item) => item.id === selected);
  // 样式面板对应的工具：当前工具，或选中标注的类型
  const styleTool: Tool | null = tool ?? (selectedItem ? selectedItem.kind as Tool : null);
  const currentStyle: ToolStyle | null = styleTool
    ? (selectedItem && !tool ? { ...styles[styleTool], color: selectedItem.color, size: selectedItem.size, wavy: selectedItem.kind === "line" ? selectedItem.wavy : false } : styles[styleTool])
    : null;

  /** 改颜色、粗细、线型：记入该工具的样式并保存，同时作用于选中的标注与正在输入的文字。 */
  function applyStyle(change: Partial<ToolStyle>) {
    if (!styleTool) return;
    setStyles((current) => {
      const next = { ...current, [styleTool]: { ...current[styleTool], ...change } };
      saveStyles(next);
      return next;
    });
    if (text) setText({ ...text, ...(change.color ? { color: change.color } : {}), ...(change.size !== undefined ? { size: change.size } : {}) });
    if (selected !== null) commit(annotations.map((item) => {
      if (item.id !== selected) return item;
      const { wavy, ...rest } = change;
      return (item.kind === "line" && wavy !== undefined ? { ...item, ...rest, wavy } : { ...item, ...rest }) as Annotation;
    }));
  }

  const visible = selection && selection.width > 0 && selection.height > 0;
  const toolbar = visible ? toolbarPosition(selection) : null;
  // 工具栏贴近屏幕底部时，颜色与粗细面板放到工具栏上方
  const panelAbove = toolbar ? toolbar.top + TOOLBAR_HEIGHT + 46 > window.innerHeight : false;
  return (
    <>
    {context?.image && <img className="capture-snapshot" src={context.image} alt="" draggable={false} onLoad={() => { if (isTauri()) void invoke("capture_ready", { session: context.session }); }} />}
    <main className={`capture-overlay${visible ? " has-selection" : ""}`} aria-label="截图" onMouseDown={(event) => begin(event, "draw")}>
      <p className="capture-hint">{visible ? (tool ? "按住 ⇧ 吸附角度 · ⌘Z 撤销 · 回车复制" : "回车复制 · ⌘S 保存 · Esc 取消") : "拖动选择区域 · Esc 取消"}</p>
      {visible && (
        <>
          <div className={`capture-selection${locked ? " locked" : ""}${tool === "text" ? " text-tool" : ""}`} aria-label="截图选区" style={{ left: selection.x, top: selection.y, width: selection.width, height: selection.height }}
            onMouseDown={(event) => locked ? beginStroke(event) : begin(event, "move")} onDoubleClick={() => { if (!tool) void exportAs("copy"); }}>
            {!locked && handles.map(([handle, name]) => (
              <span key={handle} className={`capture-handle capture-handle-${handle}`} aria-label={`调整选区：${name}`} onMouseDown={(event) => begin(event, "resize", handle)} />
            ))}
          </div>
          <output className="capture-size" aria-label="选区尺寸" style={{ left: clamp(selection.x, window.innerWidth - 130), top: selection.y >= 32 ? selection.y - 30 : selection.y + 8 }}>
            {/* 显示截出图片的实际像素，Retina 屏为逻辑尺寸的两倍 */}
            {Math.round(selection.width * scale)} × {Math.round(selection.height * scale)}
          </output>
          {text && (
            <textarea ref={textRef} className="capture-text" aria-label="标注文字" value={text.value} rows={Math.max(1, text.value.split("\n").length)}
              style={{ left: text.x, top: text.y, color: text.color, fontSize: FONT[text.size], fontFamily: TEXT_FONT_FAMILY, width: Math.max(80, Math.min(selection.x + selection.width - text.x, 600)) }}
              onMouseDown={(event) => event.stopPropagation()}
              onChange={(event) => setText({ ...text, value: event.target.value })}
              onBlur={() => { if (discardText.current) { discardText.current = false; return; } finishText(); }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                // 回车确认，⇧ 回车换行；Esc 只退出文字编辑，不取消截图
                if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); finishText(); }
                else if (event.key === "Escape") { event.preventDefault(); discardText.current = true; setText(null); }
              }} />
          )}
          {!dragging && toolbar && (
            <div className="capture-toolbar" role="toolbar" aria-label="截图操作" style={toolbar} onMouseDown={(event) => event.stopPropagation()}>
              {TOOLS.map(([id, name, icon]) => (
                <button key={id} type="button" aria-label={name} title={name} aria-pressed={tool === id} disabled={busy !== null}
                  onClick={() => { finishText(); setSelected(null); setTool(tool === id ? null : id); }}>
                  <svg viewBox="0 0 20 20" aria-hidden="true">{icon}</svg>
                </button>
              ))}
              <span className="capture-separator" />
              <button type="button" aria-label="撤销" title="撤销（⌘Z）" disabled={busy !== null || !doc.past.length} onClick={undo}>
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 7.5H13a3.5 3.5 0 010 7H8M7.5 7.5l3-3M7.5 7.5l3 3" /></svg>
              </button>
              <button type="button" aria-label="重做" title="重做（⌘⇧Z）" disabled={busy !== null || !doc.future.length} onClick={redo}>
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.5 7.5H7a3.5 3.5 0 000 7h5M12.5 7.5l-3-3M12.5 7.5l-3 3" /></svg>
              </button>
              <span className="capture-separator" />
              <button type="button" aria-label="取消" title="取消（Esc）" disabled={busy !== null} onClick={() => { if (isTauri() && context) void invoke("capture_cancel", { session: context.session }); }}>
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" /></svg>
              </button>
              <button type="button" aria-label="保存" title="保存到“图片/轻匣截图”（⌘S）" disabled={busy !== null} onClick={() => void exportAs("save")}>
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v10M6 9l4 4 4-4M4 16h12" /></svg>
              </button>
              <button type="button" aria-label="贴图" title="钉在屏幕上" disabled={busy !== null} onClick={() => void exportAs("pin")}>
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 3.5h5l-.6 4.5 2.6 3H5.5l2.6-3zM10 11v5.5" /></svg>
              </button>
              <button type="button" className="capture-done" aria-label="复制" title="复制到剪贴板（回车）" disabled={busy !== null} onClick={() => void exportAs("copy")}>
                <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="7" width="9.5" height="10" rx="1.6" /><path d="M13 7V5.2A1.7 1.7 0 0011.3 3.5H5.2A1.7 1.7 0 003.5 5.2v7.1A1.7 1.7 0 005.2 14H7" /></svg>
              </button>
              {styleTool && currentStyle && (
                <div className={`capture-style${panelAbove ? " above" : ""}`} role="group" aria-label="颜色与粗细" onMouseDown={(event) => event.preventDefault()}>
                  {styleTool !== "blur" && COLORS.map((value) => (
                    <button key={value} type="button" className="capture-color" aria-label={`颜色 ${value}`} aria-pressed={currentStyle.color === value} style={{ background: value }} onClick={() => applyStyle({ color: value })} />
                  ))}
                  {styleTool !== "blur" && <span className="capture-separator" />}
                  {SIZE_NAMES.map((name, index) => (
                    <button key={name} type="button" className="capture-size-option" aria-label={`${styleTool === "text" ? "字号" : styleTool === "blur" ? "模糊" : "粗细"}：${name}`} aria-pressed={currentStyle.size === index} onClick={() => applyStyle({ size: index as Size })}>
                      {styleTool === "text" ? <b style={{ fontSize: 10 + index * 3 }}>A</b> : <span style={{ width: 4 + index * 4, height: 4 + index * 4 }} />}
                    </button>
                  ))}
                  {styleTool === "line" && <>
                    <span className="capture-separator" />
                    <button type="button" className="capture-line-option" aria-label="线型：直线" title="直线" aria-pressed={!currentStyle.wavy} onClick={() => applyStyle({ wavy: false })}>
                      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 10h14" /></svg>
                    </button>
                    <button type="button" className="capture-line-option" aria-label="线型：波浪线" title="波浪线" aria-pressed={currentStyle.wavy} onClick={() => applyStyle({ wavy: true })}>
                      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 10c1.5-3 3-3 4.5 0s3 3 4.5 0 3-3 4.5 0" /></svg>
                    </button>
                  </>}
                </div>
              )}
              {error && <p className="capture-error" role="alert">{error}</p>}
            </div>
          )}
        </>
      )}
    </main>
    <canvas ref={canvasRef} className="capture-annotations" aria-hidden="true" />
    </>
  );
}
