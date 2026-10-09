//! 截图会话：宿主内置的截图功能，不经插件加载。方案见 docs/截图与录屏计划.md。
//!
//! 同一时刻只有一个会话，按下快捷键或在搜索框选“截图”都调用 [`start_screenshot`]。
//! 每个会话有递增编号，异步回调携带编号推进状态，会话已取消或被新会话取代时，迟到的回调直接丢弃。
pub mod record;
pub mod record_engine;
pub mod record_windows;
pub mod record_files;
pub mod record_media;
pub mod export;
pub mod long;
pub mod long_stitch;
pub mod overlay;
pub mod permission;
pub mod pin;
pub mod screenshot;

use std::sync::Mutex;

/// 截图与录屏的入口共用此锁，避免并发检查后同时占用会话。
pub(crate) static SESSION_START: Mutex<()> = Mutex::new(());

use tauri::{AppHandle, Manager, Webview};

/// 截图与录屏要求的最低系统版本：`SCScreenshotManager` 需 14+，`SCRecordingOutput` 与麦克风捕获需 15+，统一以 15 为基线。
const MINIMUM_MACOS: i64 = 15;

/// 截图会话所处阶段。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    /// 没有会话。
    Idle,
    /// 检查权限、收起主面板、取快照。
    Preparing,
    /// 覆盖窗已显示，用户正在框选。
    Selecting,
    /// 已确定选区，正在标注。
    Annotating,
    /// 正在复制或保存。
    Exporting,
    /// 长截图：用户滚动内容，后台截取拼接。
    Scrolling,
}

/// 推动会话前进的事件。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    /// 用户触发截图。
    Start,
    /// 快照与覆盖窗准备完成。
    Ready,
    /// 选区确定。
    Selected,
    /// 开始复制或保存。
    Export,
    /// 复制或保存成功，会话结束。
    Done,
    /// 当前步骤失败。导出失败回到标注，保留编辑；其余阶段失败结束会话。
    Fail,
    /// 用户取消（Esc）或出现无法继续的情况。
    Cancel,
    /// 开始长截图。
    LongStart,
}

/// 状态转换表；返回 `None` 表示该事件在当前阶段无效，应忽略（例如准备期间重复按快捷键）。
pub fn transition(phase: Phase, event: Event) -> Option<Phase> {
    use Event::*;
    use Phase::*;
    match (phase, event) {
        (Idle, Start) => Some(Preparing),
        (Preparing, Ready) => Some(Selecting),
        (Selecting, Selected) => Some(Annotating),
        (Annotating | Scrolling, Export) => Some(Exporting),
        (Selecting | Annotating, LongStart) => Some(Scrolling),
        (Exporting, Done) => Some(Idle),
        (Exporting, Fail) => Some(Annotating),
        (Preparing | Selecting | Annotating | Scrolling, Fail) => Some(Idle),
        (Idle, _) => None,
        (_, Cancel) => Some(Idle),
        _ => None,
    }
}

#[derive(Debug)]
struct Session {
    id: u64,
    phase: Phase,
    /// 按下快捷键的时刻，用于记录各步骤耗时。
    started: Option<std::time::Instant>,
}

pub struct CaptureState {
    session: Mutex<Session>,
}

impl Default for CaptureState {
    fn default() -> Self {
        Self { session: Mutex::new(Session { id: 0, phase: Phase::Idle, started: None }) }
    }
}

impl CaptureState {
    /// 开始新会话，返回会话编号；已有会话进行中时返回 `None`。
    fn begin(&self) -> Result<Option<u64>, String> {
        let mut session = self.session.lock().map_err(|_| "截图状态不可用")?;
        let Some(phase) = transition(session.phase, Event::Start) else { return Ok(None) };
        session.id += 1;
        session.phase = phase;
        session.started = Some(std::time::Instant::now());
        Ok(Some(session.id))
    }

    /// 按会话编号推进状态；编号不是当前会话或事件无效时返回 `false`，调用方应丢弃该回调。
    pub fn advance(&self, id: u64, event: Event) -> Result<bool, String> {
        let mut session = self.session.lock().map_err(|_| "截图状态不可用")?;
        if session.id != id { return Ok(false) }
        let Some(phase) = transition(session.phase, event) else { return Ok(false) };
        session.phase = phase;
        Ok(true)
    }

    /// 指定会话当前所处阶段；不是当前会话时返回 `None`。
    fn phase_of(&self, id: u64) -> Option<Phase> {
        self.session.lock().ok().filter(|session| session.id == id).map(|session| session.phase)
    }

