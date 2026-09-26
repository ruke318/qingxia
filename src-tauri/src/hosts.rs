use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::{HashMap, HashSet}, fs::File, io::Read, net::IpAddr, path::Path};
use tauri::{AppHandle, Manager};
use crate::plugins::CallError;

const SYSTEM_PATH: &str = "/private/etc/hosts";
const BEGIN: &str = "# >>> QingBox hosts >>>";
const END: &str = "# <<< QingBox hosts <<<";
const MAX_BYTES: usize = 1024 * 1024;
static UPDATE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Group {
    pub id: String,
    pub name: String,
    pub content: String,
    pub enabled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    groups: Vec<Group>,
    system_hosts: String,
    version: String,
    synced: bool,
    notice: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SaveRequest {
    groups: Vec<Group>,
    version: String,
}

#[derive(Deserialize, Serialize)]
struct Pending {
    groups: Vec<Group>,
    after_hash: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct WriteRequest {
    groups: Vec<Group>,
    expected_hash: String,
}

fn hash(value: &[u8]) -> String { format!("{:x}", Sha256::digest(value)) }

fn read_text(path: &Path) -> Result<String, String> {
    let mut bytes = Vec::new();
    File::open(path).map_err(|_| "无法读取 hosts 文件")?.take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes).map_err(|_| "读取 hosts 文件失败")?;
    if bytes.len() > MAX_BYTES { return Err("hosts 文件不能超过 1 MB".into()) }
    String::from_utf8(bytes).map_err(|_| "hosts 文件不是有效的 UTF-8 文本".into())
}

fn managed_range(text: &str) -> Result<Option<std::ops::Range<usize>>, String> {
    let (mut start, mut end, mut offset) = (None, None, 0);
    for line in text.split_inclusive('\n') {
        let value = line.trim_end_matches(['\r', '\n']);
        if value == BEGIN {
            if start.is_some() || end.is_some() { return Err("系统 hosts 中轻匣管理标记重复或不完整，请先检查文件".into()) }
            start = Some(offset);
        }
        if value == END {
            if start.is_none() || end.is_some() { return Err("系统 hosts 中轻匣管理标记重复或不完整，请先检查文件".into()) }
            end = Some(offset + line.len());
        }
        offset += line.len();
    }
    match (start, end) {
        (None, None) => Ok(None),
        (Some(start), Some(end)) => Ok(Some(start..end)),
        _ => Err("系统 hosts 中轻匣管理标记不完整，请先检查文件".into()),
    }
}

fn entries(text: &str, name: &str) -> Result<Vec<(String, IpAddr)>, String> {
    let mut result = Vec::new();
    for (index, line) in text.lines().enumerate() {
        if line.contains(BEGIN) || line.contains(END) { return Err(format!("「{name}」不能包含轻匣管理标记")) }
        let line = line.split('#').next().unwrap_or("").trim();
        if line.is_empty() { continue }
        let parts: Vec<_> = line.split_whitespace().collect();
        let address = parts[0].parse::<IpAddr>().map_err(|_| format!("「{name}」第 {} 行不是有效的 IP 地址", index + 1))?;
        if parts.len() < 2 { return Err(format!("「{name}」第 {} 行缺少域名", index + 1)) }
        for host in &parts[1..] {
            if host.len() > 253 || !host.bytes().all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c)) || !host.bytes().any(|c| c.is_ascii_alphanumeric()) {
                return Err(format!("「{name}」第 {} 行的域名不正确：{host}", index + 1))
            }
            result.push((host.trim_end_matches('.').to_ascii_lowercase(), address));
        }
    }
    Ok(result)
}

fn merge(system: &str, groups: &[Group]) -> Result<String, String> {
    if groups.len() > 100 { return Err("分组不能超过 100 个".into()) }
    if groups.iter().map(|group| group.content.len()).sum::<usize>() > 256 * 1024 { return Err("分组内容总计不能超过 256 KB".into()) }
    let range = managed_range(system)?;
    let mut base = system.to_string();
    if let Some(range) = &range { base.replace_range(range.clone(), ""); }
    let mut addresses: HashMap<(String, bool), (IpAddr, String)> = HashMap::new();
    // 原有内容逐行读取用于冲突检查；无法识别的旧行仍原样保留。
    for line in base.lines() {
        if let Ok(items) = entries(line, "系统原有内容") {
            for (host, address) in items { addresses.insert((host, address.is_ipv4()), (address, "系统原有内容".into())); }
        }
    }
    let mut ids = HashSet::new();
    let mut block = String::new();
    for group in groups {
        if group.id.is_empty() || group.id.len() > 64 || !group.id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') || !ids.insert(&group.id) {
            return Err("分组标识不正确或重复".into())
        }
        if group.name.trim().is_empty() || group.name.chars().count() > 60 || group.name.chars().any(char::is_control) {
            return Err("分组名称须为 1 至 60 个字符，不能包含换行".into())
        }
        if group.content.contains('\0') { return Err(format!("「{}」包含无效字符", group.name)) }
        if !group.enabled { continue }
        let items = entries(&group.content, &group.name)?;
        for (host, address) in items {
            let key = (host.clone(), address.is_ipv4());
            if let Some((previous, source)) = addresses.get(&key) {
                if *previous != address { return Err(format!("域名 {host} 在「{source}」与「{}」指向不同 IP，未切换", group.name)) }
            }
            addresses.insert(key, (address, group.name.clone()));
        }
        block.push_str(&format!("# 分组：{}\n", group.name.trim()));
        block.push_str(group.content.trim_end_matches(['\r', '\n']));
        block.push('\n');
    }
    if block.is_empty() { return Ok(base) }
    let block = format!("{BEGIN}\n{block}{END}\n");
    // 首次放在文件开头，关闭全部分组后可逐字节还原没有结尾换行的原文件。
    base.insert_str(range.map_or(0, |range| range.start), &block);
    if base.len() > MAX_BYTES { return Err("合并后的 hosts 文件不能超过 1 MB".into()) }
    Ok(base)
}

