// 宿主侧插件消息桥（方案 10.3）：iframe 每次 load 后新建一条 MessageChannel，发送 init 并转移端口；
// 端口上的请求经 plugin_call 转给 Rust，按 id 回传结果或错误，宿主事件经同一端口下发。
// 本模块不依赖 Tauri，调用函数由外部注入；绝不向 iframe 传递 invoke、调用密钥或 __TAURI_INTERNALS__。
import {
  PROTOCOL_VERSION,
  QINGBOX_ERROR_CODES,
  type QingboxErrorCode,
  type QingboxErrorPayload,
  type QingboxHostEvent,
  type QingboxInitMessage,
  type QingboxResponse,
  type QingboxTheme,
} from "../../../packages/plugin-sdk/src/protocol.ts";

/** 把插件请求转给 Rust 网关，桌面端实现为 invoke("plugin_call", { token, method, params })。 */
export type PluginCall = (token: string, method: string, params: Record<string, unknown>) => Promise<unknown>;

export interface PluginConnection {
  /** 下发宿主事件，例如 `view.shown`、`theme.changed`；关闭后忽略。 */
  emit(event: string, payload?: unknown): void;
  /** 关闭端口；之后才返回的调用结果一律丢弃。 */
  close(): void;
}

export interface ConnectOptions {
  token: string;
  theme: QingboxTheme;
  locale: string;
  command?: string;
  call: PluginCall;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// Rust 网关的结构化错误原样透传；其他异常（如 Tauri 权限拒绝）归为 internal。
function toErrorPayload(error: unknown): QingboxErrorPayload {
  if (isRecord(error) && typeof error.message === "string" && (QINGBOX_ERROR_CODES as readonly unknown[]).includes(error.code)) {
    return { code: error.code as QingboxErrorCode, message: error.message };
  }
  return { code: "internal", message: `宿主处理插件调用失败：${error instanceof Error ? error.message : String(error)}` };
}

/** 与已加载的插件 iframe 握手。`target` 为 iframe.contentWindow。 */
export function connectPlugin(target: Pick<Window, "postMessage">, options: ConnectOptions): PluginConnection {
  const { port1, port2 } = new MessageChannel();
  let open = true;
  const post = (message: QingboxResponse | QingboxHostEvent) => {
    if (open) port1.postMessage(message);
  };

  port1.onmessage = (event: MessageEvent) => {
    const data: unknown = event.data;
    // 没有数字 id 的消息无法回复，直接忽略
    if (!isRecord(data) || typeof data.id !== "number") return;
    const id = data.id;
    if (typeof data.method !== "string" || (data.params !== undefined && !isRecord(data.params))) {
      post({ id, ok: false, error: { code: "invalid_params", message: "插件请求格式不正确" } });
      return;
    }
    options.call(options.token, data.method, (data.params ?? {}) as Record<string, unknown>).then(
      (result) => post({ id, ok: true, result }),
      (error: unknown) => post({ id, ok: false, error: toErrorPayload(error) }),
    );
  };

  const init: QingboxInitMessage = { qingbox: "init", protocol: PROTOCOL_VERSION, theme: options.theme, locale: options.locale, ...(options.command ? { command: options.command } : {}) };
  // 沙箱 iframe 是不透明来源，目标来源只能写 "*"；端口只转移给这一个 iframe 窗口
  target.postMessage(init, "*", [port2]);

  return {
    emit(event, payload) {
      post({ event, payload });
    },
    close() {
      open = false;
      port1.onmessage = null;
      port1.close();
    },
  };
}
