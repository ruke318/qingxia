//! 快捷键统一管理：唤起轻匣、插件全屏与各插件命令的全局快捷键都经这里保存、恢复和查询。
//!
//! - 组合键按“修饰键集合 + 按键”比较，与书写顺序、别名无关（`Control+Super+F` 与 `Cmd+Ctrl+F` 相同）；
//!   同一组合只能属于一项，全局快捷键与面板内的全屏快捷键也互相校验。
//! - 记录每个组合实际由谁持有，不再只凭“是否已注册”判断，避免误删其他项的绑定。
//! - 保存值统一写成规范形式（如 `Super+Control+F`），设置表键名沿用旧版本。
use std::{
    collections::BTreeMap,
    str::FromStr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, MutexGuard,
    },
};

use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Webview};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Modifiers, Shortcut, ShortcutState as KeyState};

/// 唤起轻匣，注册为系统全局快捷键。
pub const LAUNCHER: &str = "launcher";
/// 插件全屏，只在面板内由原生按键监听处理，不注册为全局快捷键。
pub const FULLSCREEN: &str = "fullscreen";
/// 截图，注册为系统全局快捷键；可以清除。
pub const SCREENSHOT: &str = "screenshot";
/// 录屏，注册为系统全局快捷键；可以清除。
pub const SCREEN_RECORD: &str = "recording";
const INITIAL_RECORDING: &str = "Alt+Shift+R";
const DEFAULT_LAUNCHER: &str = "Alt+Space";
const DEFAULT_FULLSCREEN: &str = "Control+Super+F";
/// 截图快捷键只在首次初始化时写入，之后用户修改或清除都不会被重置。
const INITIAL_SCREENSHOT: &str = "Alt+Shift+A";

/// 设置页正在录制快捷键：全局快捷键只回报组合、不执行动作，面板内也不截获全屏与编辑快捷键。
static RECORDING: AtomicBool = AtomicBool::new(false);

#[derive(Default)]
pub struct ShortcutState {
    /// 保存、恢复与插件重载互斥执行。
    update: Mutex<()>,
    /// 实际生效的绑定：项标识 → 组合键。项标识为 `launcher`、`fullscreen` 或完整命令标识。
    active: Mutex<BTreeMap<String, Shortcut>>,
    /// 最近一次注册或恢复失败的原因，按项记录。
    errors: Mutex<BTreeMap<String, String>>,
}

/// 设置页的一行。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutRow {
    id: String,
    /// 分组名：“轻匣”或插件名称。
    group: String,
    title: String,
    /// `global` 为全局快捷键，`panel` 只在面板内生效。
    scope: &'static str,
    /// 唤起与全屏的默认值；插件命令为 `null`。
    default_value: Option<String>,
    /// 插件清单中的建议值，只作提示。
    suggested: Option<String>,
    /// 已保存的值；插件停用时仍保留。
    saved: Option<String>,
    /// 当前实际生效的值。
    active: Option<String>,
    /// 插件是否启用；唤起与全屏始终为 `true`。
    enabled: bool,
    error: Option<String>,
}

/// 已安装插件的命令，由插件管理扫描得到（含已停用插件）。
pub struct InstalledCommand {
    pub id: String,
    pub title: String,
    pub plugin_name: String,
    pub enabled: bool,
    pub suggested: Option<String>,
}

pub fn is_recording() -> bool {
    RECORDING.load(Ordering::SeqCst)
}

/// 面板隐藏、重新唤起时结束录制，避免快捷键一直处于只回报状态。
pub fn stop_recording() {
    if RECORDING.swap(false, Ordering::SeqCst) {
        crate::diag!("快捷键录入结束（面板收起或重新唤起）");
    }
}

/// 解析并校验组合键：至少包含 ⌘、⌃ 或 ⌥，否则会吞掉普通输入。
pub fn parse(text: &str) -> Result<Shortcut, String> {
    let shortcut = Shortcut::from_str(text.trim()).map_err(|_| format!("无法识别的快捷键：{}", text.trim()))?;
    if !shortcut.mods.intersects(Modifiers::SUPER | Modifiers::CONTROL | Modifiers::ALT) {
        return Err("快捷键需要包含 ⌘、⌃ 或 ⌥".into());
    }
    Ok(shortcut)
}

