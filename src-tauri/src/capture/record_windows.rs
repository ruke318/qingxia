//! 录屏选区、控制条、边框与录完的操作卡片，沿用截图面板的安全销毁方式。
use std::{collections::HashMap, sync::Mutex};
use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use super::record::RecordRect;
static DISPLAYS: Mutex<Option<(u64, HashMap<String, u32>)>> = Mutex::new(None);
#[derive(Serialize)]
pub struct Candidate { pub id: u32, pub name: String, #[serde(flatten)] pub rect: RecordRect }
pub fn validate_display(label: &str, id: u64, display: u32) -> Result<(), String> {
    let good = DISPLAYS.lock().is_ok_and(|g| g.as_ref().is_some_and(|(s, m)| *s == id && m.get(label) == Some(&display)));
    if good { Ok(()) } else { Err("选区窗口与显示器不匹配".into()) }
}
#[cfg(target_os = "macos")]
mod panel_type {
    tauri_nspanel::tauri_panel! { panel!(RecordPanel { config: { can_become_key_window: true, can_become_main_window: false, is_floating_panel: true } }) }
}
#[cfg(target_os = "macos")]
fn panel(app: &AppHandle, label: &str, context: serde_json::Value, frame: objc2_foundation::NSRect, passthrough: bool) -> Result<(), String> {
    use objc2_app_kit::{NSColor, NSScreenSaverWindowLevel, NSWindowCollectionBehavior, NSWindowStyleMask};
    use tauri_nspanel::WebviewWindowExt;
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::App("capture.html".into()))
        .title("轻匣录屏").decorations(false).transparent(true).shadow(false).resizable(false)
        .skip_taskbar(true).visible(false).accept_first_mouse(true).inner_size(frame.size.width, frame.size.height)
        .initialization_script(format!("window.__QINGBOX_RECORD__ = {context};"))
        .build().map_err(|e| format!("创建录屏窗口失败：{e}"))?;
    let panel = window.to_panel::<panel_type::RecordPanel>().map_err(|e| format!("创建录屏面板失败：{e}"))?;
    panel.set_becomes_key_only_if_needed(false); panel.set_hides_on_deactivate(false); panel.set_works_when_modal(true); panel.set_released_when_closed(false);
    let native = panel.as_panel();
    panel.set_style_mask(native.styleMask() | NSWindowStyleMask::NonactivatingPanel).map_err(|e| format!("设置录屏面板失败：{e:?}"))?;
    native.setOpaque(false); native.setBackgroundColor(Some(&NSColor::clearColor())); panel.set_has_shadow(false);
    panel.set_level(NSScreenSaverWindowLevel as i64);
    panel.set_collection_behavior(NSWindowCollectionBehavior::CanJoinAllSpaces | NSWindowCollectionBehavior::CanJoinAllApplications | NSWindowCollectionBehavior::FullScreenAuxiliary | NSWindowCollectionBehavior::Stationary | NSWindowCollectionBehavior::IgnoresCycle);
    native.setIgnoresMouseEvents(passthrough); native.setFrame_display(frame, false); native.orderFrontRegardless();
    Ok(())
}
#[cfg(target_os = "macos")]
pub fn select(app: &AppHandle, id: u64) -> Result<(), String> {
    use objc2::{MainThreadMarker, runtime::AnyObject};
    use objc2_foundation::{NSString, NSNumber, NSArray, NSDictionary};
    use objc2_app_kit::{NSScreen, NSEvent, NSApplication};
    use objc2_core_graphics::{CGWindowListCopyWindowInfo, CGWindowListOption};
    let marker = MainThreadMarker::new().ok_or("录屏窗口必须在主线程创建")?;
    let raw = CGWindowListCopyWindowInfo(CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements, 0);
    let raw: Option<&NSArray<NSDictionary<NSString, AnyObject>>> = raw.as_ref().map(|r| unsafe { &*(objc2_core_foundation::CFRetained::as_ptr(r).as_ptr() as *const _) });
    let num = |d: &NSDictionary<NSString, AnyObject>, key: &str| d.objectForKey(&NSString::from_str(key)).and_then(|v| v.downcast::<NSNumber>().ok()).map(|n| n.doubleValue());
    let mut display_map = HashMap::new(); let mut focus = None; let mouse = NSEvent::mouseLocation();
    for (index, screen) in NSScreen::screens(marker).iter().enumerate() {
        let display = screen.deviceDescription().objectForKey(&NSString::from_str("NSScreenNumber")).and_then(|v| v.downcast::<NSNumber>().ok()).map(|n| n.unsignedIntValue()).ok_or("无法识别显示器")?;
        let bounds = objc2_core_graphics::CGDisplayBounds(display); let frame = screen.frame();
        let mut candidates = Vec::new();
        if let Some(raw) = raw { for window in raw.iter() {
            if num(&window, "kCGWindowOwnerPID") == Some(f64::from(std::process::id())) || num(&window, "kCGWindowLayer") != Some(0.0) { continue }
            let Some(b) = window.objectForKey(&NSString::from_str("kCGWindowBounds")).and_then(|v| v.downcast::<NSDictionary>().ok()) else { continue };
            let b: &NSDictionary<NSString, AnyObject> = unsafe { &*(objc2::rc::Retained::as_ptr(&b) as *const _) };
            let (Some(x), Some(y), Some(w), Some(h), Some(wid)) = (num(b, "X"), num(b, "Y"), num(b, "Width"), num(b, "Height"), num(&window, "kCGWindowNumber")) else { continue };
            if w < 20.0 || h < 20.0 || x + w <= bounds.origin.x || y + h <= bounds.origin.y || x >= bounds.origin.x + bounds.size.width || y >= bounds.origin.y + bounds.size.height { continue }
            let name = window.objectForKey(&NSString::from_str("kCGWindowName")).and_then(|v| v.downcast::<NSString>().ok()).map(|s| s.to_string()).filter(|s| !s.is_empty())
                .or_else(|| window.objectForKey(&NSString::from_str("kCGWindowOwnerName")).and_then(|v| v.downcast::<NSString>().ok()).map(|s| s.to_string())).unwrap_or_else(|| "窗口".into());
            candidates.push(Candidate { id: wid as u32, name, rect: RecordRect { x: x - bounds.origin.x, y: y - bounds.origin.y, width: w, height: h } });
        } }
        let scale = super::screenshot::info(id, display).unwrap_or(screen.backingScaleFactor());
        let label = format!("record-select-{id}-{index}");
        let context = serde_json::json!({"role":"select", "session":id, "display":display, "screen":index, "scale":scale, "image":format!("qingbox-capture://localhost/{id}/{display}.png"), "windows":candidates});
        panel(app, &label, context, frame, false)?; display_map.insert(label.clone(), display);
        if crate::native_window::contains(frame, mouse) { focus = Some(label); }
    }
    *DISPLAYS.lock().map_err(|_| "录屏显示器状态不可用")? = Some((id, display_map));
    NSApplication::sharedApplication(marker).unhideWithoutActivation();
    let label = focus.unwrap_or_else(|| format!("record-select-{id}-0"));
    if let Ok(p) = tauri_nspanel::ManagerExt::get_webview_panel(app, &label) { p.as_panel().makeKeyAndOrderFront(None); }
    if let Some(w) = app.get_webview(&label) { let _ = w.set_focus(); }
    Ok(())
}
#[cfg(target_os = "macos")]
pub fn controls(app: &AppHandle, id: u64) -> Result<(), String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSScreen;
    use objc2_foundation::{NSRect, NSPoint, NSSize};
    let marker = MainThreadMarker::new().ok_or("录屏控制窗必须在主线程创建")?;
    let screen = NSScreen::mainScreen(marker).ok_or("没有可用显示器")?; let f = screen.visibleFrame();
    let frame = NSRect::new(NSPoint::new(f.origin.x + (f.size.width - 300.0) / 2.0, f.origin.y + 24.0), NSSize::new(300.0, 44.0));
    let label = format!("record-control-{id}");
    panel(app, &label, serde_json::json!({"role":"control","session":id}), frame, false)?;
    // 胶囊形控制条使用系统阴影，与截图工具栏的悬浮感一致
    if let Ok(control) = tauri_nspanel::ManagerExt::get_webview_panel(app, &label) { control.set_has_shadow(true); }
    Ok(())
}
#[cfg(target_os = "macos")]
pub fn border(app: &AppHandle, id: u64, display: u32, rect: &RecordRect) -> Result<(), String> {
    use objc2::MainThreadMarker; use objc2_app_kit::NSScreen; use objc2_foundation::{NSRect, NSPoint, NSSize, NSString, NSNumber};
    let marker = MainThreadMarker::new().ok_or("录屏边框必须在主线程创建")?;
    let screen = NSScreen::screens(marker).iter().find(|s| s.deviceDescription().objectForKey(&NSString::from_str("NSScreenNumber")).and_then(|v| v.downcast::<NSNumber>().ok()).is_some_and(|n| n.unsignedIntValue() == display)).ok_or("录屏显示器已断开")?;
    let f = screen.frame(); let frame = NSRect::new(NSPoint::new(f.origin.x + rect.x - 2.0, f.origin.y + f.size.height - rect.y - rect.height - 2.0), NSSize::new(rect.width + 4.0, rect.height + 4.0));
    panel(app, &format!("record-border-{id}"), serde_json::json!({"role":"border","session":id,"display":display}), frame, true)
}
/// 录完的操作卡片：显示在主屏右下角，浮动层级；用户点任一操作或关闭后才消失。新卡片出现时关闭旧卡片。
#[cfg(target_os = "macos")]
pub fn card(app: &AppHandle, path: &std::path::Path, duration: f64, warning: Option<String>) -> Result<(), String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSFloatingWindowLevel, NSScreen};
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    let marker = MainThreadMarker::new().ok_or("录屏卡片必须在主线程创建")?;
    super::record::close_cards(app);
    let id = super::record::register_card(path);
    let label = format!("{}{id}", super::record::CARD_PREFIX);
    let screen = NSScreen::mainScreen(marker).ok_or("没有可用显示器")?;
    let area = screen.visibleFrame();
    let (width, height) = (400.0, if warning.is_some() { 138.0 } else { 104.0 });
    let frame = NSRect::new(NSPoint::new(area.origin.x + area.size.width - width - 16.0, area.origin.y + 16.0), NSSize::new(width, height));
    let context = serde_json::json!({
        "role": "card",
        "session": id,
        "name": path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default(),
        "path": path.to_string_lossy(),
        "duration": duration,
        "size": std::fs::metadata(path).map(|metadata| metadata.len()).unwrap_or(0),
        "warning": warning,
        "video": format!("qingbox-record://localhost/card/{id}.mp4"),
    });
    if let Err(error) = panel(app, &label, context, frame, false) {
        super::record::close_cards(app);
        return Err(error);
    }
    if let Ok(card) = tauri_nspanel::ManagerExt::get_webview_panel(app, &label) {
        card.set_level(NSFloatingWindowLevel as i64);
        card.set_has_shadow(true);
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn card(_app: &AppHandle, _path: &std::path::Path, _duration: f64, _warning: Option<String>) -> Result<(), String> {
    Err("当前平台不支持录屏卡片".into())
}

pub fn close_role(app: &AppHandle, role: &str) {
    let prefix = format!("record-{role}-");
    for label in app.webview_windows().into_keys().filter(|s| s.starts_with(&prefix)) { super::overlay::destroy_window(app, &label); }
}
/// 关闭录屏会话的窗口（选区、控制条、边框），保留录完的操作卡片。
pub fn close_all(app: &AppHandle) {
    for label in app.webview_windows().into_keys().filter(|s| s.starts_with("record-") && !s.starts_with(super::record::CARD_PREFIX)) { super::overlay::destroy_window(app, &label); }
    if let Ok(mut g) = DISPLAYS.lock() { *g = None; }
}
#[cfg(not(target_os = "macos"))]
pub fn select(_app: &AppHandle, _id: u64) -> Result<(), String> { Err("当前平台不支持录屏".into()) }
#[cfg(not(target_os = "macos"))]
pub fn controls(_app: &AppHandle, _id: u64) -> Result<(), String> { Err("当前平台不支持录屏".into()) }

fn startup_window_labels(id: u64, labels: impl Iterator<Item = String>) -> Vec<String> {
    labels.filter(|label| super::record::authorized(label, id, &["border", "control"])).collect()
}
pub fn rollback_start(app: &AppHandle, id: u64) {
    for label in startup_window_labels(id, app.webview_windows().into_keys()) { super::overlay::destroy_window(app, &label); }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn 启动回滚清除部分创建的边框但保留选区和其他会话() {
        let labels = ["record-select-7-0", "record-border-7", "record-control-7", "record-border-8", "main"].map(str::to_string);
        assert_eq!(startup_window_labels(7, labels.into_iter()), vec!["record-border-7", "record-control-7"]);
    }
}
