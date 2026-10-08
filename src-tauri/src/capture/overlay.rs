//! 截图覆盖窗：每块屏幕一个，铺满整屏（含菜单栏与程序坞区域），加载可信本地页面 `capture.html`。
//!
//! 与主面板一样是非激活面板：可以取得键盘焦点，但不激活应用，避免切换桌面空间；
//! 加入所有空间并浮于全屏应用之上。不适用主面板的“失焦即收起”。
//! 窗口标签为 `capture-<会话>-<屏幕>`，专用 capability 只授予这类窗口截图会话命令。
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// 覆盖窗标签前缀，与 `capabilities/capture.json` 的窗口匹配规则一致。
pub const LABEL_PREFIX: &str = "capture-";

pub fn label(session: u64, screen: usize) -> String {
    format!("{LABEL_PREFIX}{session}-{screen}")
}

/// 从覆盖窗标签解析会话编号；不是覆盖窗时返回 `None`。
pub fn session_of(label: &str) -> Option<u64> {
    label.strip_prefix(LABEL_PREFIX)?.split('-').next()?.parse().ok()
}

#[cfg(target_os = "macos")]
mod panel_type {
    tauri_nspanel::tauri_panel! {
      panel!(CapturePanel {
          config: {
              can_become_key_window: true,
              can_become_main_window: false,
              is_floating_panel: true
          }
      })
    }
}

/// 为当前会话在每块屏幕上打开覆盖窗，返回打开的数量。须在主线程调用。
#[cfg(target_os = "macos")]
pub fn open(app: &AppHandle, session: u64) -> Result<usize, String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSColor, NSEvent, NSScreen, NSScreenSaverWindowLevel, NSWindowCollectionBehavior, NSWindowStyleMask};
    use tauri_nspanel::WebviewWindowExt;

    let main_thread = MainThreadMarker::new().ok_or("覆盖窗必须在主线程创建")?;
    let mouse = NSEvent::mouseLocation();
    let screens = NSScreen::screens(main_thread);
    let mut key_panel = None;
    for (index, screen) in screens.iter().enumerate() {
        let frame = screen.frame();
        let label = label(session, index);
        // 按显示器编号取本屏快照；deviceDescription 自 macOS 10 起可用，CGDirectDisplayID 属性要到 macOS 26。
        let display = screen
            .deviceDescription()
            .objectForKey(&objc2_foundation::NSString::from_str("NSScreenNumber"))
            .and_then(|value| value.downcast::<objc2_foundation::NSNumber>().ok())
            .map(|number| number.unsignedIntValue())
            .unwrap_or(0);
        let scale = super::screenshot::info(session, display);
        let image = scale.map(|_| format!("\"qingbox-capture://localhost/{session}/{display}.png\"")).unwrap_or_else(|| "null".into());
        if scale.is_none() { crate::diag!("截图：显示器 {display} 没有快照，覆盖窗显示实时画面"); }
        let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("capture.html".into()))
            .title("轻匣截图")
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .resizable(false)
            .skip_taskbar(true)
            .visible(false)
            .accept_first_mouse(true)
            .inner_size(frame.size.width, frame.size.height)
            .initialization_script(format!(
                "window.__QINGBOX_CAPTURE__ = {{ session: {session}, screen: {index}, display: {display}, scale: {}, image: {image} }};",
                scale.unwrap_or_else(|| screen.backingScaleFactor()),
            ))
            .build()
            .map_err(|error| format!("创建截图覆盖窗失败：{error}"))?;
        let panel = window
            .to_panel::<panel_type::CapturePanel>()
            .map_err(|error| format!("创建截图覆盖面板失败：{error}"))?;
        panel.set_becomes_key_only_if_needed(false);
        panel.set_hides_on_deactivate(false);
        panel.set_works_when_modal(true);
        panel.set_released_when_closed(false);
        let native = panel.as_panel();
        if let Err(error) = panel.set_style_mask(native.styleMask() | NSWindowStyleMask::NonactivatingPanel) {
            crate::diag!("截图覆盖窗设置非激活标志失败：{error:?}");
        }
        native.setOpaque(false);
        native.setBackgroundColor(Some(&NSColor::clearColor()));
        panel.set_has_shadow(false);
        panel.set_level(NSScreenSaverWindowLevel as i64);
        panel.set_collection_behavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::CanJoinAllApplications
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::IgnoresCycle,
        );
        // AppKit 逻辑坐标铺满整块屏幕，与主面板定位一致，不经 Tauri 的坐标换算。
        native.setFrame_display(frame, false);
        native.orderFrontRegardless();
        if key_panel.is_none() && crate::native_window::contains(frame, mouse) {
            key_panel = Some(label.clone());
        }
    }
    NSApplication::sharedApplication(main_thread).unhideWithoutActivation();
    // 鼠标所在屏幕的覆盖窗取得键盘焦点，接收 Esc 等按键；取不到时用第一块屏幕。
    let key_label = key_panel.unwrap_or_else(|| label(session, 0));
    if let Ok(panel) = tauri_nspanel::ManagerExt::get_webview_panel(app, &key_label) {
        panel.as_panel().makeKeyAndOrderFront(None);
    }
    if let Some(webview) = app.get_webview(&key_label) { let _ = webview.set_focus(); }
    crate::diag!("截图：会话 {session} 打开 {} 个覆盖窗，键盘焦点在 {key_label}", screens.len());
    Ok(screens.len())
}

