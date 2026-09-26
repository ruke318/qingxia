// 非对称算法：RSA 与 PEM 解析用 node-forge，SM2 用 sm-crypto，ECDSA、Ed25519 用 @noble/curves。
// 不依赖 WebCrypto（crypto.subtle）；所有随机数都来自 crypto.getRandomValues，不可用时报错。
import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import forge from "node-forge";
import smCrypto from "sm-crypto";
import { fromBase64, fromBinaryString, fromHex, toBase64, toBinaryString, toHex } from "./bytes.ts";
import { randomBytes, requireSecureRandom } from "./random.ts";

export interface KeyPair { publicKey: string; privateKey: string }

// 让 forge 内部（PKCS#1 v1.5 填充、OAEP 种子、私钥运算盲化）也只用 getRandomValues
const forgeRandom = forge.random as unknown as {
  getBytesSync: (count: number) => string;
  getBytes: (count: number, callback?: (error: Error | null, bytes?: string) => void) => string | void;
};
const secureBinary = (count: number) => toBinaryString(randomBytes(count));
forgeRandom.getBytesSync = secureBinary;
forgeRandom.getBytes = (count, callback) => {
  if (!callback) return secureBinary(count);
  try { callback(null, secureBinary(count)); } catch (error) { callback(error as Error); }
};
const forgePrng = { getBytesSync: secureBinary };

const cleanHex = (value: string) => value.replace(/\s/g, "").replace(/^0x/i, "").toLowerCase();

/* ---------------- 签名编码 ---------------- */

export type SigFormat = "raw-hex" | "der-hex" | "der-base64" | "hex" | "base64";

export const SIG_FORMAT_LABELS: Record<SigFormat, string> = {
  "raw-hex": "原始 r‖s（Hex）",
  "der-hex": "DER（Hex）",
  "der-base64": "DER（Base64）",
  hex: "Hex",
  base64: "Base64",
};

function encodeSignature(bytes: Uint8Array, format: SigFormat): string {
  return format === "base64" || format === "der-base64" ? toBase64(bytes) : toHex(bytes);
}

function decodeSignature(text: string, format: SigFormat): Uint8Array {
  if (!text.trim()) throw new Error("请填写签名");
  try {
    return format === "base64" || format === "der-base64" ? fromBase64(text) : fromHex(text);
  } catch (error) {
    throw new Error(`签名格式不正确：${(error as Error).message}`);
  }
}

/* ---------------- RSA ---------------- */

export type RsaPadding = "pkcs1" | "oaep-sha1" | "oaep-sha256";
export type RsaSignScheme = "sha1" | "sha256" | "pss-sha256";

function keyDer(text: string): string {
  const value = text.trim();
  if (!value) throw new Error("请填写密钥");
  if (value.includes("-----BEGIN")) {
    if (/ENCRYPTED PRIVATE KEY|Proc-Type: 4,ENCRYPTED/.test(value)) throw new Error("暂不支持带口令加密的私钥，请先解密");
    try { return forge.pem.decode(value)[0].body; }
    catch { throw new Error("PEM 格式不正确"); }
  }
  try { return toBinaryString(fromBase64(value)); }
  catch { throw new Error("密钥既不是 PEM，也不是有效的 Base64"); }
}

function asn1Of(text: string) {
  const der = keyDer(text);
  try { return forge.asn1.fromDer(der); }
  catch { throw new Error("密钥内容不是有效的 DER 编码"); }
}

/** 解析 RSA 私钥：PKCS#1、PKCS#8 的 PEM，或去掉头尾的 Base64。 */
export function parseRsaPrivateKey(text: string): forge.pki.rsa.PrivateKey {
  const asn1 = asn1Of(text);
  try { return forge.pki.privateKeyFromAsn1(asn1) as forge.pki.rsa.PrivateKey; }
  catch { throw new Error("不是有效的 RSA 私钥（支持 PKCS#1、PKCS#8 的 PEM 或 Base64）"); }
}

