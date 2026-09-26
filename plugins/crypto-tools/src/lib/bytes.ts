// 字节与文本、Hex、Base64 之间的转换；错误信息均为可直接展示的中文。

export type ByteFormat = "text" | "hex" | "base64";

export const FORMAT_LABELS: Record<ByteFormat, string> = { text: "文本", hex: "Hex", base64: "Base64" };

const encoder = new TextEncoder();

export function utf8Encode(text: string): Uint8Array {
  return encoder.encode(text);
}

/** 严格按 UTF-8 解码，遇到非法字节序列时抛出错误。 */
export function utf8Decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("结果不是有效的 UTF-8 文本");
  }
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** 解析 Hex：忽略空白、冒号和开头的 0x，大小写均可。 */
export function fromHex(input: string): Uint8Array {
  let hex = input.replace(/[\s:]/g, "");
  if (/^0x/i.test(hex)) hex = hex.slice(2);
  if (/[^0-9a-f]/i.test(hex)) throw new Error("Hex 只能包含 0～9、a～f");
  if (hex.length % 2) throw new Error("Hex 长度必须是偶数");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const STANDARD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const URL_SAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function toBase64(bytes: Uint8Array, urlSafe = false): string {
  const table = urlSafe ? URL_SAFE : STANDARD;
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out += table[a >> 2] + table[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? (urlSafe ? "" : "=") : table[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? (urlSafe ? "" : "=") : table[c & 63];
  }
  return out;
}

/**
 * 解析 Base64：忽略空白，末尾的 = 可省略。
 * `alphabet` 为 standard 时只接受 +/，url 时只接受 -_，any 时两者皆可。
 */
export function fromBase64(input: string, alphabet: "standard" | "url" | "any" = "any"): Uint8Array {
  const text = input.replace(/\s/g, "");
  const body = text.replace(/=+$/, "");
  const allowed = alphabet === "standard" ? /^[A-Za-z0-9+/]*$/ : alphabet === "url" ? /^[A-Za-z0-9\-_]*$/ : /^[A-Za-z0-9+/\-_]*$/;
  if (!allowed.test(body)) {
    if (body.includes("=")) throw new Error("Base64 的 = 填充只能出现在末尾");
    if (alphabet === "standard" && /[-_]/.test(body)) throw new Error("包含 URL 安全字符 - 或 _，不是标准 Base64");
    if (alphabet === "url" && /[+/]/.test(body)) throw new Error("包含 + 或 /，不是 URL 安全 Base64");
    throw new Error("包含 Base64 以外的字符");
  }
  if (body.length % 4 === 1) throw new Error("Base64 长度不正确");
  const padding = text.length - body.length;
  if (padding > 2 || (padding > 0 && text.length % 4 !== 0)) throw new Error("Base64 末尾的 = 填充不正确");
  const out = new Uint8Array(Math.floor((body.length * 3) / 4));
  let buffer = 0, bits = 0, index = 0;
  for (const char of body) {
    const value = char === "-" ? 62 : char === "_" ? 63 : STANDARD.indexOf(char);
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (buffer >> bits) & 0xff;
    }
  }
  return out;
}

/** 按指定格式把输入框内容解析为字节；`label` 用于错误提示，例如“密钥”。 */
export function parseBytes(value: string, format: ByteFormat, label: string): Uint8Array {
  if (format === "text") return utf8Encode(value);
  try {
    return format === "hex" ? fromHex(value) : fromBase64(value);
  } catch (error) {
    throw new Error(`${label}不是有效的 ${FORMAT_LABELS[format]}：${(error as Error).message}`);
  }
}

/** 把字节按指定格式输出；文本格式遇到非 UTF-8 内容时提示改用 Hex 或 Base64。 */
export function formatBytes(bytes: Uint8Array, format: ByteFormat): string {
  if (format === "hex") return toHex(bytes);
  if (format === "base64") return toBase64(bytes);
  try {
    return utf8Decode(bytes);
  } catch {
    throw new Error("结果不是有效的 UTF-8 文本，请改用 Hex 或 Base64 输出");
  }
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

/** 把 JS 二进制字符串（node-forge 使用）转为字节。 */
export function fromBinaryString(binary: string): Uint8Array {
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function toBinaryString(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
}

export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
