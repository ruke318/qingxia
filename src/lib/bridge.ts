import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AppSettings, PluginCommand, QueryResponse } from "./types";

export const isDesktop = isTauri();
let queryRequestId = 0;
let searchSession: Promise<number> | null = null;

function getSearchSession(): Promise<number> {
  if (searchSession) return searchSession;
  const request = invoke<number>("begin_search_session");
  searchSession = request;
  void request.catch(() => {
    if (searchSession === request) searchSession = null;
  });
  return request;
}

if (isDesktop) void getSearchSession().catch(() => {});

export function nextQueryRequestId(): number {
  return ++queryRequestId;
}

export async function getSettings(): Promise<AppSettings> {
  if (!isDesktop) return { shortcut: "Alt+Space", fullscreenShortcut: "Control+Super+F", shortcutError: null };
  return invoke("get_settings");
}

export async function saveShortcut(shortcut: string): Promise<AppSettings> {
  if (!isDesktop) throw new Error("请在桌面应用中设置全局快捷键");
  return invoke("save_shortcut", { shortcut });
}

export async function saveFullscreenShortcut(shortcut: string): Promise<AppSettings> {
  if (!isDesktop) throw new Error("请在桌面应用中设置快捷键");
  return invoke("save_fullscreen_shortcut", { shortcut });
}

export async function toggleFullscreen(): Promise<void> {
  if (isDesktop) await invoke("toggle_fullscreen");
}

/** 面板内按下全屏快捷键（焦点在插件 iframe 内也会触发）。 */
export async function onFullscreenToggle(callback: () => void): Promise<() => void> {
  if (!isDesktop) return () => {};
  return listen("panel-fullscreen-toggle", callback);
}

export async function hideLauncher(): Promise<void> {
  if (isDesktop) await invoke("hide_launcher");
}

export async function resizeLauncher(height: number): Promise<void> {
  if (isDesktop) await invoke("resize_launcher", { height });
}

export async function openSettings(): Promise<void> {
  if (isDesktop) await invoke("open_settings");

}

export async function closeSettings(): Promise<void> {
  if (isDesktop) await invoke("close_settings");

}

export async function onLauncherFocus(callback: () => void): Promise<() => void> {
  if (!isDesktop) return () => {};
  return listen("launcher-focus", callback);
}

export async function onShowSettings(callback: () => void): Promise<() => void> {
  if (!isDesktop) return () => {};
  return listen("show-settings", callback);
}

export async function onSettingsChanged(callback: (settings: AppSettings) => void): Promise<() => void> {
  if (!isDesktop) return () => {};
  return listen<AppSettings>("settings-changed", (event) => callback(event.payload));
}

export async function queryFiles(query: string, requestId: number): Promise<QueryResponse> {
  if (!isDesktop) return { requestId, items: [], notice: "请在桌面应用中搜索本机文件" };
  if (query.startsWith("/") || query.startsWith("~/") || query === "~") {
    return invoke("complete_directory", { query, requestId, limit: 50 });
  }
  const querySession = await getSearchSession();
  return invoke("search_files", { query, requestId, querySession, limit: 50 });
}

export async function openPath(path: string, reveal = false): Promise<void> {
  if (!isDesktop) throw new Error("请在桌面应用中打开本机文件");
  return invoke("open_path", { path, reveal });
}

export async function getApplicationIcon(path: string): Promise<string> {
  if (!isDesktop) throw new Error("请在桌面应用中读取应用图标");
  return invoke("get_application_icon", { path });
}

export async function listPluginCommands(): Promise<PluginCommand[]> {
  return isDesktop ? invoke("list_plugin_commands") : [];
}

export async function openPlugin(command: string): Promise<void> {
  if (!isDesktop) throw new Error("请在桌面应用中打开插件");
  await invoke("open_plugin", { command });
}

export async function onPluginError(callback: (message: string) => void): Promise<() => void> {
  return isDesktop ? listen<string>("plugin-error", (event) => callback(event.payload)) : () => {};
}

/** Rust 生成实例令牌后下发的插件地址：`qingbox-plugin://localhost/<令牌>/<入口>`。 */
export interface PluginLoad {
  token: string;
  url: string;
  /** 本次打开的命令 ID，经握手转交插件。 */
  command: string;
}

export async function onPluginLoad(callback: (load: PluginLoad) => void): Promise<() => void> {
  return isDesktop ? listen<PluginLoad>("plugin-load", (event) => callback(event.payload)) : () => {};
}

// 插件调用 view.ready 后显示，载荷为实例令牌。
export async function onPluginOpened(callback: (token: string) => void): Promise<() => void> {
  return isDesktop ? listen<string>("plugin-opened", (event) => callback(event.payload)) : () => {};
}

// 实例被作废（禁用、重新加载、加载超时），载荷为实例令牌。
export async function onPluginClosed(callback: (token: string) => void): Promise<() => void> {
  return isDesktop ? listen<string>("plugin-closed", (event) => callback(event.payload)) : () => {};
}

// 转发插件请求；插件身份只由令牌决定，invoke 本身永远不交给 iframe。
export function pluginCall(token: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  return invoke("plugin_call", { token, method, params });
}

export async function onPluginsChanged(callback: () => void): Promise<() => void> {
  return isDesktop ? listen("plugins-changed", callback) : () => {};
}

export async function leavePlugin(): Promise<void> {
  if (isDesktop) await invoke("leave_plugin");
}