/// 规范形式：修饰键按 ⌘⌃⌥⇧ 排列，字母、数字去掉 `Key`、`Digit` 前缀，如 `Super+Control+F`。
pub fn format(shortcut: &Shortcut) -> String {
    let mut parts: Vec<String> = [(Modifiers::SUPER, "Super"), (Modifiers::CONTROL, "Control"), (Modifiers::ALT, "Alt"), (Modifiers::SHIFT, "Shift")]
        .into_iter()
        .filter(|(flag, _)| shortcut.mods.contains(*flag))
        .map(|(_, name)| name.to_string())
        .collect();
    let key = shortcut.key.to_string();
    parts.push(key.strip_prefix("Key").or_else(|| key.strip_prefix("Digit")).unwrap_or(&key).to_string());
    parts.join("+")
}

/// 找出持有同一组合的其他项。
fn find_holder(active: &BTreeMap<String, Shortcut>, shortcut: &Shortcut, except: &str) -> Option<String> {
    active.iter().find(|(id, held)| id.as_str() != except && *held == shortcut).map(|(id, _)| id.clone())
}

/// 宿主内置项（唤起、全屏、截图），其余为插件命令。
fn is_builtin(id: &str) -> bool {
    matches!(id, LAUNCHER | FULLSCREEN | SCREENSHOT | SCREEN_RECORD)
}

fn setting_key(id: &str) -> String {
    match id {
        LAUNCHER => "launcher_shortcut".into(),
        FULLSCREEN => "fullscreen_shortcut".into(),
        SCREENSHOT => "screenshot_shortcut".into(),
        SCREEN_RECORD => "recording_shortcut".into(),
        command => format!("plugin_shortcut:{command}"),
    }
}

fn default_value(id: &str) -> Option<&'static str> {
    match id {
        LAUNCHER => Some(DEFAULT_LAUNCHER),
        FULLSCREEN => Some(DEFAULT_FULLSCREEN),
        _ => None,
    }
}

fn state(app: &AppHandle) -> &ShortcutState {
    app.state::<ShortcutState>().inner()
}

fn lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>, String> {
    mutex.lock().map_err(|_| "快捷键状态不可用".into())
}

/// 取得快捷键更新锁；插件重载期间持有，保证与保存互斥。
pub fn lock_updates(app: &AppHandle) -> Result<MutexGuard<'_, ()>, String> {
    lock(&state(app).update)
}

/// 已保存的值；唤起与全屏未保存时为默认值。
pub fn saved(app: &AppHandle, id: &str) -> Result<Option<String>, String> {
    let app_state = app.state::<crate::AppState>();
    let database = app_state.database.lock().map_err(|_| "设置数据库不可用")?;
    let value: Option<String> = database
        .query_row("SELECT value FROM settings WHERE key = ?1", params![setting_key(id)], |row| row.get(0))
        .optional()
        .map_err(|error| format!("读取快捷键失败：{error}"))?;
    Ok(value.or_else(|| default_value(id).map(str::to_string)))
}

fn write_saved(app: &AppHandle, id: &str, value: Option<&str>) -> Result<(), String> {
    let app_state = app.state::<crate::AppState>();
    let database = app_state.database.lock().map_err(|_| "设置数据库不可用")?;
    match value {
        Some(value) => database.execute(
            "INSERT INTO settings(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![setting_key(id), value],
        ),
        None => database.execute("DELETE FROM settings WHERE key = ?1", params![setting_key(id)]),
    }
    .map(|_| ())
    .map_err(|error| error.to_string())
}

/// 冲突提示中使用的名称。
fn label(app: &AppHandle, id: &str) -> String {
    match id {
        LAUNCHER => "唤起轻匣".into(),
        FULLSCREEN => "插件全屏".into(),
        SCREENSHOT => "截图".into(),
        SCREEN_RECORD => "录屏".into(),
        command => crate::plugins::command_label(app, command).unwrap_or_else(|| command.to_string()),
    }
}

