import { useState, type ReactNode } from "react";
import { qingbox } from "../../../packages/plugin-sdk/src/index";
import { errorMessage } from "./lib/bytes.ts";
import { useTool } from "./ui.tsx";

function ActionIcon({ kind }: { kind: "paste" | "copy" | "clear" }) {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === "paste" ? <><path d="M8 5H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" /><rect x="8" y="2" width="8" height="5" rx="1.5" /></>
      : kind === "copy" ? <><rect x="8" y="3" width="12" height="16" rx="2" /><path d="M5 7H4a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h10" /></>
      : <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></>}
  </svg>;
}

export function ToolBar({ onPaste, onClear, output, children }: { onPaste: (text: string) => void; onClear: () => void; output?: string; children?: ReactNode }) {
  const { copy, notify } = useTool();
  const [reading, setReading] = useState(false);
  async function paste() {
    setReading(true);
    try { onPaste(await qingbox.clipboard.readText()); }
    catch (error) { notify(`粘贴失败：${errorMessage(error)}`, true); }
    finally { setReading(false); }
  }
  return <div className="tool-bar">
    <div className="tool-actions">
      <button type="button" className="toolbar-button" disabled={reading} onClick={() => void paste()}><ActionIcon kind="paste" />粘贴</button>
      <button type="button" className="toolbar-button" disabled={output === undefined} onClick={() => copy(output ?? "", "结果")}><ActionIcon kind="copy" />复制结果</button>
      <button type="button" className="toolbar-button destructive" onClick={onClear}><ActionIcon kind="clear" />清空</button>
    </div>
    {children}
  </div>;
}
