import assert from "node:assert/strict";
import test from "node:test";
import { copyJson, formatJson, JsonFormatError, looseFormatJson } from "../src/format-json.ts";

test("格式化保留大整数、指数写法、负零和重复键", () => {
  const source = '{"id":9007199254740993123456789,"id":1e+400,"negative":-0,"decimal":1.2300}';
  const document = formatJson(source);
  assert.equal(document.compact, source);
  assert.equal(document.formatted, '{\n  "id": 9007199254740993123456789,\n  "id": 1e+400,\n  "negative": -0,\n  "decimal": 1.2300\n}');
});

test("正常字符串内换行、引号、反斜杠路径与 Unicode 转义原样保留", () => {
  const source = String.raw`{"text":"第一行\n第二行\"内容\"","path":"C:\\Users\\test","unicode":"\u4e2d\ud83d\ude00"}`;
  const document = formatJson(source);
  assert.equal(document.compact, source);
  assert.equal(document.unwrappedLayers, 0);
});

test("只对完整新文档解包外层字符串或整体转义，保留内部转义", () => {
  const source = String.raw`{"path":"C:\\Users\\test","text":"第一行\n第二行","id":9007199254740993123}`;
  assert.equal(formatJson(JSON.stringify(source)).compact, source);
  assert.equal(formatJson(JSON.stringify(source).slice(1, -1)).compact, source);
  assert.equal(formatJson(JSON.stringify(JSON.stringify(source))).compact, source);
  assert.equal(formatJson(JSON.stringify(JSON.stringify(source))).unwrappedLayers, 2);
  assert.equal(formatJson('"123"').compact, '"123"');
  assert.equal(formatJson('"null"').compact, '"null"');
  assert.equal(formatJson('"hello\\nworld"').compact, '"hello\\nworld"');
});

test("不完整或局部转义 JSON 报错，不盲目替换反斜杠", () => {
  for (const source of ['{a:1}', '{"a":1,}', '[1,]', '{"a":01}', '{"a":1.}', '{"a":1e}', '{"a":NaN}', '{"a":Infinity}', '{"a":"\\x20"}', '{"a":"内容\n内容"}', '{"a":true} trailing', String.raw`{"a":1,"b\":2}`, '']) {
    assert.throws(() => formatJson(source), JsonFormatError, source);
  }
});

test("错误位置指向原文行列", () => {
  for (const newline of ["\n", "\r\n", "\r"]) assert.throws(() => formatJson(['{', '  "a": 1,', '  bad: 2', '}'].join(newline)), (error: unknown) => {
    assert.ok(error instanceof JsonFormatError);
    assert.equal(error.line, 3);
    assert.equal(error.column, 3);
    return true;
  });
});

test("复制三种模式结果准确，转义复制包含外层双引号", () => {
  const source = '{ "id": 9007199254740993, "text": "a\\nb" }';
  const compact = '{"id":9007199254740993,"text":"a\\nb"}';
  assert.equal(copyJson(source, "compact"), compact);
  assert.equal(copyJson(source, "formatted"), '{\n  "id": 9007199254740993,\n  "text": "a\\nb"\n}');
  assert.equal(copyJson(source, "escaped"), JSON.stringify(compact));
  assert.equal(JSON.parse(copyJson(source, "escaped")), compact);
});

test("空容器、顶层基础值及嵌套 JSON 保持含义", () => {
  for (const source of ['{}', '[]', 'null', 'true', 'false', '123', '-0', '"文本"', '{"a":[{},[],[true,null,2]],"b":{}}']) {
    const document = formatJson(source);
    assert.equal(document.compact, source);
    assert.deepEqual(JSON.parse(document.formatted), JSON.parse(source));
  }
});

test("深层合法 JSON 不依赖递归调用栈", () => {
  const source = "[".repeat(1000) + "0" + "]".repeat(1000);
  assert.equal(formatJson(source).compact, source);
});

test("有误 JSON 容错排版：只改结构间空白，字符串、注释与非法写法原样保留", () => {
  const source = "{a:1, 'b': 'x, {y}', \"c\": [1,2,], // 注释\n d: True /* 块 */}";
  const formatted = looseFormatJson(source);
  assert.equal(formatted, "{\n  a: 1,\n  'b': 'x, {y}',\n  \"c\": [\n    1,\n    2,\n  ],\n  // 注释\n  d: True /* 块 */\n}");
  assert.equal(formatted.replace(/\s+/g, ""), source.replace(/\s+/g, ""));
});

test("有误 JSON 容错排版：缺少或多出括号、未闭合字符串时不抛错且缩进不为负", () => {
  assert.equal(looseFormatJson('{"a":[1,{"b":2'), '{\n  "a": [\n    1,\n    {\n      "b": 2');
  assert.equal(looseFormatJson('{"a":1}}]'), '{\n  "a": 1\n}\n}\n]');
  assert.equal(looseFormatJson('{"a":"未闭合\n,"b":2}'), '{\n  "a": "未闭合,\n  "b": 2\n}');
});