/// 全屏快捷键由原生监听按字符匹配，可用按键比全局快捷键少。
fn check_scope(id: &str, shortcut: &Shortcut) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    if id == FULLSCREEN {
        crate::native_window::parse_shortcut(&format(shortcut))?;
    }
    let _ = (id, shortcut);
    Ok(())
}

fn register_global(app: &AppHandle, id: &str, shortcut: Shortcut) -> Result<(), String> {
    let owner = id.to_string();
    app.global_shortcut()
        .on_shortcut(shortcut, move |app, pressed, event| {
            if event.state() != KeyState::Pressed { return }
            #[cfg(target_os = "macos")]
            let front = crate::native_window::frontmost_app();
            #[cfg(not(target_os = "macos"))]
            let front = "未知";
            crate::diag!("快捷键 {} 按下 → {owner}，录入中 {}，前台应用 {front}", format(pressed), is_recording());
            if is_recording() {
                // 只有面板仍在显示时才算录制中；面板已从任何途径收起，说明录制早已结束，按正常快捷键处理。
                let visible = app.get_window("main").and_then(|window| window.is_visible().ok()).unwrap_or(false);
                if visible {
                    crate::diag!("录入中，只回报组合，不执行动作");
                    let _ = app.emit_to("main", "shortcut-recorded", format(pressed));
                    return;
                }
                crate::diag!("面板已收起，结束残留的录入状态");
                stop_recording();
            }
            if owner == LAUNCHER {
                crate::show_launcher(app);
            } else if owner == SCREEN_RECORD {
                if let Err(error) = crate::capture::record::shortcut(app) { crate::diag!("录屏未开始：{error}"); }
            } else if owner == SCREENSHOT {
                if let Err(error) = crate::capture::start_screenshot(app, false) { crate::diag!("截图未开始：{error}"); }
            } else {
                let _ = crate::plugins::open_plugin(app.clone(), owner.clone());
            }
        })
        .map_err(|error| format!("快捷键注册失败，可能已被系统或其他应用占用：{error}"))
}

/// 让组合生效：全屏替换原生监听的组合，其余注册为全局快捷键。
fn activate(app: &AppHandle, id: &str, shortcut: Shortcut) -> Result<(), String> {
    if id == FULLSCREEN {
        #[cfg(target_os = "macos")]
        crate::native_window::set_fullscreen_shortcut(crate::native_window::parse_shortcut(&format(&shortcut))?);
        return Ok(());
    }
    register_global(app, id, shortcut)
}

/// 撤销全局快捷键；全屏总有一个组合，由下一次 `activate` 替换，无需撤销。
fn deactivate(app: &AppHandle, id: &str, shortcut: Shortcut) -> Result<(), String> {
    if id == FULLSCREEN { return Ok(()) }
    app.global_shortcut().unregister(shortcut).map_err(|error| error.to_string())
}

/// 保存一项快捷键，`None` 或空字符串表示清除（唤起与全屏不能清除）。
/// 先注册新组合，再写入设置，最后释放旧组合；任一步失败都撤销已完成的步骤，并如实报告撤销结果。
pub fn save(app: &AppHandle, id: &str, text: Option<&str>) -> Result<(), String> {
    let _update = lock_updates(app)?;
    if let Err(error) = save_locked(app, id, text) {
        crate::diag!("快捷键保存失败：{id} = {}，{error}", text.unwrap_or("（清除）"));
        return Err(error);
    }
    crate::diag!("快捷键已保存：{id} = {}", text.filter(|text| !text.trim().is_empty()).unwrap_or("（清除）"));
    let _ = app.emit_to("main", "shortcuts-changed", ());
    Ok(())
}

