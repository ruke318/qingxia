pub mod manifest;
pub mod install;
pub mod management;

use manifest::{resolve_asset, PluginManifest};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::PathBuf, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager, State, Webview};

#[derive(Clone)]
struct Plugin {
    root: PathBuf,
    manifest: PluginManifest,
    icon: Option<String>,
}

#[derive(Clone)]
struct Instance {
    /// 128 位随机实例令牌，出现在 iframe 地址首段；插件身份只由它决定。
    token: String,
    plugin_id: String,
    command_id: String,
    ready: bool,
    requested: bool,
}

#[derive(Default)]
pub struct PluginState {
    plugins: Mutex<BTreeMap<String, Plugin>>,
    active: Mutex<Option<Instance>>,
}

/// 插件资源响应的 CSP（方案 10.2，PL11 实测）：沙箱不透明来源下 `'self'` 不匹配，只能写完整源。
/// 宿主主题样式表：插件只引用其中的颜色变量，调整外观时只改这一份，插件无需改动。
const THEME_CSS: &str = include_str!("../../../packages/plugin-sdk/theme.css");
/// 主题样式表在插件资源中的保留路径，插件自身不能使用。
const THEME_PATH: &str = "__qingbox/theme.css";

/// 在 HTML 的 `<head>` 开头插入主题样式表，插件自己的样式在其后加载，可按需覆盖。
fn inject_theme(html: &[u8], token: &str) -> Vec<u8> {
    let link = format!("<link rel=\"stylesheet\" href=\"/{token}/{THEME_PATH}\">");
    let text = String::from_utf8_lossy(html);
    let insert_at = text.to_ascii_lowercase().find("<head").and_then(|start| text[start..].find('>').map(|end| start + end + 1)).unwrap_or(0);
    let mut output = String::with_capacity(text.len() + link.len());
    output.push_str(&text[..insert_at]);
    output.push_str(&link);
    output.push_str(&text[insert_at..]);
    output.into_bytes()
}

const PLUGIN_CSP: &str = "default-src 'none'; script-src qingbox-plugin://localhost; style-src qingbox-plugin://localhost 'unsafe-inline'; img-src qingbox-plugin://localhost data:; font-src qingbox-plugin://localhost; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/// 插件网关的结构化错误；`code` 取值与 SDK `protocol.ts` 的 `QINGBOX_ERROR_CODES` 一致，`message` 为中文。
/// Hosts、剪贴板等宿主系统服务也直接返回本类型，在出错位置给出准确的错误码。
#[derive(Debug, Serialize)]
pub struct CallError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl CallError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self { Self { code, message: message.into() } }
}

// 未指定错误码的中文错误原样透传，错误码归为 internal。
impl From<String> for CallError {
    fn from(message: String) -> Self { Self::new("internal", message) }
}

impl From<&str> for CallError {
    fn from(message: &str) -> Self { Self::new("internal", message) }
}

/// 生成 128 位随机实例令牌（32 位十六进制）。
fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "生成插件实例令牌失败")?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandEntry {
    id: String,
    title: String,
    plugin_name: String,
    keywords: Vec<String>,
    icon: Option<String>,
}

pub fn initialize(app: &AppHandle) -> Result<(), String> {
    app.state::<crate::AppState>().database.lock().map_err(|_| "插件数据库不可用")?
        .execute_batch("CREATE TABLE IF NOT EXISTS plugin_data (plugin_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(plugin_id,key));")
        .map_err(|error| format!("初始化插件数据失败：{error}"))?;
    management::reload_on_main(app)?;
    Ok(())
}

pub fn has_enabled_permission(app: &AppHandle, permission: &str) -> bool {
    app.state::<PluginState>().plugins.lock().is_ok_and(|plugins| plugins.values().any(|plugin| plugin.manifest.permissions.iter().any(|value| value == permission)))
}

#[tauri::command]
pub fn list_plugin_commands(state: State<'_, PluginState>) -> Result<Vec<CommandEntry>, String> {
    let plugins = state.plugins.lock().map_err(|_| "插件目录不可用")?;
    Ok(plugins.values().flat_map(|plugin| plugin.manifest.commands.iter().map(|command| CommandEntry {
        id: format!("{}:{}", plugin.manifest.id, command.id),
        title: command.title.clone(),
        plugin_name: plugin.manifest.name.clone(),
        keywords: command.keywords.clone(),
        icon: plugin.icon.clone(),
    })).collect())
}

