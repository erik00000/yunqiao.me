# 云桥 AI · yunqiao.me

以客户端为起点的 AI 工作空间：**选客户端 → 连接供应商 → 选择模型 → 预览并应用**。

Windows / macOS 桌面端使用 Electron + React + TypeScript；iOS 为 Capacitor 伴侣端，连接电脑或服务器上的网关。0.6.0 正在本地功能验证，公开下载为 0.5.0 预览版。

最新调试入口及双平台验证范围见 [Windows / macOS 兼容性](docs/DESKTOP-PLATFORMS.md)；此前记录见 [Windows 本地功能验收](docs/LOCAL-VALIDATION-0.6.0.md)。 本轮修复及后续优先级见 [工程审查记录](docs/ENGINEERING-AUDIT-2026-11-15.md)。

公开仓库：[jxb412/aurora](https://github.com/jxb412/aurora) · [下载预览版 0.5.0](https://github.com/jxb412/aurora/releases/tag/v0.5.0) · [构建记录](https://github.com/jxb412/aurora/actions) · [用户讨论](https://github.com/jxb412/aurora/discussions)

![客户端工作台](docs/images/clients-v0.6.png)

## 已实现

- **已有配置自动发现**：启动、运行期间及回到窗口时识别已支持客户端的 API 配置，去重加入供应商，标明来源；保留手工编辑与删除选择。官方 OAuth 单独显示为本机账号，不转换为通用 API Key。
- **官方账号与中转共存**：含 Codex 配置能力的 ChatGPT 桌面版和 Codex CLI 可保留官方身份，在同一目录选择官方或第三方模型。官方请求直达固定官方后端，第三方请求重建供应商认证；本机 auth 文件始终由原客户端维护。需先存在可信的本机官方模型目录。
- **客户端工作台**：分类、搜索、本地检测；向导内新增供应商、拉取远端预设、选择模型、测试连接、查看脱敏配置差异、自动备份、恢复原配置。
- **厂商与供应商**：首次启动拉取官方 Web 目录，后续启动共用缓存并后台刷新；接入向导、添加供应商和厂商页共用同一列表。支持搜索、地区筛选、批量导入、多密钥和冷却。默认模型有逐项官方来源记录。
- **模型管理**：跨供应商批量选择、编辑能力/价格/上下文、预览删除影响、保护正在使用的客户端与分组引用；修改前保留备份。未知价格保持未知。
- **本地网关**：Anthropic Messages、OpenAI Chat、OpenAI Responses、Gemini；同协议原生透传，跨协议转换；分组路由、重试和请求统计。
- **历史会话**：阅读/搜索/导出，按原生 `model_provider` 区域筛选；选择来源和目标区域迁移部分或批量会话，同步日志与本地索引，支持当前/归档范围、变更预览、备份恢复和冲突保护。另提供原生消息索引修复。详见 [区域迁移](docs/HISTORY-PROVIDER-MIGRATION.md)。
- **扩展**：提供 32 项内置增强及 5 个完整拓展包，连接兼容桌面后按实际状态启用；公开/完整插件市场、插件入口解锁、主题、用量状态栏及原生资源管理。已安装版本、更新、缺失及下架状态分别展示。网关中间件支持参数校验、执行失败保护和实际运行状态；另有 MCP、Skills 和提示词工作台。每项标明兼容性，未适配项不能假开启。
- **实时用量**：进行中的请求、输入/输出、缓存读写与命中率、完成日志；原生桌面用量取自实际 token_count。上游未报告的数据不显示为零。
- **云桥会员**：平台登录/两步验证、客户端安装绑定、首次使用 $10 赠金、选择会员分组并添加 API 供应商；后端固定金额、账户/安装唯一约束、幂等核销与管理员核对。
- **设置**：浅色/深色/跟随系统、强调色、托盘、自启、网关与代理、访问令牌、更新检查、导入导出配置。
- **远程管理**：认证后的 Web 控制台与 iOS 内置伴侣 UI；公开目录不包含个人密钥，远程管理返回值脱敏。

## 客户端能力

| 客户端 | 当前接入方式 |
| --- | --- |
| Claude Code | 自动配置 settings.json，保留其他设置 |
| Claude Desktop | 支持第三方配置的版本：写入 Claude-3p profile；具体平台/版本须支持该入口 |
| Codex CLI | 自动配置共享的 Codex 配置，正确写入 TOML 顶层键与供应商表 |
| ChatGPT 桌面版 | 统一入口识别 ChatGPT、Beta 与原 Codex；有实际编码配置能力的版本自动接入，扩展需经本机调试接口验证 |
| Gemini CLI | 自动配置环境文件，使用原生 Gemini 网关接口 |
| WorkBuddy / DeepSeek API / Qwen / Kimi / OpenCode 等 | 按能力给出手动参数与文档；不猜测未证实的配置文件，也不把手动参数标记成自动接入成功 |
| 不具备编码配置接口的旧 ChatGPT 聊天版 | 在统一入口说明官方账号登录限制，不把第三方 API 接入标记成功 |

客户端界面会展示自动配置、手动接入或官方登录状态，以及版本限制。厂商同名模型也可能具有不同能力，连接测试需要用户自己的有效 API Key。

## 使用与构建

安装依赖后：

```powershell
pnpm install --frozen-lockfile
npm run dev
npm run build
npm run package:win
```

平台适配范围与原生验证见 [Windows / macOS 兼容性](docs/DESKTOP-PLATFORMS.md)。macOS 在 Mac 上执行 `npm run package:mac`，分别生成 Intel x64 和 Apple Silicon arm64 的 DMG；GitHub Actions 可选择 `macos` 构建。当前未配置 Apple Developer ID 签名与公证。

Windows 产物位于 `release/`：`YunQiaoAI-0.6.0-win-x64-setup.exe` 与 `YunQiaoAI-0.6.0-win-x64-portable.exe`。未配置代码签名证书。

无界面网关：

```powershell
npm run build
node dist/main/gateway-cli.cjs --data ./gateway-data --port 3425
```

令牌保存在该数据目录的 `settings.json`。Web 控制台与模型接口都需要令牌，API 使用 `Authorization: Bearer <gatewayToken>`；Anthropic/Gemini 兼容各自密钥头。公共 `/health` 只显示服务健康信息。

模型路由支持 `模型ID`、`供应商ID/模型ID`、`group/分组名`。向导写入明确供应商 ID，避免选好供应商后请求被同名模型误路由。

## iOS

见 [移动端说明](mobile/README.md)。移动界面内置于 App，可查看和管理已连接电脑上的客户端、供应商、会话及用量；API Key 留在电脑端，手机访问令牌仅保留当前运行会话。

```bash
cd mobile
npm ci
npm test
npm run sync:ios
npx cap open ios
```

原生编译必须使用 **macOS + Xcode**。仓库工作流在 macOS 上构建模拟器 `.app`，不会把源码或模拟器 ZIP 伪称可安装到 iPhone 的 IPA。真机分发还需要 Apple 开发者签名和描述文件。当前 Windows 工作区能生成 iOS 工程、构建 Web 资源，不能独立完成苹果原生编译。

历史 0.5.0 已通过 [GitHub macOS 原生构建](https://github.com/jxb412/aurora/actions/runs/43617930882)，实际产出包含有效 Mach-O 的 iOS 16+ 模拟器应用及 iPhoneOS 未签名设备应用。设备 ZIP 需要签名后才能安装，不是已签名 IPA。Actions 手动运行可选 `ios`、`windows`、`macos` 或 `all`。

## 验证

```powershell
npm run typecheck
npm test
node scripts/test-extensions.mjs --renderer
npm run build
node scripts/smoke.mjs
python scripts/test-ui.py
```

客户端测试使用隔离的临时 home；网关测试使用本地模拟上游。UI 测试需要 Python Playwright，使用 Electron 与隔离数据目录，验证实际的配置、恢复、会话下载和认证流程。它们不会证明所有服务商或所有客户端版本都已通过真实付费 API 联调。

0.6.0 已通过 Windows 本地回归，以及 [Intel / Apple Silicon Mac 原生验证](https://github.com/jxb412/aurora/actions/runs/43689616128)，覆盖完整核心测试、原生启动/重启、界面和实际应用包。本轮未发布新版或切换客户端下载指向，具体验证边界见 [平台记录](docs/DESKTOP-PLATFORMS-VALIDATION.json)。

## 当前边界

- 同协议原生路径尽量保留供应商专属字段。开启转换、隐私遮蔽或通用请求插件后，专属 hosted tools、加密 reasoning 和部分多模态能力不保证跨协议可用；不同供应商的思考签名不能伪造。
- 历史可阅读不等于可以跨账号无损续聊。读取有大小/消息数量边界；没有永久后台全文索引。
- 用量费用依据本地价格估算，额度策略依据已配置额度，不等同实时官方账单。
- 桌面插件依赖实际版本的原生接口。收录全部上游入口不等于每项都适配；需要额外后台或尚未适配的项目会禁用并展示原因。具体兼容状态以界面提示为准。
- 远程管理限制文件写入、自定义代码、密钥与敏感设置；这些操作需要桌面端完成。
