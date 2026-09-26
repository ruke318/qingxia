// 非对称加密分页：先选算法，再按算法显示可用操作；私钥只保存在内存中，不写入草稿。
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  CURVE_LABELS, DEFAULT_SM2_USER_ID, ecdsaSign, ecdsaVerify, ed25519Sign, ed25519Verify, generateEcdsaKeyPair, generateEd25519KeyPair,
  generateRsaKeyPair, generateSm2KeyPair, rsaDecrypt, rsaEncrypt, rsaSign, rsaVerify, SIG_FORMAT_LABELS, sm2Decrypt, sm2Encrypt, sm2Sign, sm2Verify,
  type EcCurve, type KeyPair, type RsaPadding, type RsaSignScheme, type SigFormat, type Sm2Order,
} from "../lib/asymmetric.ts";
import { errorMessage, formatBytes, fromHex, parseBytes, toHex, type ByteFormat } from "../lib/bytes.ts";
import { CopyButton, formatOptions, ResultRow, Segmented, Select, TextArea, TextInput, useDraftSaver, useTool, type Option } from "../ui.tsx";

import { ToolBar } from "../ToolBar.tsx";

export type AsymAlgorithm = "rsa" | "sm2" | "ecdsa" | "ed25519";
type Operation = "encrypt" | "decrypt" | "sign" | "verify";
type PerAlgorithm<T> = Record<AsymAlgorithm, T>;

const ALGORITHMS: Option<AsymAlgorithm>[] = [{ value: "rsa", label: "RSA" }, { value: "sm2", label: "SM2" }, { value: "ecdsa", label: "ECDSA" }, { value: "ed25519", label: "Ed25519" }];
const OPERATION_LABELS: Record<Operation, string> = { encrypt: "加密", decrypt: "解密", sign: "签名", verify: "验签" };
const OPERATIONS: PerAlgorithm<Operation[]> = { rsa: ["encrypt", "decrypt", "sign", "verify"], sm2: ["encrypt", "decrypt", "sign", "verify"], ecdsa: ["sign", "verify"], ed25519: ["sign", "verify"] };
const SIG_FORMATS: PerAlgorithm<SigFormat[]> = { rsa: ["base64", "hex"], sm2: ["raw-hex", "der-hex", "der-base64"], ecdsa: ["raw-hex", "der-hex", "der-base64"], ed25519: ["hex", "base64"] };
const RSA_PADDINGS: Option<RsaPadding>[] = [{ value: "pkcs1", label: "PKCS#1 v1.5" }, { value: "oaep-sha1", label: "OAEP（SHA-1）" }, { value: "oaep-sha256", label: "OAEP（SHA-256）" }];
const RSA_SCHEMES: Option<RsaSignScheme>[] = [{ value: "sha256", label: "SHA256withRSA" }, { value: "sha1", label: "SHA1withRSA" }, { value: "pss-sha256", label: "SHA256withRSA/PSS" }];
const MESSAGE_FORMATS = formatOptions(["text", "hex", "base64"]);
const CIPHER_FORMATS = formatOptions(["hex", "base64"]);

/** 草稿：不含私钥。 */
export interface AsymmetricDraft {
  algorithm: AsymAlgorithm;
  operations: PerAlgorithm<Operation>;
  publicKeys: PerAlgorithm<string>;
  sigFormats: PerAlgorithm<SigFormat>;
  cipherFormats: PerAlgorithm<ByteFormat>;
  rsaBits: "2048" | "4096";
  rsaPadding: RsaPadding;
  rsaScheme: RsaSignScheme;
  sm2Order: Sm2Order;
  sm2Prefix: boolean;
  userId: string;
  curve: EcCurve;
  messageFormat: ByteFormat;
  input: string;
  signature: string;
}