/** 解析 RSA 公钥：SPKI、PKCS#1 的 PEM，或去掉头尾的 Base64。 */
export function parseRsaPublicKey(text: string): forge.pki.rsa.PublicKey {
  const asn1 = asn1Of(text);
  try { return forge.pki.publicKeyFromAsn1(asn1) as forge.pki.rsa.PublicKey; }
  catch { throw new Error("不是有效的 RSA 公钥（支持 SPKI、PKCS#1 的 PEM 或 Base64）"); }
}

const pemText = (pem: string) => pem.replace(/\r\n/g, "\n").trim();

// @types/node-forge 未声明分步生成接口
interface KeyGenerationState { keys: forge.pki.rsa.KeyPair }
const rsaSteps = forge.pki.rsa as unknown as {
  createKeyPairGenerationState(bits: number, e: number, options: { prng: typeof forgePrng }): KeyGenerationState;
  stepKeyPairGenerationState(state: KeyGenerationState, milliseconds: number): boolean;
};

/** 分片生成 RSA 密钥对，每片最多占用主线程约 20 毫秒；私钥为 PKCS#8，公钥为 SPKI。 */
export function generateRsaKeyPair(bits: 2048 | 4096, signal?: AbortSignal): Promise<KeyPair> {
  requireSecureRandom();
  const state = rsaSteps.createKeyPairGenerationState(bits, 0x10001, { prng: forgePrng });
  return new Promise((resolve, reject) => {
    const step = () => {
      if (signal?.aborted) { reject(new Error("已取消生成")); return; }
      try {
        if (!rsaSteps.stepKeyPairGenerationState(state, 20)) { setTimeout(step, 0); return; }
        const { privateKey, publicKey } = state.keys;
        resolve({
          privateKey: pemText(forge.pki.privateKeyInfoToPem(forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(privateKey)))),
          publicKey: pemText(forge.pki.publicKeyToPem(publicKey)),
        });
      } catch (error) { reject(error); }
    };
    setTimeout(step, 0);
  });
}

const RSA_HASH = { "oaep-sha1": () => forge.md.sha1.create(), "oaep-sha256": () => forge.md.sha256.create() };
const byteLength = (key: { n: forge.jsbn.BigInteger }) => Math.ceil(key.n.bitLength() / 8);

export function rsaEncrypt(publicKeyText: string, data: Uint8Array, padding: RsaPadding): Uint8Array {
  requireSecureRandom();
  const key = parseRsaPublicKey(publicKeyText);
  const size = byteLength(key);
  const max = padding === "pkcs1" ? size - 11 : size - 2 * (padding === "oaep-sha1" ? 20 : 32) - 2;
  if (data.length > max) throw new Error(`明文过长：当前密钥与填充方式最多加密 ${max} 字节，当前为 ${data.length} 字节`);
  const encrypted = padding === "pkcs1"
    ? key.encrypt(toBinaryString(data), "RSAES-PKCS1-V1_5")
    : key.encrypt(toBinaryString(data), "RSA-OAEP", { md: RSA_HASH[padding](), mgf1: { md: RSA_HASH[padding]() } });
  return fromBinaryString(encrypted);
}

export function rsaDecrypt(privateKeyText: string, data: Uint8Array, padding: RsaPadding): Uint8Array {
  requireSecureRandom();
  const key = parseRsaPrivateKey(privateKeyText);
  const size = byteLength(key);
  if (data.length !== size) throw new Error(`密文长度需要是 ${size} 字节（${key.n.bitLength()} 位密钥），当前为 ${data.length} 字节`);
  try {
    const decrypted = padding === "pkcs1"
      ? key.decrypt(toBinaryString(data), "RSAES-PKCS1-V1_5")
      : key.decrypt(toBinaryString(data), "RSA-OAEP", { md: RSA_HASH[padding](), mgf1: { md: RSA_HASH[padding]() } });
    return fromBinaryString(decrypted);
  } catch {
    throw new Error("解密失败：填充校验未通过，请检查私钥与填充方式");
  }
}

