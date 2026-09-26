#[cfg(target_os = "macos")]
mod native;

use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::{atomic::{AtomicIsize, AtomicU64, Ordering}, Mutex};
use tauri::{AppHandle, Manager};
use crate::plugins::CallError;

const MAX_ITEMS: usize = 200;
const MAX_TOTAL_BYTES: usize = 128 * 1024 * 1024;
const MAX_ITEM_BYTES: usize = 20 * 1024 * 1024;

pub struct ClipboardState {
    last_change: AtomicIsize,
    revision: AtomicU64,
    notice: Mutex<Option<String>>,
}
impl Default for ClipboardState {
    fn default() -> Self { Self { last_change: AtomicIsize::new(-1), revision: AtomicU64::new(1), notice: Mutex::new(None) } }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Kind { Text, Image, File }
impl Kind {
    fn name(self) -> &'static str { match self { Self::Text => "text", Self::Image => "image", Self::File => "file" } }
}

#[derive(Clone)]
pub(super) struct Capture {
    kind: Kind,
    data: Vec<u8>,
    preview: String,
    thumbnail: Vec<u8>,
    width: u32,
    height: u32,
}
impl Capture {
    fn text(text: String) -> Result<Self, String> {
        if text.len() > 1024 * 1024 { return Err("文本超过 1 MB，未加入历史".into()) }
        let preview = text.chars().take(800).collect();
        Ok(Self { kind: Kind::Text, data: text.into_bytes(), preview, thumbnail: vec![], width: 0, height: 0 })
    }
    fn files(paths: Vec<String>) -> Result<Self, String> {
        if paths.is_empty() || paths.len() > 100 || paths.iter().any(|path| !std::path::Path::new(path).is_absolute()) {
            return Err("文件记录须包含 1 至 100 个绝对路径".into());
        }
        let preview = paths.iter().map(|path| std::path::Path::new(path).file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| path.clone())).collect::<Vec<_>>().join("、");
        let data = serde_json::to_vec(&paths).map_err(|_| "无法记录文件路径")?;
        Ok(Self { kind: Kind::File, data, preview, thumbnail: vec![], width: 0, height: 0 })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    id: i64,
    kind: String,
    preview: String,
    created_at: i64,
    bytes: usize,
    width: u32,
    height: u32,
    thumbnail: Option<String>,
    files: Vec<String>,
}

#[derive(Default, Serialize)]
pub struct Counts { text: usize, image: usize, file: usize }

#[derive(Serialize)]
pub struct Snapshot {
    revision: u64,
    items: Option<Vec<Record>>,
    counts: Counts,
    notice: Option<String>,
}

fn now() -> i64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64 }

fn create_table(database: &Connection) -> Result<(), String> {
    database.execute_batch("CREATE TABLE IF NOT EXISTS clipboard_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE,
        data BLOB NOT NULL, preview TEXT NOT NULL, thumbnail BLOB NOT NULL,
        width INTEGER NOT NULL, height INTEGER NOT NULL, created_at INTEGER NOT NULL, bytes INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS clipboard_history_recent ON clipboard_history(created_at DESC, id DESC);")
        .map_err(|_| "初始化剪贴板历史失败".into())
}

fn record(database: &mut Connection, capture: Capture, timestamp: i64) -> Result<(), String> {
    let bytes = capture.data.len() + capture.thumbnail.len();
    if bytes > MAX_ITEM_BYTES { return Err("单条剪贴板内容超过 20 MB，未加入历史".into()) }
    let mut hash = Sha256::new();
    hash.update(capture.kind.name()); hash.update(&capture.data);
    let fingerprint = format!("{:x}", hash.finalize());
    let transaction = database.transaction().map_err(|_| "无法保存剪贴板历史")?;
    transaction.execute("INSERT INTO clipboard_history(kind,fingerprint,data,preview,thumbnail,width,height,created_at,bytes)
        VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(fingerprint) DO UPDATE SET created_at=MAX(created_at,excluded.created_at)",
        params![capture.kind.name(), fingerprint, capture.data, capture.preview, capture.thumbnail, capture.width, capture.height, timestamp, bytes])
        .map_err(|_| "保存剪贴板历史失败")?;
    let expired = {
        let mut query = transaction.prepare("SELECT id,bytes FROM clipboard_history ORDER BY created_at DESC,id DESC").map_err(|_| "读取剪贴板容量失败")?;
        let rows = query.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, usize>(1)?))).map_err(|_| "读取剪贴板容量失败")?;
        let mut total = 0;
        let mut expired = vec![];
        for (index, row) in rows.enumerate() {
            let (id, bytes) = row.map_err(|_| "读取剪贴板容量失败")?;
            total += bytes;
            if index >= MAX_ITEMS || total > MAX_TOTAL_BYTES { expired.push(id); }
        }
        expired
    };
    for id in expired { transaction.execute("DELETE FROM clipboard_history WHERE id=?1", [id]).map_err(|_| "清理过期剪贴板记录失败")?; }
    transaction.commit().map_err(|_| "提交剪贴板历史失败".into())
}

