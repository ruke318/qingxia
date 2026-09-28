// JSONPath 查询：无损解析 JSON、求值并序列化结果，纯函数，便于单元测试。

export class JsonQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonQueryError";
  }
}

/** 双精度无法原样表示的数字（如 19 位雪花 ID、1.0）保留原文，序列化时原样输出。 */
export class RawNumber {
  readonly text: string;
  constructor(text: string) { this.text = text; }
}

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof RawNumber);
const hasOwn = (object: JsonObject, key: string) => Object.prototype.hasOwnProperty.call(object, key);

/** 解析已校验过的 JSON 文本。对象不带原型，`__proto__` 之类的键按普通字段保存。 */
export function parseJson(text: string): unknown {
  let offset = 0;
  const number = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const space = () => { while (offset < text.length && " \t\r\n".includes(text[offset])) offset += 1; };
  function value(): unknown {
    space();
    const character = text[offset];
    if (character === "{") {
      offset += 1;
      const object: JsonObject = Object.create(null);
      space();
      if (text[offset] === "}") { offset += 1; return object; }
      for (;;) {
        space();
        const key = value() as string;
        space(); offset += 1; // 冒号
        object[key] = value();
        space();
        if (text[offset++] === "}") return object;
      }
    }
    if (character === "[") {
      offset += 1;
      const array: unknown[] = [];
      space();
      if (text[offset] === "]") { offset += 1; return array; }
      for (;;) {
        array.push(value());
        space();
        if (text[offset++] === "]") return array;
      }
    }
    if (character === '"') {
      const start = offset++;
      while (text[offset] !== '"') offset += text[offset] === "\\" ? 2 : 1;
      offset += 1;
      return JSON.parse(text.slice(start, offset));
    }
    for (const [literal, result] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(literal, offset)) { offset += literal.length; return result; }
    }
    number.lastIndex = offset;
    const raw = number.exec(text)?.[0];
    if (!raw) throw new JsonQueryError("JSON 内容有误，无法查询");
    offset += raw.length;
    const parsed = Number(raw);
    return String(parsed) === raw ? parsed : new RawNumber(raw);
  }
  return value();
}

/** 序列化查询结果，两个空格缩进；RawNumber 原样输出。 */
export function stringify(value: unknown, depth = 0): string {
  if (value instanceof RawNumber) return value.text;
  const indent = "  ".repeat(depth + 1);
  const close = "  ".repeat(depth);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return `[\n${value.map((item) => indent + stringify(item, depth + 1)).join(",\n")}\n${close}]`;
  }
  if (isObject(value)) {
    const keys = Object.keys(value);
    if (!keys.length) return "{}";
    return `{\n${keys.map((key) => `${indent}${JSON.stringify(key)}: ${stringify(value[key], depth + 1)}`).join(",\n")}\n${close}}`;
  }
  return JSON.stringify(value);
}

type Selector =
  | { kind: "key"; key: string }
  | { kind: "index"; index: number }
  | { kind: "wildcard" }
  | { kind: "slice"; start?: number; end?: number }
  | { kind: "filter"; test: Expression };
type Segment = { recursive: boolean; selectors: Selector[] };
type Expression =
  | { kind: "or" | "and"; left: Expression; right: Expression }
  | { kind: "not"; operand: Expression }
  | { kind: "exists"; operand: Operand }
  | { kind: "compare"; operator: string; left: Operand; right: Operand };
type Operand = { kind: "path"; steps: (string | number)[] } | { kind: "literal"; value: unknown } | { kind: "regex"; pattern: RegExp };

const NAME = /[^\s.[\]()]/;