export const ASYMMETRIC_DEFAULTS: AsymmetricDraft = {
  algorithm: "rsa",
  operations: { rsa: "encrypt", sm2: "encrypt", ecdsa: "sign", ed25519: "sign" },
  publicKeys: { rsa: "", sm2: "", ecdsa: "", ed25519: "" },
  sigFormats: { rsa: "base64", sm2: "raw-hex", ecdsa: "der-hex", ed25519: "hex" },
  cipherFormats: { rsa: "base64", sm2: "hex", ecdsa: "hex", ed25519: "hex" },
  rsaBits: "2048", rsaPadding: "pkcs1", rsaScheme: "sha256",
  sm2Order: "c1c3c2", sm2Prefix: true, userId: DEFAULT_SM2_USER_ID,
  curve: "p256", messageFormat: "text", input: "", signature: "",
};

/** 读入草稿后校正取值，避免不存在的算法、操作或格式。 */
export function sanitizeAsymmetric(draft: AsymmetricDraft): AsymmetricDraft {
  const algorithm = ALGORITHMS.some((item) => item.value === draft.algorithm) ? draft.algorithm : "rsa";
  const pick = <T,>(all: PerAlgorithm<T[]>, current: PerAlgorithm<T>, fallback: PerAlgorithm<T>) =>
    Object.fromEntries(ALGORITHMS.map(({ value }) => [value, all[value].includes(current[value]) ? current[value] : fallback[value]])) as PerAlgorithm<T>;
  return {
    ...draft, algorithm,
    operations: pick(OPERATIONS, draft.operations, ASYMMETRIC_DEFAULTS.operations),
    sigFormats: pick(SIG_FORMATS, draft.sigFormats, ASYMMETRIC_DEFAULTS.sigFormats),
  };
}

type Result = { kind: "value"; label: string; value: string; note?: string } | { kind: "verify"; valid: boolean } | { kind: "error"; message: string };

