//! 长截图：用户在选区内自己上下滚动，后台每 80 毫秒截取一次选区并拼接；选区旁的面板上方是与选区等高的
//! 实时预览（整张长图等比缩小完整显示），下方是保存、取消、复制三个按钮，点一下即合成并结束截图会话。
//!
//! 控制面板标签 `longshot-<会话>`；截取时排除轻匣自身窗口，选区边框与面板不会进入长图。
use std::{
    sync::{atomic::{AtomicBool, Ordering}, mpsc, Arc, Mutex},
    time::{Duration, Instant},
};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, Webview};

use super::{long_stitch::{self, Stitcher, Update}, overlay, CaptureState, Event};

pub const LABEL_PREFIX: &str = "longshot-";
/// 截取间隔。
const INTERVAL: Duration = Duration::from_millis(80);
/// 连续这么多帧接不上才提示“滚动太快”，偶尔一帧接不上不打扰用户。
const LOST_FRAMES_TO_WARN: u32 = 3;
/// 右侧滚动条宽度（逻辑点），比对时排除。
const SCROLLBAR_POINTS: f64 = 16.0;
/// 预览与工具栏的间距、工具栏高度（逻辑点）。
const TOOLBAR_GAP: f64 = 8.0;
const TOOLBAR_HEIGHT: f64 = 40.0;

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct LongRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// 推送给控制面板的进度。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    height: usize,
    thumbnail: Option<String>,
    /// `scrolling`、`lost`（滚动太快）、`limited`（达到最大高度）、`error`。
    state: &'static str,
    message: Option<String>,
}

/// 完成后的长图信息。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LongResult {
    width: usize,
    height: usize,
    url: String,
}

struct LongShot {
    session: u64,
    running: AtomicBool,
    stitcher: Mutex<Stitcher>,
    png: Mutex<Option<Arc<Vec<u8>>>>,
    /// 面板预览区大小（逻辑点），缩略图按它等比缩小。
    preview: (f64, f64),
}

static CURRENT: Mutex<Option<Arc<LongShot>>> = Mutex::new(None);

fn current(session: u64) -> Option<Arc<LongShot>> {
    CURRENT.lock().ok()?.as_ref().filter(|shot| shot.session == session).cloned()
}

fn session_of_panel(label: &str) -> Option<u64> {
    label.strip_prefix(LABEL_PREFIX)?.parse().ok()
}

/// 长图 PNG，只交给对应的控制面板读取。
pub fn image(webview_label: &str, session: u64) -> Option<Arc<Vec<u8>>> {
    if session_of_panel(webview_label) != Some(session) { return None }
    current(session)?.png.lock().ok()?.clone()
}

/// 结束长截图：停止截取、关闭控制面板、释放拼接数据。截图会话结束时调用。
pub fn shutdown(app: &AppHandle) {
    let Some(shot) = CURRENT.lock().ok().and_then(|mut current| current.take()) else { return };
    shot.running.store(false, Ordering::SeqCst);
    overlay::destroy_window(app, &format!("{LABEL_PREFIX}{}", shot.session));
}

/// 截图覆盖窗点“长截图”：遮罩改为鼠标可穿透，打开控制面板并开始截取。
#[tauri::command]
pub fn capture_long_start(app: AppHandle, webview: Webview, session: u64, rect: LongRect) -> Result<(), String> {
    if overlay::session_of(webview.label()) != Some(session) { return Err("截图会话已失效".into()) }
    if ![rect.x, rect.y, rect.width, rect.height].iter().all(|value| value.is_finite()) || rect.width < 20.0 || rect.height < 20.0 {
        return Err("长截图区域太小".into());
    }
    let screen = overlay::screen_of(webview.label()).unwrap_or(0);
    if !app.state::<CaptureState>().advance(session, Event::LongStart)? { return Err("当前状态不能开始长截图".into()) }
    let (display, preview) = match open_panel(&app, session, screen, rect) {
        Ok(opened) => opened,
        Err(error) => {
            super::finish(&app, session, Event::Fail, &error)?;
            return Err(error);
        }
    };
    let shot = Arc::new(LongShot { session, running: AtomicBool::new(true), stitcher: Mutex::new(Stitcher::new(0)), png: Mutex::new(None), preview });
    *CURRENT.lock().map_err(|_| "长截图状态不可用")? = Some(shot.clone());
    crate::diag!("长截图：会话 {session} 开始，显示器 {display}，区域 {:.0}×{:.0}", rect.width, rect.height);
    let handle = app.clone();
    std::thread::spawn(move || run(handle, shot, display, rect));
    Ok(())
}

