use super::{filename_expression, SearchError};
use crate::contracts::FileResult;
use core_foundation::{
    array::{CFArray, CFArrayRef},
    base::{
        kCFAllocatorDefault, Boolean, CFAllocatorRef, CFIndex, CFOptionFlags, CFType, CFTypeRef,
        TCFType,
    },
    dictionary::{CFDictionary, CFDictionaryRef},
    runloop::{kCFRunLoopDefaultMode, CFRunLoopRunInMode},
    string::{CFString, CFStringRef},
};
use std::{path::Path, ptr};
use tokio::{sync::watch, time::Instant};

#[repr(C)]
struct BatchingParameters {
    first_max_num: usize,
    first_max_ms: usize,
    progress_max_num: usize,
    progress_max_ms: usize,
    update_max_num: usize,
    update_max_ms: usize,
}

#[link(name = "CoreServices", kind = "framework")]
unsafe extern "C" {
    fn MDQueryCreate(
        allocator: CFAllocatorRef,
        expression: CFStringRef,
        values: CFArrayRef,
        sorting: CFArrayRef,
    ) -> CFTypeRef;
    fn MDQuerySetSearchScope(query: CFTypeRef, directories: CFArrayRef, options: u32);
    fn MDQuerySetBatchingParameters(query: CFTypeRef, parameters: BatchingParameters);
    fn MDQueryExecute(query: CFTypeRef, options: CFOptionFlags) -> Boolean;
    fn MDQueryStop(query: CFTypeRef);
    fn MDQueryIsGatheringComplete(query: CFTypeRef) -> Boolean;
    fn MDQueryGetResultCount(query: CFTypeRef) -> CFIndex;
    fn MDQueryGetResultAtIndex(query: CFTypeRef, index: CFIndex) -> CFTypeRef;
    fn MDItemCopyAttribute(item: CFTypeRef, name: CFStringRef) -> CFTypeRef;
    fn MDItemCopyAttributes(item: CFTypeRef, names: CFArrayRef) -> CFDictionaryRef;
    static kMDQueryScopeAllIndexed: CFStringRef;
}

struct NativeQuery {
    object: CFType,
    running: bool,
}

impl NativeQuery {
    fn create(expression: &str, capacity: usize) -> Result<Self, SearchError> {
        let expression = CFString::new(expression);
        let pointer = unsafe {
            MDQueryCreate(
                kCFAllocatorDefault,
                expression.as_concrete_TypeRef(),
                ptr::null(),
                ptr::null(),
            )
        };
        if pointer.is_null() {
            return Err(SearchError::Failed("无法创建系统文件索引查询".to_string()));
        }
        let mut query = Self {
            object: unsafe { CFType::wrap_under_create_rule(pointer) },
            running: false,
        };
        unsafe {
            let scope = CFString::wrap_under_get_rule(kMDQueryScopeAllIndexed);
            let scopes = CFArray::from_CFTypes(&[scope]);
            MDQuerySetSearchScope(pointer, scopes.as_concrete_TypeRef(), 0);
            MDQuerySetBatchingParameters(
                pointer,
                BatchingParameters {
                    first_max_num: capacity,
                    first_max_ms: 10,
                    progress_max_num: capacity,
                    progress_max_ms: 10,
                    update_max_num: capacity,
                    update_max_ms: 10,
                },
            );
            if MDQueryExecute(pointer, 0) == 0 {
                return Err(SearchError::Failed(
                    "系统文件索引查询启动失败，请检查 Spotlight 状态与访问权限".to_string(),
                ));
            }
        }
        query.running = true;
        Ok(query)
    }

    fn pointer(&self) -> CFTypeRef {
        self.object.as_CFTypeRef()
    }

    fn stop(&mut self) {
        if self.running {
            unsafe { MDQueryStop(self.pointer()) };
            self.running = false;
        }
    }
}

impl Drop for NativeQuery {
    fn drop(&mut self) {
        // query 的停止和 CFType 的释放始终发生在创建它的同一线程。
        self.stop();
    }
}

