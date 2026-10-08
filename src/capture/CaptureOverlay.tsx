import { useEffect } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";

/** 宿主创建覆盖窗时注入的会话编号与屏幕序号。 */
declare global {
  interface Window { __QINGBOX_CAPTURE__?: { session: number; screen: number } }
}

/** 截图覆盖窗：铺满一块屏幕。选区（SC15）与标注（SC16）接入前只显示遮罩与提示，Esc 取消。 */
export function CaptureOverlay() {
  const context = window.__QINGBOX_CAPTURE__;

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      if (isTauri() && context) void invoke("capture_cancel", { session: context.session });
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [context]);

  return (
    <main className="capture-overlay" aria-label="截图">
      <p className="capture-hint">拖动选择区域 · Esc 取消</p>
    </main>
  );
}