/// 面板点“完成”：停止截取，合成整张长图并编码（后台执行，不阻塞界面）。
#[tauri::command]
pub async fn capture_long_finish(webview: Webview) -> Result<LongResult, String> {
    let session = session_of_panel(webview.label()).ok_or("只有长截图面板可以执行此操作")?;
    let shot = current(session).ok_or("长截图已结束")?;
    shot.running.store(false, Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || {
        let frame = shot.stitcher.lock().map_err(|_| "长截图状态不可用")?.compose();
        if frame.height == 0 { return Err("还没有截到画面".to_string()) }
        let png = long_stitch::encode_png(&frame)?;
        crate::diag!("长截图：会话 {session} 合成 {}×{}，{} 字节", frame.width, frame.height, png.len());
        *shot.png.lock().map_err(|_| "长截图状态不可用")? = Some(Arc::new(png));
        Ok(LongResult { width: frame.width, height: frame.height, url: format!("qingbox-capture://localhost/{session}/long.png") })
    }).await.map_err(|error| format!("合成长图失败：{error}"))?
}

/// 面板复制或保存长图；成功后结束截图会话。保存时取消返回 `false`，面板继续显示。
#[tauri::command]
pub fn capture_long_export(app: AppHandle, webview: Webview, action: String) -> Result<bool, String> {
    let label = webview.label().to_string();
    let session = session_of_panel(&label).ok_or("只有长截图面板可以执行此操作")?;
    let png = current(session).and_then(|shot| shot.png.lock().ok()?.clone()).ok_or("长图尚未生成")?;
    let state = app.state::<CaptureState>();
    if !state.advance(session, Event::Export)? { return Err("截图会话已结束".into()) }
    let result = match action.as_str() {
        "copy" => super::export::copy(&png).map(|_| true),
        "save" => {
            set_panel_visible(&app, &label, false);
            let saved = super::export::save(&app, &label, &png);
            if !matches!(saved, Ok(Some(_))) { set_panel_visible(&app, &label, true); }
            saved.map(|path| path.is_some())
        }
        _ => Err("不支持的长截图操作".into()),
    };
    match result {
        Ok(true) => {
            super::finish(&app, session, Event::Done, if action == "copy" { "长截图已复制" } else { "长截图已保存" })?;
            Ok(true)
        }
        Ok(false) => {
            // 取消保存：回到可操作状态
            state.advance(session, Event::Fail)?;
            Ok(false)
        }
        Err(error) => {
            state.advance(session, Event::Fail)?;
            Err(error)
        }
    }
}

/// 面板取消长截图，结束截图会话。
#[tauri::command]
pub fn capture_long_cancel(app: AppHandle, webview: Webview) -> Result<(), String> {
    let session = session_of_panel(webview.label()).ok_or("只有长截图面板可以执行此操作")?;
    super::finish(&app, session, Event::Cancel, "取消长截图")
}

fn set_panel_visible(app: &AppHandle, label: &str, visible: bool) {
    #[cfg(target_os = "macos")]
    if let Ok(panel) = tauri_nspanel::ManagerExt::get_webview_panel(app, label) {
        if visible { panel.as_panel().makeKeyAndOrderFront(None) } else { panel.as_panel().orderOut(None) }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, label, visible);
}

