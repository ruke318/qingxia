use std::{cell::{Cell, RefCell}, ptr::NonNull, time::{Duration, Instant}};
use block2::RcBlock;
use objc2::{MainThreadMarker, MainThreadOnly, rc::Retained, runtime::{AnyClass, ProtocolObject}};
use objc2_app_kit::{
    NSApplication, NSApplicationDidBecomeActiveNotification, NSApplicationDidResignActiveNotification,
    NSBox, NSBoxType, NSColor, NSEvent, NSGlassEffectView, NSGlassEffectViewStyle, NSPanel, NSScreen,
    NSScreenSaverWindowLevel, NSTitlePosition, NSView,
    NSVisualEffectBlendingMode, NSVisualEffectState, NSVisualEffectView,
    NSWindowCollectionBehavior, NSWindowOrderingMode, NSWindowStyleMask,
};
use objc2_foundation::{NSNotification, NSNotificationCenter, NSObjectProtocol, NSOperationQueue, NSPoint, NSRect, NSSize};
use tauri::{Emitter, Manager, WebviewWindow, Window};
use tauri_nspanel::{ManagerExt, WebviewWindowExt};

thread_local! {
    static ACTIVATION_PENDING: Cell<bool> = const { Cell::new(false) };
    static PRESENTED_AT: Cell<Option<Instant>> = const { Cell::new(None) };
    static ACTIVATION_OBSERVERS: RefCell<Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>>> = const { RefCell::new(Vec::new()) };
}

fn observe_activation(window: &WebviewWindow) {
    let center = NSNotificationCenter::defaultCenter();
    // 应用激活异步完成。过渡期间忽略失焦，收到激活通知后再取得键盘焦点。
    for (name, activated) in unsafe { [(NSApplicationDidBecomeActiveNotification, true), (NSApplicationDidResignActiveNotification, false)] } {
        let target = window.as_ref().window().clone();
        let block = RcBlock::new(move |_: NonNull<NSNotification>| {
            if MainThreadMarker::new().is_none() { return }
            if !activated {
                ACTIVATION_PENDING.set(false);
                let _ = hide_if_unfocused(&target);
                return;
            }
            if !ACTIVATION_PENDING.get() { return }
            let target = target.clone();
            let focus = RcBlock::new(move || {
                let Some(main_thread) = MainThreadMarker::new() else { return };
                if !ACTIVATION_PENDING.replace(false) || !NSApplication::sharedApplication(main_thread).isActive() { return }
                if let Ok(panel) = target.get_webview_panel(target.label()) {
                    let native = panel.as_panel();
                    if native.isVisible() {
                        native.makeKeyAndOrderFront(None);
                        native.orderFrontRegardless();
                    }
                }
            });
            // 退出激活通知的调用栈后再聚焦，避免 AppKit 后续的激活处理再次取消 key 状态。
            unsafe { NSOperationQueue::mainQueue().addOperationWithBlock(&focus); }
        });
        // 通知由 AppKit 主线程发送；捕获的 Tauri 窗口可跨线程传递，回调内仍检查主线程。
        let observer = unsafe { center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block) };
        ACTIVATION_OBSERVERS.with_borrow_mut(|observers| observers.push(observer));
    }
}

mod panel_type {
    tauri_nspanel::tauri_panel! {
      panel!(LauncherPanel {
          config: {
              can_become_key_window: true,
              can_become_main_window: false,
              is_floating_panel: true
          }
      })
    }
}

pub fn prepare(window: &WebviewWindow) -> Result<(), String> {
    let main_thread = MainThreadMarker::new().ok_or("原生面板必须在主线程初始化")?;
    let panel = window
        .to_panel::<panel_type::LauncherPanel>()
        .map_err(|error| format!("创建原生悬浮面板失败：{error}"))?;
    panel.set_becomes_key_only_if_needed(false);
    panel.set_hides_on_deactivate(false);
    panel.set_works_when_modal(true);
    // 初始化时固定非激活面板标志，让同一面板可反复进入其他应用的全屏空间。
    if let Err(error) = panel.set_style_mask(panel.as_panel().styleMask() | NSWindowStyleMask::NonactivatingPanel) {
        eprintln!("设置非激活面板标志失败：{error:?}");
    }
    // 背景和材质在隐藏初始化阶段固定，唤起时只布局和显示。
    panel.as_panel().setOpaque(false);
    panel
        .as_panel()
        .setBackgroundColor(Some(&NSColor::clearColor()));
    panel.set_has_shadow(false);
    panel.set_level(NSScreenSaverWindowLevel as i64);
    panel.set_collection_behavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::CanJoinAllApplications
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::IgnoresCycle,
    );
    panel.set_corner_radius(18.0);
    let content = panel.content_view();
    content.setWantsLayer(true);
    if let Some(layer) = content.layer() {
        layer.setMasksToBounds(true);
    }
    configure_material(&content, main_thread);
    observe_activation(window);
    Ok(())
}

