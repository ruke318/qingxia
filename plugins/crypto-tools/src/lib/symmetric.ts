// 对称加密：AES 用 @noble/ciphers，DES / 3DES 用 node-forge，SM4 用 sm-crypto。
// 三个库都关闭自带填充，统一由本文件处理所选填充方式。
import { cbc, ecb, gcm } from "@noble/ciphers/aes.js";
import forge from "node-forge";
import smCrypto from "sm-crypto";
import { concatBytes, fromBinaryString, toBinaryString } from "./bytes.ts";

export type SymAlgorithm = "aes-128" | "aes-192" | "aes-256" | "des" | "3des" | "sm4";
export type SymMode = "cbc" | "ecb" | "gcm";
export type SymPadding = "pkcs5" | "pkcs7" | "zero" | "none";
export const SYM_PADDINGS: { value: SymPadding; label: string }[] = [
  { value: "pkcs5", label: "PKCS5" },
  { value: "pkcs7", label: "PKCS7" },
  { value: "zero", label: "ZeroPadding" },
  { value: "none", label: "NoPadding" },
];

export const SYM_ALGORITHMS: { id: SymAlgorithm; label: string; modes: SymMode[] }[] = [
  { id: "aes-128", label: "AES-128", modes: ["cbc", "ecb", "gcm"] },
  { id: "aes-192", label: "AES-192", modes: ["cbc", "ecb", "gcm"] },
  { id: "aes-256", label: "AES-256", modes: ["cbc", "ecb", "gcm"] },
  { id: "des", label: "DES", modes: ["cbc", "ecb"] },
  { id: "3des", label: "3DES", modes: ["cbc", "ecb"] },
  { id: "sm4", label: "SM4", modes: ["cbc", "ecb"] },
];

const KEY_SIZES: Record<SymAlgorithm, number[]> = { "aes-128": [16], "aes-192": [24], "aes-256": [32], des: [8], "3des": [24, 16], sm4: [16] };
const BLOCK_SIZES: Record<SymAlgorithm, number> = { "aes-128": 16, "aes-192": 16, "aes-256": 16, des: 8, "3des": 8, sm4: 16 };

export const algorithmLabel = (algorithm: SymAlgorithm) => SYM_ALGORITHMS.find((item) => item.id === algorithm)!.label;

export function pkcs7Pad(data: Uint8Array, blockSize: number): Uint8Array {
  const count = blockSize - (data.length % blockSize);
  return concatBytes(data, new Uint8Array(count).fill(count));
}

export function pkcs7Unpad(data: Uint8Array, blockSize: number, label = "PKCS7"): Uint8Array {
  const count = data[data.length - 1];
  const valid = data.length > 0 && count >= 1 && count <= blockSize && data.subarray(data.length - count).every((byte) => byte === count);
  if (!valid) throw new Error(`解密失败：${label} 填充校验未通过，请检查密钥、IV、模式与密文`);
  return data.slice(0, data.length - count);
}

/** 检查密钥与 IV 长度，返回中文提示；通过时返回 null。 */
export function checkSizes(algorithm: SymAlgorithm, mode: SymMode, keyLength: number, ivLength: number): string | null {
  const sizes = KEY_SIZES[algorithm];
  if (!sizes.includes(keyLength)) {
    const expected = sizes.length > 1 ? `${sizes[0]} 字节（或 ${sizes[1]} 字节的双倍长密钥）` : `${sizes[0]} 字节`;
    return `${algorithmLabel(algorithm)} 的密钥需要 ${expected}，当前为 ${keyLength} 字节`;
  }
  if (mode === "cbc" && ivLength !== BLOCK_SIZES[algorithm]) return `CBC 模式的 IV 需要 ${BLOCK_SIZES[algorithm]} 字节，当前为 ${ivLength} 字节`;
  if (mode === "gcm" && ivLength < 8) return `GCM 模式的 IV 至少需要 8 字节（推荐 12 字节），当前为 ${ivLength} 字节`;
  return null;
}

