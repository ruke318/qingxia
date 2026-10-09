//! 录像文件：临时路径、录完自动保存到桌面、复制与移到废纸篓；视频资源只交给对应的录屏卡片读取。
use std::{path::{Path, PathBuf}, io::{Read, Seek, SeekFrom}};
use tauri::{AppHandle, Manager, http::{Request, Response}};

const RANGE_CHUNK: u64 = 1024 * 1024;
pub fn byte_range(header: &str, length: u64) -> Option<(u64, u64)> {
    if length == 0 { return None }
    let value = header.strip_prefix("bytes=")?;
    let (first, last) = value.split_once('-')?;
    let number = |text: &str| if !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()) { text.parse::<u64>().ok() } else { None };
    if first.is_empty() {
        let suffix = number(last)?; if suffix == 0 { return None }
        return Some((length.saturating_sub(suffix), length - 1));
    }
    let start = number(first)?;
    let end = if last.is_empty() { length - 1 } else { number(last)?.min(length - 1) };
    (start < length && start <= end).then_some((start, end))
}
pub fn temporary_path(app: &AppHandle, id: u64) -> Result<PathBuf, String> {
    let directory = app.path().app_cache_dir().map_err(|e| format!("无法取得录像缓存目录：{e}"))?.join("recordings");
    std::fs::create_dir_all(&directory).map_err(|e| format!("无法创建录像目录：{e}"))?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).map_err(|e| format!("无法设置录像目录权限：{e}"))?;
    }
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| "系统时间不正确")?.as_nanos();
    Ok(directory.join(format!("轻匣录屏-{stamp}-{id}.mp4")))
}
fn empty(status: u16) -> Response<Vec<u8>> {
    Response::builder().status(status).header("Cache-Control", "no-store").body(Vec::new()).expect("构造录像资源响应失败")
}
/// 资源路径 `/card/<卡片编号>.mp4`，只交给对应的卡片窗口。
pub fn serve(app: &AppHandle, label: &str, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let Some(id) = request.uri().path().strip_prefix("/card/").and_then(|s| s.strip_suffix(".mp4")).and_then(|s| s.parse::<u64>().ok()) else { return empty(404) };
    if app.get_webview(label).is_none() { return empty(403) }
    let Some(path) = super::record::card_path(label, id) else { return empty(403) };
    read(&path, &request)
}
fn read(path: &Path, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    if request.method() != "GET" && request.method() != "HEAD" { return empty(405) }
    let Ok(mut file) = std::fs::File::open(path) else { return empty(404) };
    let Ok(metadata) = file.metadata() else { return empty(500) };
    let length = metadata.len();
    let mut response = Response::builder().header("Content-Type", "video/mp4").header("Accept-Ranges", "bytes")
        .header("Cache-Control", "no-store").header("Access-Control-Allow-Origin", "*");
    let (start, end, partial) = if let Some(header) = request.headers().get("range") {
        let range = header.to_str().ok().and_then(|s| byte_range(s, length));
        let Some((start, end)) = range else {
            return response.status(416).header("Content-Range", format!("bytes */{length}")).body(Vec::new()).expect("构造录像范围错误失败");
        };
        let end = end.min(start.saturating_add(RANGE_CHUNK - 1));
        response = response.status(206).header("Content-Range", format!("bytes {start}-{end}/{length}"));
        (start, end, true)
    } else { response = response.status(200); (0, length.saturating_sub(1), false) };
    if !partial && request.method() == "GET" && length > RANGE_CHUNK {
        return response.status(206).header("Content-Range", format!("bytes 0-{}/{length}", RANGE_CHUNK - 1))
            .header("Content-Length", RANGE_CHUNK).body({
                let mut first = Vec::new();
                if file.take(RANGE_CHUNK).read_to_end(&mut first).is_err() { return empty(500) }
                first
            }).expect("构造录像首段响应失败");
    }
    let count = if length == 0 { 0 } else { end - start + 1 };
    response = response.header("Content-Length", count);
    if request.method() == "HEAD" { return response.body(Vec::new()).expect("构造录像头响应失败") }
    let mut body = Vec::new();
    if (partial && file.seek(SeekFrom::Start(start)).is_err()) || file.take(count).read_to_end(&mut body).is_err() { return empty(500) }
    response.body(body).expect("构造录像响应失败")
}
/// 录完自动保存到桌面：`轻匣录屏 年-月-日 时.分.秒.毫秒.mp4`，重名时追加序号，不覆盖已有文件。
pub fn store(source: &Path) -> Result<PathBuf, String> {
    let directory = dirs::desktop_dir().or_else(|| dirs::home_dir().map(|home| home.join("Desktop"))).ok_or("找不到桌面文件夹")?;
    store_in(source, &directory, &crate::diag::timestamp().replace(':', "."))
}