fn contains(frame: NSRect, point: NSPoint) -> bool {
    point.x >= frame.origin.x
        && point.x < frame.origin.x + frame.size.width
        && point.y >= frame.origin.y
        && point.y < frame.origin.y + frame.size.height
}

fn centered_x(screen: NSRect, window_width: f64) -> f64 {
    (screen.origin.x + (screen.size.width - window_width) / 2.0).round()
}

fn launcher_frame(screen: NSRect, available: NSRect, height: f64) -> NSRect {
    let width = (screen.size.width / 3.0).round().max(crate::LAUNCHER_MIN_WIDTH);
    let top = available.origin.y + available.size.height * 2.0 / 3.0 + 30.0;
    NSRect::new(
        NSPoint::new(centered_x(screen, width), top - height),
        NSSize::new(width, height),
    )
}

fn expanded_frame(current: NSRect, available: NSRect, requested: f64) -> NSRect {
    let top = current.origin.y + current.size.height;
    let height = requested.clamp(60.0, 670.0);
    let y = if requested >= 670.0 {
        (top - height).max(available.origin.y + 8.0)
    } else {
        top - height.min((top - available.origin.y - 8.0).max(60.0))
    };
    let height = if requested >= 670.0 { height } else { top - y };
    NSRect::new(
        NSPoint::new(current.origin.x, y),
        NSSize::new(current.size.width, height),
    )
}

fn configure_material(view: &NSView, main_thread: MainThreadMarker) {
    if let Some(material) = view.downcast_ref::<NSVisualEffectView>() {
        material.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
        material.setState(NSVisualEffectState::Active);
        // 保留原生背景模糊的完整强度。
        view.setAlphaValue(1.0);
        overlay_material(view, main_thread);
        return;
    }
    for child in view.subviews() {
        configure_material(&child, main_thread);
    }
}

/// macOS 26 起改用与系统聚焦搜索相同的 Liquid Glass；更早的系统保留原材质并叠加 36% 白色遮罩。
/// 覆盖层放在材质视图正上方、网页下方，随窗口尺寸自动伸缩。
fn overlay_material(material: &NSView, main_thread: MainThreadMarker) {
    let Some(parent) = (unsafe { material.superview() }) else { return };
    let overlay: Retained<NSView> = if AnyClass::get(c"NSGlassEffectView").is_some() {
        // 玻璃边缘自带镜面高光：四边各外扩 4pt、圆角同心放大，高光整体落在窗口外被裁掉。
        let frame = material.frame();
        let frame = NSRect::new(
            NSPoint::new(frame.origin.x - 4.0, frame.origin.y - 4.0),
            NSSize::new(frame.size.width + 8.0, frame.size.height + 8.0),
        );
        let glass = NSGlassEffectView::initWithFrame(NSGlassEffectView::alloc(main_thread), frame);
        glass.setStyle(NSGlassEffectViewStyle::Regular);
        glass.setCornerRadius(22.0);
        material.setHidden(true);
        Retained::into_super(glass)
    } else {
        let tint = NSBox::initWithFrame(NSBox::alloc(main_thread), material.frame());
        tint.setBoxType(NSBoxType::Custom);
        tint.setTitlePosition(NSTitlePosition::NoTitle);
        tint.setBorderWidth(0.0);
        tint.setContentViewMargins(NSSize::new(0.0, 0.0));
        tint.setFillColor(&NSColor::colorWithWhite_alpha(1.0, 0.36));
        Retained::into_super(tint)
    };
    overlay.setAutoresizingMask(material.autoresizingMask());
    parent.addSubview_positioned_relativeTo(&overlay, NSWindowOrderingMode::Above, Some(material));
}

/// 唤起后的过渡期：系统激活应用时可能在应用之间来回切换（全屏空间尤甚），
/// 期间的失焦不代表用户离开，不能据此收起面板。
const SETTLE: Duration = Duration::from_millis(600);

fn settling() -> bool {
    PRESENTED_AT.get().is_some_and(|at| at.elapsed() < SETTLE)
}

