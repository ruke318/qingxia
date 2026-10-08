//! 诊断日志：记录唤起、收起与快捷键的关键步骤，用于排查“偶发唤不起”这类无法当场复现的问题。
//!
//! 写入 `~/Library/Logs/轻匣/qingbox.log`，超过 1 MB 时改名为 `qingbox.old.log` 后重新开始，最多保留两份。
//! 只记录步骤、窗口状态与应用标识，不记录搜索内容、剪贴板内容等用户数据。写入失败时静默忽略，不影响功能。
use std::{
    fs::OpenOptions,
    io::Write,
    path::PathBuf,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_BYTES: u64 = 1024 * 1024;
static WRITE: Mutex<()> = Mutex::new(());

fn directory() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join("Library/Logs/轻匣"))
}

/// 本地时间，精确到毫秒，如 `2026-10-08 21:03:15.123`。
pub(crate) fn timestamp() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    #[cfg(unix)]
    {
        let seconds = now.as_secs() as libc::time_t;
        let mut local: libc::tm = unsafe { std::mem::zeroed() };
        if !unsafe { libc::localtime_r(&seconds, &mut local) }.is_null() {
            return format!(
                "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03}",
                local.tm_year + 1900, local.tm_mon + 1, local.tm_mday, local.tm_hour, local.tm_min, local.tm_sec, now.subsec_millis()
            );
        }
    }
    format!("{}.{:03}", now.as_secs(), now.subsec_millis())
}

/// 追加一行日志，同时输出到标准错误，便于开发时查看。
pub fn log(message: &str) {
    eprintln!("{message}");
    let Ok(_write) = WRITE.lock() else { return };
    let Some(directory) = directory() else { return };
    if std::fs::create_dir_all(&directory).is_err() { return }
    let file = directory.join("qingbox.log");
    if std::fs::metadata(&file).is_ok_and(|metadata| metadata.len() > MAX_BYTES) {
        let _ = std::fs::rename(&file, directory.join("qingbox.old.log"));
    }
    if let Ok(mut output) = OpenOptions::new().create(true).append(true).open(&file) {
        let _ = writeln!(output, "{} {message}", timestamp());
    }
}

/// 以 `format!` 的写法记录一行诊断日志。
#[macro_export]
macro_rules! diag {
    ($($argument:tt)*) => { $crate::diag::log(&format!($($argument)*)) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 时间戳为本地时间并精确到毫秒() {
        let text = timestamp();
        // 形如 2026-10-08 21:03:15.123
        assert_eq!(text.len(), 23, "{text}");
        assert_eq!(&text[4..5], "-");
        assert_eq!(&text[10..11], " ");
        assert_eq!(&text[19..20], ".");
    }
}
