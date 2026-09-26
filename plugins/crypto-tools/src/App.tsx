import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { qingbox } from "../../../packages/plugin-sdk/src/index";
import { errorMessage } from "./lib/bytes.ts";
import { secureRandomAvailable, RANDOM_UNAVAILABLE } from "./lib/random.ts";
import { ASYMMETRIC_DEFAULTS, AsymmetricTab, sanitizeAsymmetric, type AsymmetricDraft } from "./tabs/AsymmetricTab.tsx";
import { ENCODE_DEFAULTS, EncodeTab, type EncodeDraft } from "./tabs/EncodeTab.tsx";
import { HASH_DEFAULTS, HashTab, type HashDraft } from "./tabs/HashTab.tsx";
import { sanitizeSymmetric, SYMMETRIC_DEFAULTS, SymmetricTab, type SymmetricDraft } from "./tabs/SymmetricTab.tsx";
import { restore, Tool, type ToolContext } from "./ui.tsx";

export type TabId = "encode" | "hash" | "symmetric" | "asymmetric";

const TABS: { id: TabId; title: string }[] = [
  { id: "encode", title: "编码" },
  { id: "hash", title: "哈希" },
  { id: "symmetric", title: "对称加密" },
  { id: "asymmetric", title: "非对称加密" },
];
const isTab = (value: unknown): value is TabId => TABS.some((tab) => tab.id === value);

interface Drafts { encode: EncodeDraft; hash: HashDraft; symmetric: SymmetricDraft; asymmetric: AsymmetricDraft }

/** 读取打开命令、上次分页与各分页草稿；失败时使用默认值。 */
async function loadInitial(): Promise<{ tab: TabId; drafts: Drafts; warning: string | null }> {
  const get = (key: string) => qingbox.storage.get<unknown>(key);
  const [command, stored, encode, hash, symmetric, asymmetric] = await Promise.allSettled([
    qingbox.view.command(), get("lastTab"), get("draft.encode"), get("draft.hash"), get("draft.symmetric"), get("draft.asymmetric"),
  ]);
  const value = (result: PromiseSettledResult<unknown>) => result.status === "fulfilled" ? result.value : null;
  const failed = [stored, encode, hash, symmetric, asymmetric].find((result) => result.status === "rejected") as PromiseRejectedResult | undefined;
  const tab = isTab(value(command)) ? value(command) as TabId : isTab(value(stored)) ? value(stored) as TabId : "encode";
  return {
    tab,
    drafts: {
      encode: restore(ENCODE_DEFAULTS, value(encode)),
      hash: restore(HASH_DEFAULTS, value(hash)),
      symmetric: sanitizeSymmetric(restore(SYMMETRIC_DEFAULTS, value(symmetric))),
      asymmetric: sanitizeAsymmetric(restore(ASYMMETRIC_DEFAULTS, value(asymmetric))),
    },
    warning: failed ? `草稿读取失败：${errorMessage(failed.reason)}` : null,
  };
}

export default function App() {
  const [initial, setInitial] = useState<{ drafts: Drafts } | null>(null);
  const [tab, setTab] = useState<TabId>("encode");
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
  const main = useRef<HTMLElement>(null);

  const notify = useCallback((text: string, error = false) => setFeedback({ text, error }), []);
  const copy = useCallback((text: string, label: string) => {
    void qingbox.clipboard.writeText(text)
      .then(() => setFeedback({ text: `已复制 ${label}`, error: false }))
      .catch((error) => setFeedback({ text: `复制失败：${errorMessage(error)}`, error: true }));
  }, []);
  const context = useMemo<ToolContext>(() => ({ copy, notify }), [copy, notify]);

  const focusTab = useCallback((id: TabId) => {
    window.requestAnimationFrame(() => main.current?.querySelector<HTMLElement>(`[data-tab="${id}"] [data-primary]`)?.focus());
  }, []);

  useEffect(() => {
    let active = true;
    void loadInitial().then(({ tab: first, drafts, warning }) => {
      if (!active) return;
      setTab(first);
      setInitial({ drafts });
      if (warning) setFeedback({ text: warning, error: true });
      else if (!secureRandomAvailable()) setFeedback({ text: RANDOM_UNAVAILABLE, error: true });
      void qingbox.view.ready().catch((error) => { if (active) setFeedback({ text: errorMessage(error), error: true }); });
    });
    return () => { active = false; };
  }, []);

  const tabRef = useRef(tab);
  tabRef.current = tab;
  // 宿主每次显示插件时聚焦当前分页的主输入框
  useEffect(() => qingbox.events.on("view.shown", () => focusTab(tabRef.current)), [focusTab]);

  const switchTab = useCallback((id: TabId) => {
    setTab(id);
    setFeedback(null);
    focusTab(id);
    void qingbox.storage.set("lastTab", id).catch(() => {});
  }, [focusTab]);

  useEffect(() => {
    if (!feedback || feedback.error) return;
    const timer = window.setTimeout(() => setFeedback(null), 2600);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      // 输入法组合输入期间的按键交给输入法
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        void qingbox.view.back().catch((error) => setFeedback({ text: errorMessage(error), error: true }));
        return;
      }
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && /^Digit[1-4]$/.test(event.code)) {
        event.preventDefault();
        switchTab(TABS[Number(event.code.slice(5)) - 1].id);
      }
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [switchTab]);

  return <Tool.Provider value={context}>
    <main className="crypto-plugin" ref={main}>
      <nav className="tab-bar" role="tablist" aria-label="功能分页">
        {TABS.map((item, index) => <button key={item.id} type="button" role="tab" title={`⌘${index + 1}`} id={`tab-${item.id}`} aria-selected={tab === item.id} aria-controls={`panel-${item.id}`} className={tab === item.id ? "active" : ""} onClick={() => switchTab(item.id)}>
          <span>{item.title}</span><kbd>⌘{index + 1}</kbd>
        </button>)}
      </nav>
      <div className="panels">
        {initial && TABS.map((item) => <section key={item.id} id={`panel-${item.id}`} role="tabpanel" aria-labelledby={`tab-${item.id}`} data-tab={item.id} hidden={tab !== item.id} className="panel">
          {item.id === "encode" && <EncodeTab initial={initial.drafts.encode} />}
          {item.id === "hash" && <HashTab initial={initial.drafts.hash} />}
          {item.id === "symmetric" && <SymmetricTab initial={initial.drafts.symmetric} />}
          {item.id === "asymmetric" && <AsymmetricTab initial={initial.drafts.asymmetric} />}
        </section>)}
      </div>
      {feedback && <div className={`feedback${feedback.error ? " invalid" : ""}`} role="status" aria-live="polite">
        <span className="status-message">{feedback.text}</span>
        <button type="button" aria-label="关闭提示" onClick={() => setFeedback(null)}>×</button>
      </div>}
    </main>
  </Tool.Provider>;
}