pub(super) fn search(
    term: &str,
    limit: usize,
    generation: u64,
    receiver: &watch::Receiver<u64>,
    deadline: Instant,
) -> Result<(Vec<FileResult>, bool), SearchError> {
    check_current(generation, receiver, deadline)?;
    let limit = limit.clamp(1, 50);
    let capacity = limit + 1;
    #[cfg(debug_assertions)]
    let started = Instant::now();
    let filename = filename_expression(term);
    let mut queries = [
        (
            "应用",
            NativeQuery::create(
                &format!(
                    "({filename}) && (kMDItemContentTypeTree == \"com.apple.application-bundle\")"
                ),
                capacity,
            )?,
        ),
        (
            "非应用",
            NativeQuery::create(
                &format!(
                    "({filename}) && !(kMDItemContentTypeTree == \"com.apple.application-bundle\")"
                ),
                capacity,
            )?,
        ),
    ];
    loop {
        check_current(generation, receiver, deadline)?;
        let mut pending = false;
        for (_, query) in &mut queries {
            if !query.running {
                continue;
            }
            let complete = unsafe { MDQueryIsGatheringComplete(query.pointer()) != 0 };
            let count = unsafe { MDQueryGetResultCount(query.pointer()) };
            if complete || count >= capacity as CFIndex {
                query.stop();
            } else {
                pending = true;
            }
        }
        if !pending {
            break;
        }
        // 两类查询共用当前线程的 RunLoop，每轮统一检查取消与总期限。
        unsafe { CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.01, 1) };
    }
    let path_name = CFString::new("kMDItemPath");
    let names = CFArray::from_CFTypes(&[
        CFString::new("kMDItemFSName"),
        CFString::new("kMDItemDisplayName"),
        CFString::new("kMDItemContentTypeTree"),
    ]);
    let mut items = Vec::new();
    let mut total_count = 0;
    for (_category, query) in &queries {
        let count = unsafe { MDQueryGetResultCount(query.pointer()) }.max(0) as usize;
        total_count += count;
        #[cfg(debug_assertions)]
        let before_count = items.len();
        #[cfg(debug_assertions)]
        let (mut missing_metadata, mut invalid_metadata, mut missing_items) = (0, 0, 0);
        // 应用独立取得候选，不能被普通文件先占满候选池。
        for index in 0..count.min(capacity) {
            check_current(generation, receiver, deadline)?;
            let item = unsafe { MDQueryGetResultAtIndex(query.pointer(), index as CFIndex) };
            if item.is_null() {
                #[cfg(debug_assertions)]
                {
                    missing_items += 1;
                }
                continue;
            }
            // 路径单独读取，避免当前系统批量接口返回 Data 卷别名路径。
            let path = unsafe { MDItemCopyAttribute(item, path_name.as_concrete_TypeRef()) };
            let path = (!path.is_null()).then(|| unsafe { CFType::wrap_under_create_rule(path) });
            // 其余名称与类型字段一次批量读取，减少系统元数据请求。
            let attributes = unsafe { MDItemCopyAttributes(item, names.as_concrete_TypeRef()) };
            if attributes.is_null() {
                #[cfg(debug_assertions)]
                {
                    missing_metadata += 1;
                }
                continue;
            }
            let attributes: CFDictionary<CFString, CFType> =
                unsafe { CFDictionary::wrap_under_create_rule(attributes) };
            if let Some(item) = result_from_attributes(&attributes, path.as_ref()) {
                items.push(item);
            } else {
                #[cfg(debug_assertions)]
                {
                    invalid_metadata += 1;
                }
            }
        }
        #[cfg(debug_assertions)]
        super::trace_query(
            term,
            "索引查询结束",
            serde_json::json!({
                "类别": _category,
                "原始数量": count,
                "读取数量": count.min(capacity),
                "有效数量": items.len() - before_count,
                "缺少属性": missing_metadata,
                "无效路径或属性": invalid_metadata,
                "空结果项": missing_items,
                "耗时毫秒": started.elapsed().as_millis(),
            }),
        );
    }
    Ok(sort_results(term, items, limit, total_count > limit))
}

fn check_current(
    generation: u64,
    receiver: &watch::Receiver<u64>,
    deadline: Instant,
) -> Result<(), SearchError> {
    if *receiver.borrow() != generation {
        Err(SearchError::Cancelled)
    } else if Instant::now() >= deadline {
        Err(SearchError::TimedOut)
    } else {
        Ok(())
    }
}

fn string_attribute(attributes: &CFDictionary<CFString, CFType>, name: &str) -> Option<String> {
    attributes
        .find(CFString::new(name))?
        .downcast::<CFString>()
        .map(|value| value.to_string())
}

fn result_from_attributes(
    attributes: &CFDictionary<CFString, CFType>,
    path_attribute: Option<&CFType>,
) -> Option<FileResult> {
    let path = path_attribute?.downcast::<CFString>()?.to_string();
    if path.is_empty() {
        return None;
    }
    let path_value = Path::new(&path);
    let file_name = string_attribute(attributes, "kMDItemFSName")
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| {
            path_value
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        });
    let types = attributes
        .find(CFString::new("kMDItemContentTypeTree"))
        .and_then(|value| value.downcast::<CFArray>());
    let mut application = false;
    let mut directory = false;
    if let Some(types) = types {
        for value in types.iter() {
            if value.is_null() {
                continue;
            }
            let value = unsafe { CFType::wrap_under_get_rule(*value) };
            if let Some(value) = value.downcast::<CFString>() {
                match value.to_string().as_str() {
                    "com.apple.application-bundle" => application = true,
                    "public.directory" => directory = true,
                    _ => {}
                }
            }
        }
    }
    let kind = if application {
        "application"
    } else if directory {
        "directory"
    } else {
        "file"
    };
    let name = if application {
        let display_name = string_attribute(attributes, "kMDItemDisplayName")
            .filter(|name| !name.is_empty())
            .unwrap_or(file_name);
        display_name
            .strip_suffix(".app")
            .unwrap_or(&display_name)
            .to_string()
    } else {
        file_name
    };
    Some(FileResult {
        name,
        parent: path_value
            .parent()
            .unwrap_or_else(|| Path::new("/"))
            .to_string_lossy()
            .into_owned(),
        path,
        kind: kind.to_string(),
    })
}

