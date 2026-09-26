// 安全随机数：只使用 crypto.getRandomValues；不可用时明确报错，绝不退回 Math.random。

export const RANDOM_UNAVAILABLE = "当前环境不支持安全随机数（crypto.getRandomValues），无法生成密钥、加密或签名";

export function secureRandomAvailable(): boolean {
  return typeof globalThis.crypto?.getRandomValues === "function";
}

/** 在需要随机数的操作前调用；不可用时抛出中文错误。 */
export function requireSecureRandom(): void {
  if (!secureRandomAvailable()) throw new Error(RANDOM_UNAVAILABLE);
}

export function randomBytes(length: number): Uint8Array {
  requireSecureRandom();
  const out = new Uint8Array(length);
  // getRandomValues 单次最多 65536 字节
  for (let offset = 0; offset < length; offset += 65536) globalThis.crypto.getRandomValues(out.subarray(offset, offset + 65536));
  return out;
}
