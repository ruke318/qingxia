#[cfg(target_os = "macos")]
mod application_icon;
mod contracts;
#[cfg(target_os = "macos")]
mod native_window;
mod search;
mod plugins;
mod hosts;
mod clipboard;
pub use hosts::run_helper;

use std::{fs, path::PathBuf, sync::Mutex};

use rusqlite::{params, Connection};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
};
use tauri::{AppHandle, Emitter, Manager, State, Window, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::contracts::{AppSettings, FileResult, QueryResponse};

const DEFAULT_SHORTCUT: &str = "Alt+Space";
const DEFAULT_FULLSCREEN_SHORTCUT: &str = "Control+Super+F";
const LAUNCHER_HEIGHT: f64 = 60.0;
const LAUNCHER_MIN_WIDTH: f64 = 900.0;

struct AppState {
    database: Mutex<Connection>,
    shortcut_error: Mutex<Option<String>>,
    shortcut_update: Mutex<()>,
}

fn setting(state: &AppState, key: &str, default: &str) -> String {
    state
        .database
        .lock()
        .expect("设置数据库锁已中毒")
        .query_row("SELECT value FROM settings WHERE key = ?1", params![key], |row| row.get::<_, String>(0))
        .unwrap_or_else(|_| default.to_string())
}

fn settings_from_database(state: &AppState) -> AppSettings {
    AppSettings {
        shortcut: setting(state, "launcher_shortcut", DEFAULT_SHORTCUT),
        fullscreen_shortcut: setting(state, "fullscreen_shortcut", DEFAULT_FULLSCREEN_SHORTCUT),
        shortcut_error: state
            .shortcut_error
            .lock()
            .expect("快捷键状态锁已中毒")
            .clone(),
    }
}

#[cfg(not(target_os = "macos"))]
fn position_launcher(window: &Window, height: f64) -> tauri::Result<()> {
    let monitor = window
        .current_monitor()?
        .or_else(|| window.available_monitors().ok()?.into_iter().next());
    let Some(monitor) = monitor else {
        return Ok(());
    };
    let scale = monitor.scale_factor();
    let work_area = monitor.work_area();
    let origin = work_area.position.to_logical::<f64>(scale);
    let area = work_area.size.to_logical::<f64>(scale);
    let screen = monitor.size().to_logical::<f64>(scale);
    let screen_origin = monitor.position().to_logical::<f64>(scale);
    let width = (screen.width / 3.0).round().max(LAUNCHER_MIN_WIDTH);
    let x = screen_origin.x + (screen.width - width) / 2.0;
    let y = origin.y + area.height / 3.0 - 30.0;
    window.set_size(tauri::LogicalSize::new(width, height))?;
    window.set_position(tauri::LogicalPosition::new(x, y))?;
    Ok(())
}

fn show_launcher(app: &AppHandle) {
    plugins::hide_active(app);
    if let Some(view) = app.get_webview("main") { let _ = view.set_focus(); }
    if let Some(window) = app.get_window("main") {
        #[cfg(target_os = "macos")]
        if let Err(error) = native_window::present(&window, LAUNCHER_HEIGHT, "launcher-focus") {
            eprintln!("唤起主入口失败：{error}");
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = position_launcher(&window, LAUNCHER_HEIGHT);
            let _ = window.show();
            let _ = window.set_focus();
            let _ = window.emit("launcher-focus", ());
        }
    }
}

fn resize_panel(window: &Window, height: f64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return native_window::resize(window, height);
    #[cfg(not(target_os = "macos"))]
    {
        let scale = window.scale_factor().map_err(|error| error.to_string())?;
        let size = window
            .inner_size()
            .map_err(|error| error.to_string())?
            .to_logical::<f64>(scale);
        window
            .set_size(tauri::LogicalSize::new(size.width, height))
            .map_err(|error| error.to_string())
    }
}

fn show_settings(app: &AppHandle) {
    plugins::hide_active(app);
    if let Some(view) = app.get_webview("main") { let _ = view.set_focus(); }
    if let Some(window) = app.get_window("main") {
        #[cfg(target_os = "macos")]
        if let Err(error) = native_window::present(&window, 670.0, "show-settings") {
            eprintln!("打开设置失败：{error}");
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = resize_panel(&window, 670.0);
            let _ = window.show();
            let _ = window.set_focus();
            let _ = window.emit("show-settings", ());
        }
    }
}

fn register_launcher_shortcut(app: &AppHandle, shortcut: &str) -> Result<(), String> {
    app.global_shortcut()
        .on_shortcut(shortcut, move |handle, _, event| {
            if event.state() == ShortcutState::Pressed {
                show_launcher(handle);
            }
        })
        .map_err(|error| format!("快捷键注册失败：{error}"))?;
    Ok(())
}

fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法取得应用数据目录：{error}"))?;
    fs::create_dir_all(&path).map_err(|error| format!("无法创建应用数据目录：{error}"))?;
    Ok(path.join("qingbox.sqlite3"))
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> AppSettings {
    settings_from_database(&state)
}

#[tauri::command]
fn save_shortcut(
    app: AppHandle,
    state: State<'_, AppState>,
    shortcut: String,
) -> Result<AppSettings, String> {
    let _update = state.shortcut_update.lock().map_err(|_| "快捷键状态不可用")?;
    if shortcut.trim().is_empty() {
        return Err("快捷键不能为空".to_string());
    }
    let next = shortcut.trim().to_string();
    let current = settings_from_database(&state).shortcut;
    if next == current && app.global_shortcut().is_registered(next.as_str()) {
        return Ok(settings_from_database(&state));
    }
    if app.global_shortcut().is_registered(next.as_str()) {
        return Err("快捷键已被轻匣其他命令占用".into());
    }
    register_launcher_shortcut(&app, &next)?;
    let save_result = (|| -> Result<(), String> {
        let mut database = state.database.lock().expect("设置数据库锁已中毒");
        let transaction = database
            .transaction()
            .map_err(|error| format!("读取设置失败：{error}"))?;
        transaction.execute(
            "INSERT INTO settings(key, value) VALUES('launcher_shortcut', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![next],
        ).map_err(|error| format!("快捷键保存失败：{error}"))?;
        let old_registered =
            next != current && app.global_shortcut().is_registered(current.as_str());
        if old_registered {
            app.global_shortcut()
                .unregister(current.as_str())
                .map_err(|error| format!("旧快捷键释放失败：{error}"))?;
        }
        if let Err(error) = transaction.commit() {
            if old_registered {
                register_launcher_shortcut(&app, &current).map_err(|restore| {
                    format!(
                        "快捷键保存失败：{error}；恢复旧绑定失败：{restore}，请从菜单栏重新设置"
                    )
                })?;
            }
            return Err(format!("快捷键保存失败：{error}"));
        }
        Ok(())
    })();
    if let Err(error) = save_result {
        let _ = app.global_shortcut().unregister(next.as_str());
        return Err(error);
    }
    *state.shortcut_error.lock().expect("快捷键状态锁已中毒") = None;
    let settings = settings_from_database(&state);
    let _ = app.emit("settings-changed", &settings);
    Ok(settings)
}

/// 插件全屏快捷键只在面板内生效，不注册为全局快捷键。
#[tauri::command]
fn save_fullscreen_shortcut(app: AppHandle, state: State<'_, AppState>, shortcut: String) -> Result<AppSettings, String> {
    let next = shortcut.trim().to_string();
    if next.is_empty() { return Err("快捷键不能为空".into()) }
    if next == settings_from_database(&state).shortcut { return Err("不能与唤起快捷键相同".into()) }
    #[cfg(target_os = "macos")]
    let parsed = native_window::parse_shortcut(&next)?;
    state.database.lock().expect("设置数据库锁已中毒").execute(
        "INSERT INTO settings(key, value) VALUES('fullscreen_shortcut', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![next],
    ).map_err(|error| format!("快捷键保存失败：{error}"))?;
    #[cfg(target_os = "macos")]
    native_window::set_fullscreen_shortcut(parsed);
    let settings = settings_from_database(&state);
    let _ = app.emit("settings-changed", &settings);
    Ok(settings)
}

#[tauri::command]
fn toggle_fullscreen(window: Window) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return native_window::toggle_fullscreen(&window).map_err(|error| format!("切换全屏失败：{error}"));
    #[cfg(not(target_os = "macos"))]
    { let _ = window; Ok(()) }
}

