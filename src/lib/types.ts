/** 快捷键设置页的一行：唤起、插件全屏或某个插件命令。 */
export interface ShortcutRow {
  /** `launcher`、`fullscreen` 或完整命令标识 `插件id:命令id`。 */
  id: string;
  /** 分组名：“轻匣”或插件名称。 */
  group: string;
  title: string;
  /** `global` 为全局快捷键，`panel` 只在面板内生效。 */
  scope: "global" | "panel";
  /** 唤起与全屏的默认值；插件命令为 `null`。 */
  defaultValue: string | null;
  /** 插件清单中的建议值。 */
  suggested: string | null;
  /** 已保存的值，插件停用时仍保留。 */
  saved: string | null;
  /** 当前实际生效的值。 */
  active: string | null;
  enabled: boolean;
  error: string | null;
}

export interface FileResult {
  name: string;
  path: string;
  parent: string;
  kind: "application" | "directory" | "file";
}

export interface QueryResponse {
  requestId: number;
  items: FileResult[];
  notice: string | null;
}

export interface PluginCommand {
  id: string;
  title: string;
  pluginName: string;
  keywords: string[];
  icon: string | null;
}

export interface PluginResult {
  name: string;
  path: string;
  parent: string;
  kind: "plugin";
  icon: string | null;
}

export type SearchResult = FileResult | PluginResult;