function rsaDigest(scheme: RsaSignScheme, data: Uint8Array) {
  const md = scheme === "sha1" ? forge.md.sha1.create() : forge.md.sha256.create();
  md.update(toBinaryString(data));
  return md;
}

// PSS：SHA-256 摘要，MGF1 同为 SHA-256，盐长 32 字节（与 Java SHA256withRSA/PSS 默认参数一致）
const pss = () => forge.pss.create({ md: forge.md.sha256.create(), mgf: forge.mgf.mgf1.create(forge.md.sha256.create()), saltLength: 32, prng: forgePrng } as never);

export function rsaSign(privateKeyText: string, data: Uint8Array, scheme: RsaSignScheme, format: SigFormat): string {
  requireSecureRandom();
  const key = parseRsaPrivateKey(privateKeyText);
  const md = rsaDigest(scheme, data);
  const signature = scheme === "pss-sha256" ? key.sign(md, pss()) : key.sign(md);
  return encodeSignature(fromBinaryString(signature), format);
}

export function rsaVerify(publicKeyText: string, data: Uint8Array, signatureText: string, scheme: RsaSignScheme, format: SigFormat): boolean {
  const key = parseRsaPublicKey(publicKeyText);
  const signature = decodeSignature(signatureText, format);
  if (signature.length !== byteLength(key)) return false;
  const digest = rsaDigest(scheme, data).digest().bytes();
  try {
    return scheme === "pss-sha256" ? key.verify(digest, toBinaryString(signature), pss()) : key.verify(digest, toBinaryString(signature));
  } catch {
    return false;
  }
}

/* ---------------- SM2 ---------------- */

export type Sm2Order = "c1c3c2" | "c1c2c3";
const SM2_N = BigInt("0xFFFFFFFEFFFFFFFFFFFFFFFFFFFFFFFF7203DF6B21C6052B53BBF40939D54123");
export const DEFAULT_SM2_USER_ID = "1234567812345678";
const cipherMode = (order: Sm2Order) => order === "c1c3c2" ? 1 : 0;

export function generateSm2KeyPair(): KeyPair {
  // 私钥随机数由 getRandomValues 直接提供（多取 8 字节，取模偏差可忽略）
  const { privateKey, publicKey } = smCrypto.sm2.generateKeyPairHex(toHex(randomBytes(40)), 16);
  return { privateKey, publicKey };
}

/** 规范化 SM2 公钥：接受带 04、不带 04 的非压缩形式，以及 02/03 压缩形式。 */
export function normalizeSm2PublicKey(text: string): string {
  let hex = cleanHex(text);
  if (!hex) throw new Error("请填写公钥");
  if (hex.length === 128) hex = "04" + hex;
  if (!/^[0-9a-f]+$/.test(hex) || !smCrypto.sm2.verifyPublicKey(hex)) throw new Error("SM2 公钥无效：需要 04 开头的 130 位 Hex、不带 04 的 128 位 Hex，或 02/03 开头的压缩公钥");
  return hex;
}

export function normalizeSm2PrivateKey(text: string): string {
  let hex = cleanHex(text);
  if (!hex) throw new Error("请填写私钥");
  if (hex.length === 66 && hex.startsWith("00")) hex = hex.slice(2);
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("SM2 私钥需要 64 位 Hex（32 字节）");
  const d = BigInt("0x" + hex);
  if (d <= 0n || d >= SM2_N - 1n) throw new Error("SM2 私钥超出有效范围");
  return hex;
}