#[tauri::command]
fn hide_launcher(window: Window) -> Result<(), String> {
    plugins::hide_active(window.app_handle());
    window
        .hide()
        .map_err(|error| format!("隐藏主入口失败：{error}"))?;
    #[cfg(target_os = "macos")]
    native_window::hide_app(&window)?;
    Ok(())
}

#[tauri::command]
fn resize_launcher(window: Window, height: f64) -> Result<(), String> {
    resize_panel(&window, height.clamp(LAUNCHER_HEIGHT, 670.0))
        .map_err(|error| format!("调整主入口失败：{error}"))
}

#[tauri::command]
fn open_settings(window: Window) -> Result<(), String> {
    plugins::hide_active(window.app_handle());
    if let Some(view) = window.app_handle().get_webview("main") { let _ = view.set_focus(); }
    #[cfg(target_os = "macos")]
    native_window::exit_fullscreen(&window)?;
    resize_panel(&window, 670.0).map_err(|error| format!("打开设置失败：{error}"))?;
    #[cfg(target_os = "macos")]
    return Ok(());
    #[cfg(not(target_os = "macos"))]
    {
        window
            .show()
            .map_err(|error| format!("打开设置失败：{error}"))?;
        window
            .set_focus()
            .map_err(|error| format!("聚焦设置失败：{error}"))
    }
}