function forgeDes(algorithm: "des" | "3des", mode: "cbc" | "ecb", key: Uint8Array, iv: Uint8Array, data: Uint8Array, encrypt: boolean): Uint8Array {
  // 16 字节的双倍长密钥按 K1‖K2‖K1 展开
  const fullKey = algorithm === "3des" && key.length === 16 ? concatBytes(key, key.subarray(0, 8)) : key;
  const name = `${algorithm === "des" ? "DES" : "3DES"}-${mode.toUpperCase()}` as forge.cipher.Algorithm;
  const cipher = encrypt ? forge.cipher.createCipher(name, toBinaryString(fullKey)) : forge.cipher.createDecipher(name, toBinaryString(fullKey));
  cipher.start(mode === "cbc" ? { iv: toBinaryString(iv) } : {});
  cipher.update(forge.util.createBuffer(toBinaryString(data)));
  // 传入自定义填充函数即关闭 forge 自带填充
  (cipher.finish as (pad: () => boolean) => boolean)(() => true);
  return fromBinaryString(cipher.output.getBytes());
}

function sm4(mode: "cbc" | "ecb", key: Uint8Array, iv: Uint8Array, data: Uint8Array, encrypt: boolean): Uint8Array {
  const options = { padding: "none" as const, output: "array" as const, ...(mode === "cbc" ? { mode: "cbc" as const, iv: Array.from(iv) } : {}) };
  const run = encrypt ? smCrypto.sm4.encrypt : smCrypto.sm4.decrypt;
  return Uint8Array.from(run(Array.from(data), Array.from(key), options));
}

function blockCipher(algorithm: SymAlgorithm, mode: "cbc" | "ecb", key: Uint8Array, iv: Uint8Array, data: Uint8Array, encrypt: boolean): Uint8Array {
  if (algorithm === "des" || algorithm === "3des") return forgeDes(algorithm, mode, key, iv, data, encrypt);
  if (algorithm === "sm4") return sm4(mode, key, iv, data, encrypt);
  const cipher = mode === "cbc" ? cbc(key, iv, { disablePadding: true }) : ecb(key, { disablePadding: true });
  return encrypt ? cipher.encrypt(data) : cipher.decrypt(data);
}

export interface SymmetricRequest {
  algorithm: SymAlgorithm;
  mode: SymMode;
  padding?: SymPadding;
  encrypt: boolean;
  key: Uint8Array;
  iv: Uint8Array;
  data: Uint8Array;
}

/** 加密或解密；GCM 的密文为“密文‖16 字节认证标签”，与 Java 的 AES/GCM/NoPadding 一致。 */
export function symmetricCrypt({ algorithm, mode, padding = "pkcs7", encrypt, key, iv, data }: SymmetricRequest): Uint8Array {
  const sizeError = checkSizes(algorithm, mode, key.length, iv.length);
  if (sizeError) throw new Error(sizeError);
  if (mode === "gcm") {
    if (!algorithm.startsWith("aes")) throw new Error("只有 AES 支持 GCM 模式");
    if (encrypt) return gcm(key, iv).encrypt(data);
    if (data.length < 16) throw new Error("GCM 密文至少包含 16 字节认证标签");
    try { return gcm(key, iv).decrypt(data); }
    catch { throw new Error("解密失败：GCM 认证标签校验未通过，请检查密钥、IV 与密文"); }
  }
  const block = BLOCK_SIZES[algorithm];
  // PKCS5 按所选算法的分组大小处理，兼容 Java 的 PKCS5Padding 命名。
  const pkcsPadding = padding === "pkcs5" || padding === "pkcs7";
  if (encrypt) {
    if (pkcsPadding) data = pkcs7Pad(data, block);
    else if (padding === "zero") data = concatBytes(data, new Uint8Array((block - data.length % block) % block));
    else if (data.length % block) throw new Error(`NoPadding 的明文长度需要是 ${block} 字节的整数倍，当前为 ${data.length} 字节`);
    return blockCipher(algorithm, mode, key, iv, data, true);
  }
  if ((data.length === 0 && pkcsPadding) || data.length % block) throw new Error(`密文长度需要是 ${block} 字节的整数倍，当前为 ${data.length} 字节`);
  const plain = blockCipher(algorithm, mode, key, iv, data, false);
  if (pkcsPadding) return pkcs7Unpad(plain, block, padding.toUpperCase());
  if (padding === "zero") {
    let end = plain.length;
    while (end > 0 && plain[end - 1] === 0) end--;
    return plain.slice(0, end);
  }
  return plain;
}
