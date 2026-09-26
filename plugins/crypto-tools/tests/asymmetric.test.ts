// 非对称算法：RSA、SM2、ECDSA 做“生成 → 加密/签名 → 解密/验签”往返及篡改检测；Ed25519 用 RFC 8032 向量。
import assert from "node:assert/strict";
import * as nodeCrypto from "node:crypto";
import test from "node:test";
import forge from "node-forge";
import { fromBase64, fromHex, toBase64, toHex, utf8Encode } from "../src/lib/bytes.ts";
import {
  ecdsaSign, ecdsaVerify, ed25519Sign, ed25519Verify, generateEcdsaKeyPair, generateEd25519KeyPair, generateRsaKeyPair, generateSm2KeyPair,
  normalizeSm2PublicKey, rsaDecrypt, rsaEncrypt, rsaSign, rsaVerify, sm2ConvertOrder, sm2Decrypt, sm2Encrypt, sm2Sign, sm2Verify,
  type EcCurve, type RsaPadding, type RsaSignScheme, type SigFormat,
} from "../src/lib/asymmetric.ts";

const message = utf8Encode("轻匣编码工具：签名与加密测试 ✓");
const tampered = utf8Encode("轻匣编码工具：签名与加密测试 ✗");

function flipSignature(signature: string, format: SigFormat) {
  const bytes = format.includes("base64") ? fromBase64(signature) : fromHex(signature);
  bytes[bytes.length - 1] ^= 1;
  return format.includes("base64") ? toBase64(bytes) : toHex(bytes);
}

