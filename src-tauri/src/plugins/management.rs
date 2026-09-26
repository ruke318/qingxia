use super::{
    install::{install_directory, remove_directory}, manifest::{load_icon, load_plugin}, read_shortcut, register_shortcut, Plugin,
    PluginState,
};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use std::{
    collections::{BTreeMap, HashSet},
    path::PathBuf,
};
use tauri::{AppHandle, Emitter, Manager, Webview};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub enabled: bool,
    pub source: String,
    pub error: Option<String>,
    pub commands: Vec<PluginCommandInfo>,
    pub icon: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct PluginCommandInfo {
    pub id: String,
    pub title: String,
}

struct Discovered {
    info: PluginInfo,
    plugin: Option<Plugin>,
    root: PathBuf,
}

fn scan_paths(
    bases: &[(String, PathBuf)],
    disabled: &HashSet<String>,
) -> Result<Vec<Discovered>, String> {
    let mut discovered = BTreeMap::new();
    for (source, base) in bases {
        let entries = match std::fs::read_dir(base) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err("无法读取插件安装目录".into()),
        };
        let mut roots = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|_| "无法读取插件目录条目")?;
            // 安装暂存和回滚备份不是可加载插件。
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            if entry
                .file_type()
                .map_err(|_| "无法读取插件目录信息")?
                .is_dir()
            {
                roots.push(entry.path());
            }
        }
        roots.sort();
        for root in roots {
            let fallback = root
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            let item = match load_plugin(&root) {
                Ok(manifest) => {
                    let icon = load_icon(&root, manifest.icon.as_deref()).unwrap_or(None);
                    let info = PluginInfo {
                        id: manifest.id.clone(),
                        name: manifest.name.clone(),
                        version: manifest.version.clone(),
                        enabled: !disabled.contains(&manifest.id),
                        source: source.clone(),
                        error: None,
                        icon: icon.clone(),
                        commands: manifest
                            .commands
                            .iter()
                            .map(|command| PluginCommandInfo {
                                id: format!("{}:{}", manifest.id, command.id),
                                title: command.title.clone(),
                            })
                            .collect(),
                    };
                    Discovered {
                        info,
                        root: root.clone(),
                        plugin: Some(Plugin { root, manifest, icon }),
                    }
                }
                Err(error) => Discovered {
                    info: PluginInfo {
                        id: fallback.clone(),
                        name: fallback.clone(),
                        version: String::new(),
                        enabled: !disabled.contains(&fallback),
                        source: source.clone(),
                        error: Some(error),
                        commands: Vec::new(),
                        icon: None,
                    },
                    plugin: None,
                    root,
                },
            };
            // 后扫描的本地副本覆盖同标识自带插件，启用状态仍按标识保存。
            discovered.insert(item.info.id.clone(), item);
        }
    }
    Ok(discovered.into_values().collect())
}

fn scan(app: &AppHandle) -> Result<Vec<Discovered>, String> {
    let bundled = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/plugins")
    } else {
        app.path()
            .resource_dir()
            .map_err(|_| "无法定位自带插件目录")?
            .join("plugins")
    };
    let local = app
        .path()
        .app_data_dir()
        .map_err(|_| "无法定位插件安装目录")?
        .join("plugins");
    let state = app.state::<crate::AppState>();
    let database = state.database.lock().map_err(|_| "插件数据库不可用")?;
    let mut statement = database
        .prepare("SELECT key FROM settings WHERE key LIKE 'plugin_enabled:%' AND value='false'")
        .map_err(|_| "读取插件启用状态失败")?;
    let disabled = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| "读取插件启用状态失败")?
        .map(|row| row.map(|key| key.trim_start_matches("plugin_enabled:").to_string()))
        .collect::<Result<HashSet<_>, _>>()
        .map_err(|_| "读取插件启用状态失败")?;
    drop(statement);
    drop(database);
    scan_paths(
        &[("bundled".into(), bundled), ("local".into(), local)],
        &disabled,
    )
}

