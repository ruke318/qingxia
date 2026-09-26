import { createTransport } from "./transport.ts";

export * from "./protocol.ts";
export { QingboxError } from "./transport.ts";

// 是否在轻匣内由所处环境决定：iframe 中经宿主握手后的端口调用，顶层窗口为浏览器预览
const transport = createTransport(window);
const desktop = transport.embedded;
const call = transport.call;

export interface HostsGroup { id: string; name: string; content: string; enabled: boolean }
export interface HostsSnapshot { groups: HostsGroup[]; systemHosts: string; version: string; synced: boolean; notice: string | null }
export type ClipboardKind = "text" | "image" | "file";
export type ClipboardCategory = "all" | ClipboardKind;
export interface ClipboardRecord { id: number; kind: ClipboardKind; preview: string; createdAt: number; bytes: number; width: number; height: number; thumbnail: string | null; files: string[] }
export interface ClipboardSnapshot { revision: number; items: ClipboardRecord[] | null; counts: Record<ClipboardKind, number>; notice: string | null }

export const qingbox = {
  hosts: {
    get: async (): Promise<HostsSnapshot> => {
      if (!desktop) throw new Error("请在轻匣桌面应用中查看系统 Hosts");
      return call("hosts.get");
    },
    save: async (groups: HostsGroup[], version: string): Promise<HostsSnapshot> => {
      if (!desktop) throw new Error("请在轻匣桌面应用中切换系统 Hosts");
      return call("hosts.save", { groups, version });
    },
  },
  view: {
    ready: async () => { if (desktop) await call<void>("view.ready"); },
    /** 本次打开所用的命令 ID；浏览器预览或宿主未提供时为 null。 */
    command: async (): Promise<string | null> => (await transport.init)?.command ?? null,
    back: async () => { if (desktop) await call<void>("view.back"); else window.history.back(); },
    hide: async () => { if (desktop) await call<void>("view.hide"); },
    startDragging: async () => { if (desktop) await call<void>("view.drag"); },
  },
  clipboard: {
    readText: async (): Promise<string> => {
      if (desktop) return call<string>("clipboard.readText");
      return window.navigator.clipboard.readText();
    },
    list: async (kind: ClipboardCategory, since?: number): Promise<ClipboardSnapshot> => {
      if (!desktop) throw new Error("请在轻匣桌面应用中查看剪贴板历史");
      return call("clipboard.list", { kind, since });
    },
    copy: async (id: number): Promise<void> => {
      if (!desktop) throw new Error("请在轻匣桌面应用中复制历史记录");
      await call("clipboard.copy", { id });
    },
    writeText: async (text: string) => {
      if (desktop) await call<void>("clipboard.writeText", { text });
      else await window.navigator.clipboard.writeText(text);
    },
  },
  storage: {
    get: async <T>(key: string): Promise<T | null> => {
      if (desktop) return call<T | null>("storage.get", { key });
      const value = window.localStorage.getItem(`qingbox-json-preview:${key}`);
      return value === null ? null : JSON.parse(value) as T;
    },
    set: async (key: string, value: unknown): Promise<void> => {
      if (desktop) await call<void>("storage.set", { key, value });
      else window.localStorage.setItem(`qingbox-json-preview:${key}`, JSON.stringify(value));
    },
  },
  shortcuts: {
    get: async (): Promise<string | null> => desktop ? call("shortcuts.get") : null,
    set: async (shortcut: string | null): Promise<void> => {
      if (!desktop) throw new Error("请在轻匣桌面应用中设置全局快捷键");
      await call<void>("shortcuts.set", { shortcut });
    },
  },
  events: {
    /** 订阅宿主事件（如 `view.shown`、`theme.changed`），返回取消订阅函数；浏览器预览中不会触发。 */
    on: transport.on,
  },
};
