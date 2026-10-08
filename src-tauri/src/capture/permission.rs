//! 屏幕录制权限：只在用户主动截图时检测与请求，不在启动时请求。
//!
//! 系统只会弹出一次授权对话框；之后再请求不会有任何反应，只能引导用户到系统设置中允许。
//! 授权后，系统通常要求重新打开应用才生效。
use rusqlite::params;
use tauri::{AppHandle, Manager};

/// 检测与请求的结果，决定截图能否继续以及如何提示。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    /// 已授权，继续截图。
    Granted,
    /// 首次请求，系统正在弹出授权对话框。
    Prompted,
    /// 请求过仍未授权，已打开系统设置。
    Denied,
}

impl Access {
    /// 未授权时显示在主面板上的提示。
    pub fn notice(self) -> Option<&'static str> {
        match self {
            Access::Granted => None,
            Access::Prompted => Some("截图需要“屏幕录制”权限：请在系统弹窗中允许，然后按提示重新打开轻匣，再截图。"),
            Access::Denied => Some("截图需要“屏幕录制”权限：已打开系统设置，请在“屏幕录制”中允许轻匣；如已允许，请从菜单栏退出并重新打开轻匣。"),
        }
    }
}

/// 下一步：已授权直接继续；从未请求过则由系统弹窗请求；请求过仍未授权则打开系统设置。
pub fn decide(granted: bool, requested_before: bool) -> Access {
    match (granted, requested_before) {
        (true, _) => Access::Granted,
        (false, false) => Access::Prompted,
        (false, true) => Access::Denied,
    }
}

const REQUESTED_KEY: &str = "capture:permission_requested";

fn requested_before(app: &AppHandle) -> Result<bool, String> {
    let state = app.state::<crate::AppState>();
    let database = state.database.lock().map_err(|_| "设置数据库不可用")?;
    let count: i64 = database
        .query_row("SELECT COUNT(*) FROM settings WHERE key = ?1", params![REQUESTED_KEY], |row| row.get(0))
        .map_err(|error| format!("读取截图权限状态失败：{error}"))?;
    Ok(count > 0)
}

fn mark_requested(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<crate::AppState>();
    let database = state.database.lock().map_err(|_| "设置数据库不可用")?;
    database
        .execute("INSERT OR IGNORE INTO settings(key, value) VALUES(?1, 'true')", params![REQUESTED_KEY])
        .map(|_| ())
        .map_err(|error| format!("保存截图权限状态失败：{error}"))
}

#[cfg(target_os = "macos")]
fn granted() -> bool {
    objc2_core_graphics::CGPreflightScreenCaptureAccess()
}

#[cfg(not(target_os = "macos"))]
fn granted() -> bool {
    false
}

/// 检测权限，未授权时按 [`decide`] 请求或打开系统设置。须在用户主动截图时调用。
pub fn ensure(app: &AppHandle) -> Result<Access, String> {
    let granted = granted();
    let requested = requested_before(app)?;
    let access = decide(granted, requested);
    crate::diag!("截图权限：已授权 {granted}，曾请求 {requested} → {access:?}");
    match access {
        Access::Granted => {}
        Access::Prompted => {
            mark_requested(app)?;
            #[cfg(target_os = "macos")]
            objc2_core_graphics::CGRequestScreenCaptureAccess();
        }
        Access::Denied => {
            #[cfg(target_os = "macos")]
            if let Err(error) = std::process::Command::new("open")
                .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
                .spawn()
            {
                crate::diag!("打开系统设置失败：{error}");
            }
        }
    }
    Ok(access)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 已授权直接继续() {
        assert_eq!(decide(true, false), Access::Granted);
        assert_eq!(decide(true, true), Access::Granted);
        assert_eq!(Access::Granted.notice(), None);
    }

    #[test]
    fn 首次请求由系统弹窗之后引导到系统设置() {
        assert_eq!(decide(false, false), Access::Prompted);
        assert_eq!(decide(false, true), Access::Denied);
        assert!(Access::Prompted.notice().unwrap().contains("系统弹窗"));
        assert!(Access::Denied.notice().unwrap().contains("系统设置"));
    }
}
