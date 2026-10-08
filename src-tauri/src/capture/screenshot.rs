//! 冻结画面：截图开始时逐屏取一张快照，覆盖窗显示快照而不是实时画面。
//!
//! 用 ScreenCaptureKit 按物理像素截取每块显示器，并排除轻匣自身的窗口。所有屏幕截完后才打开覆盖窗。
//! 快照留在宿主内存中，覆盖窗经 `qingbox-capture://localhost/<会话>/<显示器>.png` 读取；
//! 只有本会话的覆盖窗能读，会话结束即清除。PNG 在页面首次请求时编码并缓存。
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};

/// 一块显示器的快照。
pub struct Snapshot {
    /// 显示器编号（CGDirectDisplayID），与覆盖窗所在屏幕对应。
    pub display: u32,
    /// 物理像素与逻辑点的比例，Retina 屏为 2。
    pub scale: f64,
    #[cfg(target_os = "macos")]
    image: SharedImage,
    png: OnceLock<Result<Arc<Vec<u8>>, String>>,
}

/// CGImage 创建后不可变，Apple 文档说明可跨线程使用；这里只读取，不修改。
#[cfg(target_os = "macos")]
struct SharedImage(objc2_core_foundation::CFRetained<objc2_core_graphics::CGImage>);
#[cfg(target_os = "macos")]
unsafe impl Send for SharedImage {}
#[cfg(target_os = "macos")]
unsafe impl Sync for SharedImage {}

impl Snapshot {
    /// 编码为 PNG，只编码一次。
    fn png(&self) -> Result<Arc<Vec<u8>>, String> {
        self.png.get_or_init(|| self.encode().map(Arc::new)).clone()
    }

    #[cfg(target_os = "macos")]
    fn encode(&self) -> Result<Vec<u8>, String> {
        use objc2::AllocAnyThread;
        use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
        use objc2_foundation::NSDictionary;
        let started = std::time::Instant::now();
        // 在后台线程编码，自动释放池回收 AppKit 临时对象
        let result = objc2::rc::autoreleasepool(|_| {
            let representation = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &self.image.0);
            unsafe { representation.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) }
                .map(|data| data.to_vec())
                .ok_or_else(|| "快照编码失败".to_string())
        });
        crate::diag!("截图：显示器 {} 快照编码 {} 毫秒", self.display, started.elapsed().as_millis());
        result
    }

    #[cfg(not(target_os = "macos"))]
    fn encode(&self) -> Result<Vec<u8>, String> {
        Err("当前平台不支持截图".into())
    }
}

/// 当前会话的快照：会话编号 → 显示器编号 → 快照。同一时刻只保留一个会话。
static STORE: Mutex<Option<(u64, HashMap<u32, Arc<Snapshot>>)>> = Mutex::new(None);

pub fn store(session: u64, snapshots: Vec<Snapshot>) {
    let snapshots: Vec<Arc<Snapshot>> = snapshots.into_iter().map(Arc::new).collect();
    // 截完立即在后台并行编码，与创建覆盖窗同时进行；页面请求时若未完成会等待同一份结果
    for snapshot in &snapshots {
        let snapshot = snapshot.clone();
        std::thread::spawn(move || { let _ = snapshot.png(); });
    }
    let map = snapshots.into_iter().map(|snapshot| (snapshot.display, snapshot)).collect();
    if let Ok(mut store) = STORE.lock() { *store = Some((session, map)); }
}

/// 某会话某显示器的快照编号与缩放，供覆盖窗页面使用。
pub fn info(session: u64, display: u32) -> Option<f64> {
    let store = STORE.lock().ok()?;
    let (current, map) = store.as_ref()?;
    (*current == session).then(|| map.get(&display).map(|snapshot| snapshot.scale)).flatten()
}

pub fn clear() {
    if let Ok(mut store) = STORE.lock() { *store = None; }
}

/// 解析资源路径 `/<会话>/<显示器>.png`。
fn parse_path(path: &str) -> Option<(u64, u32)> {
    let (session, file) = path.trim_start_matches('/').split_once('/')?;
    Some((session.parse().ok()?, file.strip_suffix(".png")?.parse().ok()?))
}