#[cfg(not(target_os = "macos"))]
pub fn open(_app: &AppHandle, _session: u64) -> Result<usize, String> {
    Err("当前平台不支持截图".into())
}

/// 关闭全部覆盖窗（包括旧会话遗留的），并从面板注册表中移除。
pub fn close_all(app: &AppHandle) {
    let labels: Vec<String> = app.webview_windows().into_keys().filter(|label| label.starts_with(LABEL_PREFIX)).collect();
    for label in &labels { destroy_window(app, label); }
    if !labels.is_empty() { crate::diag!("截图：关闭 {} 个覆盖窗", labels.len()); }
}

/// 关闭由面板转换而来的窗口（覆盖窗、贴图）。直接销毁会导致进程崩溃，须先恢复窗口类型。
pub fn destroy_window(app: &AppHandle, label: &str) {
    #[cfg(target_os = "macos")]
    if let Ok(panel) = tauri_nspanel::ManagerExt::get_webview_panel(app, label) {
        panel.as_panel().orderOut(None);
        // 恢复 Tauri 原来的窗口类型与所有权，再交给运行时销毁。
        panel.to_window();
    }
    if let Some(window) = app.get_webview_window(label) {
        if let Err(error) = window.destroy() { crate::diag!("关闭窗口 {label} 失败：{error}"); }
    }
}

/// 暂时隐藏或恢复本会话的全部覆盖窗；恢复时 `key_label` 对应的覆盖窗取得键盘焦点。
pub fn set_visible(app: &AppHandle, visible: bool, key_label: &str) {
    #[cfg(target_os = "macos")]
    for label in app.webview_windows().into_keys().filter(|label| label.starts_with(LABEL_PREFIX)) {
        let Ok(panel) = tauri_nspanel::ManagerExt::get_webview_panel(app, &label) else { continue };
        let native = panel.as_panel();
        if !visible { native.orderOut(None) }
        else if label == key_label { native.makeKeyAndOrderFront(None) }
        else { native.orderFrontRegardless() }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, visible, key_label);
}

/// 从覆盖窗标签解析屏幕序号。
pub fn screen_of(label: &str) -> Option<usize> {
    label.strip_prefix(LABEL_PREFIX)?.split('-').nth(1)?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 覆盖窗标签携带会话编号() {
        assert_eq!(label(12, 1), "capture-12-1");
        assert_eq!(session_of("capture-12-1"), Some(12));
        assert_eq!(session_of("main"), None);
        assert_eq!(session_of("capture-x-1"), None);
        assert_eq!(screen_of("capture-12-1"), Some(1));
        assert_eq!(screen_of("pin-3"), None);
    }
}
