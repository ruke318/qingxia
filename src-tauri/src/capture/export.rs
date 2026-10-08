//! 导出截图：覆盖窗按物理像素把选区合成为 PNG，宿主复制到剪贴板或保存为文件。
//!
//! 成功后结束会话并关闭覆盖窗；失败时会话回到标注阶段，保留选区与编辑内容，覆盖窗显示原因并可重试。
use std::{fs::OpenOptions, io::Write, path::PathBuf};

use tauri::{ipc::{InvokeBody, Request}, AppHandle, Manager, Webview};

use super::{overlay, CaptureState, Event};

/// 单张截图上限，防止异常数据占满内存。
const MAX_BYTES: usize = 256 * 1024 * 1024;
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Action {
    Copy,
    Save,
    Pin,
}

fn header<'a>(request: &'a Request<'_>, name: &str) -> Result<&'a str, String> {
    request.headers().get(name).and_then(|value| value.to_str().ok()).ok_or_else(|| format!("截图请求缺少 {name}"))
}

/// 覆盖窗导出选区。请求体为 PNG，请求头 `x-capture-session` 为会话编号，`x-capture-action` 为 `copy` 或 `save`。
/// 保存成功时返回文件路径。
#[tauri::command]
pub fn capture_export(app: AppHandle, webview: Webview, request: Request<'_>) -> Result<Option<String>, String> {
    let session: u64 = header(&request, "x-capture-session")?.parse().map_err(|_| "截图会话编号不正确")?;
    if overlay::session_of(webview.label()) != Some(session) { return Err("截图会话已失效".into()) }
    let action = match header(&request, "x-capture-action")? {
        "copy" => Action::Copy,
        "save" => Action::Save,
        "pin" => Action::Pin,
        _ => return Err("不支持的截图操作".into()),
    };
    let InvokeBody::Raw(png) = request.body() else { return Err("截图数据格式不正确".into()) };
    if !png.starts_with(PNG_SIGNATURE) { return Err("截图数据不是 PNG".into()) }
    if png.len() > MAX_BYTES { return Err("截图超过 256 MB，无法导出".into()) }

    let state = app.state::<CaptureState>();
    // 选区确定后才能导出；已在标注阶段（例如上次导出失败）时这一步无效，直接忽略。
    state.advance(session, Event::Selected)?;
    if !state.advance(session, Event::Export)? { return Err("截图会话已结束".into()) }
    if action == Action::Pin {
        // 先关闭覆盖窗，再在原位置打开贴图，贴图不会被覆盖窗挡住
        let rect = pin_rect(header(&request, "x-capture-rect")?)?;
        let screen = overlay::screen_of(webview.label()).unwrap_or(0);
        super::finish(&app, session, Event::Done, "已贴图")?;
        return super::pin::open(&app, png.clone(), screen, rect).map(|_| None);
    }
    let result = match action {
        Action::Copy => copy(png).map(|_| None),
        Action::Save => save(png).map(|path| Some(path.to_string_lossy().into_owned())),
        Action::Pin => unreachable!("贴图已在上方处理"),
    };
    match &result {
        Ok(path) => {
            let reason = match path { Some(path) => format!("已保存 {path}"), None => "已复制".into() };
            super::finish(&app, session, Event::Done, &reason)?;
        }
        Err(error) => {
            crate::diag!("截图：会话 {session} 导出失败：{error}");
            state.advance(session, Event::Fail)?;
        }
    }
    result
}

/// 同时写入 PNG 与 TIFF：部分应用只读取 TIFF。
#[cfg(target_os = "macos")]
pub(super) fn copy(png: &[u8]) -> Result<(), String> {
    use objc2::AllocAnyThread;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSPasteboard, NSPasteboardTypePNG, NSPasteboardTypeTIFF};
    use objc2_foundation::{NSData, NSDictionary};
    let data = NSData::from_vec(png.to_vec());
    let tiff = NSBitmapImageRep::initWithData(NSBitmapImageRep::alloc(), &data)
        .and_then(|bitmap| unsafe { bitmap.representationUsingType_properties(NSBitmapImageFileType::TIFF, &NSDictionary::new()) });
    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    if !pasteboard.setData_forType(Some(&data), unsafe { NSPasteboardTypePNG }) { return Err("写入剪贴板失败".into()) }
    if let Some(tiff) = tiff { pasteboard.setData_forType(Some(&tiff), unsafe { NSPasteboardTypeTIFF }); }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub(super) fn copy(_png: &[u8]) -> Result<(), String> {
    Err("当前平台不支持复制截图".into())
}

/// 解析选区 `x,y,宽,高`（逻辑坐标）。
fn pin_rect(text: &str) -> Result<(f64, f64, f64, f64), String> {
    let values: Vec<f64> = text.split(',').map(|part| part.trim().parse::<f64>()).collect::<Result<_, _>>().map_err(|_| "贴图位置不正确")?;
    match values.as_slice() {
        [x, y, width, height] if values.iter().all(|value| value.is_finite()) && *width > 0.0 && *height > 0.0 => Ok((*x, *y, *width, *height)),
        _ => Err("贴图位置不正确".into()),
    }
}

/// 文件名：`轻匣截图 2026-10-08 21.03.15.123.png`；重名时追加序号，不覆盖已有文件。
fn file_name(stamp: &str, attempt: u32) -> String {
    if attempt == 0 { format!("轻匣截图 {stamp}.png") } else { format!("轻匣截图 {stamp} {}.png", attempt + 1) }
}

fn save(png: &[u8]) -> Result<PathBuf, String> {
    let directory = dirs::picture_dir().ok_or("找不到“图片”目录")?.join("轻匣截图");
    std::fs::create_dir_all(&directory).map_err(|error| format!("创建保存目录失败：{error}"))?;
    let stamp = crate::diag::timestamp().replace(':', ".");
    for attempt in 0..100 {
        let path = directory.join(file_name(&stamp, attempt));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                if let Err(error) = file.write_all(png).and_then(|_| file.sync_all()) {
                    let _ = std::fs::remove_file(&path);
                    return Err(format!("保存截图失败：{error}"));
                }
                return Ok(path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("保存截图失败：{error}")),
        }
    }
    Err("同名截图过多，无法保存".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 贴图位置解析() {
        assert_eq!(pin_rect("10,20.5,300,200").unwrap(), (10.0, 20.5, 300.0, 200.0));
        assert!(pin_rect("10,20,0,200").is_err());
        assert!(pin_rect("10,20,300").is_err());
        assert!(pin_rect("a,b,c,d").is_err());
    }

    #[test]
    fn 文件名带时间且重名追加序号() {
        assert_eq!(file_name("2026-10-08 21.03.15.123", 0), "轻匣截图 2026-10-08 21.03.15.123.png");
        assert_eq!(file_name("2026-10-08 21.03.15.123", 1), "轻匣截图 2026-10-08 21.03.15.123 2.png");
        assert!(!crate::diag::timestamp().replace(':', ".").contains(':'), "文件名中不能有冒号");
    }
}