// 插件 iframe 随主页面切换视图或窗口隐藏而不可见，这里只撤销“等待显示”状态，实例保留。
pub fn hide_active(app: &AppHandle) {
    if let Ok(mut active) = app.state::<PluginState>().active.lock() {
        if let Some(instance) = active.as_mut() { instance.requested = false; }
    }
}

#[tauri::command]
pub fn leave_plugin(app: AppHandle) {
    hide_active(&app);
    if let Some(main) = app.get_webview("main") { let _ = main.set_focus(); }
}

pub fn restore_after_authorization(app: &AppHandle, token: &str) {
    let handle = app.clone();
    let token = token.to_string();
    let _ = app.run_on_main_thread(move || {
        // 用户已打开主入口或其他插件时，不抢回界面。
        if handle.get_window("main").is_some_and(|window| window.is_visible().unwrap_or(false)) { return }
        let restore = handle.state::<PluginState>().active.lock().map(|mut active| {
            if let Some(instance) = active.as_mut().filter(|instance| instance.token == token && instance.ready) {
                instance.requested = true;
                true
            } else { false }
        }).unwrap_or(false);
        if restore { let _ = present_on_main(&handle, &token); }
    });
}

#[tauri::command]
pub fn open_plugin(app: AppHandle, command: String) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if let Err(error) = open_on_main(&handle, &command) {
            let _ = handle.emit_to("main", "plugin-error", error);
        }
    }).map_err(|error| format!("打开插件失败：{error}"))
}

fn open_on_main(app: &AppHandle, command: &str) -> Result<(), String> {
    let (plugin_id, command_id) = command.split_once(':').ok_or("插件命令不正确")?;
    let state = app.state::<PluginState>();
    let plugin = state.plugins.lock().map_err(|_| "插件目录不可用")?.get(plugin_id).cloned().ok_or("插件不存在")?;
    if !plugin.manifest.commands.iter().any(|item| item.id == command_id) { return Err("插件命令不存在".into()) }
    let previous = state.active.lock().map_err(|_| "插件状态不可用")?.clone();
    if let Some(instance) = &previous {
        if instance.plugin_id == plugin_id && instance.command_id == command_id {
            if let Some(active) = state.active.lock().map_err(|_| "插件状态不可用")?.as_mut() { active.requested = true; }
            if instance.ready { present(app, &instance.token)?; }
            return Ok(())
        }
    }
    // 切换插件：新令牌立即取代旧令牌，旧实例的资源请求和调用随之失效；主页面收到新地址后替换 iframe。
    let token = new_token()?;
    *state.active.lock().map_err(|_| "插件状态不可用")? = Some(Instance {token: token.clone(), plugin_id: plugin_id.into(), command_id: command_id.into(), ready: false, requested: true});
    let mut url = tauri::Url::parse("qingbox-plugin://localhost/").map_err(|_| "插件入口地址不正确")?;
    url.set_path(&format!("{token}/{}", plugin.manifest.entry));
    if let Err(error) = app.emit_to("main", "plugin-load", json!({ "token": token, "url": url.as_str(), "command": command_id })) {
        *state.active.lock().map_err(|_| "插件状态不可用")? = None;
        return Err(format!("通知主入口加载插件失败：{error}"));
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(8)).await;
        let state = handle.state::<PluginState>();
        // 超时仍未 ready 时作废令牌；返回是否仍在等待显示。
        let timed_out = state.active.lock().ok().and_then(|mut active| {
            let requested = active.as_ref().filter(|current| current.token == token && !current.ready)?.requested;
            *active = None;
            Some(requested)
        });
        if let Some(requested) = timed_out {
            let _ = handle.emit_to("main", "plugin-closed", &token);
            if requested { let _ = handle.emit_to("main", "plugin-error", "插件加载超时，请重新打开"); }
        }
    });
    Ok(())
}

fn present(app: &AppHandle, token: &str) -> Result<(), String> {
    let handle = app.clone();
    let token = token.to_string();
    app.run_on_main_thread(move || {
        if let Err(error) = present_on_main(&handle, &token) { let _ = handle.emit_to("main", "plugin-error", error); }
    }).map_err(|error| format!("显示插件失败：{error}"))
}

