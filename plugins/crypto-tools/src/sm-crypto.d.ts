// sm-crypto 0.5.x 没有自带类型，社区类型停留在 0.3；这里只声明本插件用到的部分。
declare module "sm-crypto" {
  type Bytes = string | ArrayLike<number>;
  interface Sm2 {
    generateKeyPairHex(a?: string, b?: number): { privateKey: string; publicKey: string };
    doEncrypt(msg: Bytes, publicKey: string, cipherMode?: 0 | 1): string;
    doDecrypt(encryptData: string, privateKey: string, cipherMode: 0 | 1, options: { output: "array" }): number[];
    doSignature(msg: Bytes, privateKey: string, options?: { der?: boolean; hash?: boolean; publicKey?: string; userId?: string }): string;
    doVerifySignature(msg: Bytes, signHex: string, publicKey: string, options?: { der?: boolean; hash?: boolean; userId?: string }): boolean;
    getPublicKeyFromPrivateKey(privateKey: string): string;
    verifyPublicKey(publicKey: string): boolean;
  }
  interface Sm4Options { padding?: "none" | "pkcs#7"; mode?: "cbc" | "ecb"; iv?: number[]; output: "array" }
  interface Sm4 {
    encrypt(input: number[], key: number[], options: Sm4Options): number[];
    decrypt(input: number[], key: number[], options: Sm4Options): number[];
  }
  const smCrypto: {
    sm2: Sm2;
    sm3(input: Bytes, options?: { key: Bytes; mode?: "hmac" }): string;
    sm4: Sm4;
  };
  export default smCrypto;
}
