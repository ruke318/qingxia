export class JsonFormatError extends Error {
  readonly offset: number;
  readonly line: number;
  readonly column: number;

  constructor(message: string, source: string, offset: number) {
    const preceding = source.slice(0, offset);
    const lines = preceding.split(/\r\n|\r|\n/);
    const line = lines.length;
    const column = lines[lines.length - 1].length + 1;
    super(`${message}（第 ${line} 行，第 ${column} 列）`);
    this.name = "JsonFormatError";
    this.offset = offset;
    this.line = line;
    this.column = column;
  }
}

interface Token { value: string; offset: number; }

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const number = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  let offset = 0;
  const fail = (message: string, position = offset): never => { throw new JsonFormatError(message, source, position); };
  while (offset < source.length) {
    const character = source[offset];
    if (/[ \t\r\n]/.test(character)) { offset += 1; continue; }
    const start = offset;
    if ("{}[]:,".includes(character)) offset += 1;
    else if (character === '"') {
      offset += 1;
      let closed = false;
      while (offset < source.length) {
        const next = source[offset++];
        if (next === '"') { closed = true; break; }
        if (next.charCodeAt(0) < 32) fail("字符串中含有未转义的控制字符", offset - 1);
        if (next !== "\\") continue;
        const escaped = source[offset++];
        if (escaped === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(source.slice(offset, offset + 4))) fail("Unicode 转义需要四位十六进制数字", offset);
          offset += 4;
        } else if (!escaped || !'"\\/bfnrt'.includes(escaped)) fail("无效的字符串转义", Math.min(offset - 1, source.length));
      }
      if (!closed) fail("字符串缺少结束引号", source.length);
    } else if (character === "-" || /\d/.test(character)) {
      number.lastIndex = offset;
      const match = number.exec(source);
      if (!match) fail("数字格式不正确");
      offset = number.lastIndex;
    } else {
      const literal = ["true", "false", "null"].find((value) => source.startsWith(value, offset));
      if (!literal) return fail("此处不是有效的 JSON 内容");
      offset += literal.length;
    }
    tokens.push({ value: source.slice(start, offset), offset: start });
  }
  return tokens;
}

type Context = { kind: "object"; step: "first-key" | "key" | "colon" | "value" | "separator" }
  | { kind: "array"; step: "first-value" | "value" | "separator" };

function validate(source: string): Token[] {
  const tokens = tokenize(source);
  const stack: Context[] = [];
  let rootRead = false;
  const fail = (message: string, offset: number): never => { throw new JsonFormatError(message, source, offset); };

  for (const token of tokens) {
    const context = stack.at(-1);
    const value = token.value;
    if (context?.kind === "object" && (context.step === "first-key" || context.step === "key")) {
      if (value === "}" && context.step === "first-key") { stack.pop(); continue; }
      if (!value.startsWith('"')) fail("对象的键需要使用双引号", token.offset);
      context.step = "colon";
      continue;
    }
    if (context?.kind === "object" && context.step === "colon") {
      if (value !== ":") fail("对象的键后缺少冒号", token.offset);
      context.step = "value";
      continue;
    }
    if (context?.step === "separator") {
      if (value === (context.kind === "object" ? "}" : "]")) { stack.pop(); continue; }
      if (value !== ",") fail("此处需要逗号或结束括号", token.offset);
      context.step = context.kind === "object" ? "key" : "value";
      continue;
    }
    if (context?.kind === "array" && context.step === "first-value" && value === "]") { stack.pop(); continue; }
    if (!context && rootRead) fail("JSON 值后存在多余内容", token.offset);
    if (!value.startsWith('"') && !/^-?\d/.test(value) && !["true", "false", "null", "{", "["].includes(value)) {
      fail("此处需要一个 JSON 值", token.offset);
    }
    if (context) context.step = "separator";
    else rootRead = true;
    if (value === "{") stack.push({ kind: "object", step: "first-key" });
    if (value === "[") stack.push({ kind: "array", step: "first-value" });
  }
  if (!rootRead) fail("请先输入 JSON", 0);
  if (stack.length) fail("JSON 内容尚未结束", source.length);
  return tokens;
}

function pretty(tokens: Token[]): string {
  const output: string[] = [];
  let depth = 0;
  const newline = () => output.push("\n", "  ".repeat(depth));
  tokens.forEach(({ value }, index) => {
    if (value === "{" || value === "[") {
      output.push(value);
      depth += 1;
      if (tokens[index + 1]?.value !== (value === "{" ? "}" : "]")) newline();
    } else if (value === "}" || value === "]") {
      depth -= 1;
      if (tokens[index - 1]?.value !== (value === "}" ? "{" : "[")) newline();
      output.push(value);
    } else if (value === ",") { output.push(value); newline(); }
    else if (value === ":") output.push(": ");
    else output.push(value);
  });
  return output.join("");
}