    /// 当前会话是否进行中；主面板的失焦收起、抢回焦点等逻辑据此避让。
    pub fn active(&self) -> bool {
        self.session.lock().is_ok_and(|session| session.phase != Phase::Idle)
    }
}

/// 当前系统是否满足截图要求。
pub fn supported() -> bool {
    #[cfg(target_os = "macos")]
    {
        objc2_foundation::NSProcessInfo::processInfo().operatingSystemVersion().majorVersion >= MINIMUM_MACOS as _
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = MINIMUM_MACOS;
        false
    }
}

/// 截图入口：快捷键与搜索框共用。会话进行中再次触发会被忽略。
/// `hide_panel` 为真时先收起主面板（从搜索框启动，面板只是入口）；快捷键启动时保留主面板与插件界面，可以截取轻匣自身。
pub fn start_screenshot(app: &AppHandle, hide_panel: bool) -> Result<(), String> {
    if !supported() {
        crate::diag!("截图：系统版本低于 macOS {MINIMUM_MACOS}，不可用");
        return Err(format!("截图需要 macOS {MINIMUM_MACOS} 或更高版本"));
    }
    let entry = SESSION_START.lock().map_err(|_| "截图与录屏入口不可用")?;
    if app.state::<record::RecordState>().active() { return Ok(()); }
    let state = app.state::<CaptureState>();
    let Some(id) = state.begin()? else {
        crate::diag!("截图：已有会话进行中，忽略本次触发");
        return Ok(());
    };
    drop(entry);
    crate::diag!("截图：会话 {id} 开始");
    // 未授权时结束会话，唤起主面板说明原因。
    let access = match permission::ensure(app) {
        Ok(access) => access,
        Err(error) => { state.advance(id, Event::Fail)?; return Err(error) }
    };
    if let Some(notice) = access.notice() {
        state.advance(id, Event::Cancel)?;
        crate::diag!("截图：会话 {id} 结束（未授权）");
        crate::show_launcher_with(app, Some(notice));
        return Ok(());
    }
    if hide_panel {
        if let Some(window) = app.get_window("main") {
            if window.is_visible().unwrap_or(false) { crate::hide_panel(&window, "从搜索框开始截图")?; }
        }
    }
    // 冻结画面：全部屏幕截完后再打开覆盖窗，覆盖窗不会出现在快照中。
    let handle = app.clone();
    let started = std::time::Instant::now();
    screenshot::capture(move |result| {
        let app = handle.clone();
        let elapsed = started.elapsed().as_millis();
        if let Err(error) = handle.run_on_main_thread(move || present(&app, id, result, elapsed)) {
            crate::diag!("截图：调度覆盖窗失败：{error}");
        }
    });
    Ok(())
}

/// 快照完成后打开覆盖窗。会话已取消或被新会话取代时丢弃快照。
fn present(app: &AppHandle, id: u64, result: Result<Vec<screenshot::Snapshot>, String>, elapsed: u128) {
    if app.state::<CaptureState>().phase_of(id) != Some(Phase::Preparing) {
        crate::diag!("截图：会话 {id} 已结束，丢弃迟到的快照");
        return;
    }
    let outcome = result.and_then(|snapshots| {
        crate::diag!("截图：会话 {id} 取得 {} 块屏幕快照，用时 {elapsed} 毫秒", snapshots.len());
        screenshot::store(id, snapshots);
        overlay::open(app, id)
    });
    match outcome {
        Ok(_) => { let _ = app.state::<CaptureState>().advance(id, Event::Ready); }
        Err(error) => {
            if let Err(cause) = finish(app, id, Event::Fail, &error) { crate::diag!("结束截图失败：{cause}"); }
            crate::show_launcher_with(app, Some(&format!("截图失败：{error}")));
        }
    }
}

/// 结束指定会话并关闭覆盖窗；会话已结束或已被新会话取代时什么也不做。
fn finish(app: &AppHandle, id: u64, event: Event, reason: &str) -> Result<(), String> {
    if !app.state::<CaptureState>().advance(id, event)? { return Ok(()) }
    long::shutdown(app);
    overlay::close_all(app);
    screenshot::clear();
    // 保存对话框会激活应用；结束后把焦点交还给原来的应用（有贴图时保留应用，避免贴图一起隐藏）
    #[cfg(target_os = "macos")]
    crate::native_window::release_focus(app);
    crate::diag!("截图：会话 {id} 结束（{reason}）");
    Ok(())
}