export function AsymmetricTab({ initial }: { initial: AsymmetricDraft }) {
  const [draft, setDraft] = useState(initial);
  // 私钥只在内存中，按算法分别保存
  const [privateKeys, setPrivateKeys] = useState<PerAlgorithm<string>>({ rsa: "", sm2: "", ecdsa: "", ed25519: "" });
  const [result, setResult] = useState<Result | null>(null);
  const [generating, setGenerating] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const { notify } = useTool();
  useDraftSaver("draft.asymmetric", draft);

  const algorithm = draft.algorithm;
  const operation = draft.operations[algorithm];
  const sigFormat = draft.sigFormats[algorithm];
  const cipherFormat = draft.cipherFormats[algorithm];
  const update = (patch: Partial<AsymmetricDraft>) => { setDraft((current) => ({ ...current, ...patch })); setResult(null); };
  const setFor = <K extends "operations" | "publicKeys" | "sigFormats" | "cipherFormats">(key: K, value: AsymmetricDraft[K][AsymAlgorithm]) => {
    setDraft((current) => ({ ...current, [key]: { ...current[key], [current.algorithm]: value } }));
    setResult(null);
  };

  useEffect(() => () => abort.current?.abort(), []);

  async function generate() {
    if (generating) return;
    setResult(null);
    const target = algorithm;
    try {
      let pair: KeyPair;
      if (target === "rsa") {
        setGenerating(true);
        notify(`正在生成 RSA ${draft.rsaBits} 位密钥对，可继续操作界面…`);
        abort.current = new AbortController();
        pair = await generateRsaKeyPair(draft.rsaBits === "4096" ? 4096 : 2048, abort.current.signal);
      } else {
        pair = target === "sm2" ? generateSm2KeyPair() : target === "ecdsa" ? generateEcdsaKeyPair(draft.curve) : generateEd25519KeyPair();
      }
      setDraft((current) => ({ ...current, publicKeys: { ...current.publicKeys, [target]: pair.publicKey } }));
      setPrivateKeys((current) => ({ ...current, [target]: pair.privateKey }));
      notify(`已生成 ${target === "rsa" ? `RSA ${draft.rsaBits} 位` : target === "ecdsa" ? `ECDSA ${CURVE_LABELS[draft.curve]}` : ALGORITHMS.find((item) => item.value === target)!.label} 密钥对；私钥不会保存`);
    } catch (error) {
      notify(errorMessage(error), true);
    } finally {
      abort.current = null;
      setGenerating(false);
    }
  }

  function run() {
    const publicKey = draft.publicKeys[algorithm];
    const privateKey = privateKeys[algorithm];
    try {
      const needsPrivate = operation === "decrypt" || operation === "sign";
      if (needsPrivate ? !privateKey.trim() : !publicKey.trim()) throw new Error(needsPrivate ? "请填写私钥" : "请填写公钥");
      if (operation === "decrypt") {
        const cipher = parseBytes(draft.input, cipherFormat, "密文");
        if (!cipher.length) throw new Error("请填写密文");
        const { data, note } = algorithm === "rsa" ? { data: rsaDecrypt(privateKey, cipher, draft.rsaPadding), note: undefined } : sm2Decrypt(privateKey, toHex(cipher), draft.sm2Order);
        setResult({ kind: "value", label: "明文", value: formatBytes(data, draft.messageFormat), note });
        return;
      }
      const message = parseBytes(draft.input, draft.messageFormat, operation === "encrypt" ? "明文" : "消息");
      if (operation === "encrypt") {
        const value = algorithm === "rsa"
          ? formatBytes(rsaEncrypt(publicKey, message, draft.rsaPadding), cipherFormat)
          : formatBytes(fromHex(sm2Encrypt(publicKey, message, draft.sm2Order, draft.sm2Prefix)), cipherFormat);
        setResult({ kind: "value", label: "密文", value, note: algorithm === "rsa" ? "填充含随机数，每次结果不同" : `${draft.sm2Order.toUpperCase()}${draft.sm2Prefix ? "，C1 带 04" : "，C1 不带 04"}` });
      } else if (operation === "sign") {
        const value = algorithm === "rsa" ? rsaSign(privateKey, message, draft.rsaScheme, sigFormat)
          : algorithm === "sm2" ? sm2Sign(privateKey, message, draft.userId, sigFormat)
          : algorithm === "ecdsa" ? ecdsaSign(draft.curve, privateKey, message, sigFormat)
          : ed25519Sign(privateKey, message, sigFormat);
        setResult({ kind: "value", label: "签名", value });
      } else {
        const valid = algorithm === "rsa" ? rsaVerify(publicKey, message, draft.signature, draft.rsaScheme, sigFormat)
          : algorithm === "sm2" ? sm2Verify(publicKey, message, draft.signature, draft.userId, sigFormat)
          : algorithm === "ecdsa" ? ecdsaVerify(draft.curve, publicKey, message, draft.signature, sigFormat)
          : ed25519Verify(publicKey, message, draft.signature, sigFormat);
        setResult({ kind: "verify", valid });
      }
    } catch (error) {
      setResult({ kind: "error", message: errorMessage(error) });
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); run(); }
  }

  const encrypting = operation === "encrypt" || operation === "decrypt";
  const inputIsCipher = operation === "decrypt";
  const keyPlaceholder = algorithm === "rsa" ? "PEM（PKCS#1 / PKCS#8 / SPKI）或只有 Base64 的一段" : algorithm === "sm2" ? "Hex，带 04 或不带 04 均可" : "Hex";

  return <div className="workbench" onKeyDown={onKeyDown}>
    <div className="tab-body asymmetric-body">
    <div className="field-row">
      <Segmented label="算法" value={algorithm} options={ALGORITHMS} onChange={(value) => update({ algorithm: value })} />
      <Segmented label="操作" value={operation} options={OPERATIONS[algorithm].map((value) => ({ value, label: OPERATION_LABELS[value] }))} onChange={(value) => setFor("operations", value)} />
    </div>
    <div className="field-row">
      {algorithm === "rsa" && <Select label="密钥长度" value={draft.rsaBits} options={[{ value: "2048", label: "2048 位" }, { value: "4096", label: "4096 位" }]} onChange={(rsaBits) => update({ rsaBits })} />}
      {algorithm === "ecdsa" && <Select label="曲线" value={draft.curve} options={[{ value: "p256", label: "P-256" }, { value: "secp256k1", label: "secp256k1" }]} onChange={(curve) => update({ curve })} />}
      <button type="button" className="secondary-button" disabled={generating} onClick={() => void generate()}>{generating ? "生成中…" : "生成密钥对"}</button>
      {generating && <button type="button" className="text-button" onClick={() => abort.current?.abort()}>取消</button>}
      <span className="field-note">私钥只保留在本次打开的界面中，不会保存</span>
    </div>
    <div className="key-grid">
      <TextArea label="公钥" rows={4} value={draft.publicKeys[algorithm]} placeholder={keyPlaceholder} onChange={(value) => setFor("publicKeys", value)} extra={<CopyButton text={draft.publicKeys[algorithm]} label="公钥" />} />
      <TextArea label="私钥" rows={4} secret value={privateKeys[algorithm]} placeholder={keyPlaceholder} onChange={(value) => { setPrivateKeys((current) => ({ ...current, [algorithm]: value })); setResult(null); }} extra={<CopyButton text={privateKeys[algorithm]} label="私钥" />} />
    </div>
    <div className="field-row">
      {algorithm === "rsa" && encrypting && <Select label="填充" value={draft.rsaPadding} options={RSA_PADDINGS} onChange={(rsaPadding) => update({ rsaPadding })} />}
      {algorithm === "rsa" && !encrypting && <Select label="签名算法" value={draft.rsaScheme} options={RSA_SCHEMES} onChange={(rsaScheme) => update({ rsaScheme })} />}
      {algorithm === "sm2" && encrypting && <Select label="密文顺序" value={draft.sm2Order} options={[{ value: "c1c3c2", label: "C1C3C2" }, { value: "c1c2c3", label: "C1C2C3" }]} onChange={(sm2Order) => update({ sm2Order })} />}
      {algorithm === "sm2" && operation === "encrypt" && <Select label="C1 前缀" value={draft.sm2Prefix ? "yes" : "no"} options={[{ value: "yes", label: "带 04" }, { value: "no", label: "不带 04" }]} onChange={(value) => update({ sm2Prefix: value === "yes" })} />}
      {algorithm === "sm2" && !encrypting && <TextInput label="用户 ID" value={draft.userId} onChange={(userId) => update({ userId })} />}
      {!encrypting && <Select label="签名格式" value={sigFormat} options={SIG_FORMATS[algorithm].map((value) => ({ value, label: SIG_FORMAT_LABELS[value] }))} onChange={(value) => setFor("sigFormats", value)} />}
      {encrypting && <Select label="密文格式" value={cipherFormat} options={CIPHER_FORMATS} onChange={(value) => setFor("cipherFormats", value)} />}
      <Select label={inputIsCipher ? "明文输出" : "消息格式"} value={draft.messageFormat} options={MESSAGE_FORMATS} onChange={(messageFormat) => update({ messageFormat })} />
    </div>
    <TextArea label={inputIsCipher ? "密文" : operation === "encrypt" ? "明文" : "消息"} primary rows={3} value={draft.input} placeholder={inputIsCipher ? (algorithm === "sm2" ? "SM2 密文，带不带 04 前缀均可" : "RSA 密文") : "输入内容；⌘↩ 执行"} onChange={(input) => update({ input })} />
    {operation === "verify" && <TextArea label="签名" rows={2} value={draft.signature} placeholder={SIG_FORMAT_LABELS[sigFormat]} onChange={(signature) => update({ signature })} />}
    <div className="transform-bar">
      <span className="toolbar-note">⌘↩ 执行</span>
      <button type="button" className="primary-button" onClick={run} title="⌘↩">{OPERATION_LABELS[operation]}</button>
    </div>
    <div className="results" aria-label="执行结果">
      {result?.kind === "value" && <ResultRow label={result.label} value={result.value} note={result.note} />}
      {result?.kind === "error" && <ResultRow label={`${OPERATION_LABELS[operation]}失败`} error={result.message} />}
      {result?.kind === "verify" && <div className={`verify-result${result.valid ? " valid" : ""}`} role="status">{result.valid ? "验签通过：签名与消息、公钥匹配" : "验签未通过：签名、消息或公钥不匹配"}</div>}
    </div>
    </div>
    <ToolBar onPaste={(input) => update({ input })} onClear={() => update({ input: "", signature: "" })} output={result?.kind === "value" ? result.value : undefined}>
    </ToolBar>
  </div>;
}