pub fn initialize(app: &AppHandle) -> Result<(), String> {
    {
        let state = app.state::<crate::AppState>();
        let mut database = state.database.lock().map_err(|_| "剪贴板数据库不可用")?;
        create_table(&database)?;
        let transaction = database.transaction().map_err(|_| "初始化剪贴板设置失败")?;
        let first = transaction.execute("INSERT OR IGNORE INTO settings(key,value) VALUES('clipboard:initialized','true')", []).map_err(|_| "初始化剪贴板设置失败")?;
        if first > 0 {
            transaction.execute("INSERT OR IGNORE INTO settings(key,value) VALUES('plugin_shortcut:clipboard-history:open','Alt+Shift+V')", []).map_err(|_| "初始化剪贴板快捷键失败")?;
        }
        transaction.commit().map_err(|_| "保存剪贴板设置失败")?;
    }
    app.manage(ClipboardState::default());
    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                if !crate::plugins::has_enabled_permission(&handle, "clipboard.history") { continue }
                let app = handle.clone();
                let (send, receive) = tokio::sync::oneshot::channel();
                if handle.run_on_main_thread(move || {
                    let state = app.state::<ClipboardState>();
                    let result = native::capture_changed(&state.last_change);
                    let _ = send.send((now(), result));
                }).is_err() { break }
                let Ok((timestamp, captured)) = receive.await else { break };
                if !crate::plugins::has_enabled_permission(&handle, "clipboard.history") { continue }
                let outcome = match captured {
                    Ok(Some(capture)) => {
                        let state = handle.state::<crate::AppState>();
                        let result = state.database.lock().map_err(|_| "剪贴板数据库不可用".to_string())
                            .and_then(|mut database| record(&mut database, capture, timestamp));
                        if result.is_ok() { handle.state::<ClipboardState>().revision.fetch_add(1, Ordering::SeqCst); }
                        result
                    }
                    Ok(None) => continue,
                    Err(error) => Err(error),
                };
                if let Ok(mut notice) = handle.state::<ClipboardState>().notice.lock() { *notice = outcome.err(); }
            }
        });
    }
    Ok(())
}

pub fn list(app: &AppHandle, kind: Option<Kind>, since: Option<u64>) -> Result<Snapshot, String> {
    let state = app.state::<crate::AppState>();
    let database = state.database.lock().map_err(|_| "剪贴板数据库不可用")?;
    let clipboard = app.state::<ClipboardState>();
    let revision = clipboard.revision.load(Ordering::SeqCst);
    let mut counts = Counts::default();
    let mut query = database.prepare("SELECT kind,COUNT(*) FROM clipboard_history GROUP BY kind").map_err(|_| "读取历史数量失败")?;
    let rows = query.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, usize>(1)?))).map_err(|_| "读取历史数量失败")?;
    for row in rows {
        let (kind, count) = row.map_err(|_| "读取历史数量失败")?;
        match kind.as_str() { "text" => counts.text = count, "image" => counts.image = count, "file" => counts.file = count, _ => {} }
    }
    let items = if since == Some(revision) { None } else {
        let mut query = database.prepare("SELECT id,kind,preview,created_at,bytes,width,height,thumbnail,CASE WHEN kind='file' THEN data ELSE X'' END FROM clipboard_history WHERE (?1 IS NULL OR kind=?1) ORDER BY created_at DESC,id DESC LIMIT 200").map_err(|_| "读取剪贴板历史失败")?;
        let rows = query.query_map([kind.map(Kind::name)], |row| {
            let thumbnail: Vec<u8> = row.get(7)?;
            let data: Vec<u8> = row.get(8)?;
            Ok(Record { id: row.get(0)?, kind: row.get(1)?, preview: row.get(2)?, created_at: row.get(3)?, bytes: row.get(4)?, width: row.get(5)?, height: row.get(6)?,
                thumbnail: (!thumbnail.is_empty()).then(|| format!("data:image/png;base64,{}", STANDARD.encode(thumbnail))),
                files: if data.is_empty() { vec![] } else { serde_json::from_slice(&data).unwrap_or_default() },
            })
        }).map_err(|_| "读取剪贴板历史失败")?;
        Some(rows.collect::<Result<Vec<_>, _>>().map_err(|_| "读取剪贴板记录失败")?)
    };
    let notice = clipboard.notice.lock().map_err(|_| "剪贴板状态不可用")?.clone();
    Ok(Snapshot { revision, items, counts, notice })
}

fn load_record(database: &Connection, id: i64) -> Result<(String, Vec<u8>), CallError> {
    database.query_row("SELECT kind,data FROM clipboard_history WHERE id=?1", [id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?)))
        .optional().map_err(|_| "读取复制内容失败")?.ok_or_else(|| CallError::new("not_found", "记录已经过期，请选择其他记录"))
}

