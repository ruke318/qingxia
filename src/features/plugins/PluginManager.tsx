import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { PluginIcon } from "../../components/PluginIcon";
import "./manager.css";

type PluginInfo = {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  source: "bundled" | "local";
  error: string | null;
  icon: string | null;
  commands: { id: string; title: string }[];
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function PluginManager() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [pending, setPending] = useState<string | null>("读取插件");
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [operationPlugin, setOperationPlugin] = useState<string | null>(null);
  const busy = useRef(true);
  const mounted = useRef(false);
  const desktop = isTauri();

  useEffect(() => {
    let active = true;
    mounted.current = true;
    if (!desktop) {
      setError("请在轻匣桌面应用内管理插件");
      setPending(null);
      busy.current = false;
    } else {
      void invoke<PluginInfo[]>("list_plugins")
        .then((items) => { if (active) setPlugins(items); })
        .catch((cause) => { if (active) setError(`读取插件失败：${errorMessage(cause)}`); })
        .finally(() => {
          if (active) { busy.current = false; setPending(null); }
        });
    }
    return () => { active = false; mounted.current = false; };
  }, [desktop]);

  async function perform(label: string, action: () => Promise<PluginInfo[] | void>, pluginId?: string) {
    if (busy.current || !desktop) return;
    busy.current = true;
    setPending(label);
    setError(null);
    setOperationPlugin(pluginId ?? null);
    try {
      const items = await action();
      if (mounted.current && items) setPlugins(items);
    } catch (cause) {
      if (mounted.current) setError(`${label}失败：${errorMessage(cause)}`);
    } finally {
      busy.current = false;
      if (mounted.current) setPending(null);
    }
  }

  const disabled = pending !== null || !desktop;

  return (
    <section className="plugin-manager" aria-labelledby="plugin-manager-title">
      <div className="plugin-manager-heading">
        <h2 id="plugin-manager-title">插件管理</h2>
        <div className="plugin-manager-tools">
          <button type="button" className="plugin-manager-reload" title="重新加载插件" aria-label="重新加载插件" disabled={disabled}
            onClick={() => void perform("重新加载", () => invoke<PluginInfo[]>("reload_plugins"))}>
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M16 8a6.2 6.2 0 1 0 .2 4M16 3.5V8h-4.5" /></svg>
          </button>
          <button type="button" className="plugin-manager-import" disabled={disabled}
            onClick={() => void perform("导入插件", () => invoke<PluginInfo[]>("import_plugin"))}>
            <span aria-hidden="true">＋</span> 本地导入
          </button>
        </div>
      </div>
      {error && !operationPlugin && <p className="plugin-manager-error" role="alert">{error}</p>}
      {pending && !operationPlugin && <p className="plugin-manager-status" role="status">{pending}…</p>}
      {!pending && !error && plugins.length === 0 && <p className="plugin-manager-empty">还没有插件，从本地导入一个开始使用。</p>}
      <ul className="plugin-manager-list" aria-busy={pending !== null} aria-label="已安装插件">
        {plugins.map((plugin) => {
          const command = plugin.commands[0];
          return (
            <li className="plugin-manager-item" key={plugin.id}>
              <div className="plugin-manager-row">
                <PluginIcon icon={plugin.icon} />
                <div className="plugin-manager-info">
                  <strong title={plugin.name}>{plugin.name}</strong>
                  <span>{plugin.version} · {plugin.source === "bundled" ? "内置" : "本地"}</span>
                </div>
                <button type="button" className="plugin-manager-open"
                  disabled={disabled || !plugin.enabled || !!plugin.error || !command}
                  title={command?.title ?? "此插件没有可打开的命令"}
                  onClick={() => {
                    if (command) void perform("打开插件", () => invoke<void>("open_plugin", { command: command.id }), plugin.id);
                  }}>打开</button>
                <button type="button" className="plugin-manager-switch" role="switch" aria-checked={plugin.enabled}
                  aria-label={`启用${plugin.name}`} title={plugin.enabled ? "停用插件" : "启用插件"} disabled={disabled}
                  onClick={() => void perform(plugin.enabled ? "停用插件" : "启用插件", () => invoke<PluginInfo[]>("set_plugin_enabled", { id: plugin.id, enabled: !plugin.enabled }), plugin.id)}>
                  <span />
                </button>
                {/* 固定宽度的移除位，内置插件留空，保证各行按钮对齐 */}
                <span className="plugin-manager-slot">
                  {plugin.source === "local" && <button type="button" className="plugin-manager-remove" disabled={disabled}
                    aria-label={`移除${plugin.name}`} onClick={() => setRemoving(plugin.id)}>移除</button>}
                </span>
              </div>
              {removing === plugin.id && <div className="plugin-manager-confirm" role="group" aria-label={`确认移除${plugin.name}`}>
                <span>移除“{plugin.name}”？保留插件数据和原始导入目录。</span>
                <button type="button" className="plugin-manager-open" disabled={disabled} onClick={() => setRemoving(null)}>取消</button>
                <button type="button" className="plugin-manager-remove" disabled={disabled}
                  onClick={() => void perform("移除插件", async () => {
                    const items = await invoke<PluginInfo[]>("remove_plugin", { id: plugin.id });
                    if (mounted.current) setRemoving(null);
                    return items;
                  }, plugin.id)}>确认移除</button>
              </div>}
              {operationPlugin === plugin.id && error && <p className="plugin-manager-item-error" role="alert">{error}</p>}
              {operationPlugin === plugin.id && pending && <p className="plugin-manager-status" role="status">{pending}…</p>}
              {plugin.error && <p className="plugin-manager-item-error">{plugin.error}</p>}
            </li>
          );
        })}
      </ul>
      <p className="plugin-manager-hint">选择包含 manifest.json 的插件文件夹</p>
    </section>
  );
}

export default PluginManager;