fn save_locked(app: &AppHandle, id: &str, text: Option<&str>) -> Result<(), String> {
    let next = text.map(str::trim).filter(|text| !text.is_empty()).map(parse).transpose()?;
    if next.is_none() && default_value(id).is_some() { return Err("快捷键不能为空".into()) }
    if let Some(next) = &next { check_scope(id, next)?; }
    let shortcuts = state(app);
    let old = lock(&shortcuts.active)?.get(id).copied();
    let saved_value = saved(app, id)?.and_then(|text| parse(&text).ok());
    if next == old && next == saved_value {
        lock(&shortcuts.errors)?.remove(id);
        return Ok(());
    }
    if let Some(next) = &next {
        if let Some(holder) = find_holder(&*lock(&shortcuts.active)?, next, id) {
            return Err(format!("{} 已被「{}」使用", format(next), label(app, &holder)));
        }
    }
    // 1. 新组合生效；与当前生效的组合相同时不必重复注册。
    let fresh = next.filter(|next| Some(*next) != old);
    if let Some(fresh) = fresh { activate(app, id, fresh)?; }
    // 2. 写入设置，失败时撤销新组合。
    if let Err(error) = write_saved(app, id, next.as_ref().map(format).as_deref()) {
        let mut message = format!("快捷键保存失败：{error}");
        if let Some(fresh) = fresh {
            let undo = match old { Some(old) if id == FULLSCREEN => activate(app, id, old), _ => deactivate(app, id, fresh) };
            if let Err(undo) = undo {
                message.push_str(&format!("；撤销新快捷键失败：{undo}"));
                lock(&shortcuts.errors)?.insert(id.to_string(), format!("{} 仍在生效，但未保存", format(&fresh)));
            }
        }
        return Err(message);
    }
    // 3. 释放旧组合。设置已是新值，释放失败时记录在该项上，不再回退。
    let mut error = None;
    if let Some(old) = old.filter(|old| Some(*old) != next) {
        if let Err(cause) = deactivate(app, id, old) {
            error = Some(format!("旧快捷键 {} 未能释放：{cause}", format(&old)));
        }
    }
    match next {
        Some(next) => lock(&shortcuts.active)?.insert(id.to_string(), next),
        None => lock(&shortcuts.active)?.remove(id),
    };
    let mut errors = lock(&shortcuts.errors)?;
    match error {
        Some(error) => errors.insert(id.to_string(), error),
        None => errors.remove(id),
    };
    Ok(())
}

/// 按已保存的值恢复一项；失败原因记录在该项上。调用方须持有更新锁。
pub fn restore_locked(app: &AppHandle, id: &str) -> Result<(), String> {
    let shortcuts = state(app);
    let Some(text) = saved(app, id)? else {
        lock(&shortcuts.errors)?.remove(id);
        return Ok(());
    };
    let result = (|| -> Result<Shortcut, String> {
        let shortcut = parse(&text)?;
        check_scope(id, &shortcut)?;
        if let Some(holder) = find_holder(&*lock(&shortcuts.active)?, &shortcut, id) {
            return Err(format!("{} 已被「{}」使用，未生效", format(&shortcut), label(app, &holder)));
        }
        activate(app, id, shortcut)?;
        Ok(shortcut)
    })();
    match result {
        Ok(shortcut) => {
            crate::diag!("快捷键已恢复：{id} = {}", format(&shortcut));
            lock(&shortcuts.active)?.insert(id.to_string(), shortcut);
            lock(&shortcuts.errors)?.remove(id);
        }
        Err(error) => {
            crate::diag!("快捷键未恢复：{id} = {text}，{error}");
            lock(&shortcuts.errors)?.insert(id.to_string(), error);
        }
    }
    Ok(())
}

/// 启动时恢复唤起与全屏快捷键，须在加载插件之前调用。
pub fn initialize(app: &AppHandle) -> Result<(), String> {
    let _update = lock_updates(app)?;
    seed_screenshot(app)?;
    restore_locked(app, LAUNCHER)?;
    restore_locked(app, FULLSCREEN)?;
    restore_locked(app, SCREENSHOT)?;
    restore_locked(app, SCREEN_RECORD)
}