fn setting(database: &Connection, key: &str) -> Result<Option<String>, String> {
    database.query_row("SELECT value FROM settings WHERE key=?1", [key], |row| row.get(0)).optional().map_err(|_| "读取 Hosts 配置失败".into())
}

fn store(database: &Connection, key: &str, value: &str) -> Result<(), String> {
    database.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, value])
        .map(|_| ()).map_err(|_| "保存 Hosts 配置失败".into())
}

fn snapshot(database: &mut Connection, system: String) -> Result<Snapshot, String> {
    if let Some(pending) = setting(database, "hosts:pending")? {
        let pending: Pending = serde_json::from_str(&pending).map_err(|_| "Hosts 待完成记录损坏")?;
        let transaction = database.transaction().map_err(|_| "无法恢复 Hosts 配置")?;
        // 写入完成后即使进程退出，下次也能按实际文件完成配置提交。
        if hash(system.as_bytes()) == pending.after_hash {
            store(&transaction, "hosts:groups", &serde_json::to_string(&pending.groups).map_err(|_| "无法恢复 Hosts 分组")?)?;
        }
        transaction.execute("DELETE FROM settings WHERE key='hosts:pending'", []).map_err(|_| "无法清理 Hosts 待完成记录")?;
        transaction.commit().map_err(|_| "无法恢复 Hosts 配置")?;
    }
    let saved = setting(database, "hosts:groups")?.unwrap_or_else(|| "[]".into());
    let groups: Vec<Group> = serde_json::from_str(&saved).map_err(|_| "Hosts 分组数据损坏")?;
    let synced = merge(&system, &groups).is_ok_and(|desired| desired == system);
    let version = hash(format!("{}:{saved}{system}", saved.len()).as_bytes());
    Ok(Snapshot { groups, system_hosts: system, version, synced, notice: None })
}

pub async fn get(app: &AppHandle) -> Result<Snapshot, CallError> {
    let _guard = UPDATE_LOCK.try_lock().map_err(|_| "正在应用 Hosts，请稍后再试")?;
    Ok(get_snapshot(app)?)
}

fn get_snapshot(app: &AppHandle) -> Result<Snapshot, String> {
    if !cfg!(target_os = "macos") { return Err("当前仅支持 macOS 的 Hosts 切换".into()) }
    let system = read_text(Path::new(SYSTEM_PATH))?;
    snapshot(&mut *app.state::<crate::AppState>().database.lock().map_err(|_| "配置数据库不可用")?, system)
}

pub async fn save(app: &AppHandle, token: &str, request: SaveRequest) -> Result<Snapshot, CallError> {
    let _guard = UPDATE_LOCK.try_lock().map_err(|_| "正在应用 Hosts，请勿重复操作")?;
    let before = get_snapshot(app)?;
    check_version(&before, &request.version)?;
    let desired = desired_system(&before, &request.groups)?;
    let changed = desired != before.system_hosts;
    let pending = Pending { groups: request.groups.clone(), after_hash: hash(desired.as_bytes()) };
    let encoded = serde_json::to_string(&pending).map_err(|_| "无法生成 Hosts 配置")?;
    store(&*app.state::<crate::AppState>().database.lock().map_err(|_| "配置数据库不可用")?, "hosts:pending", &encoded)?;
    let mut notice = "分组已保存".to_string();
    if changed {
        let write = WriteRequest { groups: request.groups, expected_hash: hash(before.system_hosts.as_bytes()) };
        // 授权和文件操作在后台执行；不持有数据库锁，也不存储管理员密码。
        // 优先免密写入；只有需要系统授权框时才收起面板，授权结束后恢复插件。
        let handle = app.clone();
        let hide_for_prompt = move || -> Result<(), CallError> {
            if let Some(window) = handle.get_window("main") { window.hide().map_err(|_| "无法显示系统授权，请重试")?; }
            Ok(())
        };
        let outcome = tauri::async_runtime::spawn_blocking(move || apply_write(&write, hide_for_prompt)).await;
        if outcome.as_ref().map_or(true, |(_, prompted)| *prompted) { crate::plugins::restore_after_authorization(app, token); }
        let result = outcome
            .map_err(|_| "Hosts 写入任务中断，请刷新检查实际状态")?.0;
        match result {
            Ok(warning) => notice = warning.unwrap_or_else(|| "已应用，原 hosts 已自动备份".into()),
            Err(error) => {
                // 以系统实际文件为准：取消时保持旧配置，写入后中断则恢复新配置。
                let current = get_snapshot(app)?;
                if hash(current.system_hosts.as_bytes()) != pending.after_hash { return Err(write_failure(error, &before.system_hosts, &current.system_hosts)) }
                notice = "Hosts 已写入，请检查系统内容".into();
            }
        }
    }
    let mut after = get_snapshot(app)?;
    if after.groups != pending.groups { return Err(CallError::new("invalid_params", "保存期间系统 hosts 已发生变化，请刷新后重试；分组状态未提交")) }
    after.notice = Some(notice);
    Ok(after)
}

