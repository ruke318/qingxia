# 轻匣（QingBox）

面向 macOS 的键盘优先效率工具：按下快捷键唤起一个类似「聚焦搜索」的悬浮输入框，搜索应用、文件和目录；格式化、Hosts 切换、剪贴板历史等工具通过插件提供，也可以自己写插件扩展。

全部数据保存在本机，不需要账号，不依赖任何云服务。

> 项目处于早期阶段，目前只支持 macOS。

## 功能

### 主入口

- 默认按 `⌥Space` 唤起，`Esc` 收起；唤起快捷键可以在设置里修改。
- 搜索应用、文件和目录，应用优先，显示系统图标；回车打开，`⌘↵` 在访达中显示。
- 输入目录路径直接列出其中内容，`Tab` 补全目录。
- 搜索结合 Spotlight 索引与桌面、文稿、下载目录的实时文件名检索，能找到尚未进入索引的新文件。
- macOS 26 及以上使用与系统聚焦搜索相同的 Liquid Glass 材质。

### 内置插件

| 插件 | 打开方式 | 说明 |
| --- | --- | --- |
| 格式化编辑器 | 搜索 `json`、`xml`、`html` | 粘贴即格式化 JSON、HTML、XML；自动去除整段 JSON 的外层转义；语法有误时仍按括号排版并指出错误位置；提供复制、压缩复制、压缩转义复制 |
| Hosts | 搜索 `host` | 按分组管理 hosts，可同时启用多个分组，检测冲突；写入系统前自动备份 |
| 剪贴板 | `⌥⇧V`，或搜索 `剪贴板` | 记录文本、图片、文件的复制历史，最多 200 条，只保存在本机；系统标记为隐私或临时的内容不记录 |

### 外部插件

| 插件 | 目录 | 说明 |
| --- | --- | --- |
| 二维码 | [`plugins/qr-tools`](plugins/qr-tools) | 文字实时生成二维码；按 `⌘V` 粘贴截图即可识别其中的二维码 |

外部插件不随应用打包，需要单独构建后在「设置 → 插件管理 → 本地导入」中导入，见[插件目录中的说明](plugins/qr-tools/README.md)。

## 从源码构建

### 环境要求

- macOS 13 或更高版本
- Xcode Command Line Tools：`xcode-select --install`
- [Node.js](https://nodejs.org/) 20.19+ 或 22.12+
- [Rust](https://rustup.rs/)：版本由仓库中的 `rust-toolchain.toml` 固定，rustup 会自动安装

### 构建与运行

```sh
npm ci

# 开发模式：同时启动前端开发服务与原生应用
npm run tauri -- dev

# 构建应用包，产物位于 src-tauri/target/release/bundle/macos/轻匣.app
npm run tauri -- build --bundles app
```

构建出的应用只做了本地临时签名（ad-hoc），拷到 `/Applications` 后即可使用。首次访问桌面、文稿、下载目录时，系统会请求授权。

### 测试

```sh
npm run test:json      # 格式化编辑器
npm run test:qr        # 二维码插件
npm run test:sdk       # 插件 SDK
npm run test:bridge    # 插件通信
npm run test:browser   # 各插件的浏览器回归测试，需要本机安装 Chrome，可用 CHROME_PATH 指定路径
cd src-tauri && cargo test
```

## 插件开发

插件就是一个静态网页目录，运行在只允许脚本的沙箱 iframe 中，通过消息协议调用宿主能力（存储、剪贴板、快捷键等），能力需要在清单里声明权限。

最小的插件目录：

```
my-plugin/
├── manifest.json   # 插件标识、名称、入口、命令、权限
├── index.html
└── main.js
```

```json
{
  "apiVersion": 1,
  "id": "my-plugin",
  "name": "示例插件",
  "version": "0.1.0",
  "entry": "index.html",
  "commands": [{ "id": "open", "title": "示例插件", "keywords": ["示例"] }],
  "permissions": []
}
```

- [`examples/minimal-plugin`](examples/minimal-plugin)：不依赖任何构建工具的完整示例。
- [`packages/plugin-sdk`](packages/plugin-sdk)：TypeScript SDK，内置插件和二维码插件都基于它编写。
- [接口约定](docs/接口约定.md)：清单字段、沙箱限制、消息协议 v1、全部宿主能力与错误码。

面板背景由宿主统一绘制，插件页面和根容器背景请保持透明，分区只使用低不透明度的半透明色。

## 关于 Hosts 免密

Hosts 插件第一次写入时需要管理员授权。授权后会安装一个只能修改 hosts 的辅助程序和对应的 sudoers 规则，之后切换不再询问密码。不需要时可以移除：

```sh
sudo rm /private/etc/sudoers.d/qingbox-hosts /Library/PrivilegedHelperTools/local.qingbox.hosts-helper
```

hosts 备份位于 `/private/etc/.qingbox-hosts-backups/`，始终保留首次的原始备份和最近 5 次切换的备份。

## 项目结构

```
├── src/                   # 主入口前端（React + TypeScript）
├── src-tauri/             # 原生部分（Rust + Tauri 2）：窗口、搜索、插件宿主、剪贴板、Hosts
├── packages/plugin-sdk/   # 插件 SDK
├── plugins/               # 内置插件与外部插件源码
├── examples/              # 插件示例
├── tests/                 # 浏览器回归测试与模拟宿主
└── docs/                  # 设计文档与接口约定
```

技术栈：[Tauri 2](https://tauri.app/)、React、TypeScript、Rust、SQLite。

## 许可证

[MIT](LICENSE)