/// 面板的布局：预览与选区顶部对齐、等高（屏幕放不下时缩短），工具栏在预览下方。
#[derive(Debug, PartialEq)]
pub struct PanelLayout {
    /// 面板左上角（相对屏幕左上角，逻辑点）。
    x: f64,
    top: f64,
    /// 预览区大小。
    preview_width: f64,
    preview_height: f64,
    /// 面板在选区的哪一侧：`right`、`left`、`inside`（左右都放不下时放在选区内右侧）。
    side: &'static str,
}

impl PanelLayout {
    fn height(&self) -> f64 { self.preview_height + TOOLBAR_GAP + TOOLBAR_HEIGHT }
}

/// 面板放在选区右侧，放不下放左侧，再放不下放在选区内右侧。
pub fn panel_layout(screen_width: f64, screen_height: f64, rect: LongRect) -> PanelLayout {
    let (gap, margin) = (10.0, 8.0);
    let preview_width = (rect.width * 0.45).clamp(160.0, 360.0);
    let preview_height = rect.height.min(screen_height - 2.0 * margin - TOOLBAR_GAP - TOOLBAR_HEIGHT).max(160.0);
    let (x, side) = if rect.x + rect.width + gap + preview_width <= screen_width { (rect.x + rect.width + gap, "right") }
        else if rect.x - gap - preview_width >= 0.0 { (rect.x - gap - preview_width, "left") }
        else { ((rect.x + rect.width - preview_width - gap).max(margin), "inside") };
    let height = preview_height + TOOLBAR_GAP + TOOLBAR_HEIGHT;
    let top = rect.y.min(screen_height - margin - height).max(margin);
    PanelLayout { x, top, preview_width, preview_height, side }
}

#[cfg(target_os = "macos")]
mod panel_type {
    tauri_nspanel::tauri_panel! {
      panel!(LongPanel {
          config: {
              can_become_key_window: true,
              can_become_main_window: false,
              is_floating_panel: true
          }
      })
    }
}

/// 覆盖窗改为可穿透，打开控制面板；返回选区所在显示器编号与预览区大小。
#[cfg(target_os = "macos")]
fn open_panel(app: &AppHandle, session: u64, screen_index: usize, rect: LongRect) -> Result<(u32, (f64, f64)), String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSColor, NSScreen, NSScreenSaverWindowLevel, NSWindowCollectionBehavior, NSWindowStyleMask};
    use objc2_foundation::{NSNumber, NSPoint, NSRect, NSSize, NSString};
    use tauri_nspanel::WebviewWindowExt;

    let marker = MainThreadMarker::new().ok_or("长截图面板必须在主线程创建")?;
    let screens = NSScreen::screens(marker);
    let screen = screens.iter().nth(screen_index).ok_or("找不到选区所在屏幕")?;
    let display = screen.deviceDescription().objectForKey(&NSString::from_str("NSScreenNumber"))
        .and_then(|value| value.downcast::<NSNumber>().ok()).map(|number| number.unsignedIntValue()).ok_or("无法识别显示器")?;
    // 遮罩改为鼠标与滚轮可穿透，用户直接滚动下方的应用
    for label in app.webview_windows().into_keys().filter(|label| overlay::session_of(label) == Some(session)) {
        if let Ok(panel) = tauri_nspanel::ManagerExt::get_webview_panel(app, &label) { panel.as_panel().setIgnoresMouseEvents(true); }
    }
    let frame = screen.frame();
    let layout = panel_layout(frame.size.width, frame.size.height, rect);
    let (x, top, width, height) = (layout.x, layout.top, layout.preview_width, layout.height());
    let label = format!("{LABEL_PREFIX}{session}");
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("capture.html".into()))
        .title("轻匣长截图").decorations(false).transparent(true).shadow(false).resizable(false)
        .skip_taskbar(true).visible(false).accept_first_mouse(true).inner_size(width, height)
        .initialization_script(format!("window.__QINGBOX_LONG__ = {{ session: {session}, side: \"{}\" }};", layout.side))
        .build().map_err(|error| format!("创建长截图面板失败：{error}"))?;
    let panel = window.to_panel::<panel_type::LongPanel>().map_err(|error| format!("创建长截图面板失败：{error}"))?;
    panel.set_becomes_key_only_if_needed(false);
    panel.set_hides_on_deactivate(false);
    panel.set_works_when_modal(true);
    panel.set_released_when_closed(false);
    let native = panel.as_panel();
    let _ = panel.set_style_mask(native.styleMask() | NSWindowStyleMask::NonactivatingPanel);
    native.setOpaque(false);
    native.setBackgroundColor(Some(&NSColor::clearColor()));
    panel.set_has_shadow(true);
    // 高于覆盖窗一级，始终在遮罩之上
    panel.set_level(NSScreenSaverWindowLevel as i64 + 1);
    panel.set_collection_behavior(NSWindowCollectionBehavior::CanJoinAllSpaces | NSWindowCollectionBehavior::FullScreenAuxiliary | NSWindowCollectionBehavior::Stationary | NSWindowCollectionBehavior::IgnoresCycle);
    native.setFrame_display(NSRect::new(NSPoint::new(frame.origin.x + x, frame.origin.y + frame.size.height - top - height), NSSize::new(width, height)), false);
    native.makeKeyAndOrderFront(None);
    if let Some(webview) = app.get_webview(&label) { let _ = webview.set_focus(); }
    Ok((display, (layout.preview_width, layout.preview_height)))
}