/** SM2 加密，返回 Hex 密文；`prefix04` 为真时在 C1 前加 04（BouncyCastle 的格式）。 */
export function sm2Encrypt(publicKeyText: string, data: Uint8Array, order: Sm2Order, prefix04: boolean): string {
  requireSecureRandom();
  const cipher = smCrypto.sm2.doEncrypt(Array.from(data), normalizeSm2PublicKey(publicKeyText), cipherMode(order));
  return (prefix04 ? "04" : "") + cipher;
}

/** SM2 解密：密文带不带 04 前缀都可以；所选顺序解不开时再试另一种顺序，并在 note 中说明。 */
export function sm2Decrypt(privateKeyText: string, cipherHex: string, order: Sm2Order): { data: Uint8Array; note?: string } {
  const privateKey = normalizeSm2PrivateKey(privateKeyText);
  const hex = cleanHex(cipherHex);
  if (hex.length < 192) throw new Error("密文过短：至少需要 C1（64 字节）与 C3（32 字节）");
  const candidates = hex.startsWith("04") ? [hex.slice(2), hex] : [hex];
  const attempt = (mode: Sm2Order) => {
    for (const candidate of candidates) {
      if (candidate.length < 192) continue;
      const result = smCrypto.sm2.doDecrypt(candidate, privateKey, cipherMode(mode), { output: "array" });
      if (result.length) return Uint8Array.from(result);
    }
    return null;
  };
  const data = attempt(order);
  if (data) return { data };
  const other: Sm2Order = order === "c1c3c2" ? "c1c2c3" : "c1c3c2";
  const fallback = attempt(other);
  if (fallback) return { data: fallback, note: `已按 ${other.toUpperCase()} 顺序解密（与所选顺序不同）` };
  throw new Error("解密失败：C3 校验未通过，请检查私钥与密文");
}

/** 在 C1C3C2 与 C1C2C3 之间转换 Hex 密文；`prefix04` 指明密文 C1 是否带 04。 */
export function sm2ConvertOrder(cipherHex: string, from: Sm2Order, prefix04: boolean): string {
  const hex = cleanHex(cipherHex);
  const c1Length = prefix04 ? 130 : 128;
  const c1 = hex.slice(0, c1Length);
  const rest = hex.slice(c1Length);
  if (rest.length < 64) throw new Error("密文过短");
  return from === "c1c3c2" ? c1 + rest.slice(64) + rest.slice(0, 64) : c1 + rest.slice(-64) + rest.slice(0, -64);
}

export function sm2Sign(privateKeyText: string, data: Uint8Array, userId: string, format: SigFormat): string {
  requireSecureRandom();
  const der = format !== "raw-hex";
  const signature = fromHex(smCrypto.sm2.doSignature(Array.from(data), normalizeSm2PrivateKey(privateKeyText), { hash: true, der, userId }));
  return encodeSignature(signature, format);
}

export function sm2Verify(publicKeyText: string, data: Uint8Array, signatureText: string, userId: string, format: SigFormat): boolean {
  const publicKey = normalizeSm2PublicKey(publicKeyText);
  const signature = decodeSignature(signatureText, format);
  if (format === "raw-hex" && signature.length !== 64) throw new Error(`原始签名需要 64 字节（r‖s 共 128 位 Hex），当前为 ${signature.length} 字节`);
  return smCrypto.sm2.doVerifySignature(Array.from(data), toHex(signature), publicKey, { hash: true, der: format !== "raw-hex", userId });
}

/* ---------------- ECDSA ---------------- */

export type EcCurve = "p256" | "secp256k1";
const CURVES = { p256, secp256k1 };
export const CURVE_LABELS: Record<EcCurve, string> = { p256: "P-256", secp256k1: "secp256k1" };

export function generateEcdsaKeyPair(curve: EcCurve): KeyPair {
  requireSecureRandom();
  const { secretKey } = CURVES[curve].keygen();
  return { privateKey: toHex(secretKey), publicKey: toHex(CURVES[curve].getPublicKey(secretKey, false)) };
}