fn store_in(source: &Path, directory: &Path, stamp: &str) -> Result<PathBuf, String> {
    std::fs::create_dir_all(directory).map_err(|e| format!("无法访问保存目录：{e}"))?;
    for attempt in 0..100 {
        let name = if attempt == 0 { format!("轻匣录屏 {stamp}.mp4") } else { format!("轻匣录屏 {stamp} {}.mp4", attempt + 1) };
        let destination = directory.join(name);
        if destination.exists() { continue }
        return match std::fs::rename(source, &destination) {
            Ok(()) => Ok(destination),
            // 缓存目录与桌面不在同一磁盘时改为复制后删除
            Err(error) if error.raw_os_error() == Some(libc::EXDEV) => {
                let copied = (|| {
                    let mut target = std::fs::OpenOptions::new().create_new(true).write(true).open(&destination)?;
                    std::io::copy(&mut std::fs::File::open(source)?, &mut target)?;
                    target.sync_all()
                })();
                if let Err(error) = copied {
                    let _ = std::fs::remove_file(&destination);
                    return Err(format!("保存录像失败：{error}"));
                }
                let _ = std::fs::remove_file(source);
                Ok(destination)
            }
            Err(error) => Err(format!("保存录像失败：{error}")),
        };
    }
    Err("同名录像过多，无法保存".into())
}

/// 移到废纸篓，误删可以找回。
#[cfg(target_os = "macos")]
pub fn trash(path: &Path) -> Result<(), String> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};
    let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
    NSFileManager::defaultManager().trashItemAtURL_resultingItemURL_error(&url, None).map_err(|error| format!("删除录像失败：{}", error.localizedDescription()))
}

#[cfg(not(target_os = "macos"))]
pub fn trash(path: &Path) -> Result<(), String> {
    std::fs::remove_file(path).map_err(|error| format!("删除录像失败：{error}"))
}

#[cfg(target_os = "macos")]
pub fn copy(path: &Path) -> Result<(), String> {
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::{NSArray, NSURL, NSString};
    use objc2::runtime::ProtocolObject;
    let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
    let object = ProtocolObject::from_ref(&*url);
    let items = NSArray::from_slice(&[object]);
    let clipboard = NSPasteboard::generalPasteboard(); clipboard.clearContents();
    if clipboard.writeObjects(&items) { Ok(()) } else { Err("复制录像文件失败".into()) }
}
#[cfg(not(target_os = "macos"))]
pub fn copy(_path: &Path) -> Result<(), String> { Err("当前平台不支持复制录像".into()) }
#[cfg(test)]
mod tests {
 use super::*;
 fn fixture(name: &str) -> PathBuf {
  let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
  std::env::temp_dir().join(format!("qingbox-record-test-{name}-{stamp}"))
 }
 #[test] fn 大文件无范围请求也只读取首段且头请求不读取内容() {
  let path = fixture("range"); let file = std::fs::File::create(&path).unwrap(); file.set_len(RANGE_CHUNK * 3).unwrap();
  let request = Request::builder().body(Vec::new()).unwrap(); let response = read(&path, &request);
  assert_eq!(response.status(), 206); assert_eq!(response.body().len() as u64, RANGE_CHUNK);
  let request = Request::builder().method("HEAD").body(Vec::new()).unwrap(); let response = read(&path, &request);
  assert_eq!(response.status(), 200); assert!(response.body().is_empty());
  assert_eq!(response.headers()["content-length"], (RANGE_CHUNK * 3).to_string()); std::fs::remove_file(path).unwrap();
 }
 #[test] fn 范围响应实际内容与错误状态符合视频拖动读取() {
  let path = fixture("bytes"); std::fs::write(&path, b"0123456789").unwrap();
  let request = Request::builder().header("range", "bytes=2-5").body(Vec::new()).unwrap(); let response = read(&path, &request);
  assert_eq!(response.status(), 206); assert_eq!(response.headers()["content-range"], "bytes 2-5/10"); assert_eq!(response.body(), b"2345");
  let request = Request::builder().header("range", "bytes=10-").body(Vec::new()).unwrap(); let response = read(&path, &request);
  assert_eq!(response.status(), 416); assert_eq!(response.headers()["content-range"], "bytes */10"); std::fs::remove_file(path).unwrap();
 }
 #[test] fn 自动保存带时间命名且重名追加序号不覆盖() {
  let directory = fixture("movies"); let source = fixture("recording");
  std::fs::write(&source, b"first").unwrap();
  let first = store_in(&source, &directory, "2026-10-09 09.50.12.345").unwrap();
  assert_eq!(first.file_name().unwrap(), "轻匣录屏 2026-10-09 09.50.12.345.mp4"); assert!(!source.exists(), "保存后临时文件移走");
  std::fs::write(&source, b"second").unwrap();
  let second = store_in(&source, &directory, "2026-10-09 09.50.12.345").unwrap();
  assert_eq!(second.file_name().unwrap(), "轻匣录屏 2026-10-09 09.50.12.345 2.mp4");
  assert_eq!(std::fs::read(&first).unwrap(), b"first", "不能覆盖已有录像"); assert_eq!(std::fs::read(&second).unwrap(), b"second");
  std::fs::remove_dir_all(directory).unwrap();
 }

 #[test] fn 视频范围支持闭区间开放区间与后缀() {
  assert_eq!(byte_range("bytes=2-5", 10), Some((2, 5))); assert_eq!(byte_range("bytes=3-", 10), Some((3, 9))); assert_eq!(byte_range("bytes=-3", 10), Some((7, 9)));
 }
 #[test] fn 不可满足畸形和多范围请求拒绝() {
  for value in ["bytes=10-", "bytes=5-2", "bytes=-0", "bytes=0-1,4-5", "bytes=a-b"] { assert_eq!(byte_range(value, 10), None); }
  assert_eq!(byte_range("bytes=0-", 0), None);
 }
}