function unwrap(source: string): { source: string; layers: number } | null {
  let candidate = source.trim();
  let layers = 0;
  while (candidate.length) {
    let decoded: unknown;
    try { decoded = JSON.parse(candidate.startsWith('"') ? candidate : `"${candidate}"`); }
    catch { return null; }
    if (typeof decoded !== "string" || decoded === candidate) return null;
    candidate = decoded.trim();
    layers += 1;
    try {
      const tokens = validate(candidate);
      // 只解包完整对象或数组，保留正常 JSON 字符串的类型与内部转义。
      if (tokens[0]?.value === "{" || tokens[0]?.value === "[") return { source: candidate, layers };
      if (!tokens[0]?.value.startsWith('"')) return null;
    } catch {
      if (!candidate.startsWith('"')) return null;
    }
  }
  return null;
}

export interface JsonDocument {
  formatted: string;
  compact: string;
  unwrappedLayers: number;
}

export function formatJson(source: string, unescape = true): JsonDocument {
  let tokens: Token[];
  let originalError: unknown;
  try { tokens = validate(source); }
  catch (error) { originalError = error; tokens = []; }
  const decoded = unescape && (!tokens.length || tokens[0]?.value.startsWith('"')) ? unwrap(source) : null;
  if (decoded) tokens = validate(decoded.source);
  else if (originalError) throw originalError;
  return { formatted: pretty(tokens), compact: tokens.map((token) => token.value).join(""), unwrappedLayers: decoded?.layers ?? 0 };
}

export function copyJson(source: string, mode: "formatted" | "compact" | "escaped"): string {
  const document = formatJson(source);
  if (mode === "formatted") return document.formatted;
  if (mode === "compact") return document.compact;
  return JSON.stringify(document.compact);
}

/**
 * 容错排版：内容不是合法 JSON 时，只按括号与逗号调整缩进和换行。
 * 字符串（单双引号）、注释与其余字符原样保留，仅规整结构之间的空白；括号不配对时缩进不低于零。
 */
export function looseFormatJson(source: string): string {
  const tokens: string[] = [];
  let offset = 0;
  while (offset < source.length) {
    const character = source[offset];
    if (/\s/.test(character)) { offset += 1; continue; }
    const start = offset;
    if ("{}[]:,".includes(character)) offset += 1;
    else if (character === '"' || character === "'") {
      offset += 1;
      // 未闭合的字符串在行尾截止，避免吞掉后续全部内容。
      while (offset < source.length && source[offset] !== character && source[offset] !== "\n") offset += source[offset] === "\\" ? 2 : 1;
      if (source[offset] === character) offset += 1;
      offset = Math.min(offset, source.length);
    } else if (source.startsWith("//", offset)) {
      const end = source.indexOf("\n", offset);
      offset = end < 0 ? source.length : end;
    } else if (source.startsWith("/*", offset)) {
      const end = source.indexOf("*/", offset + 2);
      offset = end < 0 ? source.length : end + 2;
    } else {
      while (offset < source.length && !/[\s{}[\]:,"']/.test(source[offset]) && !source.startsWith("//", offset) && !source.startsWith("/*", offset)) offset += 1;
    }
    tokens.push(source.slice(start, offset));
  }

  let output = "";
  let depth = 0;
  let pendingNewline = false;
  let previous: string | undefined;
  const emit = (text: string, gap: boolean) => {
    if (pendingNewline) { output += `\n${"  ".repeat(depth)}`; pendingNewline = false; }
    else if (gap && output) output += " ";
    output += text;
  };
  for (const token of tokens) {
    const gap = previous !== undefined && !"{[:,".includes(previous);
    if (token === "{" || token === "[") { emit(token, gap); depth += 1; pendingNewline = true; }
    else if (token === "}" || token === "]") {
      depth = Math.max(0, depth - 1);
      pendingNewline = previous !== "{" && previous !== "[";
      emit(token, false);
    } else if (token === ",") { pendingNewline = false; emit(token, false); pendingNewline = true; }
    else if (token === ":") emit(": ", false);
    else if (token.startsWith("//")) { emit(token, gap); pendingNewline = true; }
    else emit(token, gap);
    previous = token;
  }
  return output;
}
