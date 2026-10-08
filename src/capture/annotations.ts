// 截图标注：数据结构、绘制与命中检测。坐标为覆盖窗的逻辑坐标（与选区相同）；
// 屏幕预览与导出共用同一套绘制函数，导出结果与所见一致。

export type Tool = "rect" | "line" | "arrow" | "pen" | "text" | "step" | "mosaic" | "cover";
export type Size = 0 | 1 | 2;
type Base = { id: number; color: string; size: Size };
export type Annotation =
  | (Base & { kind: "rect" | "mosaic" | "cover"; x: number; y: number; width: number; height: number })
  | (Base & { kind: "arrow"; x1: number; y1: number; x2: number; y2: number })
  | (Base & { kind: "line"; x1: number; y1: number; x2: number; y2: number; wavy: boolean })
  | (Base & { kind: "pen"; points: [number, number][] })
  | (Base & { kind: "text"; x: number; y: number; text: string })
  | (Base & { kind: "step"; x: number; y: number });

export const COLORS = ["#e5484d", "#f5a524", "#30a46c", "#3b82f6", "#1f2328", "#ffffff"] as const;
const STROKE = [2, 4, 6];
export const FONT = [14, 18, 24];
const STEP_RADIUS = [11, 14, 18];
const MOSAIC_BLOCK = [6, 10, 16];
export const TEXT_FONT_FAMILY = '"PingFang SC", -apple-system, sans-serif';

/** 步骤序号按出现顺序编号，删除中间的标记后其余自动重排。 */
export function stepNumber(annotations: Annotation[], id: number): number {
  return annotations.filter((item) => item.kind === "step").findIndex((item) => item.id === id) + 1;
}

