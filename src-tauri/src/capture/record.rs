//! 录屏会话：选区、开始、停止与收尾。原生完成回调是保存录像的唯一入口。
//!
//! 录完自动保存到桌面并结束会话，右下角显示操作卡片（播放、复制、访达、删除）；
//! 卡片与会话无关，卡片未关闭时也可以开始下一次录屏。
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{atomic::{AtomicU64, Ordering}, Mutex},
    time::Instant,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Webview};

use super::{record_engine, record_files, record_windows};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Preparing,
    Selecting,
    Starting,
    Recording,
    Finalizing,
    /// 文件已完成，等待保存并结束会话。
    Preview,
    Failed,
}

#[derive(Clone, Copy, Debug)]
pub enum Event {
    Ready,
    Start,
    Started,
    Stop,
    Finished,
    Fail,
}

pub fn transition(phase: Phase, event: Event) -> Option<Phase> {
    use Event::*;
    use Phase::*;
    match (phase, event) {
        (Preparing, Ready) => Some(Selecting),
        (Selecting, Start) => Some(Starting),
        (Starting, Started) => Some(Recording),
        (Starting | Recording, Stop) => Some(Finalizing),
        (Recording | Finalizing, Finished) => Some(Preview),
        (Preparing | Selecting | Starting | Recording | Finalizing, Fail) => Some(Failed),
        _ => None,
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct RecordRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct RecordTarget {
    pub kind: String,
    pub display: u32,
    pub window: Option<u32>,
    pub rect: RecordRect,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordOptions {
    pub system_audio: bool,
    pub microphone: bool,
    pub show_clicks: bool,
}

impl Default for RecordOptions {
    fn default() -> Self {
        Self { system_audio: false, microphone: false, show_clicks: true }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordStatus {
    pub phase: Phase,
    pub elapsed: f64,
    pub duration: f64,
    pub file_size: u64,
    pub error: Option<String>,
}

struct Session {
    id: u64,
    phase: Phase,
    started: Option<Instant>,
    elapsed: f64,
    duration: f64,
    path: PathBuf,
    error: Option<String>,
    quitting: bool,
}

impl Session {
    fn note_error(&mut self, error: String) {
        match &mut self.error {
            Some(previous) if previous != &error => {
                previous.push_str("；");
                previous.push_str(&error);
            }
            None => self.error = Some(error),
            _ => {}
        }
    }

    /// 放弃会话时删除尚未保存的临时录像。
    fn cleanup(self) {
        let _ = std::fs::remove_file(self.path);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ShortcutAction {
    Start,
    Stop(u64),
    Ignore,
}

#[derive(Default)]
pub struct RecordState {
    session: Mutex<Option<Session>>,
}

static NEXT: AtomicU64 = AtomicU64::new(1);

fn accept_callback(current: u64, callback: u64) -> bool {
    current == callback
}

impl RecordState {
    fn shortcut_action(&self) -> Result<ShortcutAction, String> {
        let current = self.session.lock().map_err(|_| "录屏状态不可用")?;
        Ok(match current.as_ref() {
            None => ShortcutAction::Start,
            Some(session) if session.phase == Phase::Recording => ShortcutAction::Stop(session.id),
            _ => ShortcutAction::Ignore,
        })
    }

    /// 启动失败且尚未开始录制：清理本轮临时文件，回到选区让用户调整后重试。
    fn retry_ready(&self, id: u64, error: String) -> Result<bool, String> {
        self.with(id, |session| {
            if !matches!(session.phase, Phase::Starting | Phase::Finalizing) || session.started.is_some() || session.quitting {
                return Ok(false);
            }
            if let Err(cause) = std::fs::remove_file(&session.path) {
                if cause.kind() != std::io::ErrorKind::NotFound {
                    let reason = format!("清理未完成录像失败：{cause}");
                    session.note_error(reason.clone());
                    return Err(reason);
                }
            }
            session.phase = Phase::Selecting;
            session.note_error(error);
            Ok(true)
        })
    }

    pub fn active(&self) -> bool {
        self.session.lock().is_ok_and(|session| session.is_some())
    }

    fn with<T>(&self, id: u64, operation: impl FnOnce(&mut Session) -> Result<T, String>) -> Result<T, String> {
        let mut guard = self.session.lock().map_err(|_| "录屏状态不可用")?;
        let session = guard.as_mut().filter(|session| accept_callback(session.id, id)).ok_or("录屏会话已失效")?;
        operation(session)
    }

    /// 取出并结束指定会话。
    fn take(&self, id: u64) -> Option<Session> {
        let mut guard = self.session.lock().ok()?;
        if guard.as_ref().is_some_and(|session| session.id == id) { guard.take() } else { None }
    }

    fn request_stop(&self, id: u64) -> Result<bool, String> {
        self.with(id, |session| {
            let Some(next) = transition(session.phase, Event::Stop) else { return Ok(false) };
            session.elapsed = session.started.map(|start| start.elapsed().as_secs_f64()).unwrap_or(0.0);
            session.phase = next;
            Ok(true)
        })
    }

    /// 原生文件完成：返回 `Some(是否正在退出)`；回调已失效时返回 `None`。
    fn finish(&self, id: u64, duration: f64, error: Option<String>) -> Result<Option<bool>, String> {
        self.with(id, |session| {
            if !matches!(session.phase, Phase::Recording | Phase::Finalizing) && !(session.phase == Phase::Starting && error.is_some()) {
                return Ok(None);
            }
            if session.phase == Phase::Recording {
                session.elapsed = session.started.map(|start| start.elapsed().as_secs_f64()).unwrap_or(session.elapsed);
            }
            let output_failed = error.is_some();
            session.duration = duration;
            if let Some(error) = error { session.note_error(error); }
            session.phase = transition(session.phase, if output_failed { Event::Fail } else { Event::Finished }).ok_or("录屏完成回调已失效")?;
            Ok(Some(session.quitting))
        })
    }

    pub fn is_starting(&self, id: u64) -> bool {
        self.with(id, |session| Ok(session.phase == Phase::Starting)) == Ok(true)
    }
}

/// 来源区域始终使用逻辑点，输出才按实际过滤器缩放为物理像素，并限制在 4K 编码范围内。
pub fn output_size(rect: &RecordRect, scale: f64) -> Result<(usize, usize), String> {
    if ![rect.width, rect.height, scale].iter().all(|value| value.is_finite() && *value > 0.0) {
        return Err("录屏尺寸或缩放不正确".into());
    }
    let width = rect.width * scale;
    let height = rect.height * scale;
    let factor = (3840.0 / width).min(2160.0 / height).min(1.0);
    let even = |value: f64| ((value * factor / 2.0).round() as usize * 2).max(2);
    Ok((even(width).min(3840), even(height).min(2160)))
}

pub fn validate_target(target: &RecordTarget, bounds: &RecordRect) -> Result<(), String> {
    let rect = &target.rect;
    if ![rect.x, rect.y, rect.width, rect.height].iter().all(|value| value.is_finite()) || rect.width < 2.0 || rect.height < 2.0 {
        return Err("录屏选区不正确".into());
    }
    if !matches!(target.kind.as_str(), "region" | "display" | "window") { return Err("录屏模式不正确".into()) }
    if target.kind == "window" {
        if target.window.is_none_or(|id| id == 0) { return Err("窗口录屏必须提供真实窗口编号".into()) }
    } else if rect.x < 0.0 || rect.y < 0.0 || rect.x + rect.width > bounds.width + 0.5 || rect.y + rect.height > bounds.height + 0.5 {
        return Err("录屏选区超出显示器".into());
    }
    Ok(())
}

/// 录屏窗口标签：`record-select-<会话>-<屏幕>`、`record-control-<会话>`、`record-border-<会话>`。
pub fn authorized(label: &str, session: u64, roles: &[&str]) -> bool {
    let Some(rest) = label.strip_prefix("record-") else { return false };
    let parts: Vec<_> = rest.split('-').collect();
    match parts.as_slice() {
        [role, id, screen] if *role == "select" => roles.contains(role) && id.parse::<u64>() == Ok(session) && screen.parse::<usize>().is_ok(),
        [role, id] if matches!(*role, "control" | "border") => roles.contains(role) && id.parse::<u64>() == Ok(session),
        _ => false,
    }
}

pub fn microphone_needed(selected: bool, authorized: bool) -> bool {
    selected && !authorized
}

fn require(app: &AppHandle, webview: &Webview, id: u64, roles: &[&str]) -> Result<(), String> {
    if !authorized(webview.label(), id, roles) || app.get_webview(webview.label()).is_none() {
        return Err("此窗口无权操作录屏会话".into());
    }
    app.state::<RecordState>().with(id, |_| Ok(()))
}

/// 录屏快捷键：空闲时开始，录制中停止，其余阶段忽略。
pub fn shortcut(app: &AppHandle) -> Result<(), String> {
    match app.state::<RecordState>().shortcut_action()? {
        ShortcutAction::Start => start(app),
        ShortcutAction::Stop(id) => stop(app, id),
        ShortcutAction::Ignore => Ok(()),
    }
}

pub fn start(app: &AppHandle) -> Result<(), String> {
    if !super::supported() { return Err("录屏需要 macOS 15 或更高版本".into()) }
    let entry = super::SESSION_START.lock().map_err(|_| "截图与录屏入口不可用")?;
    if app.state::<super::CaptureState>().active() { return Ok(()) }
    let state = app.state::<RecordState>();
    let id = {
        let mut guard = state.session.lock().map_err(|_| "录屏状态不可用")?;
        if guard.is_some() { return Ok(()) }
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        *guard = Some(Session {
            id,
            phase: Phase::Preparing,
            started: None,
            elapsed: 0.0,
            duration: 0.0,
            path: record_files::temporary_path(app, id)?,
            error: None,
            quitting: false,
        });
        id
    };
    drop(entry);
    crate::diag!("录屏：会话 {id} 开始准备");
    let access = match super::permission::ensure(app) {
        Ok(access) => access,
        Err(error) => {
            abandon(app, id);
            return Err(error);
        }
    };
    if let Some(notice) = access.notice() {
        abandon(app, id);
        crate::show_launcher_with(app, Some(&notice.replace("截图", "录屏")));
        return Ok(());
    }
    if let Some(window) = app.get_window("main") {
        if window.is_visible().unwrap_or(false) { let _ = crate::hide_panel(&window, "开始录屏"); }
    }
    let handle = app.clone();
    super::screenshot::capture(move |result| {
        let app = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            if app.state::<RecordState>().with(id, |session| Ok(session.phase == Phase::Preparing)) != Ok(true) { return }
            let result = result.and_then(|snapshots| {
                super::screenshot::store(id, snapshots);
                record_windows::select(&app, id)
            });
            match result {
                Ok(()) => {
                    let _ = app.state::<RecordState>().with(id, |session| {
                        session.phase = transition(session.phase, Event::Ready).ok_or("录屏选区准备已失效")?;
                        Ok(())
                    });
                }
                Err(error) => {
                    abandon(&app, id);
                    crate::show_launcher_with(&app, Some(&format!("录屏失败：{error}")));
                }
            }
        });
    });
    Ok(())
}

#[tauri::command]
pub fn start_recording_command(app: AppHandle, webview: Webview) -> Result<(), String> {
    if webview.label() != "main" { return Err("只有主入口可以开始录屏".into()) }
    start(&app)
}

#[tauri::command]
pub fn record_start(app: AppHandle, webview: Webview, session: u64, target: RecordTarget, options: RecordOptions) -> Result<(), String> {
    require(&app, &webview, session, &["select"])?;
    record_windows::validate_display(webview.label(), session, target.display)?;
    let state = app.state::<RecordState>();
    let path = state.with(session, |current| {
        if current.phase != Phase::Selecting { return Err("录屏已经开始".into()) }
        current.phase = transition(current.phase, Event::Start).ok_or("录屏已经开始")?;
        current.error = None;
        Ok(current.path.clone())
    })?;
    crate::diag!(
        "录屏：会话 {session} 目标 {} 显示器 {} 窗口 {:?}，系统声 {} 麦克风 {} 点击圆圈 {}",
        target.kind, target.display, target.window, options.system_audio, options.microphone, options.show_clicks
    );
    // 权限拒绝和启动前失败保留选区，允许用户关闭麦克风重试。
    record_engine::start(app.clone(), session, target, options, path);
    Ok(())
}

#[tauri::command]
pub fn record_cancel(app: AppHandle, webview: Webview, session: u64) -> Result<(), String> {
    require(&app, &webview, session, &["select"])?;
    let cancel = app.state::<RecordState>().with(session, |current| Ok(matches!(current.phase, Phase::Selecting | Phase::Preparing)))?;
    if cancel { abandon(&app, session); }
    Ok(())
}

#[tauri::command]
pub fn record_status(app: AppHandle, webview: Webview, session: u64) -> Result<RecordStatus, String> {
    require(&app, &webview, session, &["select", "control"])?;
    app.state::<RecordState>().with(session, |current| {
        let elapsed = if current.phase == Phase::Recording {
            current.started.map(|start| start.elapsed().as_secs_f64()).unwrap_or(0.0)
        } else {
            current.elapsed
        };
        Ok(RecordStatus {
            phase: current.phase,
            elapsed,
            duration: current.duration,
            file_size: std::fs::metadata(&current.path).map(|metadata| metadata.len()).unwrap_or(0),
            error: current.error.clone(),
        })
    })
}

#[tauri::command]
pub fn record_stop(app: AppHandle, webview: Webview, session: u64) -> Result<(), String> {
    require(&app, &webview, session, &["control"])?;
    stop(&app, session)
}

pub fn stop(app: &AppHandle, id: u64) -> Result<(), String> {
    let changed = app.state::<RecordState>().request_stop(id)?;
    if changed { crate::diag!("录屏：会话 {id} 请求停止，等待文件收尾"); }
    if app.state::<RecordState>().with(id, |session| Ok(session.phase == Phase::Finalizing)) == Ok(true) {
        record_engine::stop(app.clone(), id);
    }
    Ok(())
}

pub fn pending_error(app: &AppHandle, id: u64, error: String) {
    finalizing(app, id);
    let _ = app.state::<RecordState>().with(id, |session| {
        if session.phase == Phase::Finalizing { session.note_error(error); }
        Ok(())
    });
}

pub fn finalizing(app: &AppHandle, id: u64) {
    let _ = app.state::<RecordState>().request_stop(id);
}

/// 菜单栏“停止录屏”与控制窗关闭按钮。
pub fn stop_active(app: &AppHandle) {
    let id = app.state::<RecordState>().session.lock().ok().and_then(|session| session.as_ref().map(|session| session.id));
    if let Some(id) = id { let _ = stop(app, id); }
}

pub fn starting_failed(app: &AppHandle, id: u64, error: String) {
    let ready = app.state::<RecordState>().with(id, |session| {
        Ok(matches!(session.phase, Phase::Starting | Phase::Finalizing) && session.started.is_none() && !session.quitting)
    });
    if ready != Ok(true) || !record_engine::release(id) { return }
    record_windows::rollback_start(app, id);
    if let Err(reason) = app.state::<RecordState>().retry_ready(id, error) {
        native_finished(app, id, 0.0, Some(reason));
    }
}

pub fn native_started(app: &AppHandle, id: u64) {
    let result = app.state::<RecordState>().with(id, |session| {
        if transition(session.phase, Event::Started).is_none() { return Ok(false) }
        session.phase = Phase::Recording;
        session.started = Some(Instant::now());
        Ok(true)
    });
    if result == Ok(true) {
        crate::diag!("录屏：会话 {id} 原生录制已开始");
        if let Err(error) = record_windows::controls(app, id) {
            crate::diag!("创建录屏控制窗失败：{error}");
            let _ = stop(app, id);
        }
        record_windows::close_role(app, "select");
        super::screenshot::clear();
    }
}

/// 原生文件完成：关闭录屏窗口，保存录像并显示操作卡片，结束会话。
pub fn native_finished(app: &AppHandle, id: u64, duration: f64, error: Option<String>) {
    if !record_engine::release(id) { return }
    let Ok(Some(quitting)) = app.state::<RecordState>().finish(id, duration, error) else { return };
    let _ = app.state::<RecordState>().with(id, |session| {
        crate::diag!(
            "录屏：会话 {id} 文件完成，时长 {} 秒，大小 {} 字节，错误 {:?}",
            session.duration, std::fs::metadata(&session.path).map(|metadata| metadata.len()).unwrap_or(0), session.error
        );
        Ok(())
    });
    record_windows::close_all(app);
    super::screenshot::clear();
    deliver(app, id);
    if quitting { app.exit(0); }
}

/// 保存录像并打开操作卡片；没有生成视频时说明原因。保存失败保留临时文件并给出位置。
fn deliver(app: &AppHandle, id: u64) {
    let Some(session) = app.state::<RecordState>().take(id) else { return };
    let has_video = std::fs::metadata(&session.path).is_ok_and(|metadata| metadata.len() > 0);
    if !has_video {
        let reason = session.error.clone().unwrap_or_else(|| "没有生成视频文件".into());
        session.cleanup();
        crate::show_launcher_with(app, Some(&format!("录屏失败：{reason}")));
        return;
    }
    match record_files::store(&session.path) {
        Ok(saved) => {
            crate::diag!("录屏：会话 {id} 已保存到 {}", saved.display());
            // 录制中途出错但保留了视频时，在卡片上提示原因
            let warning = session.error.as_ref().map(|reason| format!("录制提前结束：{reason}"));
            if let Err(error) = record_windows::card(app, &saved, session.duration, warning) {
                crate::show_launcher_with(app, Some(&format!("录屏已保存到 {}，但无法显示操作卡片：{error}", saved.display())));
            }
        }
        Err(error) => {
            crate::show_launcher_with(app, Some(&format!("录屏已完成，但保存失败：{error}。临时文件位置：{}", session.path.display())));
        }
    }
}

fn abandon(app: &AppHandle, id: u64) {
    if let Some(session) = app.state::<RecordState>().take(id) {
        record_engine::release(id);
        session.cleanup();
        record_windows::close_all(app);
        super::screenshot::clear();
    }
}

/// 返回真表示必须等待原生文件完成，调用方阻止本次退出。
pub fn prepare_exit(app: &AppHandle) -> bool {
    let state = app.state::<RecordState>();
    let waiting = state.session.lock().ok().and_then(|mut guard| guard.as_mut().map(|session| {
        if matches!(session.phase, Phase::Starting | Phase::Recording | Phase::Finalizing) {
            let fresh = !session.quitting;
            session.quitting = true;
            Some((session.id, fresh))
        } else {
            None
        }
    })).flatten();
    let Some((id, fresh)) = waiting else { return false };
    let _ = stop(app, id);
    if !fresh { return true }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(15));
        let dispatch = app.clone();
        let _ = dispatch.run_on_main_thread(move || {
            let timed_out = app.state::<RecordState>().with(id, |session| {
                if session.quitting && session.phase == Phase::Finalizing {
                    session.phase = Phase::Failed;
                    session.error = Some("退出等待录像收尾超时，临时文件已保留".into());
                    Ok(true)
                } else {
                    Ok(false)
                }
            });
            if timed_out == Ok(true) {
                crate::diag!("录屏：退出收尾超时，保留文件并退出");
                app.exit(0);
            }
        });
    });
    true
}

// ——— 录完的操作卡片 ———

/// 打开中的卡片：卡片编号 → 已保存的录像路径。
static CARDS: Mutex<Option<HashMap<u64, PathBuf>>> = Mutex::new(None);
static NEXT_CARD: AtomicU64 = AtomicU64::new(1);
pub const CARD_PREFIX: &str = "record-card-";

pub fn register_card(path: &Path) -> u64 {
    let id = NEXT_CARD.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut cards) = CARDS.lock() { cards.get_or_insert_with(HashMap::new).insert(id, path.to_path_buf()); }
    id
}

fn remove_card(id: u64) {
    if let Ok(mut cards) = CARDS.lock() {
        if let Some(map) = cards.as_mut() { map.remove(&id); }
    }
}

/// 卡片窗口只能读取自己的录像。
pub fn card_path(label: &str, id: u64) -> Option<PathBuf> {
    if card_id(label) != Some(id) { return None }
    CARDS.lock().ok()?.as_ref()?.get(&id).cloned()
}

fn card_id(label: &str) -> Option<u64> {
    label.strip_prefix(CARD_PREFIX)?.parse().ok()
}

/// 关闭已有卡片，新录像出现时只保留一张。
pub fn close_cards(app: &AppHandle) {
    for label in app.webview_windows().into_keys().filter(|label| label.starts_with(CARD_PREFIX)) {
        if let Some(id) = card_id(&label) { remove_card(id); }
        super::overlay::destroy_window(app, &label);
    }
}

/// 卡片操作：`play` 用默认应用播放，`copy` 复制文件，`reveal` 在访达中显示，`delete` 移到废纸篓，`close` 只关闭。
/// 成功后关闭卡片；失败时卡片保留并显示原因。
#[tauri::command]
pub fn record_card_action(app: AppHandle, webview: Webview, action: String) -> Result<(), String> {
    let label = webview.label().to_string();
    let id = card_id(&label).ok_or("只有录屏卡片可以执行此操作")?;
    let path = card_path(&label, id).ok_or("录屏卡片已失效")?;
    let open = |arguments: &[&str]| {
        std::process::Command::new("open").args(arguments).arg(&path).spawn().map(|_| ()).map_err(|error| format!("打开录像失败：{error}"))
    };
    match action.as_str() {
        "play" => open(&[])?,
        "copy" => record_files::copy(&path)?,
        "reveal" => open(&["-R"])?,
        "delete" => record_files::trash(&path)?,
        "close" => {}
        _ => return Err("不支持的录屏卡片操作".into()),
    }
    crate::diag!("录屏卡片：{action} {}", path.display());
    remove_card(id);
    super::overlay::destroy_window(&app, &label);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试用临时路径：带进程号与纳秒时间戳，避免与中断运行遗留的文件重名。
    fn unique_temp(name: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("qingbox-{name}-{}-{stamp}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)))
    }

    fn test_session(path: PathBuf) -> Session {
        Session { id: 7, phase: Phase::Starting, started: None, elapsed: 0.0, duration: 0.0, path, error: None, quitting: false }
    }

    #[test]
    fn 快捷键分发空闲开始录制中停止且收尾忽略() {
        let state = RecordState::default();
        assert_eq!(state.shortcut_action().unwrap(), ShortcutAction::Start);
        let mut session = test_session(PathBuf::from("test.mp4"));
        session.phase = Phase::Recording;
        *state.session.lock().unwrap() = Some(session);
        assert_eq!(state.shortcut_action().unwrap(), ShortcutAction::Stop(7));
        state.request_stop(7).unwrap();
        assert_eq!(state.shortcut_action().unwrap(), ShortcutAction::Ignore);
        assert!(!state.request_stop(7).unwrap());
    }

    #[test]
    fn 先前原生错误在成功文件完成后保留() {
        let state = RecordState::default();
        let mut session = test_session(PathBuf::from("test.mp4"));
        session.phase = Phase::Finalizing;
        session.error = Some("系统提前停止共享".into());
        *state.session.lock().unwrap() = Some(session);
        state.finish(7, 3.0, None).unwrap();
        assert_eq!(state.with(7, |s| Ok((s.phase, s.error.clone()))).unwrap(), (Phase::Preview, Some("系统提前停止共享".into())));
    }

    #[test]
    fn 启动失败恢复清除本轮临时文件并保留可重试会话() {
        let path = unique_temp("retry-test");
        std::fs::write(&path, b"partial").unwrap();
        let state = RecordState::default();
        *state.session.lock().unwrap() = Some(test_session(path.clone()));
        assert!(state.retry_ready(7, "添加输出失败".into()).unwrap());
        assert!(!path.exists());
        state.with(7, |s| {
            assert_eq!(s.phase, Phase::Selecting);
            s.phase = transition(s.phase, Event::Start).unwrap();
            Ok(())
        }).unwrap();
        assert!(state.is_starting(7));
    }

    #[test]
    fn 无法清理启动文件时不得开放重试以免覆盖遗留文件() {
        let path = unique_temp("retry-directory");
        std::fs::create_dir(&path).unwrap();
        let state = RecordState::default();
        *state.session.lock().unwrap() = Some(test_session(path.clone()));
        assert!(state.retry_ready(7, "启动失败".into()).is_err());
        assert!(state.is_starting(7));
        assert!(path.exists());
        std::fs::remove_dir(path).unwrap();
    }

    #[test]
    fn 结束会话后释放入口且旧会话命令失效() {
        let state = RecordState::default();
        *state.session.lock().unwrap() = Some(test_session(PathBuf::from("test.mp4")));
        assert!(state.take(6).is_none(), "不能取出其他会话");
        assert!(state.take(7).is_some());
        assert!(!state.active());
        assert_eq!(state.shortcut_action().unwrap(), ShortcutAction::Start);
        assert!(state.with(7, |_| Ok(())).is_err());
    }

    #[test]
    fn 停止只进入收尾完成回调才进入完成() {
        assert_eq!(transition(Phase::Recording, Event::Stop), Some(Phase::Finalizing));
        assert_eq!(transition(Phase::Finalizing, Event::Stop), None);
        assert_eq!(transition(Phase::Finalizing, Event::Finished), Some(Phase::Preview));
        assert_eq!(transition(Phase::Starting, Event::Started), Some(Phase::Recording));
        assert_eq!(transition(Phase::Starting, Event::Finished), None);
    }

    #[test]
    fn 实际停止幂等冻结计时() {
        let state = RecordState::default();
        let mut session = test_session(PathBuf::from("test.mp4"));
        session.phase = Phase::Recording;
        session.started = Some(Instant::now() - std::time::Duration::from_secs(3));
        *state.session.lock().unwrap() = Some(session);
        assert!(state.request_stop(7).unwrap());
        assert!(!state.request_stop(7).unwrap());
        let elapsed = state.with(7, |s| {
            assert_eq!(s.phase, Phase::Finalizing);
            Ok(s.elapsed)
        }).unwrap();
        assert!(elapsed >= 3.0);
        assert_eq!(state.with(7, |s| Ok(s.elapsed)).unwrap(), elapsed);
    }

    #[test]
    fn 文件完成回调不把收尾等待算入录制计时且只生效一次() {
        let state = RecordState::default();
        let mut session = test_session(PathBuf::from("test.mp4"));
        session.phase = Phase::Recording;
        session.started = Some(Instant::now() - std::time::Duration::from_secs(3));
        *state.session.lock().unwrap() = Some(session);
        state.request_stop(7).unwrap();
        let elapsed = state.with(7, |s| {
            s.started = Some(Instant::now() - std::time::Duration::from_secs(13));
            Ok(s.elapsed)
        }).unwrap();
        state.finish(7, 3.0, None).unwrap();
        assert_eq!(state.with(7, |s| Ok(s.elapsed)).unwrap(), elapsed);
        assert_eq!(state.with(7, |s| Ok((s.phase, s.duration))).unwrap(), (Phase::Preview, 3.0));
        assert_eq!(state.finish(7, 20.0, None).unwrap(), None);
    }

    #[test]
    fn 每次声音默认关闭且点击圆圈开启() {
        let options = RecordOptions::default();
        assert!(!options.system_audio && !options.microphone && options.show_clicks);
    }

    #[test]
    fn 迟到原生回调拒绝旧会话() {
        assert!(!accept_callback(8, 7));
        assert!(accept_callback(8, 8));
    }

    #[test]
    fn 输出按缩放保持比例偶数尺寸并限制编码范围() {
        let rect = RecordRect { x: 1.0, y: 2.0, width: 301.0, height: 201.0 };
        assert_eq!(output_size(&rect, 2.0).unwrap(), (602, 402));
        let rect = RecordRect { width: 7680.0, height: 4320.0, ..rect };
        assert_eq!(output_size(&rect, 2.0).unwrap(), (3840, 2160));
        assert!(output_size(&rect, f64::NAN).is_err());
    }

    #[test]
    fn 本地坐标不受负坐标副屏影响并拒绝越界与假窗口() {
        let bounds = RecordRect { x: -1920.0, y: -300.0, width: 1920.0, height: 1080.0 };
        let mut target = RecordTarget { kind: "region".into(), display: 1, window: None, rect: RecordRect { x: 10.0, y: 20.0, width: 500.0, height: 300.0 } };
        assert!(validate_target(&target, &bounds).is_ok());
        target.rect.x = -1.0;
        assert!(validate_target(&target, &bounds).is_err());
        target.rect.x = 10.0;
        target.kind = "window".into();
        assert!(validate_target(&target, &bounds).is_err());
        target.window = Some(13);
        assert!(validate_target(&target, &bounds).is_ok());
    }

    #[test]
    fn 命令授权校验角色会话与完整标签() {
        assert!(authorized("record-select-7-0", 7, &["select"]));
        assert!(authorized("record-control-7", 7, &["control"]));
        for label in ["main", "plugin-x", "record-control-7", "record-select-8-0", "record-select-7-0-extra", "record-card-7"] {
            assert!(!authorized(label, 7, &["select"]), "拒绝窗口 {label}");
        }
    }

    #[test]
    fn 卡片只能读取自己的录像且关闭后失效() {
        let id = register_card(Path::new("/tmp/轻匣录屏 测试.mp4"));
        let label = format!("{CARD_PREFIX}{id}");
        assert_eq!(card_path(&label, id), Some(PathBuf::from("/tmp/轻匣录屏 测试.mp4")));
        assert_eq!(card_path(&format!("{CARD_PREFIX}{}", id + 1), id), None, "其他卡片不能读取");
        assert_eq!(card_path("record-control-1", id), None);
        remove_card(id);
        assert_eq!(card_path(&label, id), None);
    }

    #[test]
    fn 只有本次启用麦克风且未授权才请求权限() {
        assert!(!microphone_needed(false, false));
        assert!(!microphone_needed(true, true));
        assert!(microphone_needed(true, false));
    }
}
