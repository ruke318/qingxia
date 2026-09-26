# 二维码

轻匣外部插件：文字转二维码，以及识别图片中的二维码。只使用插件 SDK 已有能力，宿主无需改动。

## 功能

- 输入文字或网址，右侧实时生成二维码，可在底栏切换纠错级别（低 / 中 / 较高 / 高）。
- 在插件中按 `⌘V` 粘贴截图或图片，自动识别其中的二维码，识别结果填入输入框并重新生成同一个码。
- 「复制文字」把输入框内容写入剪贴板。
- 内容和纠错级别保存在插件存储中，下次打开时恢复。

生成使用 [qrcode](https://www.npmjs.com/package/qrcode)，识别使用 [jsQR](https://www.npmjs.com/package/jsqr)，均在插件页面内运行，不联网。

## 权限

| 权限 | 用途 |
| --- | --- |
| `clipboard.writeText` | 「复制文字」 |

粘贴图片通过页面的粘贴事件读取，不需要额外权限。

## 构建与安装

在仓库根目录执行：

```sh
npm install
npm run test:qr      # 生成与识别往返的单元测试
npm run build:qr     # 类型检查并构建到 dist-plugins/qr-tools
```

然后在轻匣中打开设置 → 插件管理 → 本地导入，选择 `dist-plugins/qr-tools` 目录。

浏览器回归测试随 `npm run test:browser` 一起运行（需要本机安装 Chrome，可用 `CHROME_PATH` 指定路径）。