#[cfg(not(target_os = "macos"))]
fn open_panel(_app: &AppHandle, _session: u64, _screen_index: usize, _rect: LongRect) -> Result<(u32, (f64, f64)), String> {
    Err("当前平台不支持长截图".into())
}

fn emit(app: &AppHandle, session: u64, progress: Progress) {
    let _ = app.emit_to(format!("{LABEL_PREFIX}{session}"), "long-progress", progress);
}

/// 后台截取并拼接，直到停止。
#[cfg(target_os = "macos")]
fn run(app: AppHandle, shot: Arc<LongShot>, display: u32, rect: LongRect) {
    let session = shot.session;
    let capture = match Capture::new(display, rect) {
        Ok(capture) => {
            if let Ok(mut stitcher) = shot.stitcher.lock() { stitcher.set_ignore_right((SCROLLBAR_POINTS * capture.scale).round() as usize); }
            capture
        }
        Err(error) => {
            crate::diag!("长截图：会话 {session} 无法开始截取：{error}");
            emit(&app, session, Progress { height: 0, thumbnail: None, state: "error", message: Some(error) });
            return;
        }
    };
    // 缩略图按预览区的物理像素等比缩小，视网膜屏上也清晰
    let thumbnail_box = ((shot.preview.0 * capture.scale).round() as usize, (shot.preview.1 * capture.scale).round() as usize);
    let mut last_emit = Instant::now() - INTERVAL;
    let (mut capture_time, mut captured) = (Duration::ZERO, 0u32);
    // 有新内容但缩略图因限频还没推送；连续接不上的帧数；上次推送的状态
    let (mut dirty, mut lost_frames, mut last_state) = (false, 0u32, "scrolling");
    while shot.running.load(Ordering::SeqCst) {
        let started = Instant::now();
        let frame = capture.frame();
        capture_time += started.elapsed();
        captured += 1;
        match frame {
            Ok(frame) => {
                let (update, height, limited, thumbnail) = {
                    let Ok(mut stitcher) = shot.stitcher.lock() else { break };
                    let update = stitcher.add(frame);
                    dirty |= matches!(update, Update::First | Update::Scrolled { added: 1.., .. });
                    // 缩略图编码有开销，有新内容时最多每 200 毫秒更新一次；停止滚动后补推最后一次
                    let thumbnail = (dirty && last_emit.elapsed() >= Duration::from_millis(200)).then(|| {
                        let small = stitcher.thumbnail(thumbnail_box.0, thumbnail_box.1);
                        long_stitch::encode_png(&small).ok().map(|png| format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)))
                    }).flatten();
                    (update, stitcher.height(), stitcher.limited, thumbnail)
                };
                if thumbnail.is_some() { last_emit = Instant::now(); dirty = false; }
                lost_frames = if update == Update::Lost { lost_frames + 1 } else { 0 };
                let state = if limited { "limited" } else if lost_frames >= LOST_FRAMES_TO_WARN { "lost" } else { "scrolling" };
                // 有新缩略图或状态变化（含接上后撤掉“滚动太快”提示）时推送
                if thumbnail.is_some() || state != last_state {
                    emit(&app, session, Progress { height, thumbnail, state, message: None });
                    last_state = state;
                }
                if limited { break }
            }
            Err(error) => crate::diag!("长截图：会话 {session} 截取失败：{error}"),
        }
        if let Some(rest) = INTERVAL.checked_sub(started.elapsed()) { std::thread::sleep(rest); }
    }
    let stats = shot.stitcher.lock().map(|stitcher| stitcher.stats).unwrap_or_default();
    crate::diag!(
        "长截图：会话 {session} 停止截取，共 {} 帧，平均截取 {} 毫秒、比对 {} 毫秒，拼接 {} 次，未滚动 {} 次，接不上 {} 次，最近一次接不上（最好候选、原位对不上比例）{:?}",
        stats.frames, capture_time.as_millis() / u128::from(captured.max(1)), stats.micros / 1000 / stats.frames.max(1) as u128, stats.scrolled, stats.unchanged, stats.lost, stats.last_lost
    );
}