/// 版本过期说明插件读取后系统 hosts 或分组已被修改，属于请求参数 `version` 失效。
fn check_version(before: &Snapshot, version: &str) -> Result<(), CallError> {
    if before.version == version { Ok(()) } else { Err(CallError::new("invalid_params", "系统 hosts 或分组已发生变化，请刷新后再保存；本次未写入")) }
}

/// 写入失败且系统文件未达到目标：若文件已不同于保存前，说明授权期间被外部修改，按版本冲突返回；
/// 用户取消以及其他失败保持原错误码，消息不变。
fn write_failure(error: CallError, before: &str, current: &str) -> CallError {
    if error.code != "cancelled" && before != current { CallError::new("invalid_params", error.message) } else { error }
}

/// 系统授权脚本失败：`-128` 是系统授权对话框的“用户已取消”错误号，其余均为内部错误。
fn authorization_error(stderr: &str) -> CallError {
    if stderr.contains("(-128)") { return CallError::new("cancelled", "已取消系统授权，分组启用状态未改变") }
    CallError::from(format!("应用 Hosts 失败：{}", stderr.trim()))
}

fn desired_system(before: &Snapshot, groups: &[Group]) -> Result<String, CallError> {
    // 系统原文的管理标记损坏不是参数问题；其余合并错误都来自提交的分组内容。
    managed_range(&before.system_hosts)?;
    let merged = merge(&before.system_hosts, groups).map_err(|message| CallError::new("invalid_params", message))?;
    // 仅修改未启用分组时只保存本地配置；启用分组的名称或内容变化也要写入系统。
    let enabled_unchanged = before.groups.iter().filter(|group| group.enabled).eq(groups.iter().filter(|group| group.enabled));
    Ok(if enabled_unchanged { before.system_hosts.clone() } else { merged })
}

/// 免密写入程序的固定位置：由 root 拥有，普通用户不能修改。
const HELPER_PATH: &str = "/Library/PrivilegedHelperTools/local.qingbox.hosts-helper";
/// 免密规则文件；文件名不含点，sudo 才会读取。
const SUDOERS_PATH: &str = "/private/etc/sudoers.d/qingbox-hosts";
/// 待校验的规则临时文件；文件名含点，sudo 不会读取未经校验的内容。
const SUDOERS_TEMP: &str = "/private/etc/sudoers.d/.qingbox-hosts.tmp";

#[cfg(any(target_os = "macos", test))]
fn shell_quote(value: &str) -> String { format!("'{}'", value.replace('\'', "'\\''")) }

/// 免密规则：只允许该用户以 root 运行固定位置的写入程序，且必须带 Hosts 写入标记。
#[cfg(any(target_os = "macos", test))]
fn sudoers_rule(uid: u32) -> String {
    format!("#{uid} ALL = (root) NOPASSWD: {HELPER_PATH} --qingbox-apply-hosts *\n")
}

/// 管理员授权下执行的命令：先尽力安装免密写入程序与规则（规则经 visudo 校验后才启用；
/// 任一步失败都不影响本次写入，下次仍会请求授权），再用当前程序完成本次写入。
/// 安装步骤的输出全部丢弃，标准输出只保留写入程序的结果。
#[cfg(any(target_os = "macos", test))]
fn privileged_command(executable: &str, payload: &str, rule: &str) -> String {
    let executable = shell_quote(executable);
    let install = format!(
        "/bin/mkdir -p /Library/PrivilegedHelperTools && /usr/bin/install -o root -g wheel -m 755 {executable} {HELPER_PATH} && /usr/bin/install -o root -g wheel -m 440 {} {SUDOERS_TEMP} && /usr/sbin/visudo -cf {SUDOERS_TEMP} && /bin/mv -f {SUDOERS_TEMP} {SUDOERS_PATH}",
        shell_quote(rule),
    );
    format!("{{ {install}; /bin/rm -f {SUDOERS_TEMP}; }} >/dev/null 2>&1; {executable} --qingbox-apply-hosts {}", shell_quote(payload))
}