pub async fn copy(app: &AppHandle, id: i64) -> Result<(), CallError> {
    let (kind, data) = {
        let state = app.state::<crate::AppState>();
        let database = state.database.lock().map_err(|_| "剪贴板数据库不可用")?;
        load_record(&database, id)?
    };
    let handle = app.clone();
    let (send, receive) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        #[cfg(target_os = "macos")]
        let result = native::write_history(&kind, &data).map(|change| { handle.state::<ClipboardState>().last_change.store(change, Ordering::SeqCst); });
        #[cfg(not(target_os = "macos"))]
        let result: Result<(), CallError> = { let _ = (handle, kind, data); Err("当前仅支持 macOS 剪贴板".into()) };
        let _ = send.send(result);
    }).map_err(|_| "调度剪贴板复制失败")?;
    receive.await.map_err(|_| "复制操作中断")??;
    let state = app.state::<crate::AppState>();
    state.database.lock().map_err(|_| "剪贴板数据库不可用")?.execute("UPDATE clipboard_history SET created_at=?1 WHERE id=?2", params![now(), id]).map_err(|_| "更新剪贴板顺序失败")?;
    app.state::<ClipboardState>().revision.fetch_add(1, Ordering::SeqCst);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn database() -> Connection { let db = Connection::open_in_memory().unwrap(); create_table(&db).unwrap(); db }
    #[test]
    fn 文本保留中文空白且重复内容只更新顺序() {
        let mut db = database();
        let text = " 中文\n\t内容 ";
        record(&mut db, Capture::text(text.into()).unwrap(), 1).unwrap();
        record(&mut db, Capture::text("第二条".into()).unwrap(), 2).unwrap();
        record(&mut db, Capture::text(text.into()).unwrap(), 3).unwrap();
        assert_eq!(db.query_row("SELECT COUNT(*) FROM clipboard_history", [], |row| row.get::<_, usize>(0)).unwrap(), 2);
        assert_eq!(db.query_row("SELECT data FROM clipboard_history ORDER BY created_at DESC LIMIT 1", [], |row| row.get::<_, Vec<u8>>(0)).unwrap(), text.as_bytes());
    }
    #[test]
    fn 历史数量有界且保留最近记录() {
        let mut db = database();
        for index in 0..205 { record(&mut db, Capture::text(format!("记录{index}")).unwrap(), index).unwrap(); }
        assert_eq!(db.query_row("SELECT COUNT(*) FROM clipboard_history", [], |row| row.get::<_, usize>(0)).unwrap(), 200);
        assert_eq!(db.query_row("SELECT MIN(created_at) FROM clipboard_history", [], |row| row.get::<_, i64>(0)).unwrap(), 5);
    }
    #[test]
    fn 文件保留多个中文和特殊字符路径且不读取文件内容() {
        let paths = vec!["/不存在/中文 #1.txt".into(), "/测试/目录".into()];
        let capture = Capture::files(paths.clone()).unwrap();
        assert_eq!(serde_json::from_slice::<Vec<String>>(&capture.data).unwrap(), paths);
        assert!(Capture::files(vec!["相对路径".into()]).is_err());
        assert!(Capture::files(vec![]).is_err());
        assert!(Capture::text("字".repeat(400_000)).is_err());
    }
    #[test]
    fn 图片历史总容量受限且超大单项不入库() {
        let mut db = database();
        for index in 0..9 {
            let capture = Capture { kind: Kind::Image, data: vec![index as u8; 16 * 1024 * 1024], preview: "测试图片".into(), thumbnail: vec![], width: 100, height: 100 };
            record(&mut db, capture, index).unwrap();
        }
        let bytes = db.query_row("SELECT SUM(bytes) FROM clipboard_history", [], |row| row.get::<_, usize>(0)).unwrap();
        assert!(bytes <= MAX_TOTAL_BYTES);
        assert_eq!(db.query_row("SELECT MIN(created_at) FROM clipboard_history", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        let too_large = Capture { kind: Kind::Image, data: vec![0; MAX_ITEM_BYTES + 1], preview: String::new(), thumbnail: vec![], width: 1, height: 1 };
        assert!(record(&mut db, too_large, 10).unwrap_err().contains("20 MB"));
    }
    #[test]
    fn 复制已过期的记录返回未找到() {
        let mut db = database();
        record(&mut db, Capture::text("保留".into()).unwrap(), 1).unwrap();
        let id = db.query_row("SELECT id FROM clipboard_history", [], |row| row.get::<_, i64>(0)).unwrap();
        assert_eq!(load_record(&db, id).unwrap(), ("text".to_string(), "保留".as_bytes().to_vec()));
        let missing = load_record(&db, id + 1).unwrap_err();
        assert_eq!((missing.code, missing.message.as_str()), ("not_found", "记录已经过期，请选择其他记录"));
    }
}
