use crate::contracts::QueryResponse;

#[cfg(target_os = "macos")]
mod spotlight;
#[cfg(target_os = "macos")]
mod filenames;

#[cfg(target_os = "macos")]
use {
    std::{
        sync::{Arc, Mutex as StdMutex, OnceLock},
        time::Duration,
    },
    tokio::{
        sync::{watch, Mutex, OwnedMutexGuard},
        time::{sleep_until, Instant},
    },
};

#[cfg(target_os = "macos")]
struct SearchCoordinator {
    order: StdMutex<RequestOrder>,
    latest: watch::Sender<u64>,
    active: Arc<Mutex<()>>,
}

#[cfg(target_os = "macos")]
#[derive(Default)]
struct RequestOrder {
    session: u64,
    request_id: Option<u64>,
    generation: u64,
}

#[cfg(target_os = "macos")]
impl SearchCoordinator {
    fn new() -> Self {
        Self {
            order: StdMutex::new(RequestOrder::default()),
            latest: watch::channel(0).0,
            active: Arc::new(Mutex::new(())),
        }
    }

    fn open_session(&self) -> u64 {
        let mut order = self.order.lock().expect("搜索请求顺序锁已中毒");
        order.session += 1;
        order.request_id = None;
        order.generation += 1;
        self.latest.send_replace(order.generation);
        order.session
    }

    fn begin(&self, session: u64, request_id: u64) -> Option<(u64, watch::Receiver<u64>)> {
        let mut order = self.order.lock().expect("搜索请求顺序锁已中毒");
        // 会话只由初始化命令切换；旧请求晚到不能激活旧会话或取消较新的请求。
        if session == 0
            || session != order.session
            || order.request_id.is_some_and(|id| request_id <= id)
        {
            return None;
        }
        order.request_id = Some(request_id);
        order.generation += 1;
        let receiver = self.latest.subscribe();
        self.latest.send_replace(order.generation);
        Some((order.generation, receiver))
    }
}

#[cfg(target_os = "macos")]
static SEARCHES: OnceLock<SearchCoordinator> = OnceLock::new();

pub fn begin_search_session() -> u64 {
    #[cfg(target_os = "macos")]
    {
        SEARCHES.get_or_init(SearchCoordinator::new).open_session()
    }
    #[cfg(not(target_os = "macos"))]
    {
        0
    }
}

