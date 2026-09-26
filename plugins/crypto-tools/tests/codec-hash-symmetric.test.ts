// 编码、哈希、对称加密的标准测试向量（RFC 4648、RFC 1321、FIPS 180、GB/T 32905、RFC 4231、NIST SP 800-38A/38D、GB/T 32907）。
import assert from "node:assert/strict";
import * as nodeCrypto from "node:crypto";
import test from "node:test";
import { fromBase64, fromHex, toBase64, toHex, utf8Encode } from "../src/lib/bytes.ts";
import { decodeAll, encodeAll, unicodeEscape, unicodeUnescape } from "../src/lib/encode.ts";
import { hashAll } from "../src/lib/hash.ts";
import { symmetricCrypt, type SymAlgorithm, type SymMode } from "../src/lib/symmetric.ts";

const text = (value: string) => utf8Encode(value);
const hashes = (message: Uint8Array, key: Uint8Array | null = null) => Object.fromEntries(hashAll(message, key, false).map((row) => [row.id, row.value]));

test("Base64 与 Base16：RFC 4648 第 10 节测试向量", () => {
  const vectors: [string, string, string][] = [
    ["", "", ""], ["f", "Zg==", "66"], ["fo", "Zm8=", "666F"], ["foo", "Zm9v", "666F6F"],
    ["foob", "Zm9vYg==", "666F6F62"], ["fooba", "Zm9vYmE=", "666F6F6261"], ["foobar", "Zm9vYmFy", "666F6F626172"],
  ];
  for (const [plain, base64, base16] of vectors) {
    assert.equal(toBase64(text(plain)), base64);
    assert.deepEqual(fromBase64(base64), text(plain));
    assert.equal(toHex(text(plain)), base16.toLowerCase());
    assert.deepEqual(fromHex(base16), text(plain));
  }
  // URL 安全字母表：0xfb 0xff → +/ 与 -_
  assert.equal(toBase64(Uint8Array.of(0xfb, 0xff)), "+/8=");
  assert.equal(toBase64(Uint8Array.of(0xfb, 0xff), true), "-_8");
  assert.throws(() => fromBase64("Zm9=v"), /填充/);
  assert.throws(() => fromHex("abc"), /偶数/);
});

test("编码：同时列出六种结果，文本按 UTF-8 处理", () => {
  const rows = Object.fromEntries(encodeAll("中文 a+b/?").map((row) => [row.id, row.value]));
  assert.equal(rows.base64, "5Lit5paHIGErYi8/");
  assert.equal(rows.base64url, "5Lit5paHIGErYi8_");
  assert.equal(rows.component, "%E4%B8%AD%E6%96%87%20a%2Bb%2F%3F");
  assert.equal(rows.uri, "%E4%B8%AD%E6%96%87%20a+b/?");
  assert.equal(rows.unicode, "\\u4e2d\\u6587\\u0020\\u0061\\u002b\\u0062\\u002f\\u003f");
  assert.equal(rows.hex, "e4b8ad e69687 20 612b622f3f".replace(/ /g, ""));
  const lone = encodeAll("\ud800").find((row) => row.id === "component")!;
  assert.match(lone.error!, /孤立代理/);
});

test("解码：逐个格式尝试，解不出的给出原因", () => {
  const rows = Object.fromEntries(decodeAll("5Lit5paH").map((row) => [row.id, row]));
  assert.equal(rows.base64.value, "中文");
  assert.equal(rows.base64url.value, "中文");
  assert.match(rows.hex.error!, /Hex/);
  assert.match(rows.component.error!, /没有需要解码/);
  const percent = Object.fromEntries(decodeAll("%E4%B8%AD%zz").map((row) => [row.id, row]));
  assert.match(percent.component.error!, /百分号/);
  assert.equal(Object.fromEntries(decodeAll("e4b8ad").map((row) => [row.id, row])).hex.value, "中");
  assert.match(Object.fromEntries(decodeAll("-_8").map((row) => [row.id, row])).base64.error!, /URL 安全/);
  assert.match(Object.fromEntries(decodeAll("+/8=").map((row) => [row.id, row])).base64.error!, /UTF-8/);
  assert.equal(unicodeUnescape(unicodeEscape("😀中")), "😀中");
  assert.equal(unicodeUnescape("\\u{1F600}"), "😀");
});