/// 首次初始化时写入截图快捷键，以后不再写入（同剪贴板 ⌥⇧V 的做法）。
fn seed_screenshot(app: &AppHandle) -> Result<(), String> {
    let app_state = app.state::<crate::AppState>();
    let mut database = app_state.database.lock().map_err(|_| "设置数据库不可用")?;
    let transaction = database.transaction().map_err(|_| "初始化截图快捷键失败")?;
    let first = transaction
        .execute("INSERT OR IGNORE INTO settings(key, value) VALUES('screenshot:initialized', 'true')", [])
        .map_err(|_| "初始化截图快捷键失败")?;
    if first > 0 {
        transaction
            .execute("INSERT OR IGNORE INTO settings(key, value) VALUES(?1, ?2)", params![setting_key(SCREENSHOT), INITIAL_SCREENSHOT])
            .map_err(|_| "初始化截图快捷键失败")?;
    }
    let first_recording = transaction.execute("INSERT OR IGNORE INTO settings(key, value) VALUES('recording:initialized', 'true')", []).map_err(|_| "初始化录屏快捷键失败")?;
    if first_recording > 0 {
        transaction.execute("INSERT OR IGNORE INTO settings(key, value) VALUES(?1, ?2)", params![setting_key(SCREEN_RECORD), INITIAL_RECORDING]).map_err(|_| "初始化录屏快捷键失败")?;
    }
    transaction.commit().map_err(|_| "初始化快捷键失败".into())
}

/// 插件重载前撤销全部插件命令的快捷键并清空其错误；中途失败时恢复已撤销的项。调用方须持有更新锁。
pub fn release_commands_locked(app: &AppHandle) -> Result<(), String> {
    let shortcuts = state(app);
    let commands: Vec<(String, Shortcut)> = lock(&shortcuts.active)?
        .iter()
        .filter(|(id, _)| !is_builtin(id))
        .map(|(id, shortcut)| (id.clone(), *shortcut))
        .collect();
    let mut released: Vec<(String, Shortcut)> = Vec::new();
    for (id, shortcut) in commands {
        if deactivate(app, &id, shortcut).is_err() {
            for (id, shortcut) in &released {
                if activate(app, id, *shortcut).is_err() { lock(&shortcuts.active)?.remove(id); }
            }
            return Err("解除旧插件快捷键失败，插件未重新加载".into());
        }
        lock(&shortcuts.active)?.remove(&id);
        released.push((id, shortcut));
    }
    lock(&shortcuts.errors)?.retain(|id, _| is_builtin(id));
    Ok(())
}

fn row(app: &AppHandle, id: &str, group: &str, title: &str, suggested: Option<String>, enabled: bool) -> Result<ShortcutRow, String> {
    let shortcuts = state(app);
    let active = lock(&shortcuts.active)?.get(id).map(format);
    let saved = saved(app, id)?.map(|text| parse(&text).map(|shortcut| format(&shortcut)).unwrap_or(text));
    Ok(ShortcutRow {
        id: id.to_string(),
        group: group.to_string(),
        title: title.to_string(),
        scope: if id == FULLSCREEN { "panel" } else { "global" },
        default_value: default_value(id).and_then(|value| parse(value).ok()).map(|shortcut| format(&shortcut)),
        suggested: suggested.and_then(|value| parse(&value).ok()).map(|shortcut| format(&shortcut)),
        saved,
        active,
        enabled,
        error: lock(&shortcuts.errors)?.get(id).cloned(),
    })
}

fn rows(app: &AppHandle) -> Result<Vec<ShortcutRow>, String> {
    let mut rows = vec![
        row(app, LAUNCHER, "轻匣", "唤起轻匣", None, true)?,
        row(app, FULLSCREEN, "轻匣", "插件全屏", None, true)?,
        row(app, SCREENSHOT, "轻匣", "截图", Some(INITIAL_SCREENSHOT.into()), true)?,
        row(app, SCREEN_RECORD, "轻匣", "录屏", Some(INITIAL_RECORDING.into()), true)?,
    ];
    for command in crate::plugins::management::installed_commands(app)? {
        rows.push(row(app, &command.id, &command.plugin_name, &command.title, command.suggested, command.enabled)?);
    }
    Ok(rows)
}

fn require_main(webview: &Webview) -> Result<(), String> {
    if webview.label() != "main" { return Err("只有主入口可以管理快捷键".into()) }
    Ok(())
}

/// 列出唤起、全屏与全部已安装插件命令（含已停用）的快捷键。
#[tauri::command]
pub fn list_shortcuts(app: AppHandle, webview: Webview) -> Result<Vec<ShortcutRow>, String> {
    require_main(&webview)?;
    rows(&app)
}

