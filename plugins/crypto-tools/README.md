# 编码工具（外部插件）

构建后在轻匣中选择「设置 → 插件管理 → 本地导入」，选择 `dist-plugins/crypto-tools` 目录（内含 manifest.json）。导入后搜索 base64、md5、aes 或 rsa，进入对应分页。

## 界面和操作

- 输入在上，输出在下；算法、模式和输入格式位于中间，底部是粘贴、复制结果、清空。
- 编码支持 Base64、URL 安全 Base64、encodeURIComponent、encodeURI、Unicode 转义、Hex。
- 哈希支持 MD5、SHA-1、SHA-256、SHA-512、SM3；填写密钥后计算 HMAC，点击单项复制。
- 对称加密支持 AES-128/192/256、DES、3DES、SM4；支持 CBC、ECB，AES 还支持 GCM。
- 非对称支持 RSA、SM2、ECDSA、Ed25519，按算法提供加解密、签名、验签与生成密钥对。
- ⌘1～⌘4 切换分页；非对称算法按 ⌘↩ 执行；Esc 返回轻匣搜索。编辑区支持系统编辑快捷键。

## 运行方式

这是独立插件包，不内置进轻匣安装包，不联网下载代码。@noble、node-forge、sm-crypto 已随插件打包；算法不依赖 crypto.subtle，随机数使用 crypto.getRandomValues。

需使用支持 clipboard.readText 的轻匣版本。插件申请读取纯文本和写入纯文本剪贴板权限，粘贴按钮由宿主提供；无文件系统、网络或剪贴板历史权限。

草稿保存在本机，包含输入、公钥、对称密钥和参数。非对称私钥只保存在当前插件实例内存中，不写入草稿。

## 源码与构建

在仓库根目录执行 `npm install && npm run build:crypto`，产物为 `dist-plugins/crypto-tools`；`npm run test:crypto` 运行单元测试。默认应用构建不打包此插件。
