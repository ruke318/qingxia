import assert from "node:assert/strict";
import test from "node:test";
import { JsonQueryError, parseJson, query, RawNumber, stringify } from "../src/json-query.ts";

const data = parseJson(JSON.stringify({
  code: 0,
  data: {
    total: 3,
    list: [
      { id: 101, name: "张三", age: 28, tags: ["java", "go"], enabled: true },
      { id: 102, name: "李四", age: 17, tags: [], enabled: false },
      { id: 103, name: "王五", age: 35, tags: ["js"], enabled: true, owner: { id: 9 } },
    ],
  },
  "user-name": "测试",
}));
const values = (expression: string) => query(data, expression).values;

test("字段、下标、通配、切片与联合", () => {
  assert.deepEqual(values("data.total"), [3]);
  assert.deepEqual(values("$.data.total"), [3]);
  assert.deepEqual(values("data.list[*].id"), [101, 102, 103]);
  assert.deepEqual(values("data.list.*.id"), [101, 102, 103]);
  assert.deepEqual(values("data.list[0].name"), ["张三"]);
  assert.deepEqual(values("data.list[-1].name"), ["王五"]);
  assert.deepEqual(values("data.list[0:2].id"), [101, 102]);
  assert.deepEqual(values("data.list[1:].id"), [102, 103]);
  assert.deepEqual(values("data.list[:-1].id"), [101, 102]);
  assert.deepEqual(values("data.list[0,2].id"), [101, 103]);
  assert.deepEqual(values("data.list[0]['name','age']"), ["张三", 28]);
  assert.deepEqual(values("['user-name']"), ["测试"]);
  assert.deepEqual(values("user-name"), ["测试"]);
  assert.deepEqual(values("data.missing"), []);
});

test("递归查找任意层级", () => {
  assert.deepEqual(values("..id"), [101, 102, 103, 9]);
  assert.deepEqual(values("data..tags[0]"), ["java", "js"]);
});

test("过滤条件：比较、存在、逻辑组合、正则与长度", () => {
  assert.deepEqual(values("data.list[?(@.age > 18)].name"), ["张三", "王五"]);
  assert.deepEqual(values("data.list[?(@.name == '李四')].id"), [102]);
  assert.deepEqual(values('data.list[?(@.name != "李四")].id'), [101, 103]);
  assert.deepEqual(values("data.list[?(@.enabled)].id"), [101, 103]);
  assert.deepEqual(values("data.list[?(!@.enabled)].id"), [102]);
  assert.deepEqual(values("data.list[?(@.owner)].id"), [103]);
  assert.deepEqual(values("data.list[?(@.age >= 28 && @.enabled == true)].id"), [101, 103]);
  assert.deepEqual(values("data.list[?(@.age < 18 || @.id == 103)].id"), [102, 103]);
  assert.deepEqual(values("data.list[?(@.name =~ /^[张王]/)].id"), [101, 103]);
  assert.deepEqual(values("data.list[?(@.tags.length > 0)].id"), [101, 103]);
  assert.deepEqual(values("data.list[?(@.tags[0] == 'js')].id"), [103]);
  assert.deepEqual(values("data.list[?(@.owner.id == 9)].name"), ["王五"]);
});

test("确定路径返回单个值，含通配或过滤时返回数组", () => {
  assert.equal(query(data, "data.list[0].name").definite, true);
  assert.equal(query(data, "data.list[*].name").definite, false);
  assert.equal(query(data, "..name").definite, false);
  assert.equal(query(data, "data.list[0,1]").definite, false);
});

test("超出双精度的数字原样保留，参与比较时按数值", () => {
  const document = parseJson('{"list":[{"id":1790000000000000123,"price":1.50},{"id":7,"price":2}]}');
  const [id] = query(document, "list[0].id").values;
  assert.ok(id instanceof RawNumber);
  assert.equal(stringify(id), "1790000000000000123");
  assert.equal(stringify(query(document, "list[?(@.price > 1.4)].price").values), "[\n  1.50,\n  2\n]");
});

test("解析不带原型，__proto__ 是普通字段", () => {
  const document = parseJson('{"__proto__":{"polluted":true},"a":1}');
  assert.deepEqual(query(document, "['__proto__'].polluted").values, [true]);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("序列化为两空格缩进", () => {
  assert.equal(stringify(query(data, "data.list[1]").values[0]), '{\n  "id": 102,\n  "name": "李四",\n  "age": 17,\n  "tags": [],\n  "enabled": false\n}');
});

test("语法错误给出中文原因和位置", () => {
  for (const [expression, reason] of [
    ["data.list[", "此处需要整数"],
    ["data.list[?(@.age > )]", "过滤条件中需要"],
    ["data.list[0", "此处需要「]」"],
    ["data..", "缺少字段名"],
    ["data.list[?(@.name =~ 'x')]", "=~ 右边需要正则"],
  ]) {
    assert.throws(() => query(data, expression), (error: unknown) => error instanceof JsonQueryError && error.message.includes(reason) && /第 \d+ 个字符/.test(error.message), expression);
  }
});
