import { useCallback, useEffect, useRef, useState } from "react";
import { qingbox } from "../../../packages/plugin-sdk/src/index";
import { pastedImage, scanImage } from "./image.ts";
import { byteLength, LEVELS, toSvg, type Level } from "./qr.ts";

const isLevel = (value: unknown): value is Level => LEVELS.some((level) => level.id === value);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

type Notice = { text: string; error: boolean } | null;

export default function App() {
  const [loaded, setLoaded] = useState(false);
  const [text, setText] = useState("");
  const [level, setLevel] = useState<Level>("M");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [scanning, setScanning] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const scanRequest = useRef(0);

  const focus = useCallback(() => window.requestAnimationFrame(() => input.current?.focus()), []);

  // 恢复上次的内容与纠错级别；读取失败不影响使用。
  useEffect(() => {
    let active = true;
    void Promise.allSettled([qingbox.storage.get("text"), qingbox.storage.get("level")]).then(([storedText, storedLevel]) => {
      if (!active) return;
      if (storedText.status === "fulfilled" && typeof storedText.value === "string") setText(storedText.value);
      if (storedLevel.status === "fulfilled" && isLevel(storedLevel.value)) setLevel(storedLevel.value);
      setLoaded(true);
      focus();
      void qingbox.view.ready().catch((failure) => setNotice({ text: message(failure), error: true }));
    });
    return () => { active = false; };
  }, [focus]);

  useEffect(() => qingbox.events.on("view.shown", focus), [focus]);

  // 输入停顿后再生成并保存，避免每个按键都重绘和写存储。
  useEffect(() => {
    if (!loaded) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void qingbox.storage.set("text", text).catch(() => undefined);
      void qingbox.storage.set("level", level).catch(() => undefined);
      if (!text) { setSvg(null); setError(null); return; }
      toSvg(text, level)
        .then((value) => { if (active) { setSvg(value); setError(null); } })
        .catch((failure) => { if (active) { setSvg(null); setError(message(failure)); } });
    }, 120);
    return () => { active = false; window.clearTimeout(timer); };
  }, [text, level, loaded]);

  // 粘贴图片时识别其中的二维码，结果填入输入框；粘贴文字保持默认行为。
  useEffect(() => {
    async function recognize(image: Blob) {
      const request = ++scanRequest.current;
      setScanning(true);
      setNotice(null);
      try {
        const result = await scanImage(image);
        if (request !== scanRequest.current) return;
        if (result === null) setNotice({ text: "图片里没有识别到二维码，可以截得更清晰一些再试", error: true });
        else { setText(result); setNotice({ text: "已识别图片中的二维码，内容已填入", error: false }); }
      } catch (failure) {
        if (request === scanRequest.current) setNotice({ text: message(failure), error: true });
      } finally {
        if (request === scanRequest.current) { setScanning(false); focus(); }
      }
    }
    function handlePaste(event: ClipboardEvent) {
      const image = pastedImage(event);
      if (!image) return;
      event.preventDefault();
      void recognize(image);
    }
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [focus]);

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.key !== "Escape") return;
      event.preventDefault();
      void qingbox.view.back().catch((failure) => setNotice({ text: message(failure), error: true }));
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, []);

  useEffect(() => {
    if (!notice || notice.error) return;
    const timer = window.setTimeout(() => setNotice(null), 2600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  function copy() {
    void qingbox.clipboard.writeText(text)
      .then(() => setNotice({ text: "已复制文字", error: false }))
      .catch((failure) => setNotice({ text: `复制失败：${message(failure)}`, error: true }));
  }

  const status = scanning ? { text: "识别中…", error: false }
    : notice ?? (error ? { text: error, error: true } : { text: text ? `${byteLength(text)} 字节` : "输入文字生成二维码，或按 ⌘V 粘贴图片识别二维码", error: false });

  return <main className="qr-plugin">
    <section className="workspace">
      <textarea ref={input} value={text} onChange={(event) => { setText(event.target.value); setNotice(null); }}
        placeholder={"输入文字或网址，右侧实时生成二维码\n\n粘贴截图或图片（⌘V），自动识别其中的二维码"} aria-label="二维码内容" spellCheck={false} />
      <div className="preview">
        {svg ? <div className="qr-card" role="img" aria-label="生成的二维码" dangerouslySetInnerHTML={{ __html: svg }} />
          : <div className="qr-placeholder">{error ? "无法生成" : "二维码会显示在这里"}</div>}
      </div>
    </section>
    <footer className="tool-bar">
      <span className={`status${status.error ? " invalid" : ""}`} role="status" aria-live="polite"><span className="status-dot" />{status.text}</span>
      <span className="level-label">纠错级别</span>
      <div className="segmented" role="radiogroup" aria-label="纠错级别">
        {LEVELS.map((item) => <button key={item.id} role="radio" aria-checked={level === item.id} className={level === item.id ? "active" : ""}
          title={`${item.id} 级：级别越高越耐污损，但同样内容的码更密`} onClick={() => setLevel(item.id)}>{item.title}</button>)}
      </div>
      <button className="text-button" disabled={!text} onClick={() => { setText(""); setNotice(null); focus(); }}>清空</button>
      <button className="primary-button" disabled={!text} onClick={copy}>复制文字</button>
    </footer>
  </main>;
}