pub(super) fn reload_on_main(app: &AppHandle) -> Result<Vec<PluginInfo>, String> {
    let discovered = scan(app)?;
    let app_state = app.state::<crate::AppState>();
    let _shortcuts = app_state
        .shortcut_update
        .lock()
        .map_err(|_| "快捷键状态不可用")?;
    let state = app.state::<PluginState>();
    let previous = state.shortcuts.lock().map_err(|_| "快捷键状态不可用")?.clone();
    let mut removed: Vec<(String, String)> = Vec::new();
    for (id, shortcut) in previous {
        if app.global_shortcut().unregister(shortcut.as_str()).is_err() {
            for (id, shortcut) in &removed { let _ = register_shortcut(app, id, shortcut); }
            return Err("解除旧插件快捷键失败，插件未重新加载".into());
        }
        removed.push((id, shortcut));
    }
    state.shortcuts.lock().map_err(|_| "快捷键状态不可用")?.clear();
    // 禁用、重新加载都作废当前实例令牌，主页面据此销毁 iframe。
    let active = state.active.lock().map_err(|_| "插件状态不可用")?.take();
    if let Some(active) = active {
        if active.requested { let _ = app.emit_to("main", "show-settings", ()); }
        let _ = app.emit_to("main", "plugin-closed", &active.token);
    }
    let mut plugins = BTreeMap::new();
    let mut infos = Vec::new();
    for mut item in discovered {
        if item.info.enabled {
            if let Some(plugin) = item.plugin {
                for command in &item.info.commands {
                    if let Some(shortcut) = read_shortcut(app, &command.id)? {
                        if let Err(error) = register_shortcut(app, &command.id, &shortcut) {
                            item.info.error = Some(format!("快捷键未恢复：{error}"));
                        }
                    }
                }
                plugins.insert(item.info.id.clone(), plugin);
            }
        }
        infos.push(item.info);
    }
    *state.plugins.lock().map_err(|_| "插件目录不可用")? = plugins;
    let _ = app.emit_to("main", "plugins-changed", ());
    Ok(infos)
}

fn require_main(webview: &Webview) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("只有主入口可以管理插件".into());
    }
    Ok(())
}

async fn on_main<T: Send + 'static>(
    app: &AppHandle,
    operation: impl FnOnce(&AppHandle) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = sender.send(operation(&handle));
    })
    .map_err(|_| "无法调度插件管理操作")?;
    receiver.await.map_err(|_| "插件管理操作已取消")?
}

#[tauri::command]
pub async fn list_plugins(app: AppHandle, webview: Webview) -> Result<Vec<PluginInfo>, String> {
    require_main(&webview)?;
    on_main(&app, |app| {
        Ok(scan(app)?.into_iter().map(|item| item.info).collect())
    })
    .await
}

#[tauri::command]
pub async fn reload_plugins(app: AppHandle, webview: Webview) -> Result<Vec<PluginInfo>, String> {
    require_main(&webview)?;
    on_main(&app, reload_on_main).await
}

#[tauri::command]
pub async fn remove_plugin(app: AppHandle, webview: Webview, id: String) -> Result<Vec<PluginInfo>, String> {
    require_main(&webview)?;
    on_main(&app, move |app| {
        let item = scan(app)?.into_iter().find(|item| item.info.id == id).ok_or("插件不存在")?;
        if item.info.source != "local" { return Err("内置插件不能移除，可以使用开关停用".into()); }
        let base = app.path().app_data_dir().map_err(|_| "无法定位插件安装目录")?.join("plugins");
        // 重新加载会注销快捷键、作废实例令牌并刷新搜索结果；保留数据库中的草稿和偏好。
        remove_directory(&base, &item.root, || reload_on_main(app))
    }).await
}

#[tauri::command]
pub async fn set_plugin_enabled(
    app: AppHandle,
    webview: Webview,
    id: String,
    enabled: bool,
) -> Result<Vec<PluginInfo>, String> {
    require_main(&webview)?;
    on_main(&app, move |app| {
        let items = scan(app)?;
        let item = items.iter().find(|item| item.info.id == id).ok_or("插件不存在")?;
        if enabled && item.plugin.is_none() { return Err("插件描述或资源有误，修复后才能启用".into()); }
        let key = format!("plugin_enabled:{id}");
        let state = app.state::<crate::AppState>();
        let old: Option<String> = {
            let database = state.database.lock().map_err(|_| "插件数据库不可用")?;
            let old = database.query_row("SELECT value FROM settings WHERE key=?1", params![key], |row| row.get(0))
                .optional().map_err(|_| "读取插件启用状态失败")?;
            database.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, enabled.to_string()])
                .map_err(|_| "保存插件启用状态失败")?;
            old
        };
        match reload_on_main(app) {
            Ok(infos) => Ok(infos),
            Err(error) => {
                let database = state.database.lock().map_err(|_| "插件数据库不可用")?;
                let restored = if let Some(old) = old {
                    database.execute("UPDATE settings SET value=?2 WHERE key=?1", params![key, old])
                } else { database.execute("DELETE FROM settings WHERE key=?1", params![key]) };
                drop(database);
                restored.map_err(|_| "修改插件状态失败，恢复原状态也失败")?;
                let _ = reload_on_main(app);
                Err(error)
            }
        }
    }).await
}