fn present_on_main(app: &AppHandle, token: &str) -> Result<(), String> {
    let requested = app.state::<PluginState>().active.lock().map_err(|_| "插件状态不可用")?.as_ref().is_some_and(|instance| instance.token == token && instance.requested);
    if !requested { return Ok(()) }
    let main = app.get_window("main").ok_or("主入口不可用")?;
    // 主页面按令牌显示对应 iframe，并在显示后聚焦 iframe、下发 view.shown。
    app.emit_to("main", "plugin-opened", token).map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    crate::native_window::present_plugin(&main)?;
    #[cfg(not(target_os = "macos"))]
    { crate::resize_panel(&main, 670.0)?; main.show().map_err(|error| error.to_string())?; }
    if let Some(view) = app.get_webview("main") { view.set_focus().map_err(|error| error.to_string())?; }
    Ok(())
}

/// 资源授权：发起视图必须是 main，路径首段令牌必须对应当前实例；返回插件 ID 与解码后的包内相对路径。
fn authorize_resource(active: Option<&Instance>, label: &str, path: &str) -> Result<(String, String), String> {
    if label != "main" { return Err("无权访问插件资源".into()) }
    let (token, file) = path.strip_prefix('/').and_then(|rest| rest.split_once('/')).ok_or("插件资源地址不正确")?;
    let instance = active.filter(|instance| instance.token == token).ok_or("插件实例已失效，无权访问插件资源")?;
    Ok((instance.plugin_id.clone(), decode_resource_path(file)?))
}

pub fn resource(app: &AppHandle, label: &str, path: &str) -> tauri::http::Response<Vec<u8>> {
    let result = (|| -> Result<(Vec<u8>, &'static str), String> {
        let state = app.state::<PluginState>();
        let active = state.active.lock().map_err(|_| "插件状态不可用")?.clone();
        let (plugin_id, file) = authorize_resource(active.as_ref(), label, path)?;
        if file == THEME_PATH { return Ok((THEME_CSS.as_bytes().to_vec(), "text/css; charset=utf-8")) }
        let token = active.as_ref().map(|instance| instance.token.clone()).unwrap_or_default();
        let plugin = state.plugins.lock().map_err(|_| "插件目录不可用")?.get(&plugin_id).cloned().ok_or("插件不存在")?;
        let path = resolve_asset(&plugin.root, &file)?;
        let mime = match path.extension().and_then(|value| value.to_str()).unwrap_or("") {
            "html" => "text/html; charset=utf-8", "js" => "text/javascript; charset=utf-8",
            "css" => "text/css; charset=utf-8", "svg" => "image/svg+xml", "png" => "image/png",
            "json" => "application/json", "woff2" => "font/woff2", _ => "application/octet-stream",
        };
        let bytes = std::fs::read(path).map_err(|_| "读取插件资源失败")?;
        Ok((if mime.starts_with("text/html") { inject_theme(&bytes, &token) } else { bytes }, mime))
    })();
    let (status, body, mime) = match result {
        Ok((body, mime)) => (200, body, mime), Err(error) => (403, error.into_bytes(), "text/plain; charset=utf-8"),
    };
    // 沙箱 iframe 为不透明来源，Vite 产物的 <script type="module" crossorigin> 与 <link crossorigin>
    // 按跨域请求加载，缺少 CORS 头时不执行、不应用（PL12 探针实测）。授权已由“main + 令牌”完成。
    tauri::http::Response::builder().status(status).header("Content-Type", mime)
        .header("Content-Security-Policy", PLUGIN_CSP)
        .header("Access-Control-Allow-Origin", "*")
        .body(body).expect("构造插件资源响应失败")
}

/// 已启用插件命令的显示名称，用于快捷键冲突提示；单命令插件只显示插件名。命令不存在或插件未启用时为 `None`。
pub fn command_label(app: &AppHandle, command: &str) -> Option<String> {
    let (plugin_id, command_id) = command.split_once(':')?;
    let state = app.state::<PluginState>();
    let plugins = state.plugins.lock().ok()?;
    let plugin = plugins.get(plugin_id)?;
    let entry = plugin.manifest.commands.iter().find(|entry| entry.id == command_id)?;
    Some(if plugin.manifest.commands.len() == 1 { plugin.manifest.name.clone() } else { format!("{} · {}", plugin.manifest.name, entry.title) })
}