function parsePath(expression: string): Segment[] {
  let offset = 0;
  const source = expression.trim();
  const fail = (message: string): never => { throw new JsonQueryError(`${message}（第 ${offset + 1} 个字符）`); };
  const space = () => { while (source[offset] === " ") offset += 1; };
  const expect = (text: string) => { space(); if (!source.startsWith(text, offset)) fail(`此处需要「${text}」`); offset += text.length; };
  const name = () => {
    const start = offset;
    while (offset < source.length && NAME.test(source[offset])) offset += 1;
    if (offset === start) fail("缺少字段名");
    return source.slice(start, offset);
  };
  const quoted = () => {
    const quote = source[offset];
    const start = offset++;
    while (offset < source.length && source[offset] !== quote) offset += source[offset] === "\\" ? 2 : 1;
    if (offset >= source.length) fail("字符串缺少结束引号");
    offset += 1;
    const body = source.slice(start + 1, offset - 1);
    try { return JSON.parse(`"${quote === "'" ? body.replace(/\\'/g, "'").replace(/"/g, '\\"') : body}"`) as string; }
    catch { return fail("字符串转义不正确"); }
  };
  const integer = () => {
    const match = /^-?\d+/.exec(source.slice(offset));
    if (!match) fail("此处需要整数");
    offset += match![0].length;
    return Number(match![0]);
  };

  function operand(): Operand {
    space();
    const character = source[offset];
    if (character === "@") {
      offset += 1;
      const steps: (string | number)[] = [];
      for (;;) {
        if (source[offset] === "." && source[offset + 1] !== ".") { offset += 1; steps.push(name()); }
        else if (source[offset] === "[") {
          offset += 1; space();
          steps.push(source[offset] === "'" || source[offset] === '"' ? quoted() : integer());
          expect("]");
        } else return { kind: "path", steps };
      }
    }
    if (character === "'" || character === '"') return { kind: "literal", value: quoted() };
    if (character === "/") {
      const start = ++offset;
      while (offset < source.length && source[offset] !== "/") offset += source[offset] === "\\" ? 2 : 1;
      if (offset >= source.length) fail("正则缺少结束的 /");
      const pattern = source.slice(start, offset++);
      const flags = /^[a-z]*/.exec(source.slice(offset))![0];
      offset += flags.length;
      try { return { kind: "regex", pattern: new RegExp(pattern, flags) }; }
      catch { return fail("正则表达式不正确"); }
    }
    const number = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(offset));
    if (number) { offset += number[0].length; return { kind: "literal", value: Number(number[0]) }; }
    for (const [literal, value] of [["true", true], ["false", false], ["null", null]] as const) {
      if (source.startsWith(literal, offset)) { offset += literal.length; return { kind: "literal", value }; }
    }
    return fail("过滤条件中需要 @ 路径、数字、字符串、true、false 或 null");
  }

  function primary(): Expression {
    space();
    if (source[offset] === "!") { offset += 1; return { kind: "not", operand: primary() }; }
    if (source[offset] === "(") { offset += 1; const inner = or(); expect(")"); return inner; }
    const left = operand();
    space();
    const operator = ["==", "!=", ">=", "<=", "=~", ">", "<"].find((item) => source.startsWith(item, offset));
    if (!operator) return { kind: "exists", operand: left };
    offset += operator.length;
    const right = operand();
    if (operator === "=~" && right.kind !== "regex") fail("=~ 右边需要正则，如 /abc/i");
    return { kind: "compare", operator, left, right };
  }
  function and(): Expression {
    let left = primary();
    for (space(); source.startsWith("&&", offset); space()) { offset += 2; left = { kind: "and", left, right: primary() }; }
    return left;
  }
  function or(): Expression {
    let left = and();
    for (space(); source.startsWith("||", offset); space()) { offset += 2; left = { kind: "or", left, right: and() }; }
    return left;
  }

  function bracket(): Selector[] {
    offset += 1; space();
    if (source[offset] === "*") { offset += 1; expect("]"); return [{ kind: "wildcard" }]; }
    if (source[offset] === "?") {
      offset += 1; expect("(");
      const test = or();
      expect(")"); expect("]");
      return [{ kind: "filter", test }];
    }
    const selectors: Selector[] = [];
    for (;;) {
      space();
      if (source[offset] === "'" || source[offset] === '"') selectors.push({ kind: "key", key: quoted() });
      else {
        const start = source[offset] === ":" ? undefined : integer();
        space();
        if (source[offset] === ":") {
          offset += 1; space();
          const end = source[offset] === "]" || source[offset] === "," ? undefined : integer();
          selectors.push({ kind: "slice", start, end });
        } else selectors.push({ kind: "index", index: start! });
      }
      space();
      if (source[offset] === ",") { offset += 1; continue; }
      expect("]");
      return selectors;
    }
  }

  if (source[offset] === "$") offset += 1;
  const segments: Segment[] = [];
  while (offset < source.length) {
    const recursive = source.startsWith("..", offset);
    if (recursive) offset += 2;
    else if (source[offset] === ".") offset += 1;
    else if (source[offset] !== "[" && segments.length) fail(`无法识别「${source[offset]}」`);
    if (source[offset] === "[") segments.push({ recursive, selectors: bracket() });
    else if (source[offset] === "*") { offset += 1; segments.push({ recursive, selectors: [{ kind: "wildcard" }] }); }
    else segments.push({ recursive, selectors: [{ kind: "key", key: name() }] });
  }
  return segments;
}

