//! ScreenCaptureKit 原生录制。全部对象放在主线程，代理将任意线程回调调度回主线程。
use std::path::PathBuf;
use tauri::AppHandle;
use super::record::{RecordTarget, RecordOptions};
fn inactive_stops(target_kind: &str) -> bool { target_kind == "window" }
#[derive(Clone, Debug, PartialEq)]
enum OutputEnd { Finished(f64), Failed(String), NotStarted(String) }
#[derive(Default)]
struct NativeLifecycle { output: Option<OutputEnd>, stream_stopped: bool, stop_in_flight: bool, capture_pending: bool, stop_requested: bool, output_started: bool, completed: bool, media_pending: bool }
impl NativeLifecycle {
    fn preparing() -> Self { Self { capture_pending: true, ..Self::default() } }
    fn capture_completed(&mut self, success: bool) { self.capture_pending = false; if !success && !self.output_started { self.stream_stopped = true; } }
    fn request_stop(&mut self) -> bool {
        self.stop_requested = true;
        if self.capture_pending || self.stream_stopped || self.stop_in_flight || self.completed { return false }
        self.stop_in_flight = true; true
    }
    fn stop_completed(&mut self, success: bool) { self.stop_in_flight = false; if success { self.stream_stopped = true; } }
    fn stream_ended(&mut self) { self.stream_stopped = true; }
    fn output_ended(&mut self, output: OutputEnd) { if self.output.is_none() { self.output = Some(output); } self.stop_requested = true; }
    fn abort_unstarted_output(&mut self, error: String) -> bool {
        if !self.stream_stopped || self.output_started || self.output.is_some() { return false }
        self.output = Some(OutputEnd::NotStarted(error)); true
    }
    fn begin_media(&mut self) { self.media_pending = true; }
    fn media_completed(&mut self) { self.media_pending = false; }
    fn release_ready(&self) -> bool { self.completed && !self.media_pending }
    fn take_completion(&mut self) -> Option<OutputEnd> {
        if !self.stream_stopped || self.completed { return None }
        let output = self.output.clone()?; self.completed = true; Some(output)
    }

}
#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    #[test] fn 最终回归_同一失活通知只终结真实窗口录制() {
        assert!(inactive_stops("window"));
        for kind in ["region", "display"] { assert!(!inactive_stops(kind), "{kind} 失活不能被当作显示器断开"); }
    }
    #[test] fn 输出失败交错停止只发送一次原生停止且等待流确认() {
        let mut life = NativeLifecycle::preparing(); life.capture_completed(true); assert!(life.request_stop());
        life.output_ended(OutputEnd::Failed("磁盘写入失败".into())); assert!(!life.request_stop()); assert_eq!(life.take_completion(), None);
        life.stop_completed(true); assert_eq!(life.take_completion(), Some(OutputEnd::Failed("磁盘写入失败".into()))); assert_eq!(life.take_completion(), None);
    }
    #[test] fn 文件和流两个终结回调先后顺序均不得提前释放() {
        for file_first in [true, false] {
            let mut life = NativeLifecycle::preparing(); life.capture_completed(true); assert!(life.request_stop());
            if file_first { life.output_ended(OutputEnd::Finished(3.0)); } else { life.stop_completed(true); }
            assert_eq!(life.take_completion(), None);
            if file_first { life.stop_completed(true); } else { life.output_ended(OutputEnd::Finished(3.0)); }
            assert_eq!(life.take_completion(), Some(OutputEnd::Finished(3.0)));
        }
    }
    #[test] fn 停止错误不确认流结束也不释放已失败输出() {
        let mut life = NativeLifecycle::preparing(); life.capture_completed(true); life.request_stop(); life.output_ended(OutputEnd::Failed("磁盘失败".into()));
        life.stop_completed(false); assert!(!life.stream_stopped); assert_eq!(life.take_completion(), None);
        assert!(life.request_stop()); assert!(!life.request_stop()); life.stop_completed(true); assert!(life.take_completion().is_some());
    }
    #[test] fn 未启动失败成功移除输出后可恢复而实际开始后不能冒充未开始() {
        let mut life = NativeLifecycle::preparing(); life.capture_completed(false); assert!(life.abort_unstarted_output("启动失败".into()));
        assert_eq!(life.take_completion(), Some(OutputEnd::NotStarted("启动失败".into())));
        let mut started = NativeLifecycle::preparing(); started.output_started = true; started.capture_completed(false);
        assert!(!started.abort_unstarted_output("启动失败".into())); assert_eq!(started.take_completion(), None);
    }
    #[test] fn 输出已经开始后启动报错仍要等待真实流停止() {
        let mut life = NativeLifecycle::preparing(); life.output_started = true; life.capture_completed(false); life.output_ended(OutputEnd::Failed("启动出错".into()));
        assert!(!life.stream_stopped); assert_eq!(life.take_completion(), None); assert!(life.request_stop()); life.stop_completed(true); assert!(life.take_completion().is_some());
    }
    #[test] fn 后处理中重复停止及完成回调不能释放或再次启动封装() {
        let mut life = NativeLifecycle::preparing(); life.capture_completed(true); life.stream_ended(); life.output_ended(OutputEnd::Finished(3.0));
        assert!(life.take_completion().is_some()); life.begin_media(); assert!(!life.release_ready()); assert!(!life.request_stop()); assert_eq!(life.take_completion(), None);
        life.media_completed(); assert!(life.release_ready()); assert_eq!(life.take_completion(), None);
    }
    #[test] fn 启动尚未完成时停止延后并在成功启动后只发一次() {
        let mut life = NativeLifecycle::preparing(); assert!(!life.request_stop()); life.capture_completed(true); assert!(life.request_stop()); assert!(!life.request_stop());
    }
}
#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use std::cell::RefCell;
    use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
    use block2::RcBlock;
    use objc2::{define_class, msg_send, DefinedClass, AllocAnyThread, Message, rc::Retained, runtime::ProtocolObject};
    use objc2_foundation::{NSObject, NSObjectProtocol, NSError, NSURL, NSString, NSArray, NSNotificationCenter, NSNotification};
    use objc2_screen_capture_kit::{SCStream, SCStreamDelegate, SCRecordingOutput, SCRecordingOutputDelegate,
        SCRecordingOutputConfiguration, SCStreamConfiguration, SCContentFilter, SCShareableContent, SCWindow};
    struct SharedContent(Retained<SCShareableContent>);
    // 可分享内容是系统返回的不可变快照，只在主线程读取；保留对象跨线程转移所有权。
    unsafe impl Send for SharedContent {}
    struct Ivars { app: AppHandle, id: u64, generation: u64, output_started: Arc<AtomicBool>, target_kind: String }
    define_class!(
        #[unsafe(super = NSObject)]
        #[ivars = Ivars]
        struct Delegate;
        unsafe impl NSObjectProtocol for Delegate {}
        unsafe impl SCRecordingOutputDelegate for Delegate {
            #[unsafe(method(recordingOutputDidStartRecording:))]
            fn started(&self, _output: &SCRecordingOutput) {
                self.ivars().output_started.store(true, Ordering::Release);
                dispatch(&self.ivars().app, self.ivars().id, self.ivars().generation, |app, id| {
                    ENGINE.with(|e| { if let Some(engine) = e.borrow_mut().as_mut().filter(|e| e.id == id) { engine.lifecycle.output_started = true; } });
                    super::super::record::native_started(app, id);
                });
            }
            #[unsafe(method(recordingOutputDidFinishRecording:))]
            fn finished(&self, output: &SCRecordingOutput) {
                let time = unsafe { output.recordedDuration() };
                let seconds = unsafe { time.seconds() };
                let duration = if seconds.is_finite() { seconds.max(0.0) } else { 0.0 };
                dispatch(&self.ivars().app, self.ivars().id, self.ivars().generation, move |app, id| output_ended(app, id, OutputEnd::Finished(duration)));
            }
            #[unsafe(method(recordingOutput:didFailWithError:))]
            fn failed(&self, _output: &SCRecordingOutput, error: &NSError) {
                let reason = format!("录像写入失败：{}", error.localizedDescription());
                dispatch(&self.ivars().app, self.ivars().id, self.ivars().generation, move |app, id| output_ended(app, id, OutputEnd::Failed(reason)));
            }
        }
        unsafe impl SCStreamDelegate for Delegate {
            #[unsafe(method(stream:didStopWithError:))]
            fn stopped(&self, _stream: &SCStream, error: &NSError) {
                let reason = format!("屏幕共享已停止：{}", error.localizedDescription());
                dispatch(&self.ivars().app, self.ivars().id, self.ivars().generation, move |app, id| {
                    crate::diag!("录屏：{reason}"); super::super::record::pending_error(app, id, reason);
                    ENGINE.with(|e| { if let Some(engine) = e.borrow_mut().as_mut().filter(|e| e.id == id) { engine.lifecycle.stream_ended(); } });
                    complete_if_ready(app, id);
                });
            }
            #[unsafe(method(streamDidBecomeInactive:))]
            fn inactive(&self, _stream: &SCStream) {
                if !inactive_stops(&self.ivars().target_kind) { return }
                dispatch(&self.ivars().app, self.ivars().id, self.ivars().generation, |app, id| { let _ = super::super::record::stop(app, id); });
            }
        }
    );
    struct Observer { center: Retained<NSNotificationCenter>, token: Retained<ProtocolObject<dyn NSObjectProtocol>> }
    impl Drop for Observer { fn drop(&mut self) { unsafe { self.center.removeObserver((&*self.token).as_ref()); } } }
    struct Engine { _observers: Vec<Observer>, id: u64, generation: u64, stream: Retained<SCStream>, output: Retained<SCRecordingOutput>, _delegate: Retained<Delegate>, lifecycle: NativeLifecycle, output_started: Arc<AtomicBool>, start_error: Option<String>, silent: bool, path: PathBuf }
    static NEXT_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    thread_local! { static CURRENT: RefCell<Option<(u64, u64)>> = const { RefCell::new(None) }; static ENGINE: RefCell<Option<Engine>> = const { RefCell::new(None) }; }
    fn callback_current(id: u64, generation: u64) -> bool { CURRENT.with(|c| *c.borrow() == Some((id, generation))) }
    fn dispatch(app: &AppHandle, id: u64, generation: u64, callback: impl FnOnce(&AppHandle, u64) + Send + 'static) {
        let handle = app.clone();
        if let Err(e) = app.run_on_main_thread(move || { if callback_current(id, generation) { callback(&handle, id); } }) { crate::diag!("调度录屏回调失败：{e}"); }
    }
    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" { static AVMediaTypeAudio: &'static NSString; }
    pub fn start(app: AppHandle, id: u64, target: RecordTarget, options: RecordOptions, path: PathBuf) {
        let generation = NEXT_GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        CURRENT.with(|c| *c.borrow_mut() = Some((id, generation)));
        // 只在本次启用麦克风时接触 AVCaptureDevice 的权限 API。
        if options.microphone {
            let device = objc2::runtime::AnyClass::get(c"AVCaptureDevice").expect("系统缺少麦克风权限接口");
            let status: isize = unsafe { msg_send![device, authorizationStatusForMediaType: AVMediaTypeAudio] };
            if super::super::record::microphone_needed(true, status == 3) {
                if status != 0 { super::super::record::starting_failed(&app, id, "麦克风未授权，请关闭麦克风重试，或在系统设置中允许轻匣访问麦克风".into()); return }
                let callback_app = app.clone();
                let block = RcBlock::new(move |granted: objc2::runtime::Bool| {
                    let app = callback_app.clone(); let target = target.clone(); let options = options.clone(); let path = path.clone();
                    dispatch(&callback_app, id, generation, move |_, id| {
                        if granted.as_bool() { prepare(app, id, generation, target, options, path); }
                        else { super::super::record::starting_failed(&app, id, "麦克风未授权，可关闭麦克风后继续录屏".into()); }
                    });
                });
                unsafe { let _: () = msg_send![device, requestAccessForMediaType: AVMediaTypeAudio, completionHandler: &*block]; }
                return;
            }
        }
        prepare(app, id, generation, target, options, path);
    }
    fn prepare(app: AppHandle, id: u64, generation: u64, target: RecordTarget, options: RecordOptions, path: PathBuf) {
        use tauri::Manager;
        if !app.state::<super::super::record::RecordState>().is_starting(id) { return }
        let callback_app = app.clone();
        let handler = RcBlock::new(move |content: *mut SCShareableContent, error: *mut NSError| {
            let content = unsafe { content.as_ref() }.map(|c| SharedContent(c.retain()));
            let reason = unsafe { error.as_ref() }.map(|e| e.localizedDescription().to_string());
            let app = callback_app.clone(); let target = target.clone(); let options = options.clone(); let path = path.clone();
            dispatch(&callback_app, id, generation, move |_, id| {
                let Some(content) = content else { super::super::record::starting_failed(&app, id, format!("无法取得可录制内容：{}", reason.unwrap_or_else(|| "未知原因".into()))); return };
                if let Err(e) = configure(&app, id, generation, &target, &options, &path, &content.0) { super::super::record::starting_failed(&app, id, e); }
            });
        });
        unsafe { SCShareableContent::getShareableContentWithCompletionHandler(&handler); }
    }
    fn configure(app: &AppHandle, id: u64, generation: u64, target: &RecordTarget, options: &RecordOptions, path: &std::path::Path, content: &SCShareableContent) -> Result<(), String> {
        use tauri::Manager;
        if !app.state::<super::super::record::RecordState>().is_starting(id) { return Err("录屏会话已失效".into()) }
        let displays = unsafe { content.displays() };
        let display = displays.iter().find(|d| unsafe { d.displayID() } == target.display).ok_or("录屏显示器已断开")?;
        let bounds = unsafe { display.frame() };
        super::super::record::validate_target(target, &super::super::record::RecordRect { x: bounds.origin.x, y: bounds.origin.y, width: bounds.size.width, height: bounds.size.height })?;
        let filter = if target.kind == "window" {
            let windows = unsafe { content.windows() };
            let window = windows.iter().find(|w| Some(unsafe { w.windowID() }) == target.window).ok_or("录屏窗口已关闭")?;
            if unsafe { window.owningApplication() }.is_some_and(|a| unsafe { a.processID() } == std::process::id() as i32) { return Err("不能录制轻匣自身窗口".into()) }
            unsafe { SCContentFilter::initWithDesktopIndependentWindow(SCContentFilter::alloc(), &window) }
        } else {
            let applications: Vec<_> = unsafe { content.applications() }.iter().filter(|a| unsafe { a.processID() } == std::process::id() as i32).collect();
            if applications.is_empty() { return Err("无法取得轻匣应用过滤器，不能安全排除自身窗口".into()) }
            let apps = NSArray::from_retained_slice(&applications);
            unsafe { SCContentFilter::initWithDisplay_excludingApplications_exceptingWindows(SCContentFilter::alloc(), &display, &apps, &NSArray::<SCWindow>::new()) }
        };
        let info = unsafe { SCShareableContent::infoForFilter(&filter) }; let scale = f64::from(unsafe { info.pointPixelScale() });
        let rect = if target.kind == "region" { target.rect.clone() } else {
            let r = unsafe { info.contentRect() }; super::super::record::RecordRect { x: 0.0, y: 0.0, width: r.size.width, height: r.size.height }
        };
        let (width, height) = super::super::record::output_size(&rect, scale)?;
        let configuration = unsafe { SCStreamConfiguration::new() };
        unsafe {
            configuration.setWidth(width); configuration.setHeight(height);
            if target.kind == "region" { configuration.setSourceRect(objc2_core_foundation::CGRect { origin: objc2_core_foundation::CGPoint { x: rect.x, y: rect.y }, size: objc2_core_foundation::CGSize { width: rect.width, height: rect.height } }); }
            configuration.setShowsCursor(true); configuration.setShowMouseClicks(options.show_clicks);
            configuration.setPixelFormat(u32::from_be_bytes(*b"BGRA"));
            configuration.setCaptureDynamicRange(objc2_screen_capture_kit::SCCaptureDynamicRange::SDR);
            configuration.setCapturesAudio(options.system_audio); configuration.setExcludesCurrentProcessAudio(true);
            configuration.setCaptureMicrophone(options.microphone);
            configuration.setMinimumFrameInterval(objc2_core_media::CMTime::new(1, 30));
        }
        if target.kind != "window" { super::super::record_windows::border(app, id, target.display, &rect)?; }
        let output_started = Arc::new(AtomicBool::new(false));
        let allocated = Delegate::alloc().set_ivars(Ivars { app: app.clone(), id, generation, output_started: output_started.clone(), target_kind: target.kind.clone() });
        let delegate: Retained<Delegate> = unsafe { msg_send![super(allocated), init] };
        let output_configuration = unsafe { SCRecordingOutputConfiguration::new() };
        unsafe { output_configuration.setOutputURL(&NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()))); }
        // SCRecordingOutput 默认使用 H.264 和 MP4。
        let output = unsafe { SCRecordingOutput::initWithConfiguration_delegate(SCRecordingOutput::alloc(), &output_configuration, ProtocolObject::from_ref(&*delegate)) };
        let stream = unsafe { SCStream::initWithFilter_configuration_delegate(SCStream::alloc(), &filter, &configuration, Some(ProtocolObject::from_ref(&*delegate))) };
        unsafe { stream.addRecordingOutput_error(&output) }.map_err(|e| format!("添加录像输出失败：{e}"))?;
        let mut observers = Vec::new();
        let watch = |center: Retained<NSNotificationCenter>, name: &NSString, disconnected: Option<u32>| {
            let app = app.clone();
            let handler = RcBlock::new(move |_notification: std::ptr::NonNull<NSNotification>| {
                dispatch(&app, id, generation, move |app, id| {
                    if let Some(display) = disconnected { if objc2_core_graphics::CGDisplayIsActive(display) { return } }
                    crate::diag!("录屏：会话 {id} 收到睡眠或显示器断开事件"); let _ = super::super::record::stop(app, id);
                });
            });
            let token = unsafe { center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &handler) };
            Observer { center, token }
        };
        observers.push(watch(objc2_app_kit::NSWorkspace::sharedWorkspace().notificationCenter(), unsafe { objc2_app_kit::NSWorkspaceWillSleepNotification }, None));
        observers.push(watch(NSNotificationCenter::defaultCenter(), unsafe { objc2_app_kit::NSApplicationDidChangeScreenParametersNotification }, Some(target.display)));
        ENGINE.with(|e| { *e.borrow_mut() = Some(Engine { _observers: observers, id, generation, stream: stream.clone(), output, _delegate: delegate, lifecycle: NativeLifecycle::preparing(), output_started, start_error: None, silent: super::super::record_media::silent(options), path: path.to_path_buf() }); });
        let app = app.clone();
        let handler = RcBlock::new(move |error: *mut NSError| {
            let reason = unsafe { error.as_ref() }.map(|e| format!("启动录屏失败：{}", e.localizedDescription()));
            dispatch(&app, id, generation, move |app, id| {
                ENGINE.with(|e| { if let Some(engine) = e.borrow_mut().as_mut().filter(|e| e.id == id) {
                    engine.lifecycle.output_started |= engine.output_started.load(Ordering::Acquire);
                    engine.lifecycle.capture_completed(reason.is_none()); engine.start_error = reason.clone();
                } });
                if let Some(reason) = reason { super::super::record::pending_error(app, id, reason); stop(app.clone(), id); }
                else {
                    let requested = ENGINE.with(|e| e.borrow().as_ref().filter(|e| e.id == id).is_some_and(|e| e.lifecycle.stop_requested));
                    if requested { stop(app.clone(), id); } else { complete_if_ready(app, id); }
                }
            });
        });
        unsafe { stream.startCaptureWithCompletionHandler(Some(&handler)); }
        Ok(())
    }
    fn complete_if_ready(app: &AppHandle, id: u64) {
        let completion = ENGINE.with(|e| {
            let mut engines = e.borrow_mut(); let engine = engines.as_mut().filter(|e| e.id == id)?;
            engine.lifecycle.output_started |= engine.output_started.load(Ordering::Acquire);
            engine.lifecycle.take_completion().map(|end| {
                let normalize = matches!(end, OutputEnd::Finished(_)) && engine.silent;
                if normalize { engine.lifecycle.begin_media(); }
                (end, engine.lifecycle.output_started, normalize, engine.path.clone(), engine.generation)
            })
        });
        let Some((end, started, normalize, path, generation)) = completion else { return };
        match end {
            OutputEnd::Finished(duration) => {
                if normalize {
                    let app = app.clone();
                    std::thread::spawn(move || {
                        let result = super::super::record_media::finalize(&path, duration);
                        dispatch(&app, id, generation, move |app, id| {
                            ENGINE.with(|e| { if let Some(engine) = e.borrow_mut().as_mut().filter(|e| e.id == id) { engine.lifecycle.media_completed(); } });
                            if let Err(error) = result { super::super::record::pending_error(app, id, format!("静音录像时长修复失败，原始文件已保留：{error}")); }
                            super::super::record::native_finished(app, id, duration, None);
                        });
                    });
                } else { super::super::record::native_finished(app, id, duration, None); }
            },
            OutputEnd::Failed(reason) | OutputEnd::NotStarted(reason) => {
                if !started { super::super::record::starting_failed(app, id, reason.clone()); }
                // 退出时不恢复选区；无法恢复或已经开始的会话进入失败预览。
                if callback_current_id(id) { super::super::record::native_finished(app, id, 0.0, Some(reason)); }
            }
        }
    }
    fn callback_current_id(id: u64) -> bool { CURRENT.with(|c| c.borrow().is_some_and(|(current, _)| current == id)) }
    fn output_ended(app: &AppHandle, id: u64, end: OutputEnd) {
        if let OutputEnd::Failed(reason) = &end { super::super::record::pending_error(app, id, reason.clone()); }
        super::super::record::finalizing(app, id);
        ENGINE.with(|e| { if let Some(engine) = e.borrow_mut().as_mut().filter(|e| e.id == id) { engine.lifecycle.output_ended(end); } });
        stop(app.clone(), id);
    }
    pub fn stop(app: AppHandle, id: u64) {
        // 启动失败且输出从未开始时，成功移除输出才可清理并恢复选区。
        let detach = ENGINE.with(|e| {
            let mut engines = e.borrow_mut(); let engine = engines.as_mut().filter(|e| e.id == id)?;
            engine.lifecycle.output_started |= engine.output_started.load(Ordering::Acquire);
            if engine.lifecycle.stream_stopped && !engine.lifecycle.output_started && engine.lifecycle.output.is_none() {
                engine.start_error.clone().map(|error| (engine.stream.clone(), engine.output.clone(), error))
            } else { None }
        });
        if let Some((stream, output, reason)) = detach {
            match unsafe { stream.removeRecordingOutput_error(&output) } {
                Ok(()) => ENGINE.with(|e| { if let Some(engine) = e.borrow_mut().as_mut().filter(|e| e.id == id) {
                    engine.lifecycle.output_started |= engine.output_started.load(Ordering::Acquire);
                    if engine.lifecycle.output_started { engine.lifecycle.stream_stopped = false; }
                    else { engine.lifecycle.abort_unstarted_output(reason); }
                } }),
                Err(error) => super::super::record::pending_error(&app, id, format!("清理未启动录像输出失败，可再次停止重试：{error}")),
            }
        }
        let exists = ENGINE.with(|e| e.borrow().as_ref().is_some_and(|e| e.id == id));
        if !exists { super::super::record::native_finished(&app, id, 0.0, Some("录屏在启动前已取消".into())); return }
        let stream = ENGINE.with(|e| {
            let mut engines = e.borrow_mut(); let engine = engines.as_mut().filter(|e| e.id == id)?;
            engine.lifecycle.request_stop().then(|| (engine.stream.clone(), engine.generation))
        });
        complete_if_ready(&app, id);
        let Some((stream, generation)) = stream else { return };
        let handler = RcBlock::new(move |error: *mut NSError| {
            let reason = unsafe { error.as_ref() }.map(|e| format!("停止录屏失败，可再次停止重试：{}", e.localizedDescription()));
            dispatch(&app, id, generation, move |app, id| {
                ENGINE.with(|e| { if let Some(engine) = e.borrow_mut().as_mut().filter(|e| e.id == id) { engine.lifecycle.stop_completed(reason.is_none()); } });
                if let Some(reason) = reason { super::super::record::pending_error(app, id, reason); }
                complete_if_ready(app, id);
            });
        });
        unsafe { stream.stopCaptureWithCompletionHandler(Some(&handler)); }
    }
    pub fn release(id: u64) -> bool {
        let safe = ENGINE.with(|e| !e.borrow().as_ref().is_some_and(|e| e.id == id && !e.lifecycle.release_ready()));
        if !safe { return false }
        CURRENT.with(|c| { if c.borrow().is_some_and(|(current, _)| current == id) { *c.borrow_mut() = None; } });
        ENGINE.with(|e| { if e.borrow().as_ref().is_some_and(|e| e.id == id) { *e.borrow_mut() = None; } }); true
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn 同一会话重试也拒绝上一轮原生回调() {
            CURRENT.with(|c| *c.borrow_mut() = Some((7, 2)));
            assert!(!callback_current(7, 1)); assert!(!callback_current(6, 2)); assert!(callback_current(7, 2));
            CURRENT.with(|c| *c.borrow_mut() = None); assert!(!callback_current(7, 2));
        }
    }

}
#[cfg(target_os = "macos")]
pub use native::{start, stop, release};
#[cfg(not(target_os = "macos"))]
pub fn start(app: AppHandle, id: u64, _target: RecordTarget, _options: RecordOptions, _path: PathBuf) { super::record::starting_failed(&app, id, "当前平台不支持录屏".into()); }
#[cfg(not(target_os = "macos"))]
pub fn stop(_app: AppHandle, _id: u64) {}
#[cfg(not(target_os = "macos"))]
pub fn release(_id: u64) -> bool { true }
