export interface AppSettings {
  shortcut: string;
  shortcutError: string | null;
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
