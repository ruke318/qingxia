// 哈希与 HMAC：MD5、SHA-1、SHA-256、SHA-512 用 @noble/hashes，SM3 用 sm-crypto。
import { hmac } from "@noble/hashes/hmac.js";
import { md5, sha1 } from "@noble/hashes/legacy.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import type { CHash } from "@noble/hashes/utils.js";
import smCrypto from "sm-crypto";
import { fromHex, toHex } from "./bytes.ts";

export interface HashRow {
  id: string;
  label: string;
  value: string;
}

type Digest = (message: Uint8Array, key: Uint8Array | null) => Uint8Array;

const noble = (hash: CHash): Digest => (message, key) => key ? hmac(hash, key, message) : hash(message);

export const sm3 = (message: Uint8Array, key: Uint8Array | null = null): Uint8Array =>
  fromHex(key ? smCrypto.sm3(Array.from(message), { key: Array.from(key), mode: "hmac" }) : smCrypto.sm3(Array.from(message)));

const DIGESTS: { id: string; label: string; digest: Digest }[] = [
  { id: "md5", label: "MD5", digest: noble(md5) },
  { id: "sha1", label: "SHA-1", digest: noble(sha1) },
  { id: "sha256", label: "SHA-256", digest: noble(sha256) },
  { id: "sha512", label: "SHA-512", digest: noble(sha512) },
  { id: "sm3", label: "SM3", digest: sm3 },
];

/** 同时计算全部摘要；`key` 非空时计算 HMAC。 */
export function hashAll(message: Uint8Array, key: Uint8Array | null, upper: boolean): HashRow[] {
  const useKey = key && key.length ? key : null;
  return DIGESTS.map(({ id, label, digest }) => {
    const hex = toHex(digest(message, useKey));
    return { id, label: useKey ? `HMAC-${label}` : label, value: upper ? hex.toUpperCase() : hex };
  });
}