test("RSA 2048：生成密钥对，三种填充加解密、三种签名方案往返，篡改后验签失败，并与 OpenSSL 互通", async () => {
  const pair = await generateRsaKeyPair(2048);
  assert.match(pair.privateKey, /^-----BEGIN PRIVATE KEY-----\n/);
  assert.match(pair.publicKey, /^-----BEGIN PUBLIC KEY-----\n/);
  for (const padding of ["pkcs1", "oaep-sha1", "oaep-sha256"] as RsaPadding[]) {
    const cipher = rsaEncrypt(pair.publicKey, message, padding);
    assert.equal(cipher.length, 256);
    assert.deepEqual(rsaDecrypt(pair.privateKey, cipher, padding), message);
  }
  assert.throws(() => rsaEncrypt(pair.publicKey, new Uint8Array(246), "pkcs1"), /最多加密 245 字节/);
  for (const scheme of ["sha1", "sha256", "pss-sha256"] as RsaSignScheme[]) {
    for (const format of ["base64", "hex"] as SigFormat[]) {
      const signature = rsaSign(pair.privateKey, message, scheme, format);
      assert.equal(rsaVerify(pair.publicKey, message, signature, scheme, format), true, `${scheme} 验签`);
      assert.equal(rsaVerify(pair.publicKey, tampered, signature, scheme, format), false, `${scheme} 篡改消息`);
      assert.equal(rsaVerify(pair.publicKey, message, flipSignature(signature, format), scheme, format), false, `${scheme} 篡改签名`);
    }
  }
  // 与 Node（OpenSSL）互通：SHA256withRSA、PSS、OAEP-SHA256
  const signature = Buffer.from(rsaSign(pair.privateKey, message, "sha256", "base64"), "base64");
  assert.equal(nodeCrypto.verify("sha256", message, pair.publicKey, signature), true);
  const pssSignature = Buffer.from(rsaSign(pair.privateKey, message, "pss-sha256", "base64"), "base64");
  assert.equal(nodeCrypto.verify("sha256", message, { key: pair.publicKey, padding: nodeCrypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, pssSignature), true);
  const nodeCipher = nodeCrypto.publicEncrypt({ key: pair.publicKey, padding: nodeCrypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, message);
  assert.deepEqual(rsaDecrypt(pair.privateKey, nodeCipher, "oaep-sha256"), message);
});

test("RSA 密钥写法：PKCS#1、PKCS#8、SPKI 的 PEM 与去掉头尾的 Base64", async () => {
  const { privateKey, publicKey } = nodeCrypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
  const pkcs1Private = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const pkcs8Private = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const spki = publicKey.export({ type: "spki", format: "pem" }).toString();
  const pkcs1Public = publicKey.export({ type: "pkcs1", format: "pem" }).toString();
  const bare = (pem: string) => pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const privates = [pkcs1Private, pkcs8Private, bare(pkcs1Private), bare(pkcs8Private)];
  const publics = [spki, pkcs1Public, bare(spki), bare(pkcs1Public)];
  for (const pub of publics) {
    const cipher = rsaEncrypt(pub, message, "pkcs1");
    for (const priv of privates) assert.deepEqual(rsaDecrypt(priv, cipher, "pkcs1"), message);
  }
  for (const priv of privates) assert.equal(rsaVerify(publics[2], message, rsaSign(priv, message, "sha1", "base64"), "sha1", "base64"), true);
  assert.throws(() => rsaEncrypt("abc", message, "pkcs1"), /Base64|DER|RSA/);
  assert.throws(() => rsaDecrypt(spki, new Uint8Array(128), "pkcs1"), /RSA 私钥/);
  const wrong = rsaEncrypt(spki, message, "pkcs1");
  assert.throws(() => rsaDecrypt(pkcs8Private, wrong, "oaep-sha256"), /解密失败/);
});

test("RSA 4096：分片生成且可取消", async () => {
  const controller = new AbortController();
  const pending = generateRsaKeyPair(4096, controller.signal);
  controller.abort();
  await assert.rejects(pending, /已取消/);
});

test("SM2：生成密钥对，两种密文顺序、带或不带 04 前缀加解密，顺序互转后解密", () => {
  const pair = generateSm2KeyPair();
  assert.match(pair.privateKey, /^[0-9a-f]{64}$/);
  assert.match(pair.publicKey, /^04[0-9a-f]{128}$/);
  const withoutPrefix = pair.publicKey.slice(2);
  for (const order of ["c1c3c2", "c1c2c3"] as const) {
    for (const prefix of [true, false]) {
      for (const key of [pair.publicKey, withoutPrefix]) {
        const cipher = sm2Encrypt(key, message, order, prefix);
        assert.equal(cipher.startsWith("04") || !prefix, true);
        assert.equal(cipher.length, (prefix ? 130 : 128) + 64 + message.length * 2);
        assert.deepEqual(sm2Decrypt(pair.privateKey, cipher, order), { data: message });
      }
    }
  }
  // C1C3C2 → C1C2C3 → C1C3C2
  const original = sm2Encrypt(pair.publicKey, message, "c1c3c2", true);
  const converted = sm2ConvertOrder(original, "c1c3c2", true);
  assert.notEqual(converted, original);
  assert.deepEqual(sm2Decrypt(pair.privateKey, converted, "c1c2c3"), { data: message });
  assert.equal(sm2ConvertOrder(converted, "c1c2c3", true), original);
  // 顺序选错时自动尝试另一种，并给出说明
  assert.match(sm2Decrypt(pair.privateKey, converted, "c1c3c2").note!, /C1C2C3/);
  // 篡改 C3 或用错私钥时解密失败
  const broken = original.slice(0, 140) + (original[140] === "0" ? "1" : "0") + original.slice(141);
  assert.throws(() => sm2Decrypt(pair.privateKey, broken, "c1c3c2"), /解密失败/);
  assert.throws(() => sm2Decrypt(generateSm2KeyPair().privateKey, original, "c1c3c2"), /解密失败/);
  assert.throws(() => normalizeSm2PublicKey("04" + "00".repeat(64)), /公钥无效/);
});

test("SM2：SM3 杂凑与用户 ID 签名验签（原始 r‖s、DER Hex、DER Base64），篡改或换 ID 后失败", () => {
  const pair = generateSm2KeyPair();
  for (const format of ["raw-hex", "der-hex", "der-base64"] as SigFormat[]) {
    for (const userId of ["1234567812345678", "alice@example.com"]) {
      const signature = sm2Sign(pair.privateKey, message, userId, format);
      if (format === "raw-hex") assert.match(signature, /^[0-9a-f]{128}$/);
      if (format === "der-hex") assert.match(signature, /^30/);
      assert.equal(sm2Verify(pair.publicKey, message, signature, userId, format), true);
      assert.equal(sm2Verify(pair.publicKey.slice(2), message, signature, userId, format), true, "不带 04 的公钥");
      assert.equal(sm2Verify(pair.publicKey, tampered, signature, userId, format), false);
      assert.equal(sm2Verify(pair.publicKey, message, flipSignature(signature, format), userId, format), false);
      assert.equal(sm2Verify(pair.publicKey, message, signature, userId + "x", format), false);
    }
  }
});

test("ECDSA P-256、secp256k1：生成、签名（原始 / DER）、验签、篡改失败，并与 OpenSSL 互通", () => {
  const spkiPrefix: Record<EcCurve, string> = {
    p256: "3059301306072a8648ce3d020106082a8648ce3d030107034200",
    secp256k1: "3056301006072a8648ce3d020106052b8104000a034200",
  };
  for (const curve of ["p256", "secp256k1"] as EcCurve[]) {
    const pair = generateEcdsaKeyPair(curve);
    assert.match(pair.publicKey, /^04[0-9a-f]{128}$/);
    for (const format of ["raw-hex", "der-hex", "der-base64"] as SigFormat[]) {
      const signature = ecdsaSign(curve, pair.privateKey, message, format);
      assert.equal(ecdsaVerify(curve, pair.publicKey, message, signature, format), true, `${curve} ${format}`);
      assert.equal(ecdsaVerify(curve, pair.publicKey.slice(2), message, signature, format), true);
      assert.equal(ecdsaVerify(curve, pair.publicKey, tampered, signature, format), false);
      assert.equal(ecdsaVerify(curve, pair.publicKey, message, flipSignature(signature, format), format), false);
    }
    const key = nodeCrypto.createPublicKey({ key: Buffer.from(spkiPrefix[curve] + pair.publicKey, "hex"), format: "der", type: "spki" });
    assert.equal(nodeCrypto.verify("sha256", message, key, Buffer.from(ecdsaSign(curve, pair.privateKey, message, "der-hex"), "hex")), true, `${curve} 与 OpenSSL 互通`);
  }
});

test("Ed25519：RFC 8032 第 7.1 节测试 1～3，及生成、签名、验签往返", () => {
  const vectors = [
    ["9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "", "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"],
    ["4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb", "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", "72", "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"],
    ["c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7", "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025", "af82", "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a"],
  ];
  for (const [secret, publicKey, data, signature] of vectors) {
    assert.equal(ed25519Sign(secret, fromHex(data), "hex"), signature);
    assert.equal(ed25519Verify(publicKey, fromHex(data), signature, "hex"), true);
    assert.equal(ed25519Verify(publicKey, fromHex(data + "00"), signature, "hex"), false);
  }
  const pair = generateEd25519KeyPair();
  const signature = ed25519Sign(pair.privateKey, message, "base64");
  assert.equal(ed25519Verify(pair.publicKey, message, signature, "base64"), true);
  assert.equal(ed25519Verify(pair.publicKey, tampered, signature, "base64"), false);
  assert.equal(ed25519Verify(pair.publicKey, message, flipSignature(signature, "base64"), "base64"), false);
});

test("forge 内部随机数已改为 getRandomValues", () => {
  const random = forge.random as unknown as { getBytesSync: (count: number) => string };
  assert.equal(random.getBytesSync(16).length, 16);
  assert.notEqual(random.getBytesSync(16), random.getBytesSync(16));
});