#[tauri::command]
fn close_settings(window: Window) -> Result<(), String> {
    resize_panel(&window, LAUNCHER_HEIGHT).map_err(|error| format!("关闭设置失败：{error}"))
}

#[tauri::command]
async fn complete_directory(
    request_id: u64,
    query: String,
    limit: usize,
) -> Result<QueryResponse, String> {
    tauri::async_runtime::spawn_blocking(move || directory_results(request_id, query, limit))
        .await
        .map_err(|error| format!("目录查询任务失败：{error}"))?
}

fn directory_results(
    request_id: u64,
    query: String,
    limit: usize,
) -> Result<QueryResponse, String> {
    let limit = limit.clamp(1, 50);
    let expanded = if query == "~" {
        dirs::home_dir().unwrap_or_else(|| PathBuf::from("~"))
    } else if let Some(rest) = query.strip_prefix("~/") {
        dirs::home_dir().unwrap_or_default().join(rest)
    } else {
        PathBuf::from(&query)
    };
    let include_current = expanded.is_dir();
    let (directory, prefix) = if include_current {
        (expanded, String::new())
    } else {
        (
            expanded
                .parent()
                .unwrap_or_else(|| std::path::Path::new("/"))
                .to_path_buf(),
            expanded
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_lowercase(),
        )
    };
    let result_for_path = |path: PathBuf, kind: &str| FileResult {
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.display().to_string()),
        parent: path
            .parent()
            .unwrap_or_else(|| std::path::Path::new("/"))
            .display()
            .to_string(),
        path: path.display().to_string(),
        kind: kind.to_string(),
    };
    let mut children = Vec::new();
    let entries = fs::read_dir(&directory).map_err(|error| match error.kind() {
        std::io::ErrorKind::PermissionDenied => format!(
            "尚不能访问 {}，请允许轻匣访问该目录后重试",
            directory.display()
        ),
        std::io::ErrorKind::NotFound => format!("目录不存在：{}", directory.display()),
        _ => format!("无法读取目录 {}：{error}", directory.display()),
    })?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if prefix.is_empty() || name.to_lowercase().starts_with(&prefix) {
            let path = entry.path();
            let kind = if path.is_dir() {
                if path.extension().is_some_and(|extension| extension == "app") {
                    "application"
                } else {
                    "directory"
                }
            } else {
                "file"
            };
            children.push(result_for_path(path, kind));
            // 多取一项判断是否有更多结果，目录自身也计入限额。
            if children.len() + usize::from(include_current) > limit {
                break;
            }
        }
    }
    children.sort_by_cached_key(|item| {
        (
            item.kind != "directory",
            item.name.to_lowercase(),
            item.name.clone(),
        )
    });
    let mut items = Vec::new();
    if include_current {
        items.push(result_for_path(directory, "directory"));
    }
    items.extend(children);
    let total = items.len();
    items.truncate(limit);
    Ok(QueryResponse {
        request_id,
        items,
        notice: (total > limit)
            .then(|| format!("已显示前 {limit} 项，请输入更精确的路径")),
    })
}