/// 过渡期结束后复查：面板仍显示却没有键盘焦点时再取一次，仍取不到就按失焦收起，
/// 避免无法操作的面板停留在最上层。
fn settle_later(window: &Window) {
    let target = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(SETTLE);
        let _ = on_main_thread(&target, |target, native, main_thread| {
            if !native.isVisible() || native.isKeyWindow() || settling() { return }
            native.makeKeyAndOrderFront(None);
            if !native.isKeyWindow() && !NSApplication::sharedApplication(main_thread).isActive() {
                hide_now(target, native, main_thread);
            }
        });
    });
}

/// 唤起时激活应用，使系统“编辑”菜单的快捷键生效；应用此前被隐藏时先取消隐藏。
fn activate_application(native: &NSPanel, main_thread: MainThreadMarker) {
    PRESENTED_AT.set(Some(Instant::now()));
    let application = NSApplication::sharedApplication(main_thread);
    ACTIVATION_PENDING.set(!application.isActive());
    application.unhideWithoutActivation();
    // 先在当前空间显示面板，再激活编辑菜单，避免沿用应用上次激活所在的桌面空间。
    native.orderFrontRegardless();
    native.makeKeyAndOrderFront(None);
    #[allow(deprecated)]
    application.activateIgnoringOtherApps(true);
}

/// 收起面板后隐藏应用，由系统把焦点交还之前的前台应用；应用已不在前台时无需处理。
fn hide_application(main_thread: MainThreadMarker) {
    ACTIVATION_PENDING.set(false);
    let application = NSApplication::sharedApplication(main_thread);
    if application.isActive() {
        application.hide(None);
    }
}

fn on_main_thread(
    window: &Window,
    action: impl FnOnce(&Window, &NSPanel, MainThreadMarker) + Send + 'static,
) -> Result<(), String> {
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            let Some(main_thread) = MainThreadMarker::new() else {
                return;
            };
            match target.get_webview_panel(target.label()) {
                Ok(panel) => {
                    action(&target, panel.as_panel(), main_thread);
                }
                Err(error) => eprintln!("无法取得原生悬浮面板：{error:?}"),
            }
        })
        .map_err(|error| format!("调度原生窗口失败：{error}"))
}

pub fn present(window: &Window, height: f64, event: &'static str) -> Result<(), String> {
    on_main_thread(window, move |target, native, main_thread| {
        let mouse = NSEvent::mouseLocation();
        let screens = NSScreen::screens(main_thread);
        let screen = screens
            .iter()
            .find(|screen| contains(screen.frame(), mouse))
            .or_else(|| screens.iter().next());
        let Some(screen) = screen else {
            return;
        };
        // 全程使用 AppKit 的逻辑坐标，避免混合缩放显示器间的坐标换算错误。
        let frame = launcher_frame(screen.frame(), screen.visibleFrame(), height);
        let frame = if height >= 670.0 { expanded_frame(frame, screen.visibleFrame(), height) } else { frame };
        // 隐藏窗口先完成布局，交给置前操作绘制，避免提前绘制旧背景。
        native.setFrame_display(frame, false);
        activate_application(native, main_thread);
        // AppKit 显示面板后可能约束窗口尺寸，按最终宽度再次对齐屏幕中心。
        let actual = native.frame();
        native.setFrameOrigin(NSPoint::new(
            centered_x(screen.frame(), actual.size.width),
            actual.origin.y,
        ));
        let _ = target.emit(event, ());
        settle_later(target);
        #[cfg(debug_assertions)]
        {
            let actual = native.frame();
            let left = actual.origin.x - screen.frame().origin.x;
            let right = screen.frame().size.width - left - actual.size.width;
            eprintln!("主入口已唤起：实际宽 {:.0}，高 {:.0}，屏幕宽 {:.0}，左右留白 {:.1}/{:.1}，鼠标 ({:.0}, {:.0})，窗口 ({:.0}, {:.0})", actual.size.width, actual.size.height, screen.frame().size.width, left, right, mouse.x, mouse.y, actual.origin.x, actual.origin.y);
        }
    })
}

pub fn hide_if_unfocused(window: &Window) -> Result<(), String> {
    on_main_thread(window, |target, native, main_thread| {
        // 过渡期内的失焦多为系统在应用间来回切换激活，不收起，重新取得键盘焦点。
        if settling() && native.isVisible() {
            native.makeKeyAndOrderFront(None);
            native.orderFrontRegardless();
            return;
        }
        // 激活过程中可能先收到 key 窗口变更；只有应用确实退到后台才自动隐藏。
        let hide = !ACTIVATION_PENDING.get() && !NSApplication::sharedApplication(main_thread).isActive() && !native.isKeyWindow();
        if hide { hide_now(target, native, main_thread) }
    })
}