pub async fn search_files(
    request_id: u64,
    query_session: u64,
    query: String,
    limit: usize,
) -> Result<QueryResponse, String> {
    #[cfg(target_os = "macos")]
    {
        let coordinator = SEARCHES.get_or_init(SearchCoordinator::new);
        let empty = || QueryResponse {
            request_id,
            items: Vec::new(),
            notice: None,
        };
        let Some((generation, mut receiver)) = coordinator.begin(query_session, request_id) else {
            return Ok(empty());
        };
        let deadline = Instant::now() + Duration::from_secs(4);
        if query.trim().is_empty() {
            return Ok(empty());
        }
        #[cfg(debug_assertions)]
        trace_query(&query, "收到查询", serde_json::json!({
            "请求": request_id,
            "会话": query_session,
            "字符": query.chars().map(|value| format!("U+{:04X}", value as u32)).collect::<Vec<_>>(),
        }));
        let result = async {
            let active = tokio::select! {
                biased;
                _ = cancelled(&mut receiver, generation) => return Err(SearchError::Cancelled),
                _ = sleep_until(deadline) => return Err(SearchError::TimedOut),
                guard = coordinator.active.clone().lock_owned() => guard,
            };
            let term = query.trim().to_string();
            let worker_receiver = receiver.clone();
            let worker = spawn_active_worker(active, move || {
                let limit = limit.clamp(1, 50);
                let unavailable =
                    prepare_search_directories(generation, &worker_receiver, deadline)?;
                let ((mut items, truncated), (local, partial)) = std::thread::scope(|scope| {
                    let filenames = scope.spawn(|| filenames::search(
                        &term, limit + 1, search_directories().into_iter().filter_map(|(_, path)| path),
                        generation, &worker_receiver, deadline.min(Instant::now() + Duration::from_millis(500)),
                    ));
                    let indexed = spotlight::search(&term, limit, generation, &worker_receiver, deadline);
                    let local = filenames.join().map_err(|_| SearchError::Failed("文件名检索工作线程失败".into()))?;
                    Ok::<_, SearchError>((indexed?, local?))
                })?;
                #[cfg(debug_assertions)]
                trace_query(&term, "补充文件名检索", serde_json::json!({ "匹配数量": local.len(), "未完整遍历": partial }));
                items.extend(local);
                let (items, truncated) = spotlight::sort_results(&term, items, limit, truncated);
                Ok((items, truncated, partial, unavailable))
            });
            tokio::select! {
                biased;
                _ = cancelled(&mut receiver, generation) => Err(SearchError::Cancelled),
                _ = sleep_until(deadline) => Err(SearchError::TimedOut),
                result = worker => result.map_err(|error| SearchError::Failed(format!("系统索引工作线程失败：{error}")))?,
            }
        }
        .await;
        match result {
            Ok((items, truncated, partial, unavailable)) => {
                let mut notice = if truncated {
                    format!(
                        "已显示前 {} 项，请缩小关键词",
                        items.len()
                    )
                } else if items.is_empty() {
                    "没有找到匹配项；已查询系统索引及桌面、文稿、下载的文件名".to_string()
                } else {
                    "范围：系统索引及桌面、文稿、下载的文件名".to_string()
                };
                if partial && !truncated {
                    notice.push_str("；部分目录未完成检索，可输入目录路径继续查找");
                }
                if !unavailable.is_empty() {
                    notice.push_str(&format!(
                        "；无法访问{}，请检查系统设置中的轻匣文件与文件夹权限",
                        unavailable.join("、")
                    ));
                }
                Ok(QueryResponse {
                    request_id,
                    items,
                    notice: Some(notice),
                })
            }
            Err(SearchError::Cancelled) => Ok(empty()),
            Err(SearchError::TimedOut) => Err("文件搜索超时，请缩小关键词后重试".to_string()),
            Err(SearchError::Failed(message)) => Err(message),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (query_session, query, limit);
        Ok(QueryResponse {
            request_id,
            items: Vec::new(),
            notice: Some("当前平台暂未接入文件索引".to_string()),
        })
    }
}

#[cfg(target_os = "macos")]
fn search_directories() -> [(&'static str, Option<std::path::PathBuf>); 3] {
    [("桌面", dirs::desktop_dir()), ("文稿", dirs::document_dir()), ("下载", dirs::download_dir())]
}

#[cfg(target_os = "macos")]
fn prepare_search_directories(
    generation: u64,
    receiver: &watch::Receiver<u64>,
    deadline: Instant,
) -> Result<Vec<&'static str>, SearchError> {
    let mut unavailable = Vec::new();
    for (label, path) in search_directories() {
        if *receiver.borrow() != generation {
            return Err(SearchError::Cancelled);
        }
        if Instant::now() >= deadline {
            return Err(SearchError::TimedOut);
        }
        let Some(path) = path else { continue };
        // 在后台实际打开目录，建立当前进程的访问资格；只读索引不会触发这一步。
        // 不遍历内容，也不缓存授权状态，用户修改权限后下一次搜索即可重新检查。
        if let Err(error) = std::fs::read_dir(path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                unavailable.push(label);
            }
        }
    }
    Ok(unavailable)
}

#[cfg(all(target_os = "macos", debug_assertions))]
fn trace_query(query: &str, phase: &str, details: serde_json::Value) {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let path = std::env::temp_dir().join(format!("qingbox-search-{}.jsonl", std::process::id()));
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(path)
    {
        let record = serde_json::json!({ "查询": query, "阶段": phase, "详情": details });
        let _ = writeln!(file, "{record}");
    }
}

#[cfg(target_os = "macos")]
fn spawn_active_worker<R: Send + 'static>(
    active: OwnedMutexGuard<()>,
    worker: impl FnOnce() -> R + Send + 'static,
) -> tauri::async_runtime::JoinHandle<R> {
    tauri::async_runtime::spawn_blocking(move || {
        // 许可随工作线程持有，外层等待被中止也不能启动重叠的原生查询。
        let _active = active;
        worker()
    })
}

#[cfg(target_os = "macos")]
#[derive(Debug)]
enum SearchError {
    Cancelled,
    TimedOut,
    Failed(String),
}

#[cfg(target_os = "macos")]
async fn cancelled(receiver: &mut watch::Receiver<u64>, generation: u64) {
    loop {
        let is_current = *receiver.borrow_and_update() == generation;
        if !is_current || receiver.changed().await.is_err() {
            return;
        }
    }
}