#[cfg(test)]
mod directory_tests {
    use super::directory_results;
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let suffix = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("生成测试目录编号失败")
                .as_nanos();
            let sequence = NEXT.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "qingbox-directory-{}-{suffix}-{sequence}",
                std::process::id()
            ));
            fs::create_dir(&path).expect("创建测试目录失败");
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn 目录中的应用包使用应用类型() {
        let fixture = TestDirectory::new();
        fs::create_dir(fixture.0.join("测试工具.app")).expect("创建应用样例失败");
        let response =
            directory_results(1, fixture.0.display().to_string(), 200).expect("查询应用目录失败");
        assert_eq!(response.items[0].kind, "directory");
        assert_eq!(response.items[1].kind, "application");
        assert!(response.items[1].path.ends_with("测试工具.app"));
    }

    #[test]
    fn 中文空格目录自身置顶且子项按目录优先稳定排序() {
        let fixture = TestDirectory::new();
        let target = fixture.0.join("中文 目标目录");
        fs::create_dir(&target).expect("创建目标目录失败");
        for name in ["b目录", "a目录"] {
            fs::create_dir(target.join(name)).expect("创建子目录失败");
        }
        for name in ["b文件.txt", "a文件.json"] {
            fs::write(target.join(name), "测试").expect("创建测试文件失败");
        }
        let response =
            directory_results(42, target.display().to_string(), 200).expect("查询目录失败");
        assert_eq!(response.request_id, 42, "请求编号应原样返回");
        assert_eq!(
            response
                .items
                .iter()
                .map(|item| item.name.as_str())
                .collect::<Vec<_>>(),
            ["中文 目标目录", "a目录", "b目录", "a文件.json", "b文件.txt"]
        );
        assert_eq!(
            response.items[0].path,
            target.display().to_string(),
            "首项应直接打开目标目录"
        );
        assert_eq!(
            response
                .items
                .iter()
                .map(|item| item.kind.as_str())
                .collect::<Vec<_>>(),
            ["directory", "directory", "directory", "file", "file"]
        );
        assert!(response.notice.is_none(), "未截断时不应提示结果不全");
    }

    #[test]
    fn 空目录和带末尾分隔符的路径仍返回目录自身() {
        let fixture = TestDirectory::new();
        for path in [
            fixture.0.display().to_string(),
            format!("{}/", fixture.0.display()),
        ] {
            let response = directory_results(1, path.clone(), 200).expect("查询空目录失败");
            assert_eq!(response.items.len(), 1, "空目录也必须能够回车打开");
            assert_eq!(PathBuf::from(&response.items[0].path), PathBuf::from(path));
            assert_eq!(response.items[0].kind, "directory");
            assert!(response.notice.is_none());
        }
    }

    #[test]
    fn 部分路径同时匹配目录文件且不插入父目录() {
        let fixture = TestDirectory::new();
        fs::create_dir(fixture.0.join("恩泽 目录")).expect("创建中文子目录失败");
        fs::write(fixture.0.join("恩泽 配置.json"), "{}").expect("创建中文文件失败");
        fs::write(fixture.0.join("其他.txt"), "测试").expect("创建无关文件失败");
        let response = directory_results(2, fixture.0.join("恩泽 ").display().to_string(), 200)
            .expect("查询部分路径失败");
        assert_eq!(
            response
                .items
                .iter()
                .map(|item| item.name.as_str())
                .collect::<Vec<_>>(),
            ["恩泽 目录", "恩泽 配置.json"]
        );
        assert_eq!(response.items[0].kind, "directory");
        assert_eq!(response.items[1].kind, "file");
    }

    #[test]
    fn 限额计入自身且仅在真实截断时提示并最多返回五十项() {
        let fixture = TestDirectory::new();
        fs::write(fixture.0.join("一个文件.txt"), "测试").expect("创建测试文件失败");
        let query = fixture.0.display().to_string();
        let exact = directory_results(3, query.clone(), 2).expect("查询精确限额失败");
        assert_eq!(exact.items.len(), 2);
        assert!(exact.notice.is_none(), "恰好达到限额不应提示截断");
        for limit in [0, 1] {
            let capped = directory_results(3, query.clone(), limit).expect("查询最小限额失败");
            assert_eq!(capped.items.len(), 1);
            assert_eq!(capped.items[0].path, query, "有限额时仍须优先保留目录自身");
            assert!(capped
                .notice
                .as_deref()
                .is_some_and(|notice| notice.contains("已显示前 1 项")));
        }
        for index in 0..200 {
            fs::write(fixture.0.join(format!("样例-{index:03}.txt")), "测试")
                .expect("创建限额样例失败");
        }
        let capped = directory_results(3, query.clone(), 999).expect("查询最大限额失败");
        assert_eq!(capped.items.len(), 50, "请求更大限额也不得超过五十项");
        assert_eq!(capped.items[0].path, query);
        assert!(capped
            .notice
            .as_deref()
            .is_some_and(|notice| notice.contains("已显示前 50 项")));
    }
}

