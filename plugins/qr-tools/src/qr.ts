import QRCode from "qrcode";
import jsQR from "jsqr";

export type Level = "L" | "M" | "Q" | "H";
export const LEVELS: { id: Level; title: string }[] = [
  { id: "L", title: "低" },
  { id: "M", title: "中" },
  { id: "Q", title: "较高" },
  { id: "H", title: "高" },
];

export interface Pixels { data: Uint8ClampedArray; width: number; height: number }

export const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** 生成二维码 SVG；内容超出所选纠错级别的容量时抛出中文错误。 */
export async function toSvg(text: string, level: Level): Promise<string> {
  try {
    return await QRCode.toString(text, { type: "svg", errorCorrectionLevel: level, margin: 2, color: { dark: "#000000", light: "#ffffff" } });
  } catch {
    throw new Error(`内容太长（${byteLength(text)} 字节），超出二维码容量；可以降低纠错级别或缩短内容`);
  }
}

/** 把二维码矩阵画成像素，供测试在无浏览器环境下验证识别。 */
export function renderPixels(text: string, level: Level, scale = 4, margin = 4): Pixels {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: level });
  const width = (modules.size + margin * 2) * scale;
  const data = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let row = 0; row < modules.size; row += 1) {
    for (let column = 0; column < modules.size; column += 1) {
      if (!modules.get(row, column)) continue;
      for (let y = 0; y < scale; y += 1) {
        for (let x = 0; x < scale; x += 1) {
          const offset = (((row + margin) * scale + y) * width + (column + margin) * scale + x) * 4;
          data[offset] = data[offset + 1] = data[offset + 2] = 0;
        }
      }
    }
  }
  return { data, width, height: width };
}

/** 识别像素中的二维码，未找到返回 null。字节内容按 UTF-8 解码，失败时退回识别库自带的文本。 */
export function decodePixels(pixels: Pixels): string | null {
  const result = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: "attemptBoth" });
  if (!result) return null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(result.binaryData)); }
  catch { return result.data; }
}