/// 插件网关：只接受主页面转发的调用，插件身份只由实例令牌决定。
#[tauri::command]
pub async fn plugin_call(app: AppHandle, webview: Webview, token: String, method: String, params: Value) -> Result<Value, CallError> {
    if webview.label() != "main" { return Err(CallError::new("permission_denied", "只有主入口可以转发插件调用")) }
    let instance = app.state::<PluginState>().active.lock().map_err(|_| "插件状态不可用")?.clone().filter(|instance| instance.token == token)
        .ok_or_else(|| CallError::new("permission_denied", "插件实例已失效"))?;
    let plugin = app.state::<PluginState>().plugins.lock().map_err(|_| "插件目录不可用")?.get(&instance.plugin_id).cloned()
        .ok_or_else(|| CallError::new("not_found", "插件不存在"))?;
    let permitted = |permission: &str| plugin.manifest.permissions.iter().any(|value| value == permission);
    let invalid = |message: &str| CallError::new("invalid_params", message);
    let command = format!("{}:{}", instance.plugin_id, instance.command_id);
    match method.as_str() {
        "clipboard.readText" => {
            if !permitted("clipboard.readText") { return Err(CallError::new("permission_denied", "插件没有读取文本剪贴板权限")) }
            let (sender, receiver) = tokio::sync::oneshot::channel();
            app.run_on_main_thread(move || {
                #[cfg(target_os = "macos")]
                let result = {
                    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
                    let pasteboard = NSPasteboard::generalPasteboard();
                    pasteboard.stringForType(unsafe { NSPasteboardTypeString })
                        .map(|value| value.to_string())
                        .ok_or_else(|| "剪贴板中没有文本内容".to_string())
                };
                #[cfg(not(target_os = "macos"))]
                let result: Result<String, String> = Err("当前平台尚未接入剪贴板读取".into());
                let _ = sender.send(result);
            }).map_err(|error| format!("调度读取剪贴板失败：{error}"))?;
            let text = receiver.await.map_err(|_| "读取剪贴板操作已取消")??;
            return Ok(json!(text));
        }
        "clipboard.list" | "clipboard.copy" => {
            if !permitted("clipboard.history") { return Err(CallError::new("permission_denied", "插件没有剪贴板历史权限")) }
            if method == "clipboard.list" {
                let kind = if params["kind"].as_str() == Some("all") { None } else { Some(serde_json::from_value(params["kind"].clone()).map_err(|_| invalid("剪贴板分类不正确"))?) };
                return Ok(serde_json::to_value(crate::clipboard::list(&app, kind, params["since"].as_u64())?).map_err(|_| "无法返回剪贴板记录")?);
            }
            crate::clipboard::copy(&app, params["id"].as_i64().filter(|id| *id > 0).ok_or_else(|| invalid("剪贴板记录标识不正确"))?).await?;
        }
        "hosts.get" | "hosts.save" => {
            let permission = if method == "hosts.get" { "hosts.read" } else { "hosts.write" };
            if !permitted(permission) { return Err(CallError::new("permission_denied", "插件没有所需的 Hosts 权限")) }
            let snapshot = if method == "hosts.get" { crate::hosts::get(&app).await? } else {
                let request = serde_json::from_value(params).map_err(|_| invalid("Hosts 分组参数不正确"))?;
                crate::hosts::save(&app, &instance.token, request).await?
            };
            return Ok(serde_json::to_value(snapshot).map_err(|_| "无法返回 Hosts 状态")?);
        }
        "view.ready" => {
            if let Some(active) = app.state::<PluginState>().active.lock().map_err(|_| "插件状态不可用")?.as_mut().filter(|active| active.token == instance.token) { active.ready = true; }
            present(&app, &instance.token)?;
        }
        "view.back" => { crate::show_launcher(&app); }
        "view.hide" => {
            crate::diag!("收起面板：插件请求 view.hide");
            hide_active(&app);
            webview.window().hide().map_err(|error| error.to_string())?;
            #[cfg(target_os = "macos")]
            crate::native_window::hide_app(&webview.window())?;
        }
        "view.drag" => { webview.window().start_dragging().map_err(|error| error.to_string())?; }
        "storage.get" | "storage.set" => {
            let key = params["key"].as_str().filter(|key| !key.is_empty() && key.len() <= 128).ok_or_else(|| invalid("存储键不正确"))?;
            let state = app.state::<crate::AppState>();
            let database = state.database.lock().map_err(|_| "插件数据库不可用")?;
            if method == "storage.get" {
                let text: Option<String> = database.query_row("SELECT value FROM plugin_data WHERE plugin_id=?1 AND key=?2", params![instance.plugin_id,key], |row| row.get(0)).optional().map_err(|error| format!("读取插件数据失败：{error}"))?;
                return Ok(text.map(|text| serde_json::from_str(&text).map_err(|_| "插件数据格式不正确")).transpose()?.unwrap_or(Value::Null));
            }
            let value = params.get("value").ok_or_else(|| invalid("缺少保存内容"))?.to_string();
            if value.len() > 16 * 1024 * 1024 { return Err(invalid("草稿超过 16 MB，无法保存")) }
            database.execute("INSERT INTO plugin_data(plugin_id,key,value) VALUES(?1,?2,?3) ON CONFLICT(plugin_id,key) DO UPDATE SET value=excluded.value", params![instance.plugin_id,key,value]).map_err(|error| format!("保存插件数据失败：{error}"))?;
        }
        "shortcuts.get" => { return Ok(json!(crate::shortcuts::saved(&app, &command)?)); }
        "shortcuts.set" => {
            let shortcut = params["shortcut"].as_str().map(str::to_string);
            let handle = app.clone();
            let token = instance.token.clone();
            let (sender, receiver) = tokio::sync::oneshot::channel();
            app.run_on_main_thread(move || {
                let valid = handle.state::<PluginState>().active.lock().map(|active| active.as_ref().is_some_and(|current| current.token == token)).unwrap_or(false);
                let result = if valid { crate::shortcuts::save(&handle, &command, shortcut.as_deref()).map_err(CallError::from) } else { Err(CallError::new("permission_denied", "插件实例已失效")) };
                let _ = sender.send(result);
            }).map_err(|error| format!("调度快捷键保存失败：{error}"))?;
            receiver.await.map_err(|_| "快捷键保存已取消")??;
        }
        "clipboard.writeText" => {
            if !permitted("clipboard.writeText") { return Err(CallError::new("permission_denied", "插件没有复制文本权限")) }
            let text = params["text"].as_str().ok_or_else(|| invalid("复制内容必须是文本"))?.to_string();
            let (sender, receiver) = tokio::sync::oneshot::channel();
            app.run_on_main_thread(move || {
                #[cfg(target_os = "macos")]
                let result = {
                    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
                    let pasteboard = NSPasteboard::generalPasteboard();
                    pasteboard.clearContents();
                    if pasteboard.setString_forType(&objc2_foundation::NSString::from_str(&text), unsafe { NSPasteboardTypeString }) { Ok(()) } else { Err("写入剪贴板失败".to_string()) }
                };
                #[cfg(not(target_os = "macos"))]
                let result: Result<(), String> = { let _ = text; Err("当前平台尚未接入剪贴板".into()) };
                let _ = sender.send(result);
            }).map_err(|error| format!("调度复制失败：{error}"))?;
            receiver.await.map_err(|_| "复制操作已取消")??;
        }
        _ => return Err(CallError::new("unsupported_method", format!("宿主不支持该插件调用：{method}"))),
    }
    Ok(Value::Null)
}