/// 设置页保存一项；插件命令须属于已启用的插件。返回保存后的全部行。
#[tauri::command]
pub fn save_shortcut_binding(app: AppHandle, webview: Webview, id: String, shortcut: Option<String>) -> Result<Vec<ShortcutRow>, String> {
    require_main(&webview)?;
    if !is_builtin(&id) && crate::plugins::command_label(&app, &id).is_none() {
        return Err("插件未启用或命令不存在".into());
    }
    save(&app, &id, shortcut.as_deref())?;
    rows(&app)
}

/// 设置页录制快捷键的开始与结束。
#[tauri::command]
pub fn set_shortcut_recording(webview: Webview, recording: bool) -> Result<(), String> {
    require_main(&webview)?;
    if RECORDING.swap(recording, Ordering::SeqCst) != recording {
        crate::diag!("快捷键录入{}", if recording { "开始" } else { "结束" });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 组合与书写顺序和别名无关() {
        let a = parse("Control+Super+F").unwrap();
        let b = parse("Super+Control+F").unwrap();
        let c = parse("cmd+ctrl+KeyF").unwrap();
        assert_eq!(a, b);
        assert_eq!(a, c);
        assert_eq!(parse("Alt+Shift+V").unwrap(), parse("Shift+Option+V").unwrap());
        assert_ne!(a, parse("Control+Super+Shift+F").unwrap(), "修饰键集合不同即为不同组合");
    }

    #[test]
    fn 保存值统一为规范形式() {
        assert_eq!(format(&parse("Control+Super+F").unwrap()), "Super+Control+F");
        assert_eq!(format(&parse("shift+alt+v").unwrap()), "Alt+Shift+V");
        assert_eq!(format(&parse("Alt+Space").unwrap()), "Alt+Space");
        assert_eq!(format(&parse("Super+Shift+1").unwrap()), "Super+Shift+1");
        assert_eq!(format(&parse("Super+/").unwrap()), "Super+Slash");
        let text = format(&parse("Super+Control+ArrowUp").unwrap());
        assert_eq!(parse(&text).unwrap(), parse("Control+Super+Up").unwrap(), "规范形式可以再解析回同一组合");
    }

    #[test]
    fn 必须包含主要修饰键() {
        assert!(parse("Shift+F").is_err(), "只有 Shift 会吞掉普通输入");
        assert!(parse("F").is_err());
        assert!(parse("Super+").is_err());
        assert!(parse("不是快捷键").is_err());
    }

    #[test]
    fn 内置项与插件命令的区分() {
        assert!(is_builtin(LAUNCHER) && is_builtin(FULLSCREEN) && is_builtin(SCREENSHOT));
        assert!(!is_builtin("clipboard-history:open"));
        assert_eq!(default_value(SCREENSHOT), None, "截图快捷键可以清除，没有不可清除的默认值");
        assert_eq!(setting_key(SCREENSHOT), "screenshot_shortcut");
        assert_eq!(format(&parse(INITIAL_SCREENSHOT).unwrap()), "Alt+Shift+A");
    }

    #[test]
    fn 同一组合只能属于一项且全局与全屏互相校验() {
        let mut active = BTreeMap::new();
        active.insert(LAUNCHER.to_string(), parse("Alt+Space").unwrap());
        active.insert(FULLSCREEN.to_string(), parse("Control+Super+F").unwrap());
        active.insert("clipboard-history:open".to_string(), parse("Alt+Shift+V").unwrap());
        // 插件命令试图使用全屏组合，换一种写法也能识别
        assert_eq!(find_holder(&active, &parse("Super+Control+F").unwrap(), "json-tools:open").as_deref(), Some(FULLSCREEN));
        // 全屏试图使用插件命令的组合
        assert_eq!(find_holder(&active, &parse("Shift+Alt+V").unwrap(), FULLSCREEN).as_deref(), Some("clipboard-history:open"));
        // 自己原有的组合不算冲突
        assert_eq!(find_holder(&active, &parse("Alt+Space").unwrap(), LAUNCHER), None);
        assert_eq!(find_holder(&active, &parse("Alt+J").unwrap(), "json-tools:open"), None);
    }
}
