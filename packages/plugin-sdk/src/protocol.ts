// 轻匣插件消息协议 v1（方案 10.3）。宿主与 SDK 共用本文件的类型和常量，协议本身才是稳定契约。

/** 当前协议主版本。 */
export const PROTOCOL_VERSION = 1;

/** 宿主外观：握手 `theme` 与 `theme.changed` 事件的 `payload.theme` 取值。 */
export type QingboxTheme = "light" | "dark";

/** 握手：宿主在 iframe `load` 后经 `window.postMessage` 发送，并转移一个 `MessagePort`。 */
export interface QingboxInitMessage {
  qingbox: "init";
  protocol: typeof PROTOCOL_VERSION;
  theme?: QingboxTheme;
  locale?: string;
  /** 本次打开所用的命令 ID（清单 `commands[].id`），插件可据此定位到对应界面。 */
  command?: string;
}

/** 插件经端口发给宿主的请求；`id` 由 SDK 自增，用于匹配响应。 */
export interface QingboxRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** 稳定错误码；`message` 为中文，可直接展示给用户。 */
export const QINGBOX_ERROR_CODES = ["permission_denied", "invalid_params", "unsupported_method", "not_found", "cancelled", "timeout", "internal"] as const;
export type QingboxErrorCode = typeof QINGBOX_ERROR_CODES[number];

export interface QingboxErrorPayload {
  code: QingboxErrorCode;
  message: string;
}

/** 宿主经端口回传的响应，`id` 与请求一致。 */
export type QingboxResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: QingboxErrorPayload };

/** 宿主经端口主动下发的事件，例如 `view.shown`、`theme.changed`。 */
export interface QingboxHostEvent {
  event: string;
  payload?: unknown;
}