pub(super) fn sort_results(
    term: &str,
    mut items: Vec<FileResult>,
    limit: usize,
    truncated: bool,
) -> (Vec<FileResult>, bool) {
    let mut paths = std::collections::HashSet::new();
    items.retain(|item| paths.insert(item.path.clone()));
    let term = term.to_lowercase();
    let application_term = term.strip_suffix(".app").unwrap_or(&term);
    items.sort_by_cached_key(|item| {
        let name = item.name.to_lowercase();
        let match_rank = if item.kind == "application" {
            let stem = Path::new(&item.path)
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase();
            let display_name = name.strip_suffix(".app").unwrap_or(&name);
            if display_name == application_term || stem == application_term {
                0
            } else if display_name.starts_with(application_term)
                || stem.starts_with(application_term)
            {
                1
            } else {
                2
            }
        } else {
            0
        };
        (
            match item.kind.as_str() {
                "application" => 0,
                "directory" => 1,
                _ => 2,
            },
            match_rank,
            name,
            item.path.clone(),
        )
    });
    let truncated = truncated || items.len() > limit;
    items.truncate(limit);
    (items, truncated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use core_foundation::number::CFNumber;

    fn attributes(values: &[(&str, CFType)]) -> CFDictionary<CFString, CFType> {
        CFDictionary::from_CFType_pairs(
            &values
                .iter()
                .map(|(key, value)| (CFString::new(key), value.clone()))
                .collect::<Vec<_>>(),
        )
    }

    fn string(value: &str) -> CFType {
        CFString::new(value).into_CFType()
    }

    fn convert(values: &CFDictionary<CFString, CFType>) -> Option<FileResult> {
        let path = values
            .find(CFString::new("kMDItemPath"))
            .map(|value| (*value).clone());
        result_from_attributes(values, path.as_ref())
    }

    #[test]
    fn 索引与文件名结果按路径去重并保留索引名称和应用优先() {
        let app = FileResult { name: "微信".into(), path: "/Applications/WeChat.app".into(), parent: "/Applications".into(), kind: "application".into() };
        let file = FileResult { name: "微信说明.txt".into(), path: "/文稿/微信说明.txt".into(), parent: "/文稿".into(), kind: "file".into() };
        let local_app = FileResult { name: "WeChat".into(), ..app.clone() };
        let (items, truncated) = sort_results("微信", vec![file.clone(), app, local_app, file], 2, false);
        assert_eq!(items.len(), 2);
        assert!(!truncated, "重复路径不应触发截断提示");
        assert_eq!(items[0].name, "微信");
        assert_eq!(items[0].kind, "application");
    }

    #[test]
    fn 应用使用本地化显示名且应用类型优先于目录类型() {
        let types = CFArray::from_CFTypes(&[
            CFString::new("public.directory"),
            CFString::new("com.apple.application-bundle"),
        ]);
        let values = attributes(&[
            ("kMDItemPath", string("/Applications/WeType.app")),
            ("kMDItemFSName", string("WeType.app")),
            ("kMDItemDisplayName", string("微信输入法")),
            ("kMDItemContentTypeTree", types.into_CFType()),
        ]);
        let result = convert(&values).expect("应用元数据应能转换");
        assert_eq!(result.name, "微信输入法");
        assert_eq!(result.kind, "application");
        assert_eq!(result.path, "/Applications/WeType.app");
    }

    #[test]
    fn 中文空格文件路径和目录类型正确转换() {
        let values = attributes(&[
            ("kMDItemPath", string("/tmp/中文 空格/恩泽目录")),
            ("kMDItemFSName", string("恩泽目录")),
            (
                "kMDItemContentTypeTree",
                CFArray::from_CFTypes(&[CFString::new("public.directory")]).into_CFType(),
            ),
        ]);
        let result = convert(&values).expect("目录元数据应能转换");
        assert_eq!(result.parent, "/tmp/中文 空格");
        assert_eq!(result.kind, "directory");
        let values = attributes(&[("kMDItemPath", string("/tmp/中文 空格/配置\n样例.json"))]);
        let result = convert(&values).expect("缺少名称时应从路径补全");
        assert_eq!(result.name, "配置\n样例.json");
        assert_eq!(result.kind, "file");
    }

    #[test]
    fn 缺少路径或字段类型错误时安全忽略而不错误转换() {
        let invalid_path = attributes(&[("kMDItemPath", CFNumber::from(7).into_CFType())]);
        assert!(convert(&invalid_path).is_none());
        let missing_path = attributes(&[("kMDItemFSName", string("配置.json"))]);
        assert!(convert(&missing_path).is_none());
        let values = attributes(&[
            ("kMDItemPath", string("/tmp/配置.json")),
            ("kMDItemFSName", CFNumber::from(7).into_CFType()),
            (
                "kMDItemContentTypeTree",
                CFArray::from_CFTypes(&[CFNumber::from(7).into_CFType(), string("public.data")])
                    .into_CFType(),
            ),
        ]);
        let result = convert(&values).expect("非法可选字段应允许回退");
        assert_eq!(result.name, "配置.json");
        assert_eq!(result.kind, "file");
    }

    #[test]
    fn 候选结果按类型稳定排序且最多返回五十项并准确提示截断() {
        let mut items = (0..50)
            .map(|index| FileResult {
                name: format!("文件{index:02}"),
                path: format!("/tmp/文件{index:02}"),
                parent: "/tmp".to_string(),
                kind: "file".to_string(),
            })
            .collect::<Vec<_>>();
        items.push(FileResult {
            name: "应用".to_string(),
            path: "/Applications/应用.app".to_string(),
            parent: "/Applications".to_string(),
            kind: "application".to_string(),
        });
        let (items, truncated) = sort_results("应用", items, 50, true);
        assert_eq!(items.len(), 50);
        assert_eq!(items[0].kind, "application");
        assert!(truncated);
        let (items, truncated) = sort_results("应用", items, 50, false);
        assert_eq!(items.len(), 50);
        assert!(!truncated, "恰好五十项不应自行标记截断");
    }

    #[test]
    fn 普通候选超过五十项也保留独立应用候选且精确匹配排第一() {
        let mut items = (0..51)
            .map(|index| FileResult {
                name: format!("Cursor-{index:02}.json"),
                path: format!("/tmp/Cursor-{index:02}.json"),
                parent: "/tmp".to_string(),
                kind: "file".to_string(),
            })
            .collect::<Vec<_>>();
        items.push(FileResult {
            name: "Cursor项目".to_string(),
            path: "/tmp/Cursor项目".to_string(),
            parent: "/tmp".to_string(),
            kind: "directory".to_string(),
        });
        for (name, basename) in [
            ("A Cursor Helper", "A Cursor Helper.app"),
            ("Cursor Editor", "Cursor Editor.app"),
            ("光标", "Cursor.app"),
        ] {
            items.push(FileResult {
                name: name.to_string(),
                path: format!("/Applications/{basename}"),
                parent: "/Applications".to_string(),
                kind: "application".to_string(),
            });
        }
        for term in ["cursor", "CURSOR.app"] {
            let (results, truncated) = sort_results(term, items.clone(), 50, true);
            assert_eq!(results.len(), 50);
            assert!(truncated);
            assert_eq!(
                results[0].path, "/Applications/Cursor.app",
                "精确应用名或去除.app后的文件名应排第一"
            );
            assert_eq!(
                results[1].path, "/Applications/Cursor Editor.app",
                "名称前缀应优先于仅包含关键词"
            );
            assert_eq!(results[2].path, "/Applications/A Cursor Helper.app");
            assert_eq!(results[3].kind, "directory", "应用应排在目录和普通文件之前");
        }
    }

    #[test]
    #[ignore = "需要本机安装 Cursor 且可访问 Spotlight 索引，仅在原生搜索验收时运行"]
    fn 原生搜索_cursor在大量普通文件候选中仍将应用置顶() {
        let (_sender, receiver) = watch::channel(1);
        let started = Instant::now();
        let (items, truncated) = search(
            "Cursor",
            50,
            1,
            &receiver,
            Instant::now() + std::time::Duration::from_secs(4),
        )
        .expect("本机Cursor搜索失败");
        let first = items.first().expect("本机Cursor应有匹配结果");
        assert_eq!(first.kind, "application");
        assert_eq!(
            Path::new(&first.path)
                .file_name()
                .and_then(|name| name.to_str()),
            Some("Cursor.app"),
            "搜索Cursor时应用必须排第一"
        );
        assert!(items.len() <= 50);
        println!(
            "原生Cursor查询：结果 {} 项，截断 {}，耗时 {} 毫秒",
            items.len(),
            truncated,
            started.elapsed().as_millis()
        );
    }
}
