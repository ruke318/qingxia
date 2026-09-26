// 编码 / 解码：文本一律按 UTF-8 处理。每种格式单独给出结果或失败原因。
import { errorMessage, fromBase64, fromHex, toBase64, toHex, utf8Decode, utf8Encode } from "./bytes.ts";

export interface CodecRow {
  id: string;
  label: string;
  value?: string;
  error?: string;
}

interface Codec {
  id: string;
  label: string;
  encode: (text: string) => string;
  decode: (text: string) => string;
}

function uriError(error: unknown, action: "编码" | "解码"): Error {
  if (error instanceof URIError) return new Error(action === "编码" ? "包含无法编码的孤立代理字符" : "包含无效的百分号编码或非 UTF-8 字节");
  return error instanceof Error ? error : new Error(String(error));
}

function decodeBytes(bytes: Uint8Array): string {
  try { return utf8Decode(bytes); }
  catch { throw new Error("解码结果不是有效的 UTF-8 文本"); }
}

export function unicodeEscape(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) out += "\\u" + text.charCodeAt(i).toString(16).padStart(4, "0");
  return out;
}

export function unicodeUnescape(text: string): string {
  const pattern = /\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})/g;
  if (!pattern.test(text)) throw new Error("没有找到 \\uXXXX 形式的转义");
  pattern.lastIndex = 0;
  return text.replace(pattern, (_, long: string | undefined, short: string | undefined) => {
    const code = parseInt(long ?? short!, 16);
    if (code > 0x10ffff) throw new Error(`码点 \\u{${long}} 超出 Unicode 范围`);
    return long ? String.fromCodePoint(code) : String.fromCharCode(code);
  });
}

export const CODECS: Codec[] = [
  { id: "base64", label: "Base64", encode: (text) => toBase64(utf8Encode(text)), decode: (text) => decodeBytes(fromBase64(text, "standard")) },
  { id: "base64url", label: "Base64 URL 安全", encode: (text) => toBase64(utf8Encode(text), true), decode: (text) => decodeBytes(fromBase64(text, "url")) },
  {
    id: "component", label: "encodeURIComponent",
    encode: (text) => { try { return encodeURIComponent(text); } catch (error) { throw uriError(error, "编码"); } },
    decode: (text) => { try { return decodeURIComponent(text); } catch (error) { throw uriError(error, "解码"); } },
  },
  {
    id: "uri", label: "encodeURI",
    encode: (text) => { try { return encodeURI(text); } catch (error) { throw uriError(error, "编码"); } },
    decode: (text) => { try { return decodeURI(text); } catch (error) { throw uriError(error, "解码"); } },
  },
  { id: "unicode", label: "Unicode 转义", encode: unicodeEscape, decode: unicodeUnescape },
  { id: "hex", label: "Hex", encode: (text) => toHex(utf8Encode(text)), decode: (text) => decodeBytes(fromHex(text)) },
];

/** 编码：同时列出全部格式的结果。 */
export function encodeAll(text: string): CodecRow[] {
  return CODECS.map(({ id, label, encode }) => {
    try { return { id, label, value: encode(text) }; }
    catch (error) { return { id, label, error: errorMessage(error) }; }
  });
}

/** 解码：逐个格式尝试，解不出或与原文相同的给出原因。 */
export function decodeAll(text: string): CodecRow[] {
  return CODECS.map(({ id, label, decode }) => {
    try {
      const value = decode(text);
      return value === text ? { id, label, error: "没有需要解码的内容" } : { id, label, value };
    } catch (error) {
      return { id, label, error: errorMessage(error) };
    }
  });
}
