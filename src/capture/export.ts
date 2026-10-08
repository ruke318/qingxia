import { drawAnnotations, type Annotation } from "./annotations";

// 把选区按物理像素合成为 PNG。之后的标注、马赛克也画在同一张 canvas 上，复制与保存始终使用这一份扁平结果。

export type Rect = { x: number; y: number; width: number; height: number };

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    // 快照来自 qingbox-capture 协议，跨源读取像素需要匿名 CORS，否则 canvas 被污染无法导出
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("读取截图画面失败"));
    image.src = url;
  });
}

/** 选区（逻辑坐标）换算为快照中的像素区域；`ratio` 为快照像素与页面逻辑宽度之比。 */
export function pixelRect(rect: Rect, ratio: number): Rect {
  const x = Math.round(rect.x * ratio);
  const y = Math.round(rect.y * ratio);
  return { x, y, width: Math.max(1, Math.round((rect.x + rect.width) * ratio) - x), height: Math.max(1, Math.round((rect.y + rect.height) * ratio) - y) };
}

/** 从快照裁出选区、叠加标注并编码为 PNG 字节。`viewportWidth` 为覆盖窗的逻辑宽度。 */
export async function renderSelection(image: HTMLImageElement, rect: Rect, viewportWidth: number, annotations: Annotation[] = []): Promise<Uint8Array> {
  const ratio = image.naturalWidth / viewportWidth;
  const area = pixelRect(rect, ratio);
  const canvas = document.createElement("canvas");
  canvas.width = area.width;
  canvas.height = area.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建画布");
  context.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, area.width, area.height);
  // 标注以逻辑坐标绘制：缩放到像素并平移到选区原点
  context.setTransform(ratio, 0, 0, ratio, -area.x, -area.y);
  drawAnnotations(context, annotations, image, ratio);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("生成截图失败");
  return new Uint8Array(await blob.arrayBuffer());
}
