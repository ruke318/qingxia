import { decodePixels } from "./qr.ts";

// 大截图直接识别较慢，先限制到 2000 像素；识别不到再缩小重试，大尺寸二维码缩小后反而更易识别。
const SIZES = [2000, 1000, 500];

/** 在页面内解码图片并识别二维码；图片无法解码时抛出中文错误。 */
export async function scanImage(blob: Blob): Promise<string | null> {
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(blob); }
  catch { throw new Error("无法读取这张图片"); }
  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    for (const size of SIZES) {
      if (size < longest || size === SIZES[0]) {
        const scale = Math.min(1, size / longest);
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("无法读取这张图片");
        // 透明背景的图片先铺白底，避免透明像素被当作黑色。
        context.fillStyle = "#fff";
        context.fillRect(0, 0, width, height);
        context.drawImage(bitmap, 0, 0, width, height);
        const text = decodePixels({ data: context.getImageData(0, 0, width, height).data, width, height });
        if (text !== null) return text;
      }
    }
    return null;
  } finally {
    bitmap.close();
  }
}

/** 从粘贴事件中取第一张图片。 */
export function pastedImage(event: ClipboardEvent): File | null {
  for (const item of Array.from(event.clipboardData?.items ?? [])) {
    if (item.kind === "file" && item.type.startsWith("image/")) return item.getAsFile();
  }
  return null;
}