fn hide_now(target: &Window, native: &NSPanel, main_thread: MainThreadMarker) {
    // 导入选择器、Hosts 授权会先收起面板再弹出系统界面，此时不能隐藏应用。
    let visible = native.isVisible();
    crate::plugins::hide_active(target.app_handle());
    let _ = target.hide();
    if visible {
        hide_application(main_thread);
    }
}

/// 面板已由调用方收起，再隐藏应用以交还焦点。
pub fn hide_app(window: &Window) -> Result<(), String> {
    on_main_thread(window, |_, _, main_thread| hide_application(main_thread))
}

pub fn resize(window: &Window, height: f64) -> Result<(), String> {
    on_main_thread(window, move |_, native, _| {
        if let Some(screen) = native.screen() {
            native.setFrame_display(
                expanded_frame(native.frame(), screen.visibleFrame(), height),
                true,
            );
        }
    })
}

pub fn present_plugin(window: &Window) -> Result<(), String> {
    on_main_thread(window, move |target, native, main_thread| {
        if let Some(screen) = native.screen() {
            native.setFrame_display(expanded_frame(native.frame(), screen.visibleFrame(), 670.0), false);
        }
        activate_application(native, main_thread);
        settle_later(target);
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 实际宽度受系统约束后仍按左右等距定位() {
        let screen = NSRect::new(NSPoint::new(1512.0, 0.0), NSSize::new(3000.0, 1440.0));
        assert_eq!(launcher_frame(screen, screen, 60.0).size.width, 1000.0);
        let width = 900.0;
        let x = centered_x(screen, width);
        assert_eq!(
            x - screen.origin.x,
            screen.origin.x + screen.size.width - x - width
        );
    }

    #[test]
    fn 扩展屏负坐标使用最小宽度并保持居中与上方定位() {
        let screen = NSRect::new(NSPoint::new(-1920.0, 0.0), NSSize::new(1920.0, 1080.0));
        let available = NSRect::new(NSPoint::new(-1920.0, 24.0), NSSize::new(1920.0, 1032.0));
        let frame = launcher_frame(screen, available, 60.0);
        assert_eq!(frame.size.width, 900.0);
        assert_eq!(frame.origin.x, -1410.0);
        assert_eq!(frame.origin.y + 30.0, 712.0);
        assert!(contains(screen, NSPoint::new(-1000.0, 200.0)));
        assert!(!contains(screen, NSPoint::new(0.0, 200.0)));
    }

    #[test]
    fn 上方显示器使用同一逻辑坐标且不除以缩放倍数() {
        let screen = NSRect::new(NSPoint::new(200.0, 900.0), NSSize::new(1512.0, 982.0));
        let frame = launcher_frame(screen, screen, 60.0);
        assert_eq!(frame.size.width, 900.0);
        assert_eq!(frame.origin.x, 506.0);
        assert!(contains(screen, NSPoint::new(500.0, 1200.0)));
    }

    #[test]
    fn 插件和设置保留完整六百一十内容高度并移入可见区域() {
        let current = NSRect::new(NSPoint::new(200.0, 140.0), NSSize::new(504.0, 60.0));
        let available = NSRect::new(NSPoint::new(0.0, 24.0), NSSize::new(1512.0, 920.0));
        let frame = expanded_frame(current, available, 670.0);
        assert_eq!(frame.size.height - 60.0, 610.0);
        assert_eq!(frame.origin.x, current.origin.x);
        assert_eq!(frame.origin.y, available.origin.y + 8.0);
        assert!(frame.origin.y + frame.size.height <= available.origin.y + available.size.height);
    }

    #[test]
    fn 拖动后展开保持顶部且不超出剩余屏幕() {
        let current = NSRect::new(NSPoint::new(-1200.0, 140.0), NSSize::new(640.0, 60.0));
        let available = NSRect::new(NSPoint::new(-1920.0, 24.0), NSSize::new(1920.0, 1032.0));
        let frame = expanded_frame(current, available, 600.0);
        assert_eq!(frame.origin.x, current.origin.x);
        assert_eq!(frame.origin.y + frame.size.height, 200.0);
        assert_eq!(frame.origin.y, 32.0);
        assert_eq!(frame.size.height, 168.0);
    }
}
