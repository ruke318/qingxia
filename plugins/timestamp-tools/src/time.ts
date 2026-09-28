// 时间戳与日期互转的纯函数，不依赖页面，便于单元测试。

export type Parsed = { ok: true; ms: number; label: string } | { ok: false; error: string };
export interface Row { label: string; value: string }

/** Date 可表示的最大毫秒数（±约 27.5 万年）。 */
const LIMIT = 8.64e15;
const NUMBER = /^[+-]?\d+(\.\d+)?$/;
const LOCAL = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:[.,](\d{1,3})\d*)?)?)?$/;
const UNITS = [
  { digits: 10, label: "秒级时间戳", toMs: (text: string) => Number(text) * 1000 },
  { digits: 13, label: "毫秒级时间戳", toMs: (text: string) => Number(text) },
  { digits: 16, label: "微秒级时间戳", toMs: (text: string) => Number(text) / 1000 },
  // 纳秒超出双精度整数范围，用 BigInt 截到毫秒。
  { digits: 19, label: "纳秒级时间戳", toMs: (text: string) => Number(BigInt(text.split(".")[0]) / 1_000_000n) },
];

/** 识别时间戳或日期文本；空文本返回 null。 */
export function parse(raw: string): Parsed | null {
  const text = raw.trim();
  if (!text) return null;
  if (NUMBER.test(text)) {
    const digits = text.replace(/^[+-]/, "").split(".")[0].replace(/^0+(?=\d)/, "").length;
    const unit = UNITS.find((item) => digits <= item.digits);
    if (!unit) return { ok: false, error: "数字超过 19 位，无法识别为时间戳" };
    return checked(Math.floor(unit.toMs(text)), unit.label);
  }
  // 中文日期统一成横线与冒号，如「2026年9月28日 10时25分」。
  const normalized = text.replace(/[年月]/g, "-").replace(/日/g, " ").replace(/[时分]/g, ":").replace(/秒/g, "")
    .replace(/\s+/g, " ").replace(/:$/, "").trim();
  const match = LOCAL.exec(normalized);
  if (match) {
    const [year, month, day, hour = 0, minute = 0, second = 0] = match.slice(1, 7).map((value) => Number(value ?? 0));
    const millisecond = Number((match[7] ?? "").padEnd(3, "0"));
    const date = new Date(year, month - 1, day, hour, minute, second, millisecond);
    // 回读各字段，排除 2 月 30 日、25 点这类会被 Date 自动进位的日期。
    const exact = date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
      && date.getHours() === hour && date.getMinutes() === minute && date.getSeconds() === second;
    return exact ? checked(date.getTime(), "本地时间") : { ok: false, error: "日期或时间超出有效范围" };
  }
  const zoned = Date.parse(text);
  if (!Number.isNaN(zoned)) return checked(zoned, "日期时间");
  return { ok: false, error: "无法识别，支持秒 / 毫秒 / 微秒 / 纳秒时间戳和常见日期格式" };
}

function checked(ms: number, label: string): Parsed {
  return Number.isFinite(ms) && Math.abs(ms) <= LIMIT ? { ok: true, ms, label } : { ok: false, error: "超出可表示的时间范围" };
}

const pad = (value: number, width = 2) => String(Math.abs(value)).padStart(width, "0");

function fields(ms: number, utc: boolean) {
  const date = new Date(ms);
  return utc
    ? [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()]
    : [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds()];
}

/** 形如 2026-09-28 10:25:09，毫秒不为 0 时追加 .SSS。 */
export function formatDateTime(ms: number, utc = false): string {
  const [year, month, day, hour, minute, second, millisecond] = fields(ms, utc);
  const base = `${year < 0 ? "-" : ""}${pad(year, 4)}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`;
  return millisecond ? `${base}.${pad(millisecond, 3)}` : base;
}

/** 本地时区相对 UTC 的偏移，如 +08:00。 */
export function offset(ms: number): string {
  const minutes = -new Date(ms).getTimezoneOffset();
  return `${minutes < 0 ? "-" : "+"}${pad(Math.trunc(minutes / 60))}:${pad(minutes % 60)}`;
}

/** 带本地时区偏移的 ISO 8601，如 2026-09-28T10:25:09+08:00。 */
export function formatIso(ms: number): string {
  return `${formatDateTime(ms).replace(" ", "T")}${offset(ms)}`;
}

export function weekday(ms: number): string {
  return `星期${"日一二三四五六"[new Date(ms).getDay()]}`;
}

/** 相对现在的中文描述，如「3 小时前」「2 天后」。 */
export function relative(ms: number, now: number): string {
  const diff = ms - now;
  const seconds = Math.abs(diff) / 1000;
  if (seconds < 5) return "现在";
  const steps: [number, string][] = [[60, "秒"], [60, "分钟"], [24, "小时"], [30, "天"], [12, "个月"], [Infinity, "年"]];
  let value = seconds;
  for (const [size, unit] of steps) {
    if (value < size) return `${Math.floor(value)} ${unit}${diff < 0 ? "前" : "后"}`;
    value /= size;
  }
  return "";
}

/** 结果列表：顺序与 ⌘1～⌘5 对应。 */
export function rows(ms: number): Row[] {
  return [
    { label: "秒", value: String(Math.floor(ms / 1000)) },
    { label: "毫秒", value: String(ms) },
    { label: `本地时间（UTC${offset(ms)}）`, value: formatDateTime(ms) },
    { label: "UTC 时间", value: formatDateTime(ms, true) },
    { label: "ISO 8601", value: formatIso(ms) },
  ];
}
