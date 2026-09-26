import { after } from "node:test";
import { MessageChannel, type MessagePort } from "node:worker_threads";

// 打开的端口会阻止进程退出；断言失败时也要在全部用例结束后关闭
const channels: MessagePort[] = [];
after(() => { for (const port of channels) port.close(); });

type Handler = (event: { data: unknown; source: unknown; ports: MessagePort[] }) => void;

/** 模拟浏览器 window：只实现 SDK 用到的 parent 与 message 监听。 */
export class MockWindow {
  parent: unknown;
  handlers = new Set<Handler>();
  store = new Map<string, string>();
  localStorage = { getItem: (key: string) => this.store.get(key) ?? null, setItem: (key: string, value: string) => { this.store.set(key, value); } };
  copied: string[] = [];
  history = { backCount: 0, back: () => { this.history.backCount += 1; } };
  navigator = { clipboard: { readText: async () => this.copied.at(-1) ?? "", writeText: async (text: string) => { this.copied.push(text); } } };

  constructor(parent?: unknown) {
    this.parent = parent ?? this;
  }

  addEventListener(type: string, handler: Handler) {
    if (type === "message") this.handlers.add(handler);
  }

  removeEventListener(type: string, handler: Handler) {
    if (type === "message") this.handlers.delete(handler);
  }

  emit(data: unknown, source: unknown, ports: MessagePort[] = []) {
    for (const handler of [...this.handlers]) handler({ data, source, ports });
  }
}

/** 模拟宿主一侧：持有 port1，记录收到的请求，可回传响应或事件。 */
export function createHost() {
  const { port1, port2 } = new MessageChannel();
  channels.push(port1);
  const requests: any[] = [];
  let wake: (() => void) | null = null;
  port1.on("message", (data) => { requests.push(data); wake?.(); });
  return {
    port: port2,
    requests,
    send: (message: unknown) => port1.postMessage(message),
    async take(count: number) {
      while (requests.length < count) await new Promise<void>((resolve) => { wake = resolve; });
      return requests.splice(0, count);
    },
  };
}

export const init = { qingbox: "init", protocol: 1, theme: "dark", locale: "zh-CN" };

/** 等待端口上的消息投递完成。 */
export const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
