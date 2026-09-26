import { useEffect, useRef } from "react";
import { pluginCall } from "../../lib/bridge";
import { connectPlugin, type PluginConnection } from "./bridge";

const darkScheme = () => window.matchMedia("(prefers-color-scheme: dark)");
const currentTheme = () => (darkScheme().matches ? "dark" : "light");

interface Props {
  token: string;
  url: string;
  command?: string;
  /** 每次 Rust 显示该实例（view.ready 之后）加一；为 0 表示仍在加载。 */
  shown: number;
}

/** 插件内容区的沙箱 iframe（方案 10.2）；由父组件以令牌为 key 渲染，切换或作废时整体销毁。 */
export function PluginFrame({ token, url, command, shown }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const connection = useRef<PluginConnection | null>(null);

  useEffect(() => {
    // 先让 iframe 所在 frame 取得焦点，插件脚本挂载时的 focus() 才能生效（PL11：未聚焦时脚本聚焦不稳定）
    frame.current?.focus();
    const media = darkScheme();
    const changed = () => connection.current?.emit("theme.changed", { theme: currentTheme() });
    media.addEventListener("change", changed);
    return () => {
      media.removeEventListener("change", changed);
      // 销毁时关闭端口，迟到的调用结果随之丢弃
      connection.current?.close();
      connection.current = null;
    };
  }, []);

  useEffect(() => {
    if (!shown) return;
    // 每次显示都聚焦 iframe 并下发 view.shown，插件可据此把焦点放到自己的编辑器
    frame.current?.focus();
    connection.current?.emit("view.shown");
  }, [shown]);

  return (
    <iframe
      ref={frame}
      className={`plugin-frame${shown ? "" : " loading"}`}
      title="插件"
      src={url}
      sandbox="allow-scripts"
      allow=""
      onLoad={() => {
        // 每次加载（含插件自行刷新）重新握手，旧端口作废
        connection.current?.close();
        const target = frame.current?.contentWindow;
        connection.current = target ? connectPlugin(target, { token, theme: currentTheme(), locale: "zh-CN", command, call: pluginCall }) : null;
      }}
    />
  );
}