fn decode_resource_path(path: &str) -> Result<String, String> {
    let bytes = path.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'%' && (index + 2 >= bytes.len() || !bytes[index + 1].is_ascii_hexdigit() || !bytes[index + 2].is_ascii_hexdigit()) {
            return Err("插件资源地址编码不正确".into());
        }
    }
    let decoded = percent_encoding::percent_decode_str(path).decode_utf8().map_err(|_| "插件资源地址编码不正确")?;
    if decoded.contains('\0') { return Err("插件资源地址不正确".into()) }
    Ok(decoded.into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn 主题样式表插在_head_开头且插件样式在其后() {
        let html = inject_theme(b"<!doctype html><html><HEAD lang=\"zh\"><link rel=\"stylesheet\" href=\"./a.css\"></head></html>", "t1");
        let html = String::from_utf8(html).unwrap();
        assert!(html.contains("<HEAD lang=\"zh\"><link rel=\"stylesheet\" href=\"/t1/__qingbox/theme.css\"><link rel=\"stylesheet\" href=\"./a.css\">"));
        // 没有 head 时插在最前面。
        assert!(String::from_utf8(inject_theme(b"<p>hi</p>", "t2")).unwrap().starts_with("<link rel=\"stylesheet\" href=\"/t2/__qingbox/theme.css\"><p>"));
        assert!(THEME_CSS.contains("--qb-accent"));
    }

    #[test]
    fn 结构化错误按协议格式序列化且未指定错误码的中文错误归为内部错误() {
        assert_eq!(serde_json::to_value(CallError::new("not_found", "插件不存在")).unwrap(), json!({ "code": "not_found", "message": "插件不存在" }));
        let error = CallError::from("插件状态不可用");
        assert_eq!((error.code, error.message.as_str()), ("internal", "插件状态不可用"));
        assert_eq!(CallError::from(format!("读取插件数据失败：{}", "磁盘错误")).code, "internal");
    }

    #[test]
    fn 插件资源地址保留中文空格及特殊字符并拒绝错误编码() {
        let mut url = tauri::Url::parse("qingbox-plugin://localhost/").unwrap();
        url.set_path("页面/格式 化#?.html");
        assert_eq!(decode_resource_path(url.path()).unwrap(), "/页面/格式 化#?.html");
        assert!(decode_resource_path("/%GG").is_err());
        assert!(decode_resource_path("/%00").is_err());
        assert!(decode_resource_path("/%A").is_err());
    }

    fn instance(token: String) -> Instance {
        Instance { token, plugin_id: "json-tools".into(), command_id: "format".into(), ready: false, requested: true }
    }

    #[test]
    fn 实例令牌为一百二十八位随机十六进制() {
        let (first, second) = (new_token().unwrap(), new_token().unwrap());
        assert_eq!(first.len(), 32);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(first, second, "每次打开都应生成新令牌");
    }

    #[test]
    fn 资源授权只接受主视图与当前令牌并拒绝伪造过期令牌和路径穿越() {
        let current = instance(new_token().unwrap());
        let token = current.token.clone();
        assert_eq!(authorize_resource(Some(&current), "main", &format!("/{token}/assets/%E6%A0%BC%E5%BC%8F.js")).unwrap(), ("json-tools".to_string(), "assets/格式.js".to_string()));
        assert!(authorize_resource(Some(&current), "plugin-1", &format!("/{token}/index.html")).is_err(), "非主视图的请求必须被拒");
        assert!(authorize_resource(Some(&current), "main", "/00000000000000000000000000000000/index.html").is_err(), "伪造令牌必须被拒");
        assert!(authorize_resource(Some(&current), "main", "//index.html").is_err(), "空令牌必须被拒");
        assert!(authorize_resource(Some(&current), "main", "/index.html").is_err(), "缺少令牌段必须被拒");
        assert!(authorize_resource(None, "main", &format!("/{token}/index.html")).is_err(), "没有活动实例时必须被拒");
        // 切换、禁用或重新加载后旧令牌作废。
        let next = instance(new_token().unwrap());
        assert!(authorize_resource(Some(&next), "main", &format!("/{token}/index.html")).is_err(), "过期令牌必须被拒");

        let root = std::env::temp_dir().join(format!("qingbox-resource-{}-{}", std::process::id(), new_token().unwrap()));
        std::fs::create_dir_all(root.join("plugin")).unwrap();
        std::fs::write(root.join("plugin/index.html"), "页面").unwrap();
        std::fs::write(root.join("secret.txt"), "包外文件").unwrap();
        let resolve = |path: &str| authorize_resource(Some(&current), "main", &format!("/{token}/{path}")).and_then(|(_, file)| resolve_asset(&root.join("plugin"), &file));
        assert!(resolve("index.html").is_ok());
        for path in ["%2e%2e/secret.txt", "..%2Fsecret.txt", "/secret.txt", "", "%00"] {
            assert!(resolve(path).is_err(), "包外或非法路径必须被拒：{path}");
        }
        let _ = std::fs::remove_dir_all(&root);
    }
}
