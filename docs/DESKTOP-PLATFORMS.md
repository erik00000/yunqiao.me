# Windows / macOS 兼容性

桌面功能按当前操作系统检测和执行。macOS 分别构建 Intel x64 与 Apple Silicon arm64；iOS 为连接桌面网关的伴侣端，不操作电脑进程。

| 功能 | Windows | macOS |
| --- | --- | --- |
| 客户端安装检测 | exe、开始菜单、已注册 Store 应用 | /Applications、~/Applications、Info.plist 声明的主程序 |
| CLI 检测与打开 | PATH、新 PowerShell 窗口 | PATH、常见 Homebrew/npm/用户目录、新 Terminal；按需请求自动化权限 |
| 桌面启动与重启 | 核验用户、会话、路径、启动时间后正常关闭窗口 | 核验用户、应用包、主程序、启动时间后请求 AppKit 正常退出 |
| 已有供应商/官方账号发现 | 使用 Windows 配置根 | 使用 Application Support、XDG 与客户端配置根 |
| 配置、预览、应用、恢复 | 保留官方身份，写前校验和备份 | 相同事务流程，执行权限与私有备份目录检查 |
| 官方账号与中转共存 | 需客户端实际提供 Codex 配置能力 | 同一能力检测；原生聊天版不能冒充支持第三方接入 |
| 历史区域迁移、索引修复 | 预览、SQLite 事务、进程检查、备份恢复 | 相同流程；ps 检查应用包主程序及子进程，检查失败时停止写入 |
| 插件市场、MCP、Skills、提示词 | 校验目录、Git 对象和资源哈希 | 相同校验，保留必要的 Unix 可执行位 |
| 桌面插件、解锁与主题 | 兼容的 Electron 客户端经调试接口挂载 | 从 .app 启动调试接口，使用 macOS 主题资源；原生聊天应用无此接口时明确拒绝 |
| 供应商余额、模型同步、网关、路由、用量 | 共用平台无关实现 | 共用实现；上游未报告的缓存与余额保持未知 |
| 会员与安装绑定 | 凭据使用系统加密存储 | 凭据使用 Electron safeStorage / 系统钥匙串；不可用时不降级明文 |
| 窗口与快捷键 | 自绘按钮、Ctrl、系统托盘 | 原生交通灯、⌘、编辑/窗口菜单、单色菜单栏图标；关闭窗口后可从 Dock 重开 |
| 更新下载 | GitHub 对应架构 EXE，官网备用 | GitHub 对应架构或 Universal DMG/PKG，官网备用；拒绝错架构和降级 |
| 配置导入导出、自启、数据目录 | Windows 原生入口与 AppData | macOS 原生入口与 Application Support；配置导出不包含会员登录凭据 |

## 验证方式

`npm test` 包含平台参数化测试与当前系统的文件、配置、网关、余额、插件、历史及并发回归。参数化测试不能代替原生系统执行。

`node scripts/test-desktop-shell.mjs` 启动独立 Electron 实例，检查真实 IPC、窗口菜单、快捷键和关闭/恢复行为。`scripts/test-client-lifecycle-native.mjs` 只在 Windows 使用私有程序；`scripts/test-client-lifecycle-macos-native.mjs` 只在 macOS 使用私有 Cocoa 应用包，不重启真实客户端。`scripts/test-desktop-macos.mjs` 在 macOS 实际读取 XML/二进制 plist、检查执行权限与 ps。

GitHub 的 `Desktop platform validation` 工作流分别使用原生 arm64 和 x64 Mac：执行完整核心测试、macOS 专用测试、交互页面回归、Electron 原生窗口测试和打包后资源/IPC 验收。它不发布版本。`build` 工作流的 `macos` 目标复用这些检查并额外生成两种 DMG。

## 明确边界

终端的 Apple Events 自动化授权由用户的 macOS 管理；自动化测试覆盖拒绝授权提示，不代替真实用户首次授权。正式分发的 Gatekeeper 验收仍需 Apple Developer ID 签名、公证及真实下载测试。CLI 自定义 shell 安装目录若不在 PATH 或已知位置中，需要配置对应 PATH；不会执行用户 shell 启动脚本来猜测路径。

第三方客户端必须提供对应配置或调试接口；任意版本的客户端和插件不能仅凭平台匹配就视为兼容。历史跨供应商迁移也不保证上游模型支持原会话中的所有工具与附件。最新实测结果记录在 [平台验证记录](DESKTOP-PLATFORMS-VALIDATION.json)。