/// 取消进行中的截图，例如截图时按下唤起快捷键。
pub fn cancel_active(app: &AppHandle) {
    let state = app.state::<CaptureState>();
    let Ok(id) = state.session.lock().map(|session| (session.phase != Phase::Idle).then_some(session.id)) else { return };
    if let Some(id) = id {
        if let Err(error) = finish(app, id, Event::Cancel, "唤起主面板") { crate::diag!("取消截图失败：{error}"); }
    }
}

/// 覆盖窗显示出冻结画面时上报，用于记录从按键到画面就绪的耗时。
#[tauri::command]
pub fn capture_ready(app: AppHandle, webview: Webview, session: u64) {
    if overlay::session_of(webview.label()) != Some(session) { return }
    let elapsed = app.state::<CaptureState>().session.lock().ok()
        .filter(|current| current.id == session)
        .and_then(|current| current.started)
        .map(|started| started.elapsed().as_millis());
    if let Some(elapsed) = elapsed { crate::diag!("截图：会话 {session} {} 画面就绪，距按键 {elapsed} 毫秒", webview.label()); }
}

/// 覆盖窗请求取消（Esc）。只接受本会话覆盖窗的调用。
#[tauri::command]
pub fn capture_cancel(app: AppHandle, webview: Webview, session: u64) -> Result<(), String> {
    if overlay::session_of(webview.label()) != Some(session) { return Err("截图会话已失效".into()) }
    finish(&app, session, Event::Cancel, "用户取消")
}

/// 搜索框选中“截图”。
#[tauri::command]
pub fn start_screenshot_command(app: AppHandle, webview: Webview) -> Result<(), String> {
    if webview.label() != "main" { return Err("只有主入口可以开始截图".into()) }
    start_screenshot(&app, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use Event::*;
    use Phase::*;

    #[test]
    fn 正常流程从空闲回到空闲() {
        let mut phase = Idle;
        for event in [Start, Ready, Selected, Export, Done] {
            phase = transition(phase, event).unwrap_or_else(|| panic!("{phase:?} 不应拒绝 {event:?}"));
        }
        assert_eq!(phase, Idle);
    }

    #[test]
    fn 会话进行中重复触发被忽略() {
        for phase in [Preparing, Selecting, Annotating, Exporting] {
            assert_eq!(transition(phase, Start), None, "{phase:?} 期间不能再开始");
        }
    }

    #[test]
    fn 任一阶段取消都回到空闲() {
        for phase in [Preparing, Selecting, Annotating, Exporting] {
            assert_eq!(transition(phase, Cancel), Some(Idle));
        }
        assert_eq!(transition(Idle, Cancel), None, "空闲时取消无意义");
    }

    #[test]
    fn 导出失败保留标注其余失败结束会话() {
        assert_eq!(transition(Exporting, Fail), Some(Annotating));
        for phase in [Preparing, Selecting, Annotating] {
            assert_eq!(transition(phase, Fail), Some(Idle));
        }
    }

    #[test]
    fn 长截图从选区或标注开始可导出或取消() {
        assert_eq!(transition(Selecting, LongStart), Some(Scrolling));
        assert_eq!(transition(Annotating, LongStart), Some(Scrolling));
        assert_eq!(transition(Preparing, LongStart), None);
        assert_eq!(transition(Scrolling, Export), Some(Exporting));
        assert_eq!(transition(Scrolling, Cancel), Some(Idle));
        assert_eq!(transition(Scrolling, Fail), Some(Idle));
    }

    #[test]
    fn 不能跳过步骤() {
        assert_eq!(transition(Preparing, Selected), None);
        assert_eq!(transition(Selecting, Export), None);
        assert_eq!(transition(Annotating, Done), None);
        assert_eq!(transition(Idle, Ready), None);
    }

    #[test]
    fn 迟到的回调按会话编号丢弃() {
        let state = CaptureState::default();
        let first = state.begin().unwrap().unwrap();
        assert_eq!(state.begin().unwrap(), None, "进行中不能开始第二个会话");
        assert!(state.advance(first, Cancel).unwrap());
        assert!(!state.active());
        let second = state.begin().unwrap().unwrap();
        assert_ne!(first, second);
        assert!(!state.advance(first, Ready).unwrap(), "旧会话的回调不能推进新会话");
        assert!(state.advance(second, Ready).unwrap());
        assert!(state.active());
    }
}
