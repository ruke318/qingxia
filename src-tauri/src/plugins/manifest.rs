use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

const MAX_MANIFEST_BYTES: u64 = 64 * 1024;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub api_version: u32,
    pub entry: String,
    pub icon: Option<String>,
    pub commands: Vec<PluginCommand>,
    pub permissions: Vec<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCommand {
    pub id: String,
    pub title: String,
    pub keywords: Vec<String>,
    pub suggested_shortcut: Option<String>,
}

pub fn load_plugin(root: &Path) -> Result<PluginManifest, String> {
    let path = resolve_asset(root, "manifest.json")?;
    let file = std::fs::File::open(path).map_err(|_| "无法读取插件描述文件".to_string())?;
    let mut bytes = Vec::new();
    // 有界读取，避免描述文件过大或读取期间增长造成无上限分配。
    file.take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取插件描述文件".to_string())?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err("插件描述文件不能超过 64 KB".to_string());
    }
    let manifest: PluginManifest = serde_json::from_slice(&bytes).map_err(|error| {
        let reason = match error.classify() {
            serde_json::error::Category::Data => "字段缺失或类型不正确",
            serde_json::error::Category::Eof => "内容不完整",
            _ => "格式不正确",
        };
        format!(
            "插件描述文件{reason}（第 {} 行，第 {} 列）",
            error.line(),
            error.column()
        )
    })?;
    if !valid_id(&manifest.id) {
        return Err("插件标识必须为 1 至 64 个小写字母、数字或中划线".to_string());
    }
    if manifest.api_version != 1 {
        return Err("不支持此插件接口版本，当前仅支持 apiVersion 为 1".to_string());
    }
    if manifest.name.trim().is_empty() || manifest.version.trim().is_empty() {
        return Err("插件名称和版本不能为空".to_string());
    }
    if manifest.commands.is_empty() || manifest.commands.len() > 20 {
        return Err("插件必须声明 1 至 20 个命令".to_string());
    }
    let mut command_ids = HashSet::new();
    for command in &manifest.commands {
        if !valid_id(&command.id) {
            return Err("命令标识必须为 1 至 64 个小写字母、数字或中划线".to_string());
        }
        if !command_ids.insert(&command.id) {
            return Err(format!("插件命令标识重复：{}", command.id));
        }
        if command.title.trim().is_empty() {
            return Err("插件命令标题不能为空".to_string());
        }
        if command
            .keywords
            .iter()
            .any(|keyword| keyword.trim().is_empty())
        {
            return Err("插件命令关键词不能包含空白项".to_string());
        }
    }
    if manifest
        .permissions
        .iter()
        .any(|permission| !["clipboard.readText", "clipboard.writeText", "clipboard.history", "hosts.read", "hosts.write"].contains(&permission.as_str()))
    {
        return Err("插件声明了不支持的权限，当前支持 clipboard.readText、clipboard.writeText、clipboard.history、hosts.read 和 hosts.write".to_string());
    }
    resolve_asset(root, &manifest.entry)?;
    load_icon(root, manifest.icon.as_deref())?;
    Ok(manifest)
}

pub fn load_icon(root: &Path, icon: Option<&str>) -> Result<Option<String>, String> {
    let Some(icon) = icon else { return Ok(None) };
    let path = resolve_asset(root, icon)?;
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    let mime = match extension.as_str() {
        "svg" => "image/svg+xml", "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "webp" => "image/webp",
        _ => return Err("插件图标仅支持 SVG、PNG、JPEG 或 WebP 文件".into()),
    };
    let mut bytes = Vec::new();
    std::fs::File::open(path).map_err(|_| "无法读取插件图标")?.take(256 * 1024 + 1)
        .read_to_end(&mut bytes).map_err(|_| "无法读取插件图标")?;
    if bytes.len() > 256 * 1024 { return Err("插件图标不能超过 256 KB".into()) }
    Ok(Some(format!("data:{mime},{}", percent_encoding::percent_encode(&bytes, percent_encoding::NON_ALPHANUMERIC))))
}

pub fn resolve_asset(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative_path = Path::new(relative);
    if relative.is_empty()
        || relative_path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("插件资源必须使用非空相对路径，不能包含上级目录或绝对路径".to_string());
    }
    let root = root
        .canonicalize()
        .map_err(|_| "插件目录不存在或无法访问".to_string())?;
    if !root.is_dir() {
        return Err("插件根路径必须是目录".to_string());
    }
    let path = root
        .join(relative_path)
        .canonicalize()
        .map_err(|_| format!("插件资源不存在或无法访问：{relative}"))?;
    if !path.starts_with(&root) {
        return Err("插件资源的真实路径超出了插件目录".to_string());
    }
    if !path.is_file() {
        return Err(format!("插件资源必须是文件：{relative}"));
    }
    Ok(path)
}

fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|value| value.is_ascii_lowercase() || value.is_ascii_digit() || value == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::sync::atomic::{AtomicU64, Ordering};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("测试时钟应晚于时间起点")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "qingbox-plugin-manifest-{}-{nonce}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).expect("应创建独立的插件测试目录");
            Self(path)
        }

        fn write_manifest(&self, manifest: &Value) {
            std::fs::write(
                self.0.join("manifest.json"),
                serde_json::to_vec(manifest).unwrap(),
            )
            .expect("应写入插件描述样例");
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn sample() -> (TestDirectory, Value) {
        let directory = TestDirectory::new();
        std::fs::create_dir(directory.0.join("页面")).expect("应创建资源子目录");
        std::fs::write(directory.0.join("页面/格式 化.html"), "插件页面").expect("应写入入口样例");
        let manifest = json!({
            "id": "json-tools",
            "name": "JSON 格式化",
            "version": "0.1.0",
            "apiVersion": 1,
            "entry": "页面/格式 化.html",
            "commands": [{ "id": "format", "title": "格式化 JSON", "keywords": ["json", "格式化"] }],
            "permissions": ["clipboard.writeText"]
        });
        (directory, manifest)
    }

    fn assert_invalid(directory: &TestDirectory, manifest: &Value, expected: &str) {
        directory.write_manifest(manifest);
        let error = load_plugin(&directory.0)
            .err()
            .expect("非法插件描述应被拒绝");
        assert!(
            error.contains(expected),
            "错误提示应说明{expected}，实际为：{error}"
        );
    }

    #[test]
    fn 合法插件支持中文空格路径与可选快捷键() {
        let (directory, mut manifest) = sample();
        manifest["futureField"] = json!("未来可选字段");
        directory.write_manifest(&manifest);
        let parsed = load_plugin(&directory.0).expect("应接受合法插件描述与未知可选字段");
        assert_eq!(parsed.api_version, 1);
        assert_eq!(parsed.commands[0].suggested_shortcut, None);
        manifest["commands"][0]["suggestedShortcut"] = json!("Alt+J");
        directory.write_manifest(&manifest);
        let parsed = load_plugin(&directory.0).expect("应接受建议快捷键");
        assert_eq!(
            parsed.commands[0].suggested_shortcut.as_deref(),
            Some("Alt+J")
        );
        let encoded = serde_json::to_value(parsed).expect("描述应可序列化");
        assert_eq!(encoded["apiVersion"], 1);
        assert_eq!(encoded["commands"][0]["suggestedShortcut"], "Alt+J");
    }

    #[test]
    fn 重复命令标识被拒绝() {
        let (directory, mut manifest) = sample();
        let command = manifest["commands"][0].clone();
        manifest["commands"].as_array_mut().unwrap().push(command);
        assert_invalid(&directory, &manifest, "命令标识重复");
    }

    #[test]
    fn 图标可省略或使用插件内中文路径() {
        let (directory, mut manifest) = sample();
        directory.write_manifest(&manifest);
        assert!(load_plugin(&directory.0).unwrap().icon.is_none());
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><text>轻匣</text></svg>";
        std::fs::write(directory.0.join("页面/图 标.svg"), svg).unwrap();
        manifest["icon"] = json!("页面/图 标.svg");
        directory.write_manifest(&manifest);
        let parsed = load_plugin(&directory.0).expect("应接受内部图标路径");
        let data = load_icon(&directory.0, parsed.icon.as_deref()).unwrap().unwrap();
        assert!(data.starts_with("data:image/svg+xml,"));
        assert_eq!(percent_encoding::percent_decode_str(data.split_once(',').unwrap().1).decode_utf8().unwrap(), svg);
    }

    #[test]
    fn 图标拒绝越界缺失错误格式与超大文件() {
        let (directory, mut manifest) = sample();
        for (icon, expected) in [("../外部.svg", "相对路径"), ("/etc/hosts", "相对路径"), ("", "相对路径"), ("缺失.svg", "资源不存在"), ("页面/格式 化.html", "图标仅支持")] {
            manifest["icon"] = json!(icon);
            assert_invalid(&directory, &manifest, expected);
        }
        std::fs::write(directory.0.join("大图标.png"), vec![0; 256 * 1024 + 1]).unwrap();
        manifest["icon"] = json!("大图标.png");
        assert_invalid(&directory, &manifest, "图标不能超过");
    }

    #[test]
    fn 不兼容接口版本被拒绝() {
        let (directory, mut manifest) = sample();
        manifest["apiVersion"] = json!(2);
        assert_invalid(&directory, &manifest, "接口版本");
        manifest["apiVersion"] = json!("1");
        assert_invalid(&directory, &manifest, "字段缺失或类型不正确");
    }

    #[test]
    fn 非法插件标识和空名称版本被拒绝() {
        let (directory, manifest) = sample();
        for invalid in ["", "JSON", "含中文", "json_tools", &"a".repeat(65)] {
            let mut current = manifest.clone();
            current["id"] = json!(invalid);
            assert_invalid(&directory, &current, "插件标识");
        }
        for field in ["name", "version"] {
            let mut current = manifest.clone();
            current[field] = json!("  ");
            assert_invalid(&directory, &current, "名称和版本不能为空");
        }
    }

    #[test]
    fn 命令数量及内容受到校验() {
        let (directory, manifest) = sample();
        for count in [0, 21] {
            let mut current = manifest.clone();
            current["commands"] = Value::Array(vec![manifest["commands"][0].clone(); count]);
            assert_invalid(&directory, &current, "1 至 20 个命令");
        }
        for (field, value, expected) in [
            ("id", json!("Format"), "命令标识"),
            ("title", json!(" "), "标题不能为空"),
            ("keywords", json!(["json", " "]), "关键词不能包含空白项"),
        ] {
            let mut current = manifest.clone();
            current["commands"][0][field] = value;
            assert_invalid(&directory, &current, expected);
        }
    }

    #[test]
    fn 仅允许已实现的剪贴板与主机配置权限() {
        let (directory, mut manifest) = sample();
        for permission in ["filesystem.read", "unknown"] {
            manifest["permissions"] = json!([permission]);
            assert_invalid(&directory, &manifest, "不支持的权限");
        }
        manifest["permissions"] = json!([]);
        directory.write_manifest(&manifest);
        assert!(load_plugin(&directory.0).is_ok(), "不申请权限的插件应合法");
        manifest["permissions"] = json!(["hosts.read", "hosts.write"]);
        directory.write_manifest(&manifest);
        assert!(load_plugin(&directory.0).is_ok(), "Hosts 插件应可声明专用权限");
        manifest["permissions"] = json!(["clipboard.history"]);
        directory.write_manifest(&manifest);
        assert!(load_plugin(&directory.0).is_ok(), "剪贴板插件应可声明历史权限");
        manifest["permissions"] = json!(["clipboard.readText"]);
        directory.write_manifest(&manifest);
        assert!(load_plugin(&directory.0).is_ok(), "插件应可声明读取文本剪贴板权限");
    }

    #[test]
    fn 超大或格式错误的描述返回中文错误() {
        let (directory, mut manifest) = sample();
        manifest["padding"] = json!("x".repeat(MAX_MANIFEST_BYTES as usize));
        assert_invalid(&directory, &manifest, "不能超过 64 KB");
        std::fs::write(directory.0.join("manifest.json"), b"{").unwrap();
        let error = load_plugin(&directory.0).err().expect("不完整描述应被拒绝");
        assert!(error.contains("内容不完整"), "应提供中文格式错误提示");
    }

    #[test]
    fn 资源路径拒绝上级目录绝对路径与空路径() {
        let (directory, _) = sample();
        for path in [
            "../outside.html",
            "页面/../页面/格式 化.html",
            "/etc/hosts",
            "",
        ] {
            let error = resolve_asset(&directory.0, path).expect_err("越界路径应被拒绝");
            assert!(error.contains("相对路径"), "应提供中文路径限制提示");
        }
        let path = resolve_asset(&directory.0, "页面/格式 化.html").expect("合法相对资源应可解析");
        assert_eq!(
            path,
            directory
                .0
                .join("页面/格式 化.html")
                .canonicalize()
                .unwrap()
        );
    }

    #[test]
    fn 插件入口必须是存在的内部文件() {
        let (directory, mut manifest) = sample();
        for (entry, expected) in [
            ("missing.html", "资源不存在"),
            ("页面", "资源必须是文件"),
            ("../outside.html", "相对路径"),
            ("/etc/hosts", "相对路径"),
        ] {
            manifest["entry"] = json!(entry);
            assert_invalid(&directory, &manifest, expected);
        }
    }

    #[cfg(unix)]
    #[test]
    fn 资源和描述文件均不能通过符号链接逃出插件目录() {
        use std::os::unix::fs::symlink;
        let (directory, mut manifest) = sample();
        let outside = TestDirectory::new();
        std::fs::write(outside.0.join("outside.html"), "外部内容").unwrap();
        symlink(&outside.0, directory.0.join("外部目录")).expect("应创建测试目录符号链接");
        symlink(
            outside.0.join("outside.html"),
            directory.0.join("outside.html"),
        )
        .expect("应创建测试文件符号链接");
        for entry in ["outside.html", "外部目录/outside.html"] {
            manifest["entry"] = json!(entry);
            assert_invalid(&directory, &manifest, "真实路径超出了插件目录");
        }
        outside.write_manifest(&manifest);
        std::fs::remove_file(directory.0.join("manifest.json")).unwrap();
        symlink(
            outside.0.join("manifest.json"),
            directory.0.join("manifest.json"),
        )
        .unwrap();
        let error = load_plugin(&directory.0)
            .err()
            .expect("外部描述符号链接应被拒绝");
        assert!(error.contains("真实路径超出了插件目录"));
    }

    #[test]
    fn 对外文档中的最小示例插件通过描述校验() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/minimal-plugin");
        let manifest = load_plugin(&root).expect("示例插件描述应通过校验");
        assert_eq!((manifest.id.as_str(), manifest.entry.as_str()), ("minimal-note", "index.html"));
        assert!(manifest.permissions.is_empty(), "示例只使用基础能力，不需要声明权限");
    }
}