/// `qingbox-capture` 协议：只把本会话的快照交给本会话的覆盖窗。
pub fn serve(webview_label: &str, path: &str) -> tauri::http::Response<Vec<u8>> {
    let respond = |status: u16, mime: &str, body: Vec<u8>| {
        tauri::http::Response::builder()
            .status(status)
            .header("Content-Type", mime)
            .header("Cache-Control", "no-store")
            // 覆盖窗导出时把快照画到 canvas 上，需要跨源读取像素；读取权限仍由下方的会话校验控制。
            .header("Access-Control-Allow-Origin", "*")
            .body(body)
            .expect("构造截图资源响应失败")
    };
    // 贴图图片：/pin/<编号>.png，只交给对应的贴图窗口
    if let Some(id) = path.strip_prefix("/pin/").and_then(|file| file.strip_suffix(".png")).and_then(|id| id.parse().ok()) {
        return match super::pin::image(webview_label, id) {
            Some(png) => respond(200, "image/png", png.as_ref().clone()),
            None => respond(403, "text/plain", Vec::new()),
        };
    }
    let Some((session, display)) = parse_path(path) else { return respond(404, "text/plain", Vec::new()) };
    if super::overlay::session_of(webview_label) != Some(session) { return respond(403, "text/plain", Vec::new()) }
    let snapshot = STORE.lock().ok().and_then(|store| {
        let (current, map) = store.as_ref()?;
        (*current == session).then(|| map.get(&display).cloned()).flatten()
    });
    let Some(snapshot) = snapshot else { return respond(404, "text/plain", Vec::new()) };
    match snapshot.png() {
        Ok(png) => respond(200, "image/png", png.as_ref().clone()),
        Err(error) => {
            crate::diag!("截图：快照编码失败：{error}");
            respond(500, "text/plain", Vec::new())
        }
    }
}

type Done = Box<dyn FnOnce(Result<Vec<Snapshot>, String>) + Send>;

/// 收集各显示器的截图结果，全部完成后回调一次。
struct Collector {
    remaining: usize,
    snapshots: Vec<Snapshot>,
    error: Option<String>,
    done: Option<Done>,
}

impl Collector {
    fn finish_one(collector: &Mutex<Collector>, result: Result<Snapshot, String>) {
        let Ok(mut state) = collector.lock() else { return };
        match result {
            Ok(snapshot) => state.snapshots.push(snapshot),
            Err(error) => { state.error.get_or_insert(error); }
        }
        state.remaining -= 1;
        if state.remaining > 0 { return }
        let outcome = match state.error.take() {
            Some(error) => Err(error),
            None => Ok(std::mem::take(&mut state.snapshots)),
        };
        if let Some(done) = state.done.take() {
            drop(state);
            done(outcome);
        }
    }
}