#[tauri::command]
fn begin_search_session() -> u64 {
    search::begin_search_session()
}

#[tauri::command]
async fn search_files(
    request_id: u64,
    query_session: u64,
    query: String,
    limit: usize,
) -> Result<QueryResponse, String> {
    search::search_files(request_id, query_session, query, limit).await
}

#[tauri::command]
async fn get_application_icon(window: Window, path: String) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        window
            .run_on_main_thread(move || {
                let result = objc2::MainThreadMarker::new()
                    .ok_or_else(|| "无法进入应用图标绘制线程".to_string())
                    .and_then(|main_thread| application_icon::load_icon(&path, main_thread));
                let _ = sender.send(result);
            })
            .map_err(|error| format!("调度应用图标加载失败：{error}"))?;
        receiver
            .await
            .map_err(|_| "应用图标加载任务已结束".to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, path);
        Err("当前平台暂不支持读取应用图标".to_string())
    }
}

#[tauri::command]
fn open_path(path: String, reveal: bool) -> Result<(), String> {
    let status = if reveal {
        std::process::Command::new("open")
            .args(["-R", &path])
            .status()
    } else {
        std::process::Command::new("open").arg(&path).status()
    }
    .map_err(|error| format!("打开路径失败：{error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("系统未能打开此路径".to_string())
    }
}

pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());
    builder
        // 编辑菜单不放撤销与重做：菜单会先于网页截获 ⌘Z，走系统原生撤销，与编辑器自身的撤销历史不一致，
        // 只能撤销一步。去掉后 ⌘Z、⇧⌘Z 以按键事件交给页面，由 CodeMirror 等编辑器处理完整撤销历史。
        .menu(|handle| {
            let application = Submenu::with_items(handle, "轻匣", true, &[&PredefinedMenuItem::quit(handle, Some("退出轻匣"))?])?;
            let edit = Submenu::with_items(handle, "编辑", true, &[
                &PredefinedMenuItem::cut(handle, None)?,
                &PredefinedMenuItem::copy(handle, None)?,
                &PredefinedMenuItem::paste(handle, None)?,
                &PredefinedMenuItem::select_all(handle, None)?,
            ])?;
            Menu::with_items(handle, &[&application, &edit])
        })
        .manage(plugins::PluginState::default())
        .register_uri_scheme_protocol("qingbox-plugin", |context, request| {
            plugins::resource(context.app_handle(), context.webview_label(), request.uri().path())
        })
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let path = database_path(app.handle()).map_err(|error| tauri::Error::Anyhow(anyhow::anyhow!(error)))?;
            let database = Connection::open(path).map_err(|error| tauri::Error::Anyhow(anyhow::anyhow!(error)))?;
            database.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)", []).map_err(|error| tauri::Error::Anyhow(anyhow::anyhow!(error)))?;
            database.execute("INSERT OR IGNORE INTO settings(key, value) VALUES('launcher_shortcut', ?1)", params![DEFAULT_SHORTCUT]).map_err(|error| tauri::Error::Anyhow(anyhow::anyhow!(error)))?;
            app.manage(AppState { database: Mutex::new(database), shortcut_error: Mutex::new(None), shortcut_update: Mutex::new(()) });
            let settings = settings_from_database(app.state::<AppState>().inner());
            if let Err(error) = register_launcher_shortcut(app.handle(), &settings.shortcut) {
                *app.state::<AppState>().shortcut_error.lock().expect("快捷键状态锁已中毒") = Some(error);
            }
            clipboard::initialize(app.handle()).map_err(anyhow::Error::msg)?;
            plugins::initialize(app.handle()).map_err(anyhow::Error::msg)?;
            let show = MenuItem::with_id(app, "show", "打开轻匣", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "设置与插件", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出轻匣", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &settings, &quit])?;
            TrayIconBuilder::new().title("匣").tooltip("轻匣").menu(&menu).on_menu_event(|app, event| {
                match event.id.as_ref() {
                    "show" => show_launcher(app),
                    "settings" => show_settings(app),
                    "quit" => app.exit(0),
                    _ => {}
                }
            }).build(app)?;
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                if app.get_window("main").is_some() {
                    if let Some(webview) = app.get_webview_window("main") { native_window::prepare(&webview).map_err(anyhow::Error::msg)?; }
                }
                let fullscreen = settings_from_database(app.state::<AppState>().inner()).fullscreen_shortcut;
                match native_window::parse_shortcut(&fullscreen).or_else(|_| native_window::parse_shortcut(DEFAULT_FULLSCREEN_SHORTCUT)) {
                    Ok(shortcut) => native_window::set_fullscreen_shortcut(shortcut),
                    Err(error) => eprintln!("全屏快捷键无效：{error}"),
                }
            }
            show_launcher(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_settings, save_shortcut, save_fullscreen_shortcut, toggle_fullscreen, hide_launcher, resize_launcher, open_settings, close_settings, complete_directory, begin_search_session, search_files, get_application_icon, open_path, plugins::list_plugin_commands, plugins::open_plugin, plugins::leave_plugin, plugins::plugin_call, plugins::management::list_plugins, plugins::management::reload_plugins, plugins::management::set_plugin_enabled, plugins::management::import_plugin, plugins::management::remove_plugin])
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(false) = event {
                #[cfg(target_os = "macos")]
                let _ = native_window::hide_if_unfocused(window);
                #[cfg(not(target_os = "macos"))]
                { plugins::hide_active(window.app_handle()); let _ = window.hide(); }
            }
        })
        .run(tauri::generate_context!())
        .expect("轻匣启动失败");
}