#[cfg(not(target_os = "macos"))]
fn run(_app: AppHandle, _shot: Arc<LongShot>, _display: u32, _rect: LongRect) {}

/// 选区的截取器：固定显示器、排除轻匣自身窗口，按物理像素输出 BGRA。
#[cfg(target_os = "macos")]
struct Capture {
    /// 物理像素与逻辑点之比。
    scale: f64,
    filter: objc2::rc::Retained<objc2_screen_capture_kit::SCContentFilter>,
    configuration: objc2::rc::Retained<objc2_screen_capture_kit::SCStreamConfiguration>,
}

// ScreenCaptureKit 的过滤器与配置创建后只读，可在截取线程使用。
#[cfg(target_os = "macos")]
unsafe impl Send for Capture {}

#[cfg(target_os = "macos")]
impl Capture {
    fn new(display: u32, rect: LongRect) -> Result<Self, String> {
        use block2::RcBlock;
        use objc2::{AllocAnyThread, Message};
        use objc2_foundation::{NSArray, NSError};
        use objc2_screen_capture_kit::{SCContentFilter, SCShareableContent, SCStreamConfiguration, SCWindow};

        struct Shared(objc2::rc::Retained<SCShareableContent>);
        unsafe impl Send for Shared {}
        let (sender, receiver) = mpsc::channel::<Result<Shared, String>>();
        let handler = RcBlock::new(move |content: *mut SCShareableContent, error: *mut NSError| {
            let result = match unsafe { content.as_ref() } {
                Some(content) => Ok(Shared(content.retain())),
                None => Err(unsafe { error.as_ref() }.map(|error| error.localizedDescription().to_string()).unwrap_or_else(|| "未知原因".into())),
            };
            let _ = sender.send(result);
        });
        unsafe { SCShareableContent::getShareableContentWithCompletionHandler(&handler) };
        let content = receiver.recv_timeout(Duration::from_secs(5)).map_err(|_| "取得屏幕内容超时".to_string())??.0;
        let displays = unsafe { content.displays() };
        let target = displays.iter().find(|item| unsafe { item.displayID() } == display).ok_or("选区所在显示器已断开")?;
        let pid = std::process::id() as libc::pid_t;
        let own: Vec<_> = unsafe { content.applications() }.iter().filter(|application| unsafe { application.processID() } == pid).collect();
        let excluded = NSArray::from_retained_slice(&own);
        let filter = unsafe {
            SCContentFilter::initWithDisplay_excludingApplications_exceptingWindows(SCContentFilter::alloc(), &target, &excluded, &NSArray::<SCWindow>::new())
        };
        let scale = f64::from(unsafe { SCShareableContent::infoForFilter(&filter).pointPixelScale() });
        let configuration = unsafe { SCStreamConfiguration::new() };
        unsafe {
            configuration.setSourceRect(objc2_core_foundation::CGRect {
                origin: objc2_core_foundation::CGPoint { x: rect.x, y: rect.y },
                size: objc2_core_foundation::CGSize { width: rect.width, height: rect.height },
            });
            configuration.setWidth((rect.width * scale).round() as usize);
            configuration.setHeight((rect.height * scale).round() as usize);
            configuration.setShowsCursor(false);
            configuration.setColorSpaceName(objc2_core_graphics::kCGColorSpaceSRGB);
        }
        Ok(Self { scale, filter, configuration })
    }

