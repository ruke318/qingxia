import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { PluginCommand, QueryResponse, ShortcutRow } from "./types";

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

export async function listShortcuts(): Promise<ShortcutRow[]> {
  return isDesktop ? invoke("list_shortcuts") : [];
}

/** 保存或清除一项快捷键（`null` 表示清除），返回保存后的全部行。 */
export async function saveShortcutBinding(id: string, shortcut: string | null): Promise<ShortcutRow[]> {
  if (!isDesktop) throw new Error("请在桌面应用中设置快捷键");
  return invoke("save_shortcut_binding", { id, shortcut });
}

/** 录制期间宿主不执行已绑定的快捷键，改为经 `shortcut-recorded` 回报组合。 */
export async function setShortcutRecording(recording: boolean): Promise<void> {
  if (isDesktop) await invoke("set_shortcut_recording", { recording });
}

/** 录制时按下了轻匣已注册的全局快捷键，载荷为规范形式的组合。 */
export async function onShortcutRecorded(callback: (shortcut: string) => void): Promise<() => void> {
  return isDesktop ? listen<string>("shortcut-recorded", (event) => callback(event.payload)) : () => {};
}

/** 任一入口（设置页或插件）保存快捷键、插件重新加载后触发。 */
export async function onShortcutsChanged(callback: () => void): Promise<() => void> {
  return isDesktop ? listen("shortcuts-changed", callback) : () => {};
}

/** 宿主内置截图：收起主面板后开始截图；系统版本不满足时拒绝并给出原因。 */
export async function startScreenshot(): Promise<void> {
  if (!isDesktop) throw new Error("请在桌面应用中截图");
  await invoke("start_screenshot_command");
}

/** 宿主内置录屏：声音选择只在本次录屏中生效。 */
export async function startRecording(): Promise<void> {
  if (!isDesktop) throw new Error("请在桌面应用中录屏");
  await invoke("start_recording_command");
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

/** 唤起主入口；载荷为宿主附带的提示（如截图缺少权限），没有时为 `null`。 */
export async function onLauncherFocus(callback: (notice: string | null) => void): Promise<() => void> {
  if (!isDesktop) return () => {};
  return listen<string | null>("launcher-focus", (event) => callback(event.payload ?? null));
}

export async function onShowSettings(callback: () => void): Promise<() => void> {
  if (!isDesktop) return () => {};
  return listen("show-settings", callback);
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
