import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

declare global {
  interface Window { __QINGBOX_PIN__?: { id: number; image: string } }
}

/** 贴图窗口：拖动移动，滚轮缩放，⌘C 复制，双击或 Esc 关闭。 */
export function PinView({ image }: { image: string }) {
  const lastScale = useRef(0);

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); void invoke("pin_close"); }
      else if (event.metaKey && event.key.toLowerCase() === "c") { event.preventDefault(); void invoke("pin_copy"); }
    }
    function handleWheel(event: WheelEvent) {
      event.preventDefault();
      // 触控板滚动事件很密，限制频率
      const now = performance.now();
      if (now - lastScale.current < 30 || event.deltaY === 0) return;
      lastScale.current = now;
      void invoke("pin_scale", { factor: event.deltaY < 0 ? 1.08 : 1 / 1.08 });
    }
    window.addEventListener("keydown", handleKey);
    window.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("wheel", handleWheel);
    };
  }, []);

  return (
    <img className="pin-image" src={image} alt="贴图" draggable={false} title="拖动移动 · 滚轮缩放 · ⌘C 复制 · 双击或 Esc 关闭"
      onMouseDown={(event) => {
        if (event.button !== 0) return;
        // 第二次按下视为双击关闭，不再开始拖动
        if (event.detail >= 2) { void invoke("pin_close"); return; }
        void getCurrentWindow().startDragging();
      }} />
  );
}