test("MD5：RFC 1321 附录 A.5", () => {
  assert.equal(hashes(text("")).md5, "d41d8cd98f00b204e9800998ecf8427e");
  assert.equal(hashes(text("abc")).md5, "900150983cd24fb0d6963f7d28e17f72");
  assert.equal(hashes(text("message digest")).md5, "f96b697d7cb7938d525a2f31aaf161d0");
});

test("SHA-1、SHA-256、SHA-512：FIPS 180 示例", () => {
  const abc = hashes(text("abc"));
  assert.equal(abc.sha1, "a9993e364706816aba3e25717850c26c9cd0d89d");
  assert.equal(abc.sha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(abc.sha512, "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f");
  const long = hashes(text("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"));
  assert.equal(long.sha1, "84983e441c3bd26ebaae4aa1f95129e5e54670f1");
  assert.equal(long.sha256, "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
});

test("SM3：GB/T 32905 附录 A 示例 1、示例 2", () => {
  assert.equal(hashes(text("abc")).sm3, "66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0");
  assert.equal(hashes(text("abcd".repeat(16))).sm3, "debe9ff92275b8a138604889c18e5a4d6fdb70e5387e5765293dcba39c0c5732");
});

test("大写输出与标签", () => {
  const rows = hashAll(text("abc"), null, true);
  assert.equal(rows.find((row) => row.id === "md5")!.value, "900150983CD24FB0D6963F7D28E17F72");
  assert.deepEqual(hashAll(text("abc"), text("k"), false).map((row) => row.label), ["HMAC-MD5", "HMAC-SHA-1", "HMAC-SHA-256", "HMAC-SHA-512", "HMAC-SM3"]);
});

test("HMAC-SHA-256 / SHA-512：RFC 4231 测试用例 1、2、6", () => {
  const case1 = hashes(text("Hi There"), new Uint8Array(20).fill(0x0b));
  assert.equal(case1.sha256, "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
  assert.equal(case1.sha512, "87aa7cdea5ef619d4ff0b4241a1d6cb02379f4e2ce4ec2787ad0b30545e17cdedaa833b7d6b8a702038b274eaea3f4e4be9d914eeb61f1702e696c203a126854");
  const case2 = hashes(text("what do ya want for nothing?"), text("Jefe"));
  assert.equal(case2.sha256, "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  assert.equal(case2.sha512, "164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea2505549758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737");
  const case6 = hashes(text("Test Using Larger Than Block-Size Key - Hash Key First"), new Uint8Array(131).fill(0xaa));
  assert.equal(case6.sha256, "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
  assert.equal(case6.sha512, "80b24263c7c1a3ebb71493c1dd7be8b49b46d1f41b4aeec1121b013783f8f3526b56d037e05f2598bd0fd2215d6a1e5295e64f73f63f0aec8b915a985d786598");
});

test("HMAC-MD5 / HMAC-SHA-1：RFC 2202 测试用例 1、2", () => {
  assert.equal(hashes(text("Hi There"), new Uint8Array(16).fill(0x0b)).md5, "9294727a3638bb1c13f48ef8158bfc9d");
  assert.equal(hashes(text("Hi There"), new Uint8Array(20).fill(0x0b)).sha1, "b617318655057264e28bc0b6fb378c8ef146be00");
  const jefe = hashes(text("what do ya want for nothing?"), text("Jefe"));
  assert.equal(jefe.md5, "750c783e6ab0b503eaa86e310a5db738");
  assert.equal(jefe.sha1, "effcdf6ae5eb2fa2d27416d5f184df9c259a7c79");
});

test("HMAC-SM3：与 Node（OpenSSL）结果一致", (context) => {
  if (!nodeCrypto.getHashes().includes("sm3")) { context.skip("当前 Node 的 OpenSSL 未提供 SM3"); return; }
  for (const key of [text("Jefe"), new Uint8Array(100).fill(0xaa)]) {
    const message = text("what do ya want for nothing?");
    assert.equal(hashes(message, key).sm3, nodeCrypto.createHmac("sm3", key).update(message).digest("hex"));
  }
});

const NIST_PLAIN = fromHex("6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411e5fbc1191a0a52eff69f2445df4f9b17ad2b417be66c3710");
const NIST_IV = fromHex("000102030405060708090a0b0c0d0e0f");

function roundTrip(algorithm: SymAlgorithm, mode: SymMode, key: Uint8Array, iv: Uint8Array, plain: Uint8Array) {
  const cipher = symmetricCrypt({ algorithm, mode, encrypt: true, key, iv, data: plain });
  assert.deepEqual(symmetricCrypt({ algorithm, mode, encrypt: false, key, iv, data: cipher }), plain);
  return cipher;
}

test("AES：NIST SP 800-38A F.1、F.2（ECB、CBC，128/192/256）", () => {
  const cases: [SymAlgorithm, SymMode, string, string][] = [
    ["aes-128", "ecb", "2b7e151628aed2a6abf7158809cf4f3c", "3ad77bb40d7a3660a89ecaf32466ef97f5d3d58503b9699de785895a96fdbaaf43b1cd7f598ece23881b00e3ed0306887b0c785e27e8ad3f8223207104725dd4"],
    ["aes-192", "ecb", "8e73b0f7da0e6452c810f32b809079e562f8ead2522c6b7b", "bd334f1d6e45f25ff712a214571fa5cc974104846d0ad3ad7734ecb3ecee4eefef7afd2270e2e60adce0ba2face6444e9a4b41ba738d6c72fb16691603c18e0e"],
    ["aes-256", "ecb", "603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4", "f3eed1bdb5d2a03c064b5a7e3db181f8591ccb10d410ed26dc5ba74a31362870b6ed21b99ca6f4f9f153e7b1beafed1d23304b7a39f9f3ff067d8d8f9e24ecc7"],
    ["aes-128", "cbc", "2b7e151628aed2a6abf7158809cf4f3c", "7649abac8119b246cee98e9b12e9197d5086cb9b507219ee95db113a917678b273bed6b8e3c1743b7116e69e222295163ff1caa1681fac09120eca307586e1a7"],
    ["aes-192", "cbc", "8e73b0f7da0e6452c810f32b809079e562f8ead2522c6b7b", "4f021db243bc633d7178183a9fa071e8b4d9ada9ad7dedf4e5e738763f69145a571b242012fb7ae07fa9baac3df102e008b0e27988598881d920a9e64f5615cd"],
    ["aes-256", "cbc", "603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4", "f58c4c04d6e5f1ba779eabfb5f7bfbd69cfc4e967edb808d679f777bc6702c7d39f23369a9d9bacfa530e26304231461b2eb05e2c39be9fcda6c19078c6a9d1b"],
  ];
  for (const [algorithm, mode, key, expected] of cases) {
    const cipher = roundTrip(algorithm, mode, fromHex(key), NIST_IV, NIST_PLAIN);
    // 输入恰为整块，PKCS7 追加一整块填充；前 64 字节即 NIST 向量
    assert.equal(toHex(cipher.subarray(0, 64)), expected, `${algorithm}-${mode}`);
    assert.equal(cipher.length, 80);
  }
});

test("AES-GCM：GCM 规范测试用例 3（NIST SP 800-38D），密文‖标签", () => {
  const key = fromHex("feffe9928665731c6d6a8f9467308308");
  const iv = fromHex("cafebabefacedbaddecaf888");
  const plain = fromHex("d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b391aafd255");
  const cipher = roundTrip("aes-128", "gcm", key, iv, plain);
  assert.equal(toHex(cipher), "42831ec2217774244b7221b784d0d49ce3aa212f2c02a4e035c17e2329aca12e21d514b25466931c7d8f6a5aac84aa051ba30b396a0aac973d58e091473f5985" + "4d5c2af327cd64a62cf35abd2ba6fab4");
  cipher[0] ^= 1;
  assert.throws(() => symmetricCrypt({ algorithm: "aes-128", mode: "gcm", encrypt: false, key, iv, data: cipher }), /认证标签/);
});

test("SM4：GB/T 32907 附录 A 示例 1；CBC 与 OpenSSL 一致", () => {
  const key = fromHex("0123456789abcdeffedcba9876543210");
  const cipher = roundTrip("sm4", "ecb", key, new Uint8Array(), key);
  assert.equal(toHex(cipher.subarray(0, 16)), "681edf34d206965e86b3e94f536e4246");
  if (nodeCrypto.getCiphers().includes("sm4-cbc")) {
    const iv = fromHex("fedcba98765432100123456789abcdef");
    const plain = text("国密 SM4 CBC 测试");
    const node = nodeCrypto.createCipheriv("sm4-cbc", key, iv);
    const expected = Buffer.concat([node.update(plain), node.final()]);
    assert.equal(toHex(roundTrip("sm4", "cbc", key, iv, plain)), expected.toString("hex"));
  }
});

test("DES：FIPS 46 经典示例；3DES：与 OpenSSL 一致，支持双倍长密钥", () => {
  const cipher = roundTrip("des", "ecb", fromHex("133457799bbcdff1"), new Uint8Array(), fromHex("0123456789abcdef"));
  assert.equal(toHex(cipher.subarray(0, 8)), "85e813540f0ab405");
  const key24 = fromHex("0123456789abcdef23456789abcdef01456789abcdef0123");
  const iv = fromHex("1234567890abcdef");
  const plain = text("三重 DES 测试数据");
  const node = nodeCrypto.createCipheriv("des-ede3-cbc", key24, iv);
  assert.equal(toHex(roundTrip("3des", "cbc", key24, iv, plain)), Buffer.concat([node.update(plain), node.final()]).toString("hex"));
  const key16 = key24.subarray(0, 16);
  const node16 = nodeCrypto.createCipheriv("des-ede-cbc", key16, iv);
  assert.equal(toHex(roundTrip("3des", "cbc", key16, iv, plain)), Buffer.concat([node16.update(plain), node16.final()]).toString("hex"));
});

test("对称加密：长度不对、填充错误给出中文提示", () => {
  const base = { mode: "cbc" as const, encrypt: true, iv: new Uint8Array(16), data: text("x") };
  assert.throws(() => symmetricCrypt({ ...base, algorithm: "aes-256", key: new Uint8Array(16) }), /AES-256 的密钥需要 32 字节，当前为 16 字节/);
  assert.throws(() => symmetricCrypt({ ...base, algorithm: "aes-128", key: new Uint8Array(16), iv: new Uint8Array(8) }), /IV 需要 16 字节/);
  assert.throws(() => symmetricCrypt({ ...base, algorithm: "des", key: new Uint8Array(8) }), /IV 需要 8 字节/);
  assert.throws(() => symmetricCrypt({ ...base, algorithm: "sm4", key: new Uint8Array(15) }), /SM4 的密钥需要 16 字节/);
  assert.throws(() => symmetricCrypt({ ...base, algorithm: "aes-128", mode: "gcm", key: new Uint8Array(16), iv: new Uint8Array(4) }), /至少需要 8 字节/);
  assert.throws(() => symmetricCrypt({ ...base, algorithm: "aes-128", encrypt: false, key: new Uint8Array(16), data: new Uint8Array(15) }), /整数倍/);
  const key = new Uint8Array(16).fill(1);
  const cipher = symmetricCrypt({ ...base, algorithm: "sm4", key });
  assert.throws(() => symmetricCrypt({ ...base, algorithm: "sm4", encrypt: false, key: new Uint8Array(16).fill(2), data: cipher }), /PKCS7/);
});

test("NoPadding 与 ZeroPadding：整块不追加，短块按选择补零，保留或移除明文尾零", () => {
  for (const algorithm of ["aes-128", "aes-192", "aes-256", "des", "3des", "sm4"] as const) {
    const block = algorithm === "des" || algorithm === "3des" ? 8 : 16;
    const keySize = { "aes-128": 16, "aes-192": 24, "aes-256": 32, des: 8, "3des": 24, sm4: 16 }[algorithm];
    for (const mode of ["cbc", "ecb"] as const) {
      const base = { algorithm, mode, key: new Uint8Array(keySize).fill(1), iv: new Uint8Array(block) };
      for (const length of [0, 1, block - 1, block, block + 1]) {
        const plain = new Uint8Array(length).fill(65);
        const cipher = symmetricCrypt({ ...base, padding: "zero", encrypt: true, data: plain });
        assert.equal(cipher.length, Math.ceil(length / block) * block);
        assert.deepEqual(symmetricCrypt({ ...base, padding: "zero", encrypt: false, data: cipher }), plain);
        const padded = new Uint8Array(cipher.length);
        padded.set(plain);
        assert.deepEqual(symmetricCrypt({ ...base, padding: "none", encrypt: true, data: padded }), cipher);
        assert.deepEqual(symmetricCrypt({ ...base, padding: "none", encrypt: false, data: cipher }), padded);
      }
      assert.throws(() => symmetricCrypt({ ...base, padding: "none", encrypt: true, data: text("x") }), /NoPadding.*整数倍/);
      assert.throws(() => symmetricCrypt({ ...base, padding: "zero", encrypt: false, data: text("x") }), /密文长度.*整数倍/);
    }
  }
});

test("AES NoPadding 与独立 OpenSSL 实现一致，GCM 不受填充选择影响", () => {
  const base = { algorithm: "aes-128" as const, mode: "cbc" as const, key: fromHex("2b7e151628aed2a6abf7158809cf4f3c"), iv: NIST_IV, data: NIST_PLAIN, encrypt: true };
  const node = nodeCrypto.createCipheriv("aes-128-cbc", base.key, base.iv).setAutoPadding(false);
  assert.equal(toHex(symmetricCrypt({ ...base, padding: "none" })), Buffer.concat([node.update(base.data), node.final()]).toString("hex"));
  const gcmBase = { ...base, mode: "gcm" as const, iv: new Uint8Array(12), data: text("短明文") };
  assert.deepEqual(symmetricCrypt({ ...gcmBase, padding: "none" }), symmetricCrypt({ ...gcmBase, padding: "zero" }));
});

test("PKCS5：各算法短块、整块和空明文往返，与 OpenSSL 填充结果一致", () => {
  for (const algorithm of ["aes-128", "aes-192", "aes-256", "des", "3des", "sm4"] as const) {
    const block = algorithm === "des" || algorithm === "3des" ? 8 : 16;
    const keySize = { "aes-128": 16, "aes-192": 24, "aes-256": 32, des: 8, "3des": 24, sm4: 16 }[algorithm];
    for (const mode of ["cbc", "ecb"] as const) {
      const base = { algorithm, mode, key: new Uint8Array(keySize).fill(1), iv: new Uint8Array(block) };
      const nodeName = `${algorithm === "3des" ? "des-ede3" : algorithm}-${mode}`;
      for (const length of [0, 1, 7, 8, 9, 15, 16, 17]) {
        const plain = new Uint8Array(length).fill(65);
        const cipher = symmetricCrypt({ ...base, data: plain, padding: "pkcs5", encrypt: true });
        assert.equal(cipher.length, (Math.floor(length / block) + 1) * block);
        assert.deepEqual(symmetricCrypt({ ...base, padding: "pkcs5", encrypt: false, data: cipher }), plain);
        assert.deepEqual(cipher, symmetricCrypt({ ...base, data: plain, padding: "pkcs7", encrypt: true }));
        if (nodeCrypto.getCiphers().includes(nodeName)) {
          const node = nodeCrypto.createCipheriv(nodeName, base.key, mode === "ecb" ? null : base.iv);
          assert.equal(toHex(cipher), Buffer.concat([node.update(plain), node.final()]).toString("hex"));
        }
      }
      assert.throws(() => symmetricCrypt({ ...base, padding: "pkcs5", encrypt: false, data: new Uint8Array() }), /密文长度/);
      const invalid = symmetricCrypt({ ...base, padding: "none", encrypt: true, data: new Uint8Array(block) });
      assert.throws(() => symmetricCrypt({ ...base, padding: "pkcs5", encrypt: false, data: invalid }), /PKCS5 填充校验/);
    }
  }
});
