import { useCallback, useEffect, useRef, useState } from "react";
import { qingbox } from "../../../packages/plugin-sdk/src/index";
import { formatDateTime, offset, parse, relative, rows, weekday } from "./time.ts";

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
type Notice = { text: string; error: boolean } | null;

export default function App() {
  const [text, setText] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [notice, setNotice] = useState<Notice>(null);
  const input = useRef<HTMLInputElement>(null);

  // 每次显示时聚焦并全选，直接粘贴即可替换上一次的内容。
  const focus = useCallback(() => window.requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); }), []);

  useEffect(() => {
    focus();
    void qingbox.view.ready().catch((failure) => setNotice({ text: message(failure), error: true }));
  }, [focus]);
  useEffect(() => qingbox.events.on("view.shown", focus), [focus]);

  // 对齐到整秒刷新，当前时间与相对时间随之更新。
  useEffect(() => {
    let timer = 0;
    const tick = () => { setNow(Date.now()); timer = window.setTimeout(tick, 1000 - (Date.now() % 1000)); };
    timer = window.setTimeout(tick, 1000 - (Date.now() % 1000));
    return () => window.clearTimeout(timer);
  }, []);

  const parsed = parse(text);
  const moment = parsed === null ? now : parsed.ok ? parsed.ms : null;
  const items = moment === null ? [] : rows(moment);

  const copy = useCallback((label: string, value: string) => {
    void qingbox.clipboard.writeText(value)
      .then(() => setNotice({ text: `已复制${label}：${value}`, error: false }))
      .catch((failure) => setNotice({ text: `复制失败：${message(failure)}`, error: true }));
  }, []);

  // Esc 返回搜索；⌘1～⌘5 复制对应行。
  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        void qingbox.view.back().catch((failure) => setNotice({ text: message(failure), error: true }));
        return;
      }
      const index = Number(event.key) - 1;
      if (event.metaKey && !event.shiftKey && !event.altKey && !event.ctrlKey && items[index]) {
        event.preventDefault();
        copy(items[index].label, items[index].value);
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [items, copy]);

  useEffect(() => {
    if (!notice || notice.error) return;
    const timer = window.setTimeout(() => setNotice(null), 2600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const kind = parsed === null ? "当前时间" : parsed.ok ? `识别为${parsed.label}` : "无法识别";
  const detail = moment === null ? "" : parsed === null
    ? `${weekday(moment)} · ${Intl.DateTimeFormat().resolvedOptions().timeZone} UTC${offset(moment)}`
    : `${weekday(moment)} · ${relative(moment, now)}`;
  const status = notice ?? (parsed && !parsed.ok ? { text: parsed.error, error: true } : { text: "点击任意一行复制，或按 ⌘1～⌘5", error: false });

  return <main className="time-plugin">
    <div className="input-bar">
      <input ref={input} value={text} onChange={(event) => { setText(event.target.value); setNotice(null); }} aria-label="时间戳或日期"
        placeholder="粘贴时间戳或日期，如 1727490309、1727490309123、2024-09-28 10:25:09" spellCheck={false} autoComplete="off" />
      {text && <button className="text-button" onClick={() => { setText(""); setNotice(null); focus(); }}>清空</button>}
    </div>
    <section className={`summary${moment === null ? " invalid" : ""}`} aria-live="polite">
      <span className="summary-kind">{kind}</span>
      <strong className="summary-time">{moment === null ? "—" : formatDateTime(moment)}</strong>
      <span className="summary-detail">{detail}</span>
    </section>
    <ul className="rows" aria-label="转换结果">
      {items.map((row, index) => <li key={row.label}>
        <button className="row" onClick={() => copy(row.label, row.value)} title="点击复制">
          <kbd>⌘{index + 1}</kbd><span className="row-label">{row.label}</span><code className="row-value">{row.value}</code><span className="row-copy">复制</span>
        </button>
      </li>)}
    </ul>
    <footer className="tool-bar">
      <span className={`status${status.error ? " invalid" : ""}`} role="status" aria-live="polite"><span className="status-dot" />{status.text}</span>
    </footer>
  </main>;
}
