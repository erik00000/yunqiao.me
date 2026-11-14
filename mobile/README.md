# 云桥 AI 手机伴侣 · iOS / Android

手机端内置独立管理界面，不再跳转到一个远端网页。连接电脑或服务器上的云桥网关后，可以查看用量与请求、选择客户端并预览/应用供应商和模型、启停供应商、查看模型能力、搜索和阅读本地会话，以及查看插件状态。

电脑负责网关和客户端配置，手机负责远程管理。API Key 留在电脑；访问令牌只保留在当前应用内存中，断开连接后清除。仅保存网关地址和外观偏好。

## 使用

1. 在电脑的云桥 AI 设置中开启局域网共享，设置访问令牌，并确认网关正在运行。
2. 手机与电脑连接同一网络，输入 `http://电脑局域网IP:3425` 和访问令牌；也可以连接你部署的 HTTPS 网关。
3. 「客户端」选择已有供应商/模型，预览电脑上将修改的配置，再确认应用。需要重启的客户端，在电脑上重启后生效。
4. 「会话」只读扫描电脑会话，搜索标题/项目并阅读内容。完整会话解析和续聊能力取决于客户端格式。

供应商新增、Key 编辑、安装/编写插件和系统级操作在电脑端完成。官方客户端没有开放第三方接入时，手机也不会把它标记为已经接入。请勿把访问令牌填进 URL；远程公网连接使用 HTTPS。

## 本地资源与验证

要求 Node.js 22+。依赖锁定为 Capacitor 7.6.10；最低 iOS 16。

```bash
cd mobile
npm ci
npm test
npm run build
```

`src/` 是界面源码，`www/` 是构建结果。iOS 使用 Capacitor 原生 HTTP 网络请求，浏览器预览使用 Fetch。`tests/connection.test.mjs` 验证地址、认证头、失败响应等接口边界。

可选浏览器流程验证（需要 Python Playwright 和 Chromium）：

```bash
python tests/browser-smoke.py
```

它使用模拟 RPC，不读取本机真实密钥，覆盖连接失败/成功、预览与版本校验、客户端限制、供应商启停、模型、会话文本安全、主题、窄屏和退出。截图写入 `build/mobile-workspace.png`。这不代替 iOS 真机测试。

## 生成 Xcode 工程

```bash
npm run sync:ios
```

该命令构建页面、首次生成 `ios/`，配置本地网络权限、iOS 16 目标和图标，再同步到原生工程。可在 Windows 上生成这些源文件。Windows 没有 Xcode/CocoaPods，跳过原生依赖与编译的提示是预期结果。

**工程入口：`mobile/ios/App/App.xcworkspace`。生成工程不是编译成功，也不是 IPA。**

## 编译模拟器版本（macOS）

需要 macOS、Xcode 16+、Command Line Tools 和 CocoaPods。在 Mac 上重新运行 `npm ci` 与 `npm run sync:ios`，安装本机所需的依赖后执行：

```bash
xcodebuild -workspace ios/App/App.xcworkspace \
  -scheme App -configuration Release \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath build \
  CODE_SIGNING_ALLOWED=NO build
```

产物：`mobile/build/Build/Products/Release-iphonesimulator/App.app`，只能运行在 iOS 模拟器。

仓库根目录 [`.github/workflows/build.yml`](../.github/workflows/build.yml) 的 `ios` job 使用 macOS runner 完成相同流程，上传 `yunqiao-ios-simulator`（内含 `.app` ZIP）和构建日志。构建错误会使任务失败，不会通过管道或 `|| true` 被隐藏。只有实际运行成功后才能报告模拟器包已编译。

## 真机 IPA / TestFlight

```bash
npm run open:ios
```

在 Xcode 中选择 App target，设置自己的 Bundle Identifier 和开发团队，连接 iPhone 运行；要分发则选择 iOS Device → Product → Archive → Distribute App。可分发 IPA 需要有效的 Apple 开发者团队、签名证书及描述文件；App Store / TestFlight 还需要相应账号配置。

当前 Windows 工作区能交付已构建的网页资源和已生成的 Xcode 工程，无法凭空生成有效签名的真机 IPA。提供的源码包也明确标为 `iOS-source`，不是安装包。

## Android

```bash
npm run build
npm run add:android   # 仅首次
npm run sync
npm run open:android
```

Android Studio 中编译。当前任务主要交付 Windows 和 iOS 准备；Android 不是已验证的产物。

## 源码包

```bash
python scripts/package-source.py
```

生成 `build/YunQiaoAI-0.5.0-iOS-source.zip`，含 mobile 源码、锁文件、资源和已生成的 `ios/` 工程，不含依赖、构建缓存或本地连接信息。在 Mac 解压后进入 `mobile`，运行 `npm ci && npm run sync:ios` 即可补齐依赖并打开工程。
