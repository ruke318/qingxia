// 每个标注工具单独记住颜色、粗细与线型，保存在本机，下次截图沿用。
import { COLORS, type Size, type Tool } from "./annotations";

export type ToolStyle = { color: string; size: Size; wavy: boolean };
export type ToolStyles = Record<Tool, ToolStyle>;

const KEY = "qingbox.capture.styles";
const TOOLS: Tool[] = ["rect", "line", "arrow", "pen", "text", "step", "mosaic", "cover"];

export function defaultStyles(): ToolStyles {
  const base: ToolStyle = { color: COLORS[0], size: 1, wavy: false };
  const styles = Object.fromEntries(TOOLS.map((tool) => [tool, { ...base }])) as ToolStyles;
  styles.cover.color = "#1f2328";
  return styles;
}

/** 读取已保存的样式；缺失或无效的项用默认值，旧版本数据也能兼容。 */
export function loadStyles(storage: Pick<Storage, "getItem"> = localStorage): ToolStyles {
  const styles = defaultStyles();
  try {
    const saved = JSON.parse(storage.getItem(KEY) ?? "{}") as Partial<Record<Tool, Partial<ToolStyle>>>;
    for (const tool of TOOLS) {
      const item = saved?.[tool];
      if (!item) continue;
      if (typeof item.color === "string" && (COLORS as readonly string[]).includes(item.color)) styles[tool].color = item.color;
      if (item.size === 0 || item.size === 1 || item.size === 2) styles[tool].size = item.size;
      if (typeof item.wavy === "boolean") styles[tool].wavy = item.wavy;
    }
  } catch {
    // 数据损坏时使用默认样式
  }
  return styles;
}

export function saveStyles(styles: ToolStyles, storage: Pick<Storage, "setItem"> = localStorage) {
  try { storage.setItem(KEY, JSON.stringify(styles)); } catch { /* 存储不可用时只在本次截图生效 */ }
}