/// 已安装的写入程序由 root 拥有、他人不可写，且与当前程序完全一致时才可免密使用；
/// 应用升级后二者不同，会重新请求授权并更新写入程序。
#[cfg(target_os = "macos")]
fn helper_current(executable: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let Ok(metadata) = std::fs::symlink_metadata(HELPER_PATH) else { return false };
    if !metadata.is_file() || metadata.uid() != 0 || metadata.mode() & 0o022 != 0 { return false }
    matches!((std::fs::read(HELPER_PATH), std::fs::read(executable)), (Ok(helper), Ok(current)) if helper == current)
}

/// 免密写入；写入程序不是最新或免密规则未生效时返回 None，改走管理员授权。
#[cfg(target_os = "macos")]
fn write_without_password(payload: &Path, executable: &Path) -> Option<Result<Option<String>, CallError>> {
    if !helper_current(executable) { return None }
    let args = [HELPER_PATH, "--qingbox-apply-hosts", payload.to_str()?];
    let allowed = std::process::Command::new("/usr/bin/sudo").args(["-n", "-l"]).args(args).output().ok()?.status.success();
    if !allowed { return None }
    Some(match std::process::Command::new("/usr/bin/sudo").arg("-n").args(args).output() {
        Err(_) => Err("无法启动 Hosts 写入程序".into()),
        Ok(output) if !output.status.success() => Err(CallError::from(format!("应用 Hosts 失败：{}", String::from_utf8_lossy(&output.stderr).trim()))),
        Ok(output) => serde_json::from_slice::<Option<String>>(&output.stdout).map_err(|_| "无法确认 Hosts 写入结果，请刷新检查".into()),
    })
}

/// 写入系统 hosts，返回写入结果以及是否弹出过系统授权框。
/// 需要授权时先调用 `before_prompt`（收起面板，让授权框可见）。
#[cfg(target_os = "macos")]
fn apply_write(request: &WriteRequest, before_prompt: impl FnOnce() -> Result<(), CallError>) -> (Result<Option<String>, CallError>, bool) {
    use std::{io::Write, os::unix::fs::{DirBuilderExt, OpenOptionsExt}};
    let mut prompted = false;
    let result = (|| -> Result<Option<String>, CallError> {
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| "无法读取系统时间")?.as_nanos();
        let directory = std::env::temp_dir().join(format!("qingbox-hosts-{}-{nonce}", std::process::id()));
        std::fs::DirBuilder::new().mode(0o700).create(&directory).map_err(|_| "无法创建 Hosts 授权请求")?;
        let result = (|| -> Result<Option<String>, CallError> {
            let payload = directory.join("request.json");
            let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&payload).map_err(|_| "无法保存 Hosts 授权请求")?;
            file.write_all(&serde_json::to_vec(request).map_err(|_| "无法生成 Hosts 授权请求")?).map_err(|_| "无法保存 Hosts 授权请求")?;
            file.sync_all().map_err(|_| "无法保存 Hosts 授权请求")?;
            let executable = std::env::current_exe().map_err(|_| "无法定位 Hosts 写入程序")?;
            if let Some(result) = write_without_password(&payload, &executable) { return result }
            let rule = directory.join("sudoers");
            std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&rule)
                .and_then(|mut file| file.write_all(sudoers_rule(unsafe { libc::getuid() }).as_bytes()))
                .map_err(|_| "无法生成 Hosts 免密规则")?;
            before_prompt()?;
            prompted = true;
            let command = privileged_command(&executable.to_string_lossy(), &payload.to_string_lossy(), &rule.to_string_lossy());
            let literal = command.replace('\\', "\\\\").replace('"', "\\\"");
            let script = format!("do shell script \"{literal}\" with administrator privileges");
            let output = std::process::Command::new("/usr/bin/osascript").args(["-e", &script]).output().map_err(|_| "无法启动系统授权")?;
            if !output.status.success() { return Err(authorization_error(&String::from_utf8_lossy(&output.stderr))) }
            serde_json::from_slice::<Option<String>>(&output.stdout).map_err(|_| "无法确认 Hosts 写入结果，请刷新检查".into())
        })();
        let _ = std::fs::remove_dir_all(directory);
        result
    })();
    (result, prompted)
}

#[cfg(not(target_os = "macos"))]
fn apply_write(_: &WriteRequest, _: impl FnOnce() -> Result<(), CallError>) -> (Result<Option<String>, CallError>, bool) { (Err("当前平台尚未接入 Hosts 写入".into()), false) }

