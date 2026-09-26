use super::manifest::{load_plugin, PluginManifest};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};

const MAX_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ENTRIES: usize = 5000;
static INSTALL_LOCK: Mutex<()> = Mutex::new(());

pub(super) fn remove_directory<T>(base: &Path, root: &Path, mut reload: impl FnMut() -> Result<T, String>) -> Result<T, String> {
    let _guard = INSTALL_LOCK.lock().map_err(|_| "插件安装状态不可用")?;
    let base = base.canonicalize().map_err(|_| "无法解析插件安装目录")?;
    let metadata = fs::symlink_metadata(root).map_err(|_| "插件安装目录不存在或无法访问")?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("只能移除普通插件目录".into());
    }
    let root = root.canonicalize().map_err(|_| "无法解析插件目录")?;
    if root.parent() != Some(base.as_path()) || root.file_name().unwrap_or_default().to_string_lossy().starts_with('.') {
        return Err("只能移除插件安装目录中的本地副本".into());
    }
    let temporary = TemporaryDirectory::new(&base)?;
    let backup = temporary.0.join("backup");
    fs::rename(&root, &backup).map_err(|_| "无法移除插件，原插件保持不变")?;
    let result = match reload() {
        Ok(result) => result,
        Err(error) => {
            fs::rename(&backup, &root).map_err(|_| format!("移除失败，插件保留在 {}，请恢复该目录", backup.display()))?;
            reload().map_err(|restore| format!("移除失败，插件文件已恢复，但重新加载失败：{restore}"))?;
            return Err(error);
        }
    };
    fs::remove_dir_all(&backup).map_err(|_| format!("插件已停用，但清理文件失败：{}", backup.display()))?;
    Ok(result)
}

pub fn install_directory(source: &Path, base: &Path) -> Result<PluginManifest, String> {
    let _guard = INSTALL_LOCK.lock().map_err(|_| "插件安装状态不可用")?;
    if fs::symlink_metadata(source)
        .map_err(|_| "插件来源目录不存在或无法访问")?
        .file_type()
        .is_symlink()
    {
        return Err("插件来源目录不能是符号链接".into());
    }
    let manifest = load_plugin(source)?;
    let source = source.canonicalize().map_err(|_| "无法解析插件来源目录")?;
    let resolved_base = resolve_destination(base)?;
    if resolved_base.starts_with(&source) {
        return Err("插件安装目录不能位于来源目录内".into());
    }
    fs::create_dir_all(&resolved_base).map_err(|_| "无法创建插件安装目录")?;
    let base = resolved_base
        .canonicalize()
        .map_err(|_| "无法访问插件安装目录")?;
    if base.starts_with(&source) {
        return Err("插件安装目录不能位于来源目录内".into());
    }
    let temporary = TemporaryDirectory::new(&base)?;
    let stage = temporary.0.join("package");
    fs::create_dir(&stage).map_err(|_| "无法创建插件暂存目录")?;
    copy_tree(&source, &stage)?;
    let copied = load_plugin(&stage)?;
    if copied.id != manifest.id {
        return Err("复制期间插件标识发生变化，请重试".into());
    }
    let destination = base.join(&copied.id);
    publish(&stage, &destination, &temporary.0.join("backup"))?;
    Ok(copied)
}

// 找到已有父目录后解析真实路径，安装目录尚不存在时也能检查递归复制。
fn resolve_destination(path: &Path) -> Result<PathBuf, String> {
    if path.exists() {
        return path
            .canonicalize()
            .map_err(|_| "无法解析插件安装目录".into());
    }
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|_| "无法读取当前目录")?
            .join(path)
    };
    let parent = absolute.parent().ok_or("插件安装目录不正确")?;
    let name = absolute.file_name().ok_or("插件安装目录不正确")?;
    Ok(resolve_destination(parent)?.join(name))
}

fn copy_tree(source: &Path, target: &Path) -> Result<(), String> {
    let mut pending = vec![(source.to_path_buf(), target.to_path_buf())];
    let (mut entries, mut bytes) = (0, 0_u64);
    while let Some((source, target)) = pending.pop() {
        let metadata = fs::symlink_metadata(&source).map_err(|_| "无法读取插件来源目录")?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("插件目录不能包含符号链接或特殊文件".into());
        }
        for entry in fs::read_dir(&source).map_err(|_| "无法读取插件来源目录")? {
            let entry = entry.map_err(|_| "无法读取插件文件信息")?;
            entries += 1;
            if entries > MAX_ENTRIES {
                return Err("插件文件和目录总数不能超过 5000 项".into());
            }
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(|_| "无法读取插件文件信息")?;
            let destination = target.join(entry.file_name());
            if metadata.file_type().is_symlink() {
                return Err("插件目录不能包含符号链接".into());
            } else if metadata.is_dir() {
                fs::create_dir(&destination).map_err(|_| "无法复制插件子目录")?;
                pending.push((path, destination));
            } else if metadata.is_file() {
                let input = File::open(&path).map_err(|_| "无法读取插件文件")?;
                let opened = input.metadata().map_err(|_| "无法读取插件文件信息")?;
                if !opened.is_file() {
                    return Err("插件目录不能包含特殊文件".into());
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt;
                    if metadata.dev() != opened.dev() || metadata.ino() != opened.ino() {
                        return Err("复制期间插件文件发生变化，请重试".into());
                    }
                }
                let mut output = File::create(destination).map_err(|_| "无法创建插件文件副本")?;
                bytes += copy_bounded(input, &mut output, MAX_BYTES - bytes)?;
            } else {
                return Err("插件目录不能包含特殊文件".into());
            }
        }
    }
    Ok(())
}