#[cfg(target_os = "macos")]
fn filename_expression(query: &str) -> String {
    let mut escaped = String::new();
    for character in query.chars() {
        if matches!(character, '\\' | '"' | '*' | '?') {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    format!("(kMDItemFSName == \"*{escaped}*\"cd) || (kMDItemDisplayName == \"*{escaped}*\"cd)")
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use crate::contracts::FileResult;
    use std::path::Path;

    static REAL_QUERIES: Mutex<()> = Mutex::const_new(());

    #[tokio::test]
    #[ignore = "需要本机文稿中的国大机构信息文件，仅在漏搜修复验收时运行"]
    async fn 文稿未被系统文件索引收录时仍能搜索国大机构() {
        let _serial = REAL_QUERIES.lock().await;
        let expected = dirs::document_dir().unwrap().join("国大机构信息.xlsx");
        assert!(expected.is_file(), "验收文件应真实存在");
        let session = begin_search_session();
        for (index, term) in ["国大机构", "国大", "国大机构信息.xlsx", "国大机构"].iter().enumerate() {
            let started = Instant::now();
            let response = search_files(index as u64 + 1, session, (*term).into(), 50).await.expect("文件搜索应成功");
            assert!(response.items.iter().any(|item| Path::new(&item.path) == expected && item.kind == "file"), "搜索 {term} 应包含文稿中的真实文件");
            assert!(response.items.len() <= 50);
            println!("搜索 {term}：结果 {} 项，耗时 {} 毫秒", response.items.len(), started.elapsed().as_millis());
        }
    }

    fn assert_wechat_applications(items: &[FileResult]) {
        for application in ["WeChat.app", "企业微信.app", "WeType.app"] {
            assert!(
                items.iter().any(|item| item.kind == "application"
                    && Path::new(&item.path)
                        .file_name()
                        .is_some_and(|name| name == application)),
                "微信搜索缺少预期应用：{application}"
            );
        }
        let wechat = items
            .iter()
            .find(|item| {
                Path::new(&item.path)
                    .file_name()
                    .is_some_and(|name| name == "WeChat.app")
            })
            .expect("微信应用应出现在结果中");
        assert_eq!(wechat.name, "微信", "微信应显示本地化名称");
        assert_eq!(wechat.parent, "/Applications", "应用路径不得带 Data 卷别名");
    }

    #[test]
    fn 文件名中的查询语法按字面转义() {
        assert_eq!(
            filename_expression("-a\"*?\\'"),
            "(kMDItemFSName == \"*-a\\\"\\*\\?\\\\'*\"cd) || (kMDItemDisplayName == \"*-a\\\"\\*\\?\\\\'*\"cd)"
        );
    }

    #[tokio::test]
    async fn 延迟执行的旧请求不会取消正在等待结果的新请求() {
        let coordinator = SearchCoordinator::new();
        let session = coordinator.open_session();
        let (generation, mut receiver) = coordinator.begin(session, 2).expect("新请求应被接纳");
        let (send_result, result) = tokio::sync::oneshot::channel();
        let pending = async {
            tokio::select! {
                biased;
                _ = cancelled(&mut receiver, generation) => panic!("新请求不得被旧请求取消"),
                value = result => value.expect("新结果传递失败"),
            }
        };
        let late_request = async {
            tokio::task::yield_now().await;
            assert!(
                coordinator.begin(session, 1).is_none(),
                "延迟的旧请求必须被拒绝"
            );
            send_result.send("新结果").expect("发送新结果失败");
        };
        let (value, _) = tokio::join!(pending, late_request);
        assert_eq!(value, "新结果");
    }

    #[tokio::test]
    async fn 新请求会通知旧查询取消() {
        let coordinator = SearchCoordinator::new();
        let session = coordinator.open_session();
        let (generation, mut receiver) = coordinator.begin(session, 1).expect("初始请求应被接纳");
        let (_, current) = coordinator.begin(session, 2).expect("新请求应被接纳");
        tokio::time::timeout(Duration::from_secs(1), cancelled(&mut receiver, generation))
            .await
            .expect("旧查询必须收到取消通知");
        assert_ne!(*current.borrow(), generation);
    }

    #[test]
    fn 新页面会话允许编号重置且旧会话晚到不能抢占() {
        let coordinator = SearchCoordinator::new();
        let old_session = coordinator.open_session();
        coordinator
            .begin(old_session, 100)
            .expect("旧会话请求应被接纳");
        let new_session = coordinator.open_session();
        let (generation, receiver) = coordinator
            .begin(new_session, 1)
            .expect("新页面应允许从一开始编号");
        assert!(
            coordinator.begin(old_session, 101).is_none(),
            "旧页面不得抢占新会话"
        );
        assert!(
            coordinator.begin(new_session, 1).is_none(),
            "重复请求不得取消正在运行的同号请求"
        );
        assert_eq!(*receiver.borrow(), generation);
    }

    #[tokio::test]
    async fn 外层等待被中止后工作线程完成前仍持有活动许可() {
        let active = Arc::new(Mutex::new(()));
        let permit = active.clone().lock_owned().await;
        let (started, observed) = tokio::sync::oneshot::channel();
        let (finish, finished) = std::sync::mpsc::channel();
        let waiter = tokio::spawn(async move {
            spawn_active_worker(permit, move || {
                started.send(()).expect("通知工作线程开始失败");
                finished.recv().expect("接收工作线程完成信号失败");
            })
            .await
        });
        observed.await.expect("等待工作线程启动失败");
        waiter.abort();
        let _ = waiter.await;
        assert!(
            active.try_lock().is_err(),
            "中止外层等待不能提前释放原生活动许可"
        );
        finish.send(()).expect("发送工作线程完成信号失败");
        let _permit = tokio::time::timeout(Duration::from_secs(2), active.lock())
            .await
            .expect("工作线程结束后必须释放许可");
    }

    #[tokio::test]
    #[ignore = "需要访问本机真实 Spotlight 索引，仅在原生搜索验收时运行"]
    async fn 原生索引不复用结果连续二十五轮中文查询均返回() {
        let _serial = REAL_QUERIES.lock().await;
        let session = begin_search_session();
        for request_id in 1..=25 {
            let started = Instant::now();
            let response = search_files(request_id, session, "微信".to_string(), 50)
                .await
                .expect("真实系统索引重复查询失败");
            assert_wechat_applications(&response.items);
            println!(
                "原生索引第 {request_id} 轮：结果 {} 项，耗时 {} 毫秒",
                response.items.len(),
                started.elapsed().as_millis()
            );
        }
        let enze = search_files(26, session, "恩泽".to_string(), 50)
            .await
            .expect("恩泽查询失败");
        assert!(enze.items.len() >= 2 && enze.items.len() <= 50, "恩泽应包含目录和JSON文件，补充文件名后仍遵守上限");
        assert!(enze
            .items
            .iter()
            .any(|item| item.kind == "directory" && item.name.contains("恩泽")));
        assert!(enze.items.iter().any(|item| item.kind == "file"
            && item.name.contains("恩泽")
            && item.path.ends_with(".json")));
        let calculator = search_files(27, session, "计算器".to_string(), 50)
            .await
            .expect("计算器查询失败");
        assert!(
            calculator
                .items
                .iter()
                .any(|item| item.kind == "application" && item.path.ends_with("/Calculator.app")),
            "中文关键词应匹配系统计算器应用"
        );
    }

    #[tokio::test]
    #[ignore = "需要访问本机真实 Spotlight 索引，仅在原生取消恢复验收时运行"]
    async fn 原生连续取消与超时后中文查询仍可恢复() {
        let _serial = REAL_QUERIES.lock().await;
        let session = begin_search_session();
        let coordinator = SEARCHES.get().expect("搜索协调器应已初始化");
        for round in 0..5 {
            let request_id = round * 2 + 1;
            let old = tokio::spawn(search_files(request_id, session, "微信".to_string(), 50));
            tokio::time::timeout(Duration::from_secs(1), async {
                loop {
                    let accepted = coordinator
                        .order
                        .lock()
                        .expect("读取查询顺序失败")
                        .request_id
                        == Some(request_id);
                    if accepted && coordinator.active.try_lock().is_err() {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("旧查询应已经进入原生活动阶段");
            tokio::time::sleep(Duration::from_millis(20)).await;
            let fresh = search_files(request_id + 1, session, "微信".to_string(), 50)
                .await
                .expect("取消旧查询后新查询应恢复");
            let cancelled = old
                .await
                .expect("等待旧查询结束失败")
                .expect("旧查询应被正常取消");
            assert!(
                cancelled.items.is_empty() && cancelled.notice.is_none(),
                "旧微信查询应实际经过取消分支"
            );
            assert_wechat_applications(&fresh.items);
        }
        let (generation, receiver) = coordinator
            .begin(session, 11)
            .expect("超时测试请求应被接纳");
        let permit = coordinator.active.clone().lock_owned().await;
        let timeout_result = spawn_active_worker(permit, move || {
            spotlight::search(
                "微信",
                50,
                generation,
                &receiver,
                Instant::now() + Duration::from_millis(20),
            )
        })
        .await
        .expect("等待超时工作线程失败");
        assert!(matches!(timeout_result, Err(SearchError::TimedOut)));
        let recovered = search_files(12, session, "微信".to_string(), 50)
            .await
            .expect("超时后应恢复");
        assert_wechat_applications(&recovered.items);
    }

    #[tokio::test]
    #[ignore = "需要本机 Chrome 索引超过五十项，仅在原生结果限额验收时运行"]
    async fn 原生索引候选超过五十项时只返回五十并提示截断() {
        let _serial = REAL_QUERIES.lock().await;
        let session = begin_search_session();
        let started = Instant::now();
        let response = search_files(1, session, "Chrome".to_string(), 500)
            .await
            .expect("真实索引限额查询失败");
        assert_eq!(response.items.len(), 50);
        assert!(response
            .notice
            .as_deref()
            .is_some_and(|notice| notice.contains("前 50 项")));
        println!(
            "原生Chrome限额查询：结果 {} 项，耗时 {} 毫秒",
            response.items.len(),
            started.elapsed().as_millis()
        );
    }
}