pub fn run_helper() -> Option<i32> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new("--qingbox-apply-hosts")) { return None }
    #[cfg(target_os = "macos")]
    let result = (|| -> Result<Option<String>, String> {
        if unsafe { libc::geteuid() } != 0 { return Err("写入系统 hosts 需要管理员授权".into()) }
        let path = args.next().ok_or("缺少 Hosts 授权请求")?;
        if args.next().is_some() { return Err("Hosts 写入参数不正确".into()) }
        let request: WriteRequest = serde_json::from_str(&read_text(Path::new(&path))?).map_err(|_| "Hosts 授权请求不正确")?;
        let target = Path::new(SYSTEM_PATH);
        use std::os::unix::fs::MetadataExt;
        if std::fs::symlink_metadata(target).map_err(|_| "无法检查系统 hosts")?.uid() != 0 { return Err("系统 hosts 的所有者必须是 root，本次未写入".into()) }
        let original = read_text(target)?;
        if hash(original.as_bytes()) != request.expected_hash { return Err("授权期间系统 hosts 已被修改，本次未写入，请刷新后重试".into()) }
        let desired = merge(&original, &request.groups)?;
        if desired == original { return Ok(None) }
        atomic_replace(target, &original, &desired)?;
        let cache = std::process::Command::new("/usr/bin/dscacheutil").arg("-flushcache").status();
        let responder = std::process::Command::new("/usr/bin/killall").args(["-HUP", "mDNSResponder"]).status();
        Ok((!cache.is_ok_and(|status| status.success()) || !responder.is_ok_and(|status| status.success()))
            .then(|| "Hosts 已写入并备份，但 DNS 缓存刷新失败，部分应用可能需要重新打开".into()))
    })();
    #[cfg(not(target_os = "macos"))]
    let result: Result<Option<String>, String> = Err("当前平台尚未接入 Hosts 写入".into());
    Some(match result {
        Ok(warning) => { println!("{}", serde_json::to_string(&warning).unwrap_or_else(|_| "null".into())); 0 }
        Err(error) => { eprintln!("{error}"); 1 }
    })
}