fn copy_bounded(
    mut input: impl Read,
    output: &mut impl Write,
    remaining: u64,
) -> Result<u64, String> {
    let mut copied = 0;
    let mut buffer = [0_u8; 32 * 1024];
    loop {
        let count = input.read(&mut buffer).map_err(|_| "读取插件文件失败")?;
        if count == 0 {
            return Ok(copied);
        }
        if copied + count as u64 > remaining {
            return Err("插件总大小不能超过 64 MiB".into());
        }
        output
            .write_all(&buffer[..count])
            .map_err(|_| "写入插件文件失败")?;
        copied += count as u64;
    }
}

fn publish(stage: &Path, destination: &Path, backup: &Path) -> Result<(), String> {
    let exists = match fs::symlink_metadata(destination) {
        Ok(metadata) => {
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err("已有插件路径必须是普通目录".into());
            }
            true
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => return Err("无法检查已有插件目录".into()),
    };
    if exists {
        fs::rename(destination, backup).map_err(|_| "无法备份已有插件，旧版本保持不变")?;
    }
    if fs::rename(stage, destination).is_err() {
        if exists && fs::rename(backup, destination).is_err() {
            return Err(format!(
                "插件替换失败，旧版本保留在 {}，请恢复该目录",
                backup.display()
            ));
        }
        return Err("插件替换失败，已有版本保持不变".into());
    }
    if exists {
        let _ = fs::remove_dir_all(backup);
    }
    Ok(())
}

struct TemporaryDirectory(PathBuf);

impl TemporaryDirectory {
    fn new(base: &Path) -> Result<Self, String> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        for _ in 0..20 {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| "系统时间不正确，无法创建插件暂存目录")?
                .as_nanos();
            let path = base.join(format!(
                ".qingbox-install-{}-{nonce}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&path) {
                Ok(()) => return Ok(Self(path)),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => return Err("无法创建插件暂存目录".into()),
            }
        }
        Err("无法分配插件暂存目录".into())
    }
}

