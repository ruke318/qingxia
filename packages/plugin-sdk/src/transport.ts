import { PROTOCOL_VERSION, type QingboxErrorCode, type QingboxInitMessage, type QingboxRequest } from "./protocol.ts";

/** 宿主返回的失败，`code` 为协议错误码，`message` 为中文。 */
export class QingboxError extends Error {
  readonly code: QingboxErrorCode;

  constructor(code: QingboxErrorCode, message: string) {
    super(message);
    this.name = "QingboxError";
    this.code = code;
  }
}

type Pending = { resolve: (result: unknown) => void; reject: (error: unknown) => void };
type Listener = (payload: unknown) => void;

const isRecord = (value: unknown): value is Record<string, any> => typeof value === "object" && value !== null;

// 在 iframe 中等待宿主握手，之后只经转移过来的端口通信；顶层窗口视为浏览器预览（embedded 为 false）。
export function createTransport(win: Window) {
  const embedded = win.parent !== win;
  const pending = new Map<number, Pending>();
  const queue: QingboxRequest[] = [];
  const listeners = new Map<string, Set<Listener>>();
  let port: MessagePort | null = null;
  let nextId = 1;
  let resolveInit: (init: QingboxInitMessage | null) => void = () => {};
  // 握手得到的 init；浏览器预览没有宿主，立即得到 null
  const init = embedded ? new Promise<QingboxInitMessage | null>((resolve) => { resolveInit = resolve; }) : Promise.resolve(null);

  const send = (request: QingboxRequest) => {
    try {
      port!.postMessage(request);
    } catch {
      pending.get(request.id)?.reject(new QingboxError("invalid_params", "请求参数无法传递给宿主"));
      pending.delete(request.id);
    }
  };

  const receive = (data: unknown) => {
    if (!isRecord(data)) return;
    if (typeof data.id === "number") {
      const entry = pending.get(data.id);
      // 未知编号视为迟到或重复响应，直接忽略
      if (!entry) return;
      pending.delete(data.id);
      if (data.ok === true) entry.resolve(data.result);
      else entry.reject(new QingboxError(data.error?.code ?? "internal", data.error?.message ?? "宿主返回了无法识别的错误"));
    } else if (typeof data.event === "string") {
      for (const listener of [...(listeners.get(data.event) ?? [])]) listener(data.payload);
    }
  };

  const onWindowMessage = (event: MessageEvent) => {
    // 只接受来自 window.parent 的首条合法 init，且必须附带端口
    if (event.source !== win.parent) return;
    const data: unknown = event.data;
    if (!isRecord(data) || data.qingbox !== "init" || data.protocol !== PROTOCOL_VERSION || !event.ports[0]) return;
    port = event.ports[0];
    win.removeEventListener("message", onWindowMessage);
    port.onmessage = (message) => receive(message.data);
    for (const request of queue.splice(0)) send(request);
    resolveInit(data as QingboxInitMessage);
  };

  if (embedded) win.addEventListener("message", onWindowMessage);

  return {
    embedded,
    init,
    // 不设全局超时：hosts.save 需等待用户完成系统授权，可能持续数分钟
    call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const request: QingboxRequest = { id: nextId++, method, params };
        pending.set(request.id, { resolve: resolve as (result: unknown) => void, reject });
        if (port) send(request);
        else queue.push(request);
      });
    },
    on<T = unknown>(event: string, callback: (payload: T) => void): () => void {
      const listener = callback as Listener;
      const set = listeners.get(event) ?? new Set<Listener>();
      listeners.set(event, set);
      set.add(listener);
      return () => { set.delete(listener); };
    },
  };
}
