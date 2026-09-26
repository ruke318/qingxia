export type MarkupKind = "html" | "xml";

const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
// 这些元素的内容不按标签解析；pre、textarea 的空白有含义，整体原样保留。
const RAW_ELEMENTS = new Set(["script", "style", "pre", "textarea"]);
const HTML_HINT = /^<!doctype\s+html|<\/?(html|head|body|div|span|p|a|br|img|meta|link|script|style|table|tr|td|ul|ol|li|input|form|button|label|section|header|footer|nav|main|h[1-6])[\s>/]/i;

/** 以 `<` 开头视为标记语言：带 XML 声明或未出现常见 HTML 标签时按 XML 处理。 */
export function detectMarkup(source: string): MarkupKind | null {
  const text = source.trimStart().slice(0, 4000);
  if (!text.startsWith("<")) return null;
  if (/^<\?xml/i.test(text)) return "xml";
  return HTML_HINT.test(text) ? "html" : "xml";
}

type Token =
  | { type: "open"; name: string; text: string; selfClosing: boolean }
  | { type: "close"; name: string; text: string }
  | { type: "text"; text: string }
  | { type: "raw"; text: string }
  | { type: "other"; text: string };

function tokenize(source: string, kind: MarkupKind): Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  const pushText = (end: number) => {
    const text = source.slice(offset, end);
    const last = tokens.at(-1);
    if (last?.type === "text") last.text += text;
    else tokens.push({ type: "text", text });
    offset = end;
  };
  while (offset < source.length) {
    if (source[offset] !== "<") {
      const next = source.indexOf("<", offset + 1);
      pushText(next < 0 ? source.length : next);
      continue;
    }
    const block = [["<!--", "-->"], ["<![CDATA[", "]]>"], ["<?", "?>"]].find(([open]) => source.startsWith(open, offset));
    if (block) {
      const end = source.indexOf(block[1], offset + block[0].length);
      const stop = end < 0 ? source.length : end + block[1].length;
      tokens.push({ type: "other", text: source.slice(offset, stop) });
      offset = stop;
      continue;
    }
    // `<` 后不是标签名（如 `a < b`）时按普通文本处理。
    if (!/^<(?:\/?[A-Za-z_:]|!)/.test(source.slice(offset, offset + 3))) { pushText(offset + 1); continue; }
    let end = offset + 1;
    let quote: string | null = null;
    while (end < source.length && (quote || source[end] !== ">")) {
      if (quote) { if (source[end] === quote) quote = null; }
      else if (source[end] === '"' || source[end] === "'") quote = source[end];
      end += 1;
    }
    const text = source.slice(offset, Math.min(end + 1, source.length));
    offset = Math.min(end + 1, source.length);
    if (text.startsWith("<!")) { tokens.push({ type: "other", text }); continue; }
    const name = /^<\/?\s*([^\s/>]+)/.exec(text)?.[1] ?? "";
    if (text.startsWith("</")) { tokens.push({ type: "close", name, text }); continue; }
    const lower = name.toLowerCase();
    const selfClosing = /\/\s*>$/.test(text) || (kind === "html" && VOID_ELEMENTS.has(lower));
    tokens.push({ type: "open", name, text, selfClosing });
    if (kind === "html" && !selfClosing && RAW_ELEMENTS.has(lower)) {
      const close = source.slice(offset).search(new RegExp(`</${lower}\\s*>`, "i"));
      const stop = close < 0 ? source.length : offset + close;
      tokens.push({ type: "raw", text: source.slice(offset, stop) });
      offset = stop;
    }
  }
  return tokens;
}

const lines = (text: string) => text.split(/\r\n|\r|\n/);

/** 去掉公共缩进后按新层级重新缩进，用于 script、style 的内容。 */
function reindent(text: string, indent: string): string[] {
  const content = lines(text).filter((line) => line.trim());
  const common = Math.min(...content.map((line) => /^[ \t]*/.exec(line)![0].length));
  return content.map((line) => indent + line.slice(common).trimEnd());
}

/** 按标签层级缩进；标签不配对时缩进不低于零，内容本身不做修正。 */
export function formatMarkup(source: string, kind: MarkupKind): string {
  const tokens = tokenize(source, kind);
  const output: string[] = [];
  let depth = 0;
  const indent = () => "  ".repeat(depth);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "text") {
      for (const line of lines(token.text)) if (line.trim()) output.push(indent() + line.trim());
      continue;
    }
    if (token.type === "close") {
      depth = Math.max(0, depth - 1);
      output.push(indent() + token.text);
      continue;
    }
    if (token.type !== "open") {
      output.push(indent() + token.text.trim());
      continue;
    }
    if (token.selfClosing) { output.push(indent() + token.text); continue; }
    const next = tokens[index + 1];
    const raw = next?.type === "raw" ? next : null;
    const afterContent = tokens[index + (next?.type === "text" || raw ? 2 : 1)];
    const closesHere = afterContent?.type === "close" && afterContent.name.toLowerCase() === token.name.toLowerCase();
    // pre、textarea 整体原样输出，保留其中所有空白。
    if (raw && /^(pre|textarea)$/i.test(token.name)) {
      output.push(indent() + token.text + raw.text + (closesHere ? afterContent.text : ""));
      index += closesHere ? 2 : 1;
      continue;
    }
    // 空元素或单行短文本与开闭标签放在同一行。
    const inline = next?.type === "text" ? next.text.trim() : raw ? raw.text.trim() : "";
    if (closesHere && !inline.includes("\n") && inline.length <= 80) {
      output.push(indent() + token.text + inline + afterContent.text);
      index += next === afterContent ? 1 : 2;
      continue;
    }
    output.push(indent() + token.text);
    depth += 1;
    if (raw) {
      output.push(...reindent(raw.text, indent()));
      index += 1;
    }
  }
  return output.join("\n");
}

/** 去掉标签之间的空白与换行；script、style 等原始内容保持不变。 */
export function compactMarkup(source: string, kind: MarkupKind): string {
  return tokenize(source, kind).map((token) => token.type === "text" ? token.text.trim() : token.text).join("");
}
