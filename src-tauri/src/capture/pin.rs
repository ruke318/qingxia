//! 贴图：把截图（含标注）钉在屏幕上，置顶显示在原截图位置。
//!
//! 每张贴图一个窗口（标签 `pin-<编号>`），截图会话结束后仍保留；图片经 `qingbox-capture://localhost/pin/<编号>.png`
//! 只提供给对应的贴图窗口。拖动移动、滚轮缩放、⌘C 复制、双击或 Esc 关闭。
use std::{
    collections::HashMap,
    sync::{atomic::{AtomicU64, Ordering}, Arc, Mutex},
};

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, Webview};

pub const LABEL_PREFIX: &str = "pin-";
/// 贴图最小边长（逻辑点），缩小到此为止。
const MIN_SIDE: f64 = 40.0;

static PINS: Mutex<Option<HashMap<u64, Arc<Vec<u8>>>>> = Mutex::new(None);
static NEXT: AtomicU64 = AtomicU64::new(1);

/// 当前打开的贴图数量；有贴图时收起主面板不隐藏应用，避免贴图一起消失。
pub fn count() -> usize {
    PINS.lock().ok().and_then(|pins| pins.as_ref().map(HashMap::len)).unwrap_or(0)
}

fn id_of(label: &str) -> Option<u64> {
    label.strip_prefix(LABEL_PREFIX)?.parse().ok()
}

/// 贴图图片，只交给对应的贴图窗口。
pub fn image(webview_label: &str, id: u64) -> Option<Arc<Vec<u8>>> {
    if id_of(webview_label) != Some(id) { return None }
    PINS.lock().ok()?.as_ref()?.get(&id).cloned()
}

/// 计算贴图在 AppKit 坐标中的位置：`screen` 为覆盖窗所在屏幕（左下角原点），`rect` 为选区（左上角原点的逻辑坐标）。
pub fn frame_on_screen(screen: (f64, f64, f64, f64), rect: (f64, f64, f64, f64)) -> (f64, f64, f64, f64) {
    let (sx, sy, _, sh) = screen;
    let (x, y, width, height) = rect;
    (sx + x, sy + sh - y - height, width.max(MIN_SIDE), height.max(MIN_SIDE))
}

/// 按比例缩放并保持中心不动，最短边不小于 [`MIN_SIDE`]。
pub fn scaled(frame: (f64, f64, f64, f64), factor: f64) -> (f64, f64, f64, f64) {
    let (x, y, width, height) = frame;
    let factor = factor.max(MIN_SIDE / width.min(height));
    let (next_width, next_height) = (width * factor, height * factor);
    (x + (width - next_width) / 2.0, y + (height - next_height) / 2.0, next_width, next_height)
}

#[cfg(target_os = "macos")]
mod panel_type {
    tauri_nspanel::tauri_panel! {
      panel!(PinPanel {
          config: {
              can_become_key_window: true,
              can_become_main_window: false,
              is_floating_panel: true
          }
      })
    }
}

/// 在覆盖窗所在屏幕的选区位置打开贴图。须在主线程调用。
#[cfg(target_os = "macos")]
pub fn open(app: &AppHandle, png: Vec<u8>, screen_index: usize, rect: (f64, f64, f64, f64)) -> Result<(), String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSColor, NSFloatingWindowLevel, NSScreen, NSWindowCollectionBehavior, NSWindowStyleMask};
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    use tauri_nspanel::WebviewWindowExt;

    let main_thread = MainThreadMarker::new().ok_or("贴图必须在主线程创建")?;
    let screens = NSScreen::screens(main_thread);
    let screen = screens.iter().nth(screen_index).or_else(|| screens.iter().next()).ok_or("找不到屏幕")?;
    let area = screen.frame();
    let (x, y, width, height) = frame_on_screen((area.origin.x, area.origin.y, area.size.width, area.size.height), rect);
    let id = NEXT.fetch_add(1, Ordering::SeqCst);
    let label = format!("{LABEL_PREFIX}{id}");
    PINS.lock().map_err(|_| "贴图状态不可用")?.get_or_insert_with(HashMap::new).insert(id, Arc::new(png));
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("capture.html".into()))
        .title("轻匣贴图")
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .skip_taskbar(true)
        .visible(false)
        .accept_first_mouse(true)
        .inner_size(width, height)
        .initialization_script(format!("window.__QINGBOX_PIN__ = {{ id: {id}, image: \"qingbox-capture://localhost/pin/{id}.png\" }};"))
        .build()
        .map_err(|error| { remove(id); format!("创建贴图窗口失败：{error}") })?;
    let panel = window.to_panel::<panel_type::PinPanel>().map_err(|error| { remove(id); format!("创建贴图面板失败：{error}") })?;
    panel.set_becomes_key_only_if_needed(false);
    panel.set_hides_on_deactivate(false);
    panel.set_works_when_modal(true);
    panel.set_released_when_closed(false);
    let native = panel.as_panel();
    if let Err(error) = panel.set_style_mask(native.styleMask() | NSWindowStyleMask::NonactivatingPanel) {
        crate::diag!("贴图设置非激活标志失败：{error:?}");
    }
    native.setOpaque(false);
    native.setBackgroundColor(Some(&NSColor::clearColor()));
    panel.set_has_shadow(true);
    panel.set_level(NSFloatingWindowLevel as i64);
    // 切换桌面空间时跟随，也能停留在全屏应用之上，方便对照
    panel.set_collection_behavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::IgnoresCycle,
    );
    native.setFrame_display(NSRect::new(NSPoint::new(x, y), NSSize::new(width, height)), false);
    // 截图结束时应用可能已被隐藏，先恢复显示（不激活）贴图才看得见
    objc2_app_kit::NSApplication::sharedApplication(main_thread).unhideWithoutActivation();
    native.makeKeyAndOrderFront(None);
    native.orderFrontRegardless();
    if let Some(webview) = app.get_webview(&label) { let _ = webview.set_focus(); }
    crate::diag!("贴图：打开 {label}，{width:.0}×{height:.0}");
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn open(_app: &AppHandle, _png: Vec<u8>, _screen_index: usize, _rect: (f64, f64, f64, f64)) -> Result<(), String> {
    Err("当前平台不支持贴图".into())
}

