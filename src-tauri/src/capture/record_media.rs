//! 仅静音录制在原生双终结后重封装尾段，失败保留原文件。
use std::path::Path;
use super::record::RecordOptions;

pub fn silent(options: &RecordOptions) -> bool { !options.system_audio && !options.microphone }
fn normalize_file(path: &Path, duration: f64, normalize: impl FnOnce(&Path, &Path, f64) -> Result<bool, String>) -> Result<(), String> {
    let staged = path.with_extension("normalizing.mp4");
    let result = normalize(path, &staged, duration).and_then(|changed| {
        if changed {
            std::fs::File::open(&staged).and_then(|f| f.sync_all()).map_err(|e| format!("同步静音录像失败：{e}"))?;
            std::fs::rename(&staged, path).map_err(|e| format!("替换静音录像失败：{e}"))?;
        }
        Ok(())
    });
    let _ = std::fs::remove_file(staged);
    result
}

#[cfg(target_os = "macos")]
pub fn finalize(path: &Path, duration: f64) -> Result<(), String> {
    use std::{ffi::{CString, CStr}, os::unix::ffi::OsStrExt};
    extern "C" { fn qingbox_normalize_silent(source: *const std::ffi::c_char, destination: *const std::ffi::c_char, seconds: f64, message: *mut std::ffi::c_char, capacity: usize) -> i32; }
    normalize_file(path, duration, |source, destination, seconds| {
        let source = CString::new(source.as_os_str().as_bytes()).map_err(|_| "录像路径无效")?;
        let destination = CString::new(destination.as_os_str().as_bytes()).map_err(|_| "录像输出路径无效")?;
        let mut message = [0 as std::ffi::c_char; 1024];
        match unsafe { qingbox_normalize_silent(source.as_ptr(), destination.as_ptr(), seconds, message.as_mut_ptr(), message.len()) } {
            0 => Ok(false), 1 => Ok(true), _ => Err(unsafe { CStr::from_ptr(message.as_ptr()) }.to_string_lossy().into_owned()),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    fn fixture() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("qingbox-media-test-{}-{}.mp4", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        std::fs::write(&path, "原始录像".as_bytes()).unwrap(); path
    }
    #[test] fn 后处理成功原子替换缓存且移除中间文件() {
        let path = fixture();
        normalize_file(&path, 3.0, |source, destination, duration| {
            assert_eq!(std::fs::read(source).unwrap(), "原始录像".as_bytes()); assert_eq!(duration, 3.0);
            std::fs::write(destination, "延长后的录像".as_bytes()).unwrap(); Ok(true)
        }).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), "延长后的录像".as_bytes()); assert!(!path.with_extension("normalizing.mp4").exists()); std::fs::remove_file(path).unwrap();
    }
    #[test] fn 原生失败和原子替换失败均保留原文件并清理中间文件() {
        for failed_native in [true, false] {
            let path = fixture();
            let result = normalize_file(&path, 3.0, |_, staged, _| { if failed_native { std::fs::write(staged, "未完成文件".as_bytes()).unwrap(); Err("封装失败".into()) } else { Ok(true) } });
            assert!(result.is_err()); assert_eq!(std::fs::read(&path).unwrap(), "原始录像".as_bytes()); assert!(!path.with_extension("normalizing.mp4").exists()); std::fs::remove_file(path).unwrap();
        }
    }
    #[test] fn 已覆盖目标时长的原文件跳过重封装并逐字节保留() {
        let path = fixture(); normalize_file(&path, 3.0, |_, _, _| Ok(false)).unwrap(); assert_eq!(std::fs::read(&path).unwrap(), "原始录像".as_bytes()); std::fs::remove_file(path).unwrap();
    }
    #[test] fn 任一声音开启均保留系统原始媒体() {
        assert!(silent(&RecordOptions::default()));
        for (system_audio, microphone) in [(true, false), (false, true), (true, true)] { assert!(!silent(&RecordOptions { system_audio, microphone, show_clicks: true })); }
    }
}