#[cfg(unix)]
fn atomic_replace(target: &Path, original: &str, desired: &str) -> Result<(), String> {
    use std::{fs::{self, OpenOptions}, io::Write, os::{fd::AsRawFd, unix::fs::{MetadataExt, OpenOptionsExt, DirBuilderExt}}};
    let parent = target.parent().ok_or("hosts 路径不正确")?;
    let metadata = fs::symlink_metadata(target).map_err(|_| "无法读取 hosts 文件信息")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.nlink() != 1 { return Err("hosts 必须是普通文件，不能是链接".into()) }
    let lock = OpenOptions::new().write(true).create(true).truncate(false).mode(0o600).custom_flags(libc::O_NOFOLLOW).open(parent.join(".qingbox-hosts.lock")).map_err(|_| "无法锁定 hosts 写入")?;
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 { return Err("另一个 Hosts 写入仍在进行".into()) }
    if read_text(target)? != original { return Err("系统 hosts 已被修改，本次未写入".into()) }
    let backups = parent.join(".qingbox-hosts-backups");
    match fs::DirBuilder::new().mode(0o700).create(&backups) {
        Ok(()) => {}, Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {},
        Err(_) => return Err("无法创建 hosts 备份目录，本次未写入".into()),
    }
    let backup_meta = fs::symlink_metadata(&backups).map_err(|_| "无法检查备份目录")?;
    if !backup_meta.is_dir() || backup_meta.file_type().is_symlink() || backup_meta.uid() != metadata.uid() || backup_meta.mode() & 0o022 != 0 { return Err("hosts 备份目录权限不正确，本次未写入".into()) }
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| "无法读取系统时间")?.as_nanos();
    match OpenOptions::new().write(true).create_new(true).mode(0o600).open(backups.join("original.bak")) {
        Ok(mut first) => {
            if first.write_all(original.as_bytes()).and_then(|_| first.sync_all()).is_err() {
                let _ = fs::remove_file(backups.join("original.bak"));
                return Err("无法保存首次 hosts 备份，本次未写入".into())
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {},
        Err(_) => return Err("无法保存首次 hosts 备份，本次未写入".into()),
    }
    let backup_path = backups.join(format!("hosts-{nonce}-{}.bak", std::process::id()));
    let mut backup = OpenOptions::new().write(true).create_new(true).mode(0o600).open(&backup_path).map_err(|_| "无法备份 hosts，本次未写入")?;
    if backup.write_all(original.as_bytes()).and_then(|_| backup.sync_all()).is_err() {
        let _ = fs::remove_file(backup_path);
        return Err("无法完成 hosts 备份，本次未写入".into())
    }
    prune_backups(&backups)?;
    let stage = parent.join(format!(".qingbox-hosts-{nonce}-{}.tmp", std::process::id()));
    let result = (|| {
        let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600).open(&stage).map_err(|_| "无法创建 hosts 暂存文件")?;
        file.write_all(desired.as_bytes()).map_err(|_| "写入 hosts 暂存文件失败")?;
        if unsafe { libc::fchown(file.as_raw_fd(), metadata.uid(), metadata.gid()) } != 0 || unsafe { libc::fchmod(file.as_raw_fd(), (metadata.mode() & 0o777) as libc::mode_t) } != 0 { return Err("无法保留 hosts 原有权限，本次未写入".into()) }
        file.sync_all().map_err(|_| "无法保存 hosts 暂存文件")?;
        if read_text(target)? != original { return Err("系统 hosts 已被修改，本次未写入".into()) }
        fs::rename(&stage, target).map_err(|_| "替换 hosts 失败，原文件保持不变")?;
        if let Ok(directory) = File::open(parent) { let _ = directory.sync_all(); }
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(stage); }
    result
}

#[cfg(unix)]
fn prune_backups(directory: &Path) -> Result<(), String> {
    let mut backups = Vec::new();
    for entry in std::fs::read_dir(directory).map_err(|_| "无法检查 hosts 备份数量")? {
        let entry = entry.map_err(|_| "无法检查 hosts 备份")?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(value) = name.strip_prefix("hosts-").and_then(|name| name.strip_suffix(".bak")) else { continue };
        let Some((time, process)) = value.split_once('-') else { continue };
        let (Ok(time), Ok(_)) = (time.parse::<u128>(), process.parse::<u32>()) else { continue };
        if entry.file_type().map_err(|_| "无法检查 hosts 备份类型")?.is_file() { backups.push((time, entry.path())); }
    }
    backups.sort_by_key(|(time, _)| *time);
    let remove = backups.len().saturating_sub(5);
    for (_, path) in backups.into_iter().take(remove) {
        std::fs::remove_file(path).map_err(|_| "清理旧 hosts 备份失败，本次未写入")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {

    #[test]
    fn 免密规则只放行固定写入程序与写入标记() {
        assert_eq!(sudoers_rule(501), "#501 ALL = (root) NOPASSWD: /Library/PrivilegedHelperTools/local.qingbox.hosts-helper --qingbox-apply-hosts *\n");
    }

    #[test]
    fn 授权命令先校验安装规则再写入且只输出写入结果() {
        let command = privileged_command("/Applications/轻匣.app/Contents/MacOS/qingbox", "/tmp/a b'c/request.json", "/tmp/rule");
        let (install, write) = command.split_once(">/dev/null 2>&1; ").expect("安装步骤的输出应被丢弃");
        assert!(install.contains("/usr/sbin/visudo -cf /private/etc/sudoers.d/.qingbox-hosts.tmp && /bin/mv -f /private/etc/sudoers.d/.qingbox-hosts.tmp /private/etc/sudoers.d/qingbox-hosts"), "规则必须先校验再启用");
        assert!(install.trim_end().ends_with("/bin/rm -f /private/etc/sudoers.d/.qingbox-hosts.tmp; }"), "临时规则必须清理");
        assert_eq!(write, "'/Applications/轻匣.app/Contents/MacOS/qingbox' --qingbox-apply-hosts '/tmp/a b'\\''c/request.json'");
    }

    use super::*;

    fn group(id: &str, content: &str, enabled: bool) -> Group {
        Group { id: id.into(), name: format!("分组 {id}"), content: content.into(), enabled }
    }

    #[test]
    fn 多组可同时启用并单独关闭且还原原始字节() {
        let original = "# 原有配置\r\n127.0.0.1 localhost\r\n::1 localhost";
        let mut groups = vec![group("a", "10.0.0.1 a.test # 中文注释\n", true), group("b", "10.0.0.2 b.test alias.test", true)];
        let first = merge(original, &groups).unwrap();
        assert!(first.ends_with(original));
        assert!(first.contains("a.test") && first.contains("b.test"));
        assert_eq!(merge(&first, &groups).unwrap(), first, "重复应用不能重复添加管理段");
        groups[0].enabled = false;
        let second = merge(&first, &groups).unwrap();
        assert!(!second.contains("a.test") && second.contains("b.test"));
        groups[1].enabled = false;
        assert_eq!(merge(&second, &groups).unwrap(), original);
    }

    #[test]
    fn 同域名同协议地址冲突被拒绝而双栈允许() {
        let mut groups = vec![group("a", "10.0.0.1 A.test", true), group("b", "10.0.0.2 a.test.", true)];
        assert!(merge("", &groups).unwrap_err().contains("指向不同 IP"));
        groups[1].enabled = false;
        assert!(merge("", &groups).is_ok());
        groups[1] = group("b", "::1 a.test", true);
        assert!(merge("", &groups).is_ok(), "允许同域名 IPv4 和 IPv6 并存");
        assert!(merge("10.0.0.3 a.test\n", &groups).unwrap_err().contains("系统原有内容"));
    }

    #[test]
    fn 分组格式标记和大小均校验() {
        for content in ["无效IP a.test", "127.0.0.1", "127.0.0.1 bad/host", BEGIN, "# 注释\0"] {
            assert!(merge("", &[group("a", content, true)]).is_err(), "应拒绝无效内容：{content}");
        }
        assert!(merge("", &[group("a", "", false), group("a", "", false)]).is_err());
        assert!(merge("", &[group("a", &"#".repeat(256 * 1024 + 1), false)]).is_err());
        for original in [BEGIN.to_string(), END.to_string(), format!("{BEGIN}\n{BEGIN}\n{END}\n"), format!("{BEGIN}\n{END}\n{BEGIN}\n{END}\n")] {
            assert!(merge(&original, &[]).is_err(), "标记破损时不能猜测替换范围");
        }
    }

    #[test]
    fn 替换管理段保持前后未知内容不变() {
        let original = format!("# 前面\n{BEGIN}\n10.0.0.1 old.test\n{END}\n# 后面\n旧格式保留");
        let next = merge(&original, &[group("a", "10.0.0.2 new.test", true)]).unwrap();
        assert!(next.starts_with("# 前面\n"));
        assert!(next.ends_with("# 后面\n旧格式保留"));
        assert!(!next.contains("old.test"));
    }

    fn database() -> Connection {
        let database = Connection::open_in_memory().unwrap();
        database.execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);").unwrap();
        database
    }

    #[test]
    fn 写入完成后中断可恢复配置而取消不改变开关() {
        let mut database = database();
        let groups = vec![group("a", "10.0.0.1 a.test", true)];
        let desired = merge("# 原有", &groups).unwrap();
        let pending = serde_json::to_string(&Pending { groups: groups.clone(), after_hash: hash(desired.as_bytes()) }).unwrap();
        store(&database, "hosts:pending", &pending).unwrap();
        let cancelled = snapshot(&mut database, "# 原有".into()).unwrap();
        assert!(cancelled.groups.is_empty(), "没有写入时不能提交启用状态");
        store(&database, "hosts:pending", &pending).unwrap();
        let completed = snapshot(&mut database, desired).unwrap();
        assert_eq!(completed.groups, groups);
        assert!(completed.synced);
        assert!(setting(&database, "hosts:pending").unwrap().is_none());
    }

    #[test]
    fn 系统变化或分组变化都会使旧版本失效() {
        let mut database = database();
        let first = snapshot(&mut database, "# 初始".into()).unwrap();
        let changed = snapshot(&mut database, "# 外部修改".into()).unwrap();
        assert_ne!(first.version, changed.version);
        store(&database, "hosts:groups", &serde_json::to_string(&vec![group("a", "", false)]).unwrap()).unwrap();
        let saved = snapshot(&mut database, "# 初始".into()).unwrap();
        assert_ne!(first.version, saved.version);
    }

    #[test]
    fn 已启用分组保存后应用新内容而停用分组仅保存本地() {
        let active = group("a", "10.0.0.1 a.test", true);
        let before = Snapshot { groups: vec![active.clone()], system_hosts: merge("# 系统", &[active.clone()]).unwrap(), version: String::new(), synced: true, notice: None };
        let mut edited = active.clone();
        edited.content = "10.0.0.2 a.test".into();
        edited.name = "修改后的名称".into();
        let updated = desired_system(&before, &[edited.clone()]).unwrap();
        assert!(updated.contains("10.0.0.2 a.test") && updated.contains("修改后的名称"));
        assert!(!updated.contains("10.0.0.1 a.test"));
        let mut invalid = edited.clone();
        invalid.content = "尚未输入完成".into();
        assert!(desired_system(&before, &[invalid]).unwrap_err().message.contains("IP 地址"));
        edited.enabled = false;
        assert_eq!(desired_system(&before, &[edited]).unwrap(), "# 系统");
        let mut disabled = active;
        disabled.enabled = false;
        let system = desired_system(&before, &[disabled.clone()]).unwrap();
        assert_eq!(system, "# 系统");
        let before = Snapshot { groups: vec![disabled.clone()], system_hosts: system, version: String::new(), synced: true, notice: None };
        disabled.content = "尚未输入完成".into();
        assert_eq!(desired_system(&before, &[disabled.clone()]).unwrap(), "# 系统");
        disabled.enabled = true;
        assert!(desired_system(&before, &[disabled]).unwrap_err().message.contains("IP 地址"));
    }

    #[test]
    fn 宿主服务错误按语义给出错误码且保留中文消息() {
        let snapshot = |system: &str, version: &str| Snapshot { groups: vec![], system_hosts: system.into(), version: version.into(), synced: true, notice: None };
        // 版本过期：读取后被外部修改。
        assert!(check_version(&snapshot("# 系统", "v1"), "v1").is_ok());
        let stale = check_version(&snapshot("# 系统", "v2"), "v1").unwrap_err();
        assert_eq!((stale.code, stale.message.as_str()), ("invalid_params", "系统 hosts 或分组已发生变化，请刷新后再保存；本次未写入"));
        // 用户在系统授权对话框中取消。
        let cancelled = authorization_error("0:120: execution error: User canceled. (-128)\n");
        assert_eq!((cancelled.code, cancelled.message.as_str()), ("cancelled", "已取消系统授权，分组启用状态未改变"));
        let failed = authorization_error("0:120: execution error: 系统 hosts 的所有者必须是 root，本次未写入 (1)\n");
        assert_eq!(failed.code, "internal");
        assert_eq!(failed.message, "应用 Hosts 失败：0:120: execution error: 系统 hosts 的所有者必须是 root，本次未写入 (1)");
        // 授权期间文件被外部修改：写入程序拒绝写入，系统原文已不同于保存前。
        let changed = write_failure(authorization_error("授权期间系统 hosts 已被修改 (1)"), "# 原有", "# 外部修改");
        assert_eq!((changed.code, changed.message.as_str()), ("invalid_params", "应用 Hosts 失败：授权期间系统 hosts 已被修改 (1)"));
        assert_eq!(write_failure(authorization_error("其他失败 (1)"), "# 原有", "# 原有").code, "internal");
        assert_eq!(write_failure(authorization_error("User canceled. (-128)"), "# 原有", "# 外部修改").code, "cancelled", "用户取消优先于外部修改");
        // 分组内容不合法属于参数错误；系统原文管理标记损坏属于内部错误。
        let invalid = desired_system(&snapshot("# 系统", ""), &[group("a", "无效IP a.test", true)]).unwrap_err();
        assert_eq!(invalid.code, "invalid_params");
        assert!(invalid.message.contains("IP 地址"));
        let broken = desired_system(&snapshot(BEGIN, ""), &[group("a", "10.0.0.1 a.test", true)]).unwrap_err();
        assert_eq!((broken.code, broken.message.as_str()), ("internal", "系统 hosts 中轻匣管理标记不完整，请先检查文件"));
    }

    #[test]
    fn 仅编辑停用分组时不重新覆盖外部改变的系统管理段() {
        let groups = vec![group("a", "10.0.0.1 a.test", true), group("b", "", false)];
        let before = Snapshot { groups: groups.clone(), system_hosts: "# 系统中已被外部移除管理段".into(), version: String::new(), synced: false, notice: None };
        let mut edited = groups;
        edited[1].content = "10.0.0.2 b.test".into();
        assert_eq!(desired_system(&before, &edited).unwrap(), before.system_hosts);
    }

    #[cfg(unix)]
    struct Fixture(std::path::PathBuf);
    #[cfg(unix)]
    impl Fixture {
        fn new() -> Self {
            let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let path = std::env::temp_dir().join(format!("qingbox-hosts-test-{}-{nonce}", std::process::id()));
            std::fs::create_dir(&path).unwrap();
            std::fs::write(path.join("hosts"), "# 原始内容").unwrap();
            Self(path)
        }
    }
    #[cfg(unix)]
    impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

    #[cfg(unix)]
    #[test]
    fn 反复切换最多六份备份且首次原始文件永不覆盖() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::new();
        let target = fixture.0.join("hosts");
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o644)).unwrap();
        let mut previous = "# 原始内容".to_string();
        for index in 0..12 {
            let next = format!("# 切换 {index}");
            atomic_replace(&target, &previous, &next).unwrap();
            assert_eq!(read_text(&target).unwrap(), next);
            previous = next;
            assert!(std::fs::read_dir(fixture.0.join(".qingbox-hosts-backups")).unwrap().count() <= 6);
        }
        let backups = fixture.0.join(".qingbox-hosts-backups");
        assert_eq!(read_text(&backups.join("original.bak")).unwrap(), "# 原始内容");
        let recent: Vec<_> = std::fs::read_dir(&backups).unwrap().map(|entry| entry.unwrap().path()).filter(|path| path.file_name().unwrap() != "original.bak").map(|path| read_text(&path).unwrap()).collect();
        assert_eq!(recent.len(), 5);
        assert!(recent.contains(&"# 切换 10".into()));
        assert!(!recent.contains(&"# 切换 0".into()));
        assert_eq!(std::fs::metadata(&target).unwrap().permissions().mode() & 0o777, 0o644);
    }

    #[cfg(unix)]
    #[test]
    fn 外部修改及备份失败均不覆盖原文件() {
        let fixture = Fixture::new();
        let target = fixture.0.join("hosts");
        assert!(atomic_replace(&target, "不是当前内容", "替换内容").unwrap_err().contains("已被修改"));
        assert_eq!(read_text(&target).unwrap(), "# 原始内容");
        std::fs::write(fixture.0.join(".qingbox-hosts-backups"), "占用目录名").unwrap();
        assert!(atomic_replace(&target, "# 原始内容", "替换内容").is_err());
        assert_eq!(read_text(&target).unwrap(), "# 原始内容");
    }

    #[cfg(unix)]
    #[test]
    fn 链接目标被拒绝且轮换不删除未知文件() {
        let fixture = Fixture::new();
        let alias = fixture.0.join("alias");
        std::os::unix::fs::symlink(fixture.0.join("hosts"), &alias).unwrap();
        assert!(atomic_replace(&alias, "# 原始内容", "新内容").is_err());
        let backups = fixture.0.join("备份");
        std::fs::create_dir(&backups).unwrap();
        std::fs::write(backups.join("用户文件.bak"), "保留").unwrap();
        for time in 0..8 { std::fs::write(backups.join(format!("hosts-{time}-1.bak")), "备份").unwrap(); }
        prune_backups(&backups).unwrap();
        assert!(backups.join("用户文件.bak").exists());
        assert!(!backups.join("hosts-2-1.bak").exists());
        assert!(backups.join("hosts-3-1.bak").exists());
    }
}
