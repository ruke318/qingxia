import type { FileResult } from "./types";

export type FileIconKind = "folder" | "pdf" | "json" | "code" | "document" | "spreadsheet" | "presentation" | "image" | "audio" | "video" | "archive" | "application" | "file";

export function fileType(item: FileResult): { icon: FileIconKind; label: string } {
  const extension = item.name.toLowerCase().split(".").slice(1).pop() ?? "";
  if (item.kind === "application" || extension === "app") return { icon: "application", label: "应用" };
  if (item.kind === "directory") return { icon: "folder", label: "文件夹" };
  if (extension === "pdf") return { icon: "pdf", label: "PDF 文档" };
  if (["json", "jsonc", "json5"].includes(extension)) return { icon: "json", label: "JSON" };
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs", "vue", "svelte", "html", "htm", "css", "scss", "less", "go", "rs", "java", "kt", "swift", "py", "php", "rb", "c", "h", "cpp", "hpp", "cs", "sh", "zsh", "bash", "sql"].includes(extension)) return { icon: "code", label: `${extension.toUpperCase()} 代码` };
  if (["yaml", "yml", "toml", "ini", "conf", "xml", "env", "gitignore"].includes(extension)) return { icon: "code", label: "配置文件" };
  if (["doc", "docx", "pages", "odt", "rtf"].includes(extension)) return { icon: "document", label: "文档" };
  if (["txt", "md", "markdown", "log"].includes(extension)) return { icon: "document", label: extension === "log" ? "日志" : "文本" };
  if (["xls", "xlsx", "csv", "tsv", "numbers", "ods"].includes(extension)) return { icon: "spreadsheet", label: "表格" };
  if (["ppt", "pptx", "key", "odp"].includes(extension)) return { icon: "presentation", label: "幻灯片" };
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "heif", "tif", "tiff", "bmp", "ico", "avif", "psd", "raw"].includes(extension)) return { icon: "image", label: "图片" };
  if (["mp3", "m4a", "wav", "flac", "aac", "ogg", "aiff", "alac"].includes(extension)) return { icon: "audio", label: "音频" };
  if (["mp4", "mov", "mkv", "avi", "webm", "m4v", "mpeg", "mpg"].includes(extension)) return { icon: "video", label: "视频" };
  if (["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "tgz"].includes(extension)) return { icon: "archive", label: "压缩包" };
  if (["dmg", "pkg", "exe", "msi"].includes(extension)) return { icon: "application", label: "安装包" };
  return { icon: "file", label: extension ? `${extension.toUpperCase()} 文件` : "文件" };
}