#[cfg(target_os = "macos")]
fn choose_directory() -> Result<Option<PathBuf>, String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSModalResponseOK, NSOpenPanel};
    use objc2_foundation::NSString;

    let marker = MainThreadMarker::new().ok_or("目录选择器必须在主线程打开")?;
    #[allow(deprecated)]
    NSApplication::sharedApplication(marker).activateIgnoringOtherApps(true);
    let panel = NSOpenPanel::openPanel(marker);
    panel.setCanChooseDirectories(true);
    panel.setCanChooseFiles(false);
    panel.setAllowsMultipleSelection(false);
    panel.setCanCreateDirectories(false);
    panel.setResolvesAliases(false);
    panel.setMessage(Some(&NSString::from_str(
        "选择包含 manifest.json 的插件目录",
    )));
    panel.setPrompt(Some(&NSString::from_str("导入插件")));
    if panel.runModal() != NSModalResponseOK {
        return Ok(None);
    }
    let path = panel
        .URL()
        .and_then(|url| url.path())
        .ok_or("无法读取选中的插件目录")?;
    Ok(Some(PathBuf::from(path.to_string())))
}

#[cfg(not(target_os = "macos"))]
fn choose_directory() -> Result<Option<PathBuf>, String> {
    Err("当前平台尚未接入插件目录选择器".into())
}

#[tauri::command]
pub async fn import_plugin(app: AppHandle, webview: Webview) -> Result<Vec<PluginInfo>, String> {
    require_main(&webview)?;
    let source = on_main(&app, |app| {
        super::hide_active(app);
        if let Some(window) = app.get_window("main") { let _ = window.hide(); }
        let selected = choose_directory();
        crate::show_settings(app);
        selected
    })
    .await?;
    if let Some(source) = source {
        let base = app
            .path()
            .app_data_dir()
            .map_err(|_| "无法定位插件安装目录")?
            .join("plugins");
        tauri::async_runtime::spawn_blocking(move || install_directory(&source, &base))
            .await
            .map_err(|_| "插件安装工作线程失败")??;
        on_main(&app, reload_on_main).await
    } else {
        on_main(&app, |app| {
            Ok(scan(app)?.into_iter().map(|item| item.info).collect())
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 移除命令已生成权限且仅向主入口开放() {
        let manifests: serde_json::Value = serde_json::from_str(include_str!("../../gen/schemas/acl-manifests.json")).unwrap();
        let capability: serde_json::Value = serde_json::from_str(include_str!("../../capabilities/default.json")).unwrap();
        assert_eq!(manifests["__app-acl__"]["permissions"]["allow-remove-plugin"]["commands"]["allow"], serde_json::json!(["remove_plugin"]));
        assert_eq!(capability["webviews"], serde_json::json!(["main"]));
        assert!(capability["permissions"].as_array().unwrap().contains(&serde_json::json!("allow-remove-plugin")));
    }

    #[test]
    fn 管理扫描保留错误禁用信息且本地覆盖自带版本() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("qingbox-management-{}-{nonce}", std::process::id()));
        struct Cleanup(PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        std::fs::create_dir(&root).unwrap();
        let _cleanup = Cleanup(root.clone());
        for (source, version) in [("bundled", "1.0"), ("local", "2.0")] {
            let directory = root.join(source).join("json-tools");
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(directory.join("index.html"), "页面").unwrap();
            std::fs::write(directory.join("manifest.json"), serde_json::json!({
                "id":"json-tools", "name":"JSON 格式化", "version":version, "apiVersion":1, "entry":"index.html",
                "commands":[{"id":"format","title":"格式化","keywords":[]}], "permissions":[]
            }).to_string()).unwrap();
        }
        std::fs::create_dir(root.join("local/broken")).unwrap();
        std::fs::create_dir(root.join("local/.qingbox-install-hidden")).unwrap();
        let items = scan_paths(
            &[
                ("bundled".into(), root.join("bundled")),
                ("local".into(), root.join("local")),
            ],
            &HashSet::from(["json-tools".to_string()]),
        )
        .unwrap();
        assert_eq!(items.len(), 2, "暂存目录应被跳过，同标识只显示一个版本");
        let plugin = items
            .iter()
            .find(|item| item.info.id == "json-tools")
            .unwrap();
        assert_eq!(plugin.info.source, "local");
        assert_eq!(plugin.info.version, "2.0");
        assert!(!plugin.info.enabled, "禁用状态应按标识沿用");
        assert_eq!(plugin.info.commands[0].id, "json-tools:format");
        let broken = items.iter().find(|item| item.info.id == "broken").unwrap();
        assert!(
            broken.info.error.is_some() && broken.plugin.is_none(),
            "错误插件要显示原因而不参与加载"
        );
    }
}