/// 异步截取全部显示器（排除轻匣自身窗口），完成后在任意线程回调。
#[cfg(target_os = "macos")]
pub fn capture(done: impl FnOnce(Result<Vec<Snapshot>, String>) + Send + 'static) {
    use block2::RcBlock;
    use objc2::AllocAnyThread;
    use objc2_core_foundation::CFRetained;
    use objc2_core_graphics::CGImage;
    use objc2_foundation::{NSArray, NSError};
    use objc2_screen_capture_kit::{SCContentFilter, SCScreenshotManager, SCShareableContent, SCStreamConfiguration, SCWindow};
    use std::ptr::NonNull;

    let done: Arc<Mutex<Option<Done>>> = Arc::new(Mutex::new(Some(Box::new(done))));
    let fail = {
        let done = done.clone();
        move |message: String| {
            if let Some(done) = done.lock().ok().and_then(|mut done| done.take()) { done(Err(message)); }
        }
    };
    let handler = RcBlock::new(move |content: *mut SCShareableContent, error: *mut NSError| {
        let Some(content) = (unsafe { content.as_ref() }) else {
            let reason = unsafe { error.as_ref() }.map(|error| error.localizedDescription().to_string()).unwrap_or_else(|| "未知原因".into());
            fail(format!("取得屏幕内容失败：{reason}"));
            return;
        };
        let displays = unsafe { content.displays() };
        if displays.is_empty() { fail("没有可截取的显示器".into()); return }
        // 排除轻匣自身：主面板此时已收起，这里防止残留窗口出现在快照中。
        let pid = std::process::id() as libc::pid_t;
        let own: Vec<_> = unsafe { content.applications() }.iter().filter(|application| unsafe { application.processID() } == pid).collect();
        let excluded = NSArray::from_retained_slice(&own);
        let Some(done) = done.lock().ok().and_then(|mut done| done.take()) else { return };
        let collector = Arc::new(Mutex::new(Collector { remaining: displays.len(), snapshots: Vec::new(), error: None, done: Some(done) }));
        for display in displays.iter() {
            let display_id = unsafe { display.displayID() };
            let filter = unsafe {
                SCContentFilter::initWithDisplay_excludingApplications_exceptingWindows(
                    SCContentFilter::alloc(), &display, &excluded, &NSArray::<SCWindow>::new(),
                )
            };
            let info = unsafe { SCShareableContent::infoForFilter(&filter) };
            let scale = f64::from(unsafe { info.pointPixelScale() });
            let rect = unsafe { info.contentRect() };
            let configuration = unsafe { SCStreamConfiguration::new() };
            unsafe {
                configuration.setWidth((rect.size.width * scale).round() as usize);
                configuration.setHeight((rect.size.height * scale).round() as usize);
                configuration.setShowsCursor(false);
            }
            let collector = collector.clone();
            let completion = RcBlock::new(move |image: *mut CGImage, error: *mut NSError| {
                let result = match NonNull::new(image) {
                    Some(image) => Ok(Snapshot {
                        display: display_id,
                        scale,
                        image: SharedImage(unsafe { CFRetained::retain(image) }),
                        png: OnceLock::new(),
                    }),
                    None => {
                        let reason = unsafe { error.as_ref() }.map(|error| error.localizedDescription().to_string()).unwrap_or_else(|| "未知原因".into());
                        Err(format!("截取显示器 {display_id} 失败：{reason}"))
                    }
                };
                Collector::finish_one(&collector, result);
            });
            unsafe { SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(&filter, &configuration, Some(&completion)) };
        }
    });
    unsafe { SCShareableContent::getShareableContentWithCompletionHandler(&handler) };
}

#[cfg(not(target_os = "macos"))]
pub fn capture(done: impl FnOnce(Result<Vec<Snapshot>, String>) + Send + 'static) {
    done(Err("当前平台不支持截图".into()));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 资源路径解析会话与显示器() {
        assert_eq!(parse_path("/12/69733382.png"), Some((12, 69733382)));
        assert_eq!(parse_path("12/1.png"), Some((12, 1)));
        assert_eq!(parse_path("/12/1.jpg"), None);
        assert_eq!(parse_path("/x/1.png"), None);
        assert_eq!(parse_path("/12"), None);
    }

    #[test]
    fn 非本会话覆盖窗不能读取快照() {
        clear();
        let response = serve("capture-3-0", "/4/1.png");
        assert_eq!(response.status(), 403);
        let response = serve("main", "/4/1.png");
        assert_eq!(response.status(), 403);
        let response = serve("capture-4-0", "/4/1.png");
        assert_eq!(response.status(), 404, "没有快照时返回 404");
    }

    #[test]
    fn 全部显示器完成后只回调一次() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let record = calls.clone();
        let collector = Mutex::new(Collector {
            remaining: 2,
            snapshots: Vec::new(),
            error: None,
            done: Some(Box::new(move |result| record.lock().unwrap().push(result.map(|items| items.len())))),
        });
        Collector::finish_one(&collector, Err("第一块失败".into()));
        assert!(calls.lock().unwrap().is_empty(), "还有显示器未完成时不回调");
        Collector::finish_one(&collector, Err("第二块失败".into()));
        assert_eq!(calls.lock().unwrap().as_slice(), &[Err("第一块失败".to_string())]);
    }
}