function ecPrivateKey(curve: EcCurve, text: string): Uint8Array {
  let hex = cleanHex(text);
  if (!hex) throw new Error("请填写私钥");
  if (hex.length === 66 && hex.startsWith("00")) hex = hex.slice(2);
  if (!/^[0-9a-f]{64}$/.test(hex) || !CURVES[curve].utils.isValidSecretKey(fromHex(hex))) throw new Error(`${CURVE_LABELS[curve]} 私钥需要 64 位 Hex（32 字节）且在曲线阶范围内`);
  return fromHex(hex);
}

function ecPublicKey(curve: EcCurve, text: string): Uint8Array {
  let hex = cleanHex(text);
  if (!hex) throw new Error("请填写公钥");
  if (hex.length === 128) hex = "04" + hex;
  try {
    CURVES[curve].Point.fromHex(hex);
    return fromHex(hex);
  } catch {
    throw new Error(`${CURVE_LABELS[curve]} 公钥无效：需要 04 开头（或不带 04）的非压缩 Hex，或 02/03 开头的压缩 Hex`);
  }
}

/** ECDSA 签名：先对消息做 SHA-256，再按 RFC 6979 确定性签名。 */
export function ecdsaSign(curve: EcCurve, privateKeyText: string, data: Uint8Array, format: SigFormat): string {
  const signature = CURVES[curve].sign(data, ecPrivateKey(curve, privateKeyText), { format: format === "raw-hex" ? "compact" : "der" });
  return encodeSignature(signature, format);
}

export function ecdsaVerify(curve: EcCurve, publicKeyText: string, data: Uint8Array, signatureText: string, format: SigFormat): boolean {
  const publicKey = ecPublicKey(curve, publicKeyText);
  const signature = decodeSignature(signatureText, format);
  if (format === "raw-hex" && signature.length !== 64) throw new Error(`原始签名需要 64 字节（r‖s 共 128 位 Hex），当前为 ${signature.length} 字节`);
  try {
    // 不强制 low-S，以便验证 OpenSSL、Java 等未做规范化的签名
    return CURVES[curve].verify(signature, data, publicKey, { format: format === "raw-hex" ? "compact" : "der", lowS: false });
  } catch {
    return false;
  }
}

/* ---------------- Ed25519 ---------------- */

export function generateEd25519KeyPair(): KeyPair {
  requireSecureRandom();
  const { secretKey, publicKey } = ed25519.keygen();
  return { privateKey: toHex(secretKey), publicKey: toHex(publicKey) };
}

function edPrivateKey(text: string): Uint8Array {
  const hex = cleanHex(text);
  if (!hex) throw new Error("请填写私钥");
  // 也接受 64 字节的“种子‖公钥”写法（libsodium、Go），只取前 32 字节种子
  if (!/^[0-9a-f]{64}$|^[0-9a-f]{128}$/.test(hex)) throw new Error("Ed25519 私钥需要 64 位 Hex（32 字节种子）");
  return fromHex(hex.slice(0, 64));
}

function edPublicKey(text: string): Uint8Array {
  const hex = cleanHex(text);
  if (!hex) throw new Error("请填写公钥");
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("Ed25519 公钥需要 64 位 Hex（32 字节）");
  return fromHex(hex);
}

export function ed25519Sign(privateKeyText: string, data: Uint8Array, format: SigFormat): string {
  return encodeSignature(ed25519.sign(data, edPrivateKey(privateKeyText)), format);
}

export function ed25519Verify(publicKeyText: string, data: Uint8Array, signatureText: string, format: SigFormat): boolean {
  const publicKey = edPublicKey(publicKeyText);
  const signature = decodeSignature(signatureText, format);
  if (signature.length !== 64) throw new Error(`Ed25519 签名需要 64 字节，当前为 ${signature.length} 字节`);
  try { return ed25519.verify(signature, data, publicKey); }
  catch { return false; }
}
