use super::SearchError;
use crate::contracts::FileResult;
use std::{collections::VecDeque, path::PathBuf};
use tokio::{sync::watch, time::Instant};

pub(super) fn search(
    term: &str,
    capacity: usize,
    roots: impl IntoIterator<Item = PathBuf>,
    generation: u64,
    receiver: &watch::Receiver<u64>,
    deadline: Instant,
) -> Result<(Vec<FileResult>, bool), SearchError> {
    let term = term.to_lowercase();
    let mut pending: VecDeque<_> = roots.into_iter().collect();
    let mut items = Vec::new();
    let mut partial = false;
    // 按层枚举，先检查各常用目录的直属文件；每次实时读取，不依赖索引或搜索缓存。
    while let Some(directory) = pending.pop_front() {
        if *receiver.borrow() != generation { return Err(SearchError::Cancelled) }
        if Instant::now() >= deadline { return Ok((items, true)) }
        let entries = match std::fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(error) => { partial |= error.kind() != std::io::ErrorKind::NotFound; continue }
        };
        for entry in entries {
            if *receiver.borrow() != generation { return Err(SearchError::Cancelled) }
            if Instant::now() >= deadline { return Ok((items, true)) }
            let Ok(entry) = entry else { partial = true; continue };
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') { continue }
            let Ok(file_type) = entry.file_type() else { partial = true; continue };
            let path = entry.path();
            let extension = path.extension().and_then(|value| value.to_str()).unwrap_or_default();
            let application = file_type.is_dir() && extension.eq_ignore_ascii_case("app");
            // 应用包作为一项结果，隐藏目录和包内资源交给系统索引，避免扫入内部文件。
            if file_type.is_dir() && !["app", "bundle", "framework"].iter().any(|value| extension.eq_ignore_ascii_case(value)) {
                pending.push_back(path.clone());
            }
            if name.to_lowercase().contains(&term) {
                let directory = file_type.is_dir() || (file_type.is_symlink() && path.is_dir());
                items.push(FileResult {
                    name: if application { name[..name.len() - 4].into() } else { name },
                    parent: path.parent().unwrap().to_string_lossy().into_owned(),
                    path: path.to_string_lossy().into_owned(),
                    kind: if application { "application" } else if directory { "directory" } else { "file" }.into(),
                });
                if items.len() >= capacity { return Ok((items, true)) }
            }
        }
    }
    Ok((items, partial))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, time::{Duration, SystemTime, UNIX_EPOCH}};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("qingbox-filenames-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn search(&self, term: &str, capacity: usize) -> (Vec<FileResult>, bool) {
            let (_, receiver) = watch::channel(1);
            search(term, capacity, [self.0.clone()], 1, &receiver, Instant::now() + Duration::from_secs(2)).unwrap()
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    #[test]
    fn 无索引中文文件与深层目录可实时检索且删除后不残留() {
        let fixture = Fixture::new();
        let nested = fixture.0.join("归档/2022/十月/国大机构");
        fs::create_dir_all(&nested).unwrap();
        let file = nested.join("国大机构信息.xlsx");
        fs::write(&file, []).unwrap();
        let (items, partial) = fixture.search("国大机构", 51);
        assert!(!partial);
        assert_eq!(items.len(), 2);
        assert!(items.iter().any(|item| item.path == file.to_string_lossy() && item.kind == "file"));
        assert!(items.iter().any(|item| item.kind == "directory"));
        fs::remove_file(file).unwrap();
        assert_eq!(fixture.search("国大机构", 51).0.len(), 1);
    }

    #[test]
    fn 字面匹配支持特殊字符和大小写且不进入隐藏目录应用包或循环链接() {
        let fixture = Fixture::new();
        for directory in [".隐藏", "匹配.app"] {
            fs::create_dir(fixture.0.join(directory)).unwrap();
            fs::write(fixture.0.join(directory).join("内部匹配.txt"), []).unwrap();
        }
        fs::write(fixture.0.join("匹配A*?.txt"), []).unwrap();
        std::os::unix::fs::symlink(&fixture.0, fixture.0.join("循环")).unwrap();
        let (items, partial) = fixture.search("匹配", 51);
        assert!(!partial);
        assert_eq!(items.len(), 2);
        assert!(items.iter().any(|item| item.kind == "application"));
        assert_eq!(fixture.search("a*?", 51).0.len(), 1);
    }

    #[test]
    fn 结果限额取消与期限均生效() {
        let fixture = Fixture::new();
        for index in 0..55 { fs::write(fixture.0.join(format!("记录{index}.txt")), []).unwrap(); }
        let (items, partial) = fixture.search("记录", 51);
        assert_eq!(items.len(), 51);
        assert!(partial);
        let (_, receiver) = watch::channel(2);
        assert!(matches!(search("记录", 51, [fixture.0.clone()], 1, &receiver, Instant::now() + Duration::from_secs(1)), Err(SearchError::Cancelled)));
        let (items, partial) = search("记录", 51, [fixture.0.clone()], 2, &receiver, Instant::now()).unwrap();
        assert!(items.is_empty() && partial);
    }
}