    /// 截取一帧并转为紧密排列的 BGRA 像素。
    fn frame(&self) -> Result<long_stitch::Frame, String> {
        use block2::RcBlock;
        use objc2_core_graphics::{CGDataProvider, CGImage};
        use objc2_foundation::NSError;
        use objc2_screen_capture_kit::SCScreenshotManager;

        let (sender, receiver) = mpsc::channel::<Result<long_stitch::Frame, String>>();
        let handler = RcBlock::new(move |image: *mut CGImage, error: *mut NSError| {
            let result = match unsafe { image.as_ref() } {
                Some(image) => (|| {
                    let width = CGImage::width(Some(image));
                    let height = CGImage::height(Some(image));
                    let stride = CGImage::bytes_per_row(Some(image));
                    if CGImage::bits_per_pixel(Some(image)) != 32 { return Err("不支持的像素格式".to_string()) }
                    let provider = CGImage::data_provider(Some(image)).ok_or("无法读取画面数据")?;
                    let data = CGDataProvider::data(Some(&provider)).ok_or("无法读取画面数据")?;
                    let bytes = data.to_vec();
                    let mut pixels = Vec::with_capacity(width * height * 4);
                    for row in 0..height {
                        let start = row * stride;
                        pixels.extend_from_slice(bytes.get(start..start + width * 4).ok_or("画面数据不完整")?);
                    }
                    Ok(long_stitch::Frame { width, height, pixels })
                })(),
                None => Err(unsafe { error.as_ref() }.map(|error| error.localizedDescription().to_string()).unwrap_or_else(|| "未知原因".into())),
            };
            let _ = sender.send(result);
        });
        unsafe { SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(&self.filter, &self.configuration, Some(&handler)) };
        receiver.recv_timeout(Duration::from_secs(2)).map_err(|_| "截取超时".to_string())?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 面板贴在选区右侧且预览与选区等高() {
        let rect = LongRect { x: 100.0, y: 80.0, width: 600.0, height: 500.0 };
        assert_eq!(panel_layout(1440.0, 900.0, rect), PanelLayout { x: 710.0, top: 80.0, preview_width: 270.0, preview_height: 500.0, side: "right" });
        let right_edge = LongRect { x: 1000.0, ..rect };
        assert_eq!(panel_layout(1440.0, 900.0, right_edge).x, 720.0, "右侧放不下时放左侧");
        assert_eq!(panel_layout(1440.0, 900.0, right_edge).side, "left");
        let full = LongRect { x: 0.0, y: 0.0, width: 1440.0, height: 900.0 };
        let layout = panel_layout(1440.0, 900.0, full);
        assert_eq!((layout.x, layout.top, layout.side), (1070.0, 8.0, "inside"), "左右都放不下时放在选区内右侧");
        assert_eq!(layout.height(), 884.0, "预览缩短到工具栏也能放进屏幕");
        let low = LongRect { x: 100.0, y: 600.0, width: 600.0, height: 290.0 };
        assert_eq!(panel_layout(1440.0, 900.0, low).top, 554.0, "选区贴底时面板上移，工具栏不出屏幕");
    }

    #[test]
    fn 长图只交给对应面板() {
        assert_eq!(session_of_panel("longshot-12"), Some(12));
        assert_eq!(session_of_panel("capture-12-0"), None);
        assert!(image("capture-12-0", 12).is_none());
        assert!(image("longshot-13", 12).is_none());
    }
}