/** 规范化矩形，宽高为正。 */
export function normalize(x1: number, y1: number, x2: number, y2: number) {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

/** ⇧ 吸附：把终点吸附到水平、垂直或 45° 方向。 */
export function snapAngle(x1: number, y1: number, x2: number, y2: number): [number, number] {
  const dx = x2 - x1, dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return [x1 + Math.cos(angle) * length, y1 + Math.sin(angle) * length];
}

/** 文字标注的近似尺寸，用于命中检测与选中框。 */
function textBox(item: Extract<Annotation, { kind: "text" }>, measure?: CanvasRenderingContext2D) {
  const font = FONT[item.size];
  const lines = item.text.split("\n");
  let width = Math.max(...lines.map((line) => line.length)) * font * 0.62;
  if (measure) {
    measure.font = `${font}px ${TEXT_FONT_FAMILY}`;
    width = Math.max(...lines.map((line) => measure.measureText(line).width));
  }
  return { x: item.x, y: item.y, width: Math.max(width, font / 2), height: lines.length * font * 1.3 };
}

/** 标注的外接矩形。 */
export function bounds(item: Annotation): { x: number; y: number; width: number; height: number } {
  switch (item.kind) {
    case "rect": case "mosaic": case "cover": return { x: item.x, y: item.y, width: item.width, height: item.height };
    case "arrow": return normalize(item.x1, item.y1, item.x2, item.y2);
    case "line": {
      // 波浪线有起伏，外接矩形向外留出振幅
      const pad = item.wavy ? waveAmplitude(item.size) : 0;
      const box = normalize(item.x1, item.y1, item.x2, item.y2);
      return { x: box.x - pad, y: box.y - pad, width: box.width + pad * 2, height: box.height + pad * 2 };
    }
    case "pen": {
      const xs = item.points.map(([x]) => x), ys = item.points.map(([, y]) => y);
      return normalize(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
    }
    case "text": return textBox(item);
    case "step": { const r = STEP_RADIUS[item.size]; return { x: item.x - r, y: item.y - r, width: r * 2, height: r * 2 }; }
  }
}

/** 命中检测：从最上层往下找，返回命中的标注编号。 */
export function hitTest(annotations: Annotation[], x: number, y: number): number | null {
  for (let index = annotations.length - 1; index >= 0; index--) {
    const item = annotations[index];
    const tolerance = STROKE[item.size] + 4;
    if (item.kind === "arrow" || item.kind === "line") {
      const reach = tolerance + (item.kind === "line" && item.wavy ? waveAmplitude(item.size) : 0);
      if (distanceToSegment(x, y, item.x1, item.y1, item.x2, item.y2) <= reach) return item.id;
      continue;
    }
    if (item.kind === "pen") {
      if (item.points.some(([px, py], i) => i > 0 && distanceToSegment(x, y, item.points[i - 1][0], item.points[i - 1][1], px, py) <= tolerance)) return item.id;
      continue;
    }
    if (item.kind === "rect") {
      // 空心矩形只在边框附近命中，方便在框内继续标注
      const b = bounds(item);
      const inside = x >= b.x - tolerance && x <= b.x + b.width + tolerance && y >= b.y - tolerance && y <= b.y + b.height + tolerance;
      const inner = x > b.x + tolerance && x < b.x + b.width - tolerance && y > b.y + tolerance && y < b.y + b.height - tolerance;
      if (inside && !inner) return item.id;
      continue;
    }
    const b = bounds(item);
    if (x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height) return item.id;
  }
  return null;
}

function distanceToSegment(x: number, y: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1, dy = y2 - y1;
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / length)) : 0;
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

/** 平移标注。 */
export function translate(item: Annotation, dx: number, dy: number): Annotation {
  switch (item.kind) {
    case "arrow": case "line": return { ...item, x1: item.x1 + dx, y1: item.y1 + dy, x2: item.x2 + dx, y2: item.y2 + dy };
    case "pen": return { ...item, points: item.points.map(([x, y]) => [x + dx, y + dy] as [number, number]) };
    default: return { ...item, x: item.x + dx, y: item.y + dy };
  }
}

/**
 * 在 `context` 上绘制全部标注。`context` 的坐标变换须已设为逻辑坐标；
 * `snapshot` 为本屏快照，`snapshotRatio` 为快照像素与逻辑坐标之比，马赛克从快照取像素。
 */
export function drawAnnotations(context: CanvasRenderingContext2D, annotations: Annotation[], snapshot: HTMLImageElement | null, snapshotRatio: number) {
  for (const item of annotations) {
    context.save();
    context.strokeStyle = item.color;
    context.fillStyle = item.color;
    context.lineWidth = STROKE[item.size];
    context.lineCap = "round";
    context.lineJoin = "round";
    switch (item.kind) {
      case "rect":
        context.strokeRect(item.x, item.y, item.width, item.height);
        break;
      case "cover":
        context.fillRect(item.x, item.y, item.width, item.height);
        break;
      case "mosaic":
        drawMosaic(context, item, snapshot, snapshotRatio);
        break;
      case "arrow":
        drawArrow(context, item.x1, item.y1, item.x2, item.y2, STROKE[item.size]);
        break;
      case "line":
        if (item.wavy) drawWave(context, item.x1, item.y1, item.x2, item.y2, item.size);
        else { context.beginPath(); context.moveTo(item.x1, item.y1); context.lineTo(item.x2, item.y2); context.stroke(); }
        break;
      case "pen":
        context.beginPath();
        item.points.forEach(([x, y], index) => index ? context.lineTo(x, y) : context.moveTo(x, y));
        context.stroke();
        break;
      case "text": {
        const font = FONT[item.size];
        context.font = `${font}px ${TEXT_FONT_FAMILY}`;
        context.textBaseline = "top";
        item.text.split("\n").forEach((line, index) => context.fillText(line, item.x, item.y + index * font * 1.3));
        break;
      }
      case "step": {
        const r = STEP_RADIUS[item.size];
        context.beginPath();
        context.arc(item.x, item.y, r, 0, Math.PI * 2);
        context.fill();
        context.fillStyle = item.color === "#ffffff" ? "#1f2328" : "#ffffff";
        context.font = `600 ${Math.round(r * 1.1)}px ${TEXT_FONT_FAMILY}`;
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(String(stepNumber(annotations, item.id)), item.x, item.y + 1);
        break;
      }
    }
    context.restore();
  }
}

/** 波浪线的振幅与波长随粗细增大。 */
function waveAmplitude(size: Size) { return STROKE[size] * 1.2 + 2; }

function drawWave(context: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, size: Size) {
  const length = Math.hypot(x2 - x1, y2 - y1);
  const amplitude = waveAmplitude(size);
  const wavelength = STROKE[size] * 3 + 10;
  context.save();
  context.translate(x1, y1);
  context.rotate(Math.atan2(y2 - y1, x2 - x1));
  context.beginPath();
  context.moveTo(0, 0);
  for (let step = 1; step <= length; step++) context.lineTo(step, Math.sin((step / wavelength) * Math.PI * 2) * amplitude);
  context.stroke();
  context.restore();
}

function drawArrow(context: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, width: number) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = Math.max(10, width * 3.2);
  const neck = Math.min(head * 0.8, Math.hypot(x2 - x1, y2 - y1));
  context.beginPath();
  context.moveTo(x1, y1);
  context.lineTo(x2 - Math.cos(angle) * neck, y2 - Math.sin(angle) * neck);
  context.stroke();
  context.beginPath();
  context.moveTo(x2, y2);
  context.lineTo(x2 - head * Math.cos(angle - Math.PI / 7), y2 - head * Math.sin(angle - Math.PI / 7));
  context.lineTo(x2 - head * Math.cos(angle + Math.PI / 7), y2 - head * Math.sin(angle + Math.PI / 7));
  context.closePath();
  context.fill();
}

/** 马赛克：把快照对应区域缩小到每格一个像素，再不平滑地放大回去；导出时这块像素被真正替换。 */
function drawMosaic(context: CanvasRenderingContext2D, item: { x: number; y: number; width: number; height: number; size: Size }, snapshot: HTMLImageElement | null, ratio: number) {
  if (item.width < 1 || item.height < 1) return;
  if (!snapshot) {
    context.fillStyle = "rgba(128, 128, 128, 0.9)";
    context.fillRect(item.x, item.y, item.width, item.height);
    return;
  }
  const block = MOSAIC_BLOCK[item.size];
  const columns = Math.max(1, Math.ceil(item.width / block));
  const rows = Math.max(1, Math.ceil(item.height / block));
  const small = document.createElement("canvas");
  small.width = columns;
  small.height = rows;
  const tiny = small.getContext("2d");
  if (!tiny) return;
  // 按格放大后可能超出框选范围，先裁剪
  context.beginPath();
  context.rect(item.x, item.y, item.width, item.height);
  context.clip();
  tiny.imageSmoothingEnabled = true;
  tiny.drawImage(snapshot, item.x * ratio, item.y * ratio, item.width * ratio, item.height * ratio, 0, 0, columns, rows);
  context.imageSmoothingEnabled = false;
  context.drawImage(small, 0, 0, columns, rows, item.x, item.y, columns * block, rows * block);
  context.imageSmoothingEnabled = true;
}