impl Drop for TemporaryDirectory {
    fn drop(&mut self) {
        // 恢复失败时必须留下旧版本，不能把唯一备份随暂存目录删除。
        if !self.0.join("backup").exists() {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> (TemporaryDirectory, PathBuf, PathBuf) {
        let base = std::env::temp_dir();
        let temporary = TemporaryDirectory::new(&base).expect("应创建测试目录");
        let source = temporary.0.join("source");
        fs::create_dir(&source).unwrap();
        write_plugin(&source, "1.0", "旧内容");
        let base = temporary.0.join("installed");
        (temporary, source, base)
    }

    fn write_plugin(source: &Path, version: &str, body: &str) {
        fs::write(source.join("index.html"), body).unwrap();
        fs::write(source.join("manifest.json"), json!({
            "id":"json-tools", "name":"JSON 格式化", "version":version, "apiVersion":1,
            "entry":"index.html", "commands":[{"id":"format","title":"格式化","keywords":["json"]}],
            "permissions":["clipboard.writeText"]
        }).to_string()).unwrap();
    }

    #[test]
    fn 移除仅删除安装副本且允许重新导入() {
        let (_temporary, source, base) = fixture();
        install_directory(&source, &base).unwrap();
        let root = base.join("json-tools");
        let result = remove_directory(&base, &root, || {
            assert!(!root.exists(), "刷新时旧副本应已退出扫描");
            Ok(42)
        }).unwrap();
        assert_eq!(result, 42);
        assert!(source.join("index.html").exists(), "原始导入目录不能被删除");
        assert_eq!(fs::read_dir(&base).unwrap().count(), 0, "不残留插件或临时目录");
        install_directory(&source, &base).unwrap();
        assert!(root.join("manifest.json").exists());
    }

    #[test]
    fn 移除刷新失败恢复原插件() {
        let (_temporary, source, base) = fixture();
        install_directory(&source, &base).unwrap();
        let root = base.join("json-tools");
        let mut calls = 0;
        let result = remove_directory(&base, &root, || {
            calls += 1;
            if calls == 1 { Err("测试刷新失败".into()) } else { Ok(()) }
        });
        assert_eq!(result.unwrap_err(), "测试刷新失败");
        assert_eq!(calls, 2, "恢复文件后应恢复运行状态");
        assert_eq!(fs::read_to_string(root.join("index.html")).unwrap(), "旧内容");
    }

    #[test]
    fn 移除拒绝越界和符号链接但允许损坏的插件() {
        let (_temporary, source, base) = fixture();
        install_directory(&source, &base).unwrap();
        assert!(remove_directory(&base, &source, || Ok(())).is_err());
        assert!(remove_directory(&base, &base, || Ok(())).is_err());
        #[cfg(unix)] {
            std::os::unix::fs::symlink(&source, base.join("link")).unwrap();
            assert!(remove_directory(&base, &base.join("link"), || Ok(())).is_err());
        }
        let root = base.join("json-tools");
        fs::remove_file(root.join("manifest.json")).unwrap();
        remove_directory(&base, &root, || Ok(())).unwrap();
        assert!(!root.exists());
        assert!(source.join("index.html").exists());
    }

    #[test]
    fn 合法插件复制到独立目录且重复导入更新() {
        let (_temporary, source, base) = fixture();
        fs::create_dir(source.join("资源")).unwrap();
        fs::write(source.join("资源/样式.css"), "样式").unwrap();
        let plugin = install_directory(&source, &base).expect("应导入合法插件");
        assert_eq!(plugin.version, "1.0");
        assert_eq!(
            fs::read_to_string(base.join("json-tools/资源/样式.css")).unwrap(),
            "样式"
        );
        fs::remove_dir_all(source.join("资源")).unwrap();
        write_plugin(&source, "2.0", "新内容");
        assert_eq!(install_directory(&source, &base).unwrap().version, "2.0");
        assert_eq!(
            fs::read_to_string(base.join("json-tools/index.html")).unwrap(),
            "新内容"
        );
        assert!(!base.join("json-tools/资源").exists(), "更新应替换整个包");
        assert!(source.join("index.html").exists(), "不能移动用户原始目录");
        assert_eq!(
            fs::read_dir(&base).unwrap().count(),
            1,
            "正常更新后应清理本次暂存和备份"
        );
    }

    #[test]
    fn 非法和缺失入口不损坏已安装版本() {
        let (_temporary, source, base) = fixture();
        install_directory(&source, &base).unwrap();
        fs::remove_file(source.join("index.html")).unwrap();
        assert!(install_directory(&source, &base).is_err());
        assert_eq!(
            fs::read_to_string(base.join("json-tools/index.html")).unwrap(),
            "旧内容"
        );
        fs::write(source.join("manifest.json"), "非法描述").unwrap();
        assert!(install_directory(&source, &base).is_err());
        assert_eq!(
            load_plugin(&base.join("json-tools")).unwrap().version,
            "1.0"
        );
    }

    #[test]
    fn 替换失败恢复旧版本() {
        let (_temporary, source, base) = fixture();
        install_directory(&source, &base).unwrap();
        let backup = base.join("backup");
        assert!(publish(
            &base.join("不存在的暂存包"),
            &base.join("json-tools"),
            &backup
        )
        .is_err());
        assert!(!backup.exists(), "备份应移回原位置");
        assert_eq!(
            fs::read_to_string(base.join("json-tools/index.html")).unwrap(),
            "旧内容"
        );
    }

    #[test]
    fn 安装目录不能在来源内避免递归复制() {
        let (_temporary, source, _base) = fixture();
        for base in [source.clone(), source.join("新目录/installed")] {
            let error = install_directory(&source, &base)
                .err()
                .expect("应拒绝递归安装位置");
            assert!(error.contains("不能位于来源目录内"));
        }
        assert!(!source.join("新目录").exists(), "不应先创建非法安装目录");
    }

    #[test]
    fn 有界复制按实际读取量限制大小() {
        let mut output = Vec::new();
        assert_eq!(copy_bounded(&b"1234"[..], &mut output, 4).unwrap(), 4);
        let mut output = Vec::new();
        assert!(copy_bounded(&b"12345"[..], &mut output, 4)
            .unwrap_err()
            .contains("64 MiB"));
        assert!(output.len() <= 4, "不能把超限内容写入暂存文件");
    }

    #[cfg(unix)]
    #[test]
    fn 非入口符号链接和特殊文件也拒绝且保留旧包() {
        use std::os::unix::fs::symlink;
        let (_temporary, source, base) = fixture();
        install_directory(&source, &base).unwrap();
        symlink(source.join("index.html"), source.join("alias.html")).unwrap();
        assert!(install_directory(&source, &base)
            .err()
            .unwrap()
            .contains("符号链接"));
        fs::remove_file(source.join("alias.html")).unwrap();
        assert!(std::process::Command::new("mkfifo")
            .arg(source.join("pipe"))
            .status()
            .expect("应创建特殊文件样例")
            .success());
        assert!(install_directory(&source, &base)
            .err()
            .unwrap()
            .contains("特殊文件"));
        assert_eq!(
            load_plugin(&base.join("json-tools")).unwrap().version,
            "1.0"
        );
    }
}