fn remove(id: u64) {
    if let Ok(mut pins) = PINS.lock() {
        if let Some(map) = pins.as_mut() { map.remove(&id); }
    }
}

fn require_pin(webview: &Webview) -> Result<u64, String> {
    id_of(webview.label()).ok_or_else(|| "只有贴图窗口可以执行此操作".into())
}

/// 关闭贴图窗口并释放图片。
#[tauri::command]
pub fn pin_close(app: AppHandle, webview: Webview) -> Result<(), String> {
    let id = require_pin(&webview)?;
    remove(id);
    super::overlay::destroy_window(&app, webview.label());
    crate::diag!("贴图：关闭 {}", webview.label());
    Ok(())
}

/// 缩放贴图，`factor` 大于 1 放大、小于 1 缩小，保持中心不动。
#[tauri::command]
pub fn pin_scale(app: AppHandle, webview: Webview, factor: f64) -> Result<(), String> {
    require_pin(&webview)?;
    if !factor.is_finite() || factor <= 0.0 { return Err("缩放比例不正确".into()) }
    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::{NSPoint, NSRect, NSSize};
        let panel = tauri_nspanel::ManagerExt::get_webview_panel(&app, webview.label()).map_err(|_| "找不到贴图窗口")?;
        let native = panel.as_panel();
        let frame = native.frame();
        let (x, y, width, height) = scaled((frame.origin.x, frame.origin.y, frame.size.width, frame.size.height), factor);
        native.setFrame_display(NSRect::new(NSPoint::new(x, y), NSSize::new(width, height)), true);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    Ok(())
}

/// 复制贴图到剪贴板。
#[tauri::command]
pub fn pin_copy(webview: Webview) -> Result<(), String> {
    let id = require_pin(&webview)?;
    let png = image(webview.label(), id).ok_or("贴图已关闭")?;
    super::export::copy(&png)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 贴图出现在原选区位置() {
        // 屏幕原点 (100, -200)、高 1000；选区左上角 (50, 80)、200×100（左上角原点）
        assert_eq!(frame_on_screen((100.0, -200.0, 1600.0, 1000.0), (50.0, 80.0, 200.0, 100.0)), (150.0, 620.0, 200.0, 100.0));
        assert_eq!(frame_on_screen((0.0, 0.0, 800.0, 600.0), (0.0, 0.0, 10.0, 10.0)).2, MIN_SIDE, "过小的选区按最小边长显示");
    }

    #[test]
    fn 缩放保持中心且有最小尺寸() {
        assert_eq!(scaled((100.0, 100.0, 200.0, 100.0), 2.0), (0.0, 50.0, 400.0, 200.0));
        let (_, _, width, height) = scaled((0.0, 0.0, 200.0, 100.0), 0.01);
        assert_eq!((width, height), (80.0, 40.0), "最短边不小于最小边长");
    }

    #[test]
    fn 贴图图片只交给对应窗口() {
        PINS.lock().unwrap().get_or_insert_with(HashMap::new).insert(9001, Arc::new(vec![1]));
        assert!(image("pin-9001", 9001).is_some());
        assert!(image("pin-9002", 9001).is_none());
        assert!(image("capture-1-0", 9001).is_none());
        remove(9001);
    }
}
