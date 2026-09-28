// 固定时区，保证本地时间相关断言在任何机器上结果一致。
process.env.TZ = "Asia/Shanghai";

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDateTime, formatIso, parse, relative, rows, weekday } from "../src/time.ts";

const MOMENT = 1727490309000; // 2024-09-28 10:25:09 +08:00

test("按位数识别秒、毫秒、微秒、纳秒时间戳", () => {
  assert.deepEqual(parse("1727490309"), { ok: true, ms: MOMENT, label: "秒级时间戳" });
  assert.deepEqual(parse("1727490309123"), { ok: true, ms: MOMENT + 123, label: "毫秒级时间戳" });
  assert.deepEqual(parse("1727490309123456"), { ok: true, ms: MOMENT + 123, label: "微秒级时间戳" });
  assert.deepEqual(parse("1727490309123456789"), { ok: true, ms: MOMENT + 123, label: "纳秒级时间戳" });
  assert.deepEqual(parse(" 1727490309.5 "), { ok: true, ms: MOMENT + 500, label: "秒级时间戳" });
  assert.deepEqual(parse("0"), { ok: true, ms: 0, label: "秒级时间戳" });
  assert.deepEqual(parse("-86400"), { ok: true, ms: -86_400_000, label: "秒级时间戳" });
});

test("识别常见日期格式，无时区按本地时间", () => {
  for (const text of ["2024-09-28 10:25:09", "2024/9/28 10:25:09", "2024.09.28T10:25:09", "2024年9月28日 10时25分09秒", "2024年9月28日 10:25:09"]) {
    assert.deepEqual(parse(text), { ok: true, ms: MOMENT, label: "本地时间" }, text);
  }
  assert.equal((parse("2024-09-28") as { ms: number }).ms, new Date(2024, 8, 28).getTime());
  assert.equal((parse("2024-09-28 10:25:09.123") as { ms: number }).ms, MOMENT + 123);
  assert.deepEqual(parse("2024-09-28T02:25:09Z"), { ok: true, ms: MOMENT, label: "日期时间" });
  assert.deepEqual(parse("2024-09-28T10:25:09+08:00"), { ok: true, ms: MOMENT, label: "日期时间" });
});

test("无效输入给出中文原因，空文本返回 null", () => {
  assert.equal(parse("   "), null);
  assert.deepEqual(parse("2024-02-30"), { ok: false, error: "日期或时间超出有效范围" });
  assert.deepEqual(parse("12345678901234567890"), { ok: false, error: "数字超过 19 位，无法识别为时间戳" });
  assert.equal(parse("明天吃什么")?.ok, false);
});

test("格式化本地、UTC、ISO 与星期", () => {
  assert.equal(formatDateTime(MOMENT), "2024-09-28 10:25:09");
  assert.equal(formatDateTime(MOMENT + 7), "2024-09-28 10:25:09.007");
  assert.equal(formatDateTime(MOMENT, true), "2024-09-28 02:25:09");
  assert.equal(formatIso(MOMENT), "2024-09-28T10:25:09+08:00");
  assert.equal(weekday(MOMENT), "星期六");
  assert.deepEqual(rows(MOMENT + 123).map((row) => row.value), ["1727490309", "1727490309123", "2024-09-28 10:25:09.123", "2024-09-28 02:25:09.123", "2024-09-28T10:25:09.123+08:00"]);
  assert.equal(rows(MOMENT)[2].label, "本地时间（UTC+08:00）");
});

test("相对时间描述", () => {
  assert.equal(relative(MOMENT, MOMENT + 2000), "现在");
  assert.equal(relative(MOMENT, MOMENT + 90_000), "1 分钟前");
  assert.equal(relative(MOMENT, MOMENT - 3 * 3600_000), "3 小时后");
  assert.equal(relative(MOMENT, MOMENT + 400 * 86400_000), "1 年前");
});