function children(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return isObject(value) ? Object.values(value) : [];
}

function descendants(value: unknown, output: unknown[] = []): unknown[] {
  output.push(value);
  for (const child of children(value)) descendants(child, output);
  return output;
}

const plain = (value: unknown) => value instanceof RawNumber ? Number(value.text) : value;

function resolve(operand: Operand, current: unknown): unknown {
  if (operand.kind === "literal") return operand.value;
  if (operand.kind === "regex") return operand.pattern;
  let value: unknown = current;
  for (const step of operand.steps) {
    if (typeof step === "number") value = Array.isArray(value) ? value.at(step) : undefined;
    else if (isObject(value) && hasOwn(value, step)) value = value[step];
    // 数组、字符串没有同名字段时，length 取长度。
    else if (step === "length" && (Array.isArray(value) || typeof value === "string")) value = value.length;
    else value = undefined;
  }
  return plain(value);
}

function test(expression: Expression, current: unknown): boolean {
  switch (expression.kind) {
    case "or": return test(expression.left, current) || test(expression.right, current);
    case "and": return test(expression.left, current) && test(expression.right, current);
    case "not": return !test(expression.operand, current);
    case "exists": {
      const value = resolve(expression.operand, current);
      return value !== undefined && value !== null && value !== false;
    }
    case "compare": {
      const left = resolve(expression.left, current);
      const right = resolve(expression.right, current);
      if (expression.operator === "=~") return typeof left === "string" && (right as RegExp).test(left);
      if (expression.operator === "==") return left === right;
      if (expression.operator === "!=") return left !== right;
      const comparable = (typeof left === "number" && typeof right === "number") || (typeof left === "string" && typeof right === "string");
      if (!comparable) return false;
      const [a, b] = [left as number | string, right as number | string];
      return expression.operator === ">" ? a > b : expression.operator === "<" ? a < b : expression.operator === ">=" ? a >= b : a <= b;
    }
  }
}

function select(value: unknown, selector: Selector): unknown[] {
  switch (selector.kind) {
    case "key": return isObject(value) && hasOwn(value, selector.key) ? [value[selector.key]] : [];
    case "index": {
      if (!Array.isArray(value)) return [];
      const index = selector.index < 0 ? value.length + selector.index : selector.index;
      return index >= 0 && index < value.length ? [value[index]] : [];
    }
    case "wildcard": return children(value);
    case "slice": return Array.isArray(value) ? value.slice(selector.start, selector.end) : [];
    case "filter": return children(value).filter((child) => test(selector.test, child));
  }
}

export interface QueryResult {
  /** 命中的值。 */
  values: unknown[];
  /** 路径只含字段名和单个下标时为确定路径，结果展示为单个值而不是数组。 */
  definite: boolean;
}

export function query(root: unknown, expression: string): QueryResult {
  const segments = parsePath(expression);
  let nodes = [root];
  for (const segment of segments) {
    const sources = segment.recursive ? nodes.flatMap((node) => descendants(node)) : nodes;
    nodes = sources.flatMap((node) => segment.selectors.flatMap((selector) => select(node, selector)));
  }
  const definite = segments.every((segment) => !segment.recursive && segment.selectors.length === 1 && (segment.selectors[0].kind === "key" || segment.selectors[0].kind === "index"));
  return { values: nodes, definite };
}
