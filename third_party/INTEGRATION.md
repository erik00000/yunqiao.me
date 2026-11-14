# Codex++ 集成清单与验收边界

核对日期：2026-11-15。依据是实际源码及实时市场索引，不能用功能名称或界面开关代替运行验收。

本文集中保存第三方来源、修改记录与集成证据。文中源码路径均相对于仓库根目录。

## 固定来源与复现

- 仓库：[BigPizzaV3/CodexPlusPlus](https://github.com/BigPizzaV3/CodexPlusPlus)。固定提交：[`75d25e0b8020a4a96cb4b75c00d75ee31ed2cc3c`](https://github.com/BigPizzaV3/CodexPlusPlus/tree/75d25e0b8020a4a96cb4b75c00d75ee31ed2cc3c)，提交时间 2026-11-14 16:02:09 UTC。
- 原始源码资产：`third_party/codexplusplus/assets/inject/**`、`assets/extensions/**`；原始许可证、扩展协议及相关 Rust 组装/路由源码也随目录保留。
- 成品拓展：`third_party/codexplusplus/materialized/extensions/**`。
- 来源清单：`third_party/codexplusplus/UPSTREAM.json`；逐文件 SHA-256：`FILES.sha256.json`。
- 复现脚本：`python scripts/vendor-codexplusplus.py`；刷新市场快照使用 `--catalogs`。脚本要求本地 `.reference/CodexPlusPlus` 的 HEAD 与固定提交完全一致，更新上游时应重新审阅，不能静默漂移。

## 五个可独立装载的官方拓展包

上游定义在 `crates/codex-plus-core/src/bundled_extensions.rs`。这五个是完整包；下面另外 32 项是内置能力，不应混称为 37 个互相独立的包。

| 包 ID | 功能 | 必须实现的桥接/依赖 |
|---|---|---|
| `agent-pet` | 图片桌宠、大肥鱼、设置界面 | `/agent-pet/catalog`、`image`、`sound`、`import-sound`；`/whale/media`、`full`、`history`、`session`；诊断路由 |
| `typing-effects` | 彩虹、烟花、星星打字特效 | 纯 renderer，公开扩展生命周期 |
| `image-overlay` | 自定义背景图 | `/image-overlay/image` 只读本包已保存配置中的图片，不能接受任意页面路径；64 MiB 上限 |
| `usage-statusline` | 用量状态栏 | `/thread-usage-live`；提供 `codexpp.usage` 服务 |
| `proxy-request-status` | 请求状态条 | `/proxy-status` |

Agent 桌宠不能只复制 manifest/main.js。实际落盘按上游组装：将 `assets/inject/upstream/whale-widget/full-widget-codex.js` 包装为 `codexPlusWhaleEngine(...)`，生成 `whale-engine.js`；用 settings.js 与 settings-page.js 替换 settings.html 中的占位；复制四个 mp3 音效及图标。Whale 图片/动图/其他音效从 `/whale/media` 提供。

公开 API 由 `91-extension-api.js`、`91-extension-rpc.js`、`91-extension-runtime.js` 和 `92-extension-*` 实现。包使用 `codexPlus.extension`，以及 `ctx.effect/onConfigUpdate/registerSlot/onScan/listen/call/asset/registerSettingsPanel/provide`。关闭时应撤销监听、计时器、扫描步骤及 DOM。`types/codex-plus-extensions.d.ts` 和 `EXTENSIONS.md` 是接口依据。

## 32 项内置能力与依赖

清单来自 `assets/inject/renderer-inject/96-builtin-extensions.js`。以下“运行依赖”说明上游怎样完成；资产被打包不等于该客户端上已经通过验收。

| ID | 中文能力 | 运行依赖 |
|---|---|---|
| `dictation` | 语音听写 | renderer 录音 + `/dictation/status/transcribe/cancel`，有效语音供应商与 token 校验 |
| `turn-rewind` | 轮次回退 | 原生会话操作接口、运行状态核验 |
| `side-chat-save` | 侧聊保存 | 原生对话状态与存储桥接 |
| `history-turn-recovery` | 历史轮次补全 | CDP、原生消息分页与线程状态；与数据库索引修复不同 |
| `capacity-auto-retry` | 容量不足自动重试 | renderer 错误分类、重试生命周期 |
| `model-picker-groups` | 模型分组 | 原生模型菜单结构、renderer |
| `dream-skin` | 梦皮主题 | 主题引擎、CSS、图片及平台适配 |
| `plugin-market-unlock` | 插件市场入口/本地市场 | 原生 bridge/client 请求适配、真实市场与安装服务 |
| `instance-identity` | 多开身份提示 | 启动实例标识配置 |
| `session-title-hook` | 会话标题中间件 | 原生标题请求与中间件 |
| `session-delete` | 会话归档与撤销 | Aurora 使用原生 thread/archive、thread/unarchive；不删除 JSONL 或手工改索引 |
| `markdown-export` | Markdown 导出 | 完整会话读取、原始内容导出 |
| `thread-id-badge` | 会话 ID 角标 | renderer 当前会话身份 |
| `thread-scroll-restore` | 滚动位置恢复 | renderer 路由与滚动容器 |
| `conversation-view` | 对话宽度 | renderer CSS 与配置 |
| `activity-overlay-right` | 消息导航靠右 | renderer 定位与主题 |
| `paste-fix` | 粘贴修复 | 原生输入区、剪贴板事件 |
| `offline-auto-review` | 离线时显示审批设置 | 原生远程开关读取；不替用户审批工具 |
| `statsig-overrides` | Statsig 界面增强 | 客户端特征开关兼容层 |
| `weixin-desktop-sync` | 微信会话同步 | connect 后端真实接收消息并落盘；settings 下发 `{threadId,revision,project}`；原生 catalog notify |
| `stepwise` | 下一步建议 | 浮动面板完整脚本、当前回答与生成服务 |
| `answer-outline` | 回答大纲 | 浮动面板、回答解析与滚动导航 |
| `pet-real-mouse` | 桌宠跟随鼠标 | 系统逻辑坐标 `/system/cursor-position`、CDP；上游启动器定时驱动 |
| `model-whitelist-unlock` | 模型列表兼容 | 启动、注入与模型目录处理；不授予远端模型权限 |
| `native-fast-unlock` | 原生 Fast 入口 | `native-fast-unlock.js` + `native-fast-rspack.js`、早期原生模块识别与 runtime 设置 |
| `native-predictions` | 原生输入预测 | `native-predictions.js`、原生模块与预测服务 |
| `reported-usage-compaction` | 按上报用量压缩 | 代理/网关 token 用量与压缩阈值，实验功能 |
| `reasoning-collapse` | 回答完成折叠思考过程 | 仅经 Aurora 网关的 Responses 请求；补充缺失的 commentary/final_answer，保留已有 phase |
| `disable-work-view` | 纯 API 模式隐藏 Work | 纯 API 配置下写入 desktop.conversationDetailMode，重启客户端生效 |
| `force-chinese-locale` | 强制中文 | 注入 `locale:zh-CN` 配置、原生语言选择 |
| `native-browser-identification` | Edge/Chrome 标识兼容 | 请求头/网关与客户端版本适配 |
| `standalone-quota-unlock` | 额度提示/界面兼容 | 本地额度 UI 策略；不会增加供应商余额、订阅或真实额度 |

没有 `apply(ctx)` 的内置项由 Rust 启动器/代理/CDP 完成。Aurora 的 TypeScript 后端必须另行适配这些依赖；给列表加一个勾选框不能视为完成。`builtin_takeover.rs` 对被替代能力屏蔽原设置，避免两个实现同时工作。关闭市场补丁之后需刷新原生页面才完全移除已打的补丁。

## Aurora 0.6 运行状态与验收结果

统一入口是“ChatGPT 桌面版”，按安装目录、产品信息及实际 Codex 资源识别 ChatGPT Beta / ChatGPT / Codex。只有存在原生接口的兼容客户端能使用这些增强；本机存在 `.codex` 目录不作为兼容证据。首次连接读取版本；版本改变时需再次确认适配，不能静默沿用。CLI 配置入口保持独立。

已接入完整上游 renderer、五个随附包、四套主题、回答大纲、原生历史补载、会话导出/归档撤销、供应商模型列表、语音转写、下一步建议，以及原生 Fast/预测模块的早期加载。原生模块缺失或历史/桌宠接口不可用时返回实际错误并不标为运行中。听写须指定支持 `/audio/transcriptions` 的供应商与 ASR 模型；下一步建议默认手动生成，须有可用供应商/模型并启动本地网关，生成会实际调用该供应商。缺少配置只显示已安装及说明。

以下 **5 项明确不支持**，界面禁用且后端拒绝启用：

| ID | 当前边界 |
|---|---|
| `side-chat-save` | 未实现原生 fork、source boundary、rollout 与索引事务 |
| `weixin-desktop-sync` | 未接入真实微信账号与收发消息后端 |
| `reported-usage-compaction` | 缺少原生 app-server 压缩控制接口 |
| `native-browser-identification` | 缺少原生浏览器/网络适配 |
| `standalone-quota-unlock` | 缺少本地额度门控适配；不改变远端账户真实额度 |

桌宠提供随附图片/动图/音效和独立 avatar 窗口坐标驱动；自定义音效导入未接入。大肥鱼余额/专项统计接口明确返回 unavailable，不编造余额。原生插件安装默认停用、不执行安装包代码、不代替 OAuth 登录；启用写入原生配置并要求重启。插件目录显示原始许可证，公共库和完整库分别保留来源与同名隔离。

状态栏读取验证过 session_meta.id 的真实 rollout token_count，并可合并有可靠 threadId 的 Aurora 网关记录/正在进行请求。未上报的缓存读写、输入输出值保持未知；真实 0 保留为 0。仅在供应商真实上报时更新 token 数，rollout 通常在事件写入后更新，不宣称逐 token 即时统计。无法可靠归属线程的网关请求不贴到任意会话。

`node scripts/test-extensions.mjs --renderer` 共 **20 项**：覆盖单包 Git tree/blob 校验和事务配置、5 包编译/实际加载、4 主题、未知缓存、真实用量 DOM、归档撤销、语音 multipart/取消、供应商绑定建议、配置/加载状态、模块失败与停用清理。最后一项启动隐藏 Electron + 真实 CDP，含独立 avatar 窗口与 Electron 系统鼠标坐标。测试使用隔离临时客户端目录，供应商网络调用使用可检查请求内容的 fixture，没有修改用户客户端或产生真实 API 费用。

CDP 后端每次 RPC 校验主 frame 的默认执行上下文、`app://-/` URL、`window===top` 和 `electronBridge`，并在异步验证后复核导航代次及上下文存活。真实 Electron 攻击回归验证：同源沙盒 iframe 直接调用 Runtime binding、顶层导航到外部 data: 页面再调用 binding 均无法触发后台特权路由。CDP 只连接回环地址及指定端口。

**兼容性限制：以上真实 CDP 验收基于受控 Electron fixture，尚未在当前用户实际安装的官方 ChatGPT/Codex 发行版逐项验收。** 这些客户端的私有 renderer/原生模块可能随更新改变，因此“脚本已加载”不是所有原生功能在任意版本上都可用的承诺。

## 两个原生插件市场

2026-11-15 实际获取索引，`schemaVersion: 1`，两份索引的 `updatedAt` 均为 2026-10-08。

| 来源 | 插件数 | requiresAuth | 索引 revision |
|---|---:|---:|---|
| [公开库](https://github.com/BigPizzaV3/CodexPlusPlusPluginCache) | 520 | 104 | `1c13d7180da9717bb5b8b35fdb40261290bacd7d` |
| [完整库](https://github.com/BigPizzaV3/CodexPlusPlusFullPluginCache) | 5491 | 4524 | `64d6b2876644744be29d69f99a8944fc405fd3dc` |

快照位于 `third_party/codexplusplus/catalog/{public,full}.json`。每项包含 id/name/displayName/description/version/author/tags/license/path/tree/bytes/skills/requiresAuth；完整 SHA-256 及许可统计在 UPSTREAM.json。两个库存在重叠，不应相加宣传为 6011 个互不重复插件。

上游安装流程是选择单项后，使用固定 revision 的 Git sparse checkout，只提取索引路径，校验 Git tree；不是下载全库后执行。上游限制：索引 8 MiB、包 512 MiB、10 万文件。安装目录为 `CODEX_HOME/plugins/cache/<marketName>/<plugin.name>/<plugin.version>`，marketName 根据 source+id 的 SHA-256 生成避免重名覆盖；同时生成虚拟 marketplace/receipt。原生协议有 `plugin/list/read/install/installed` 和 legacy `list-plugins/read-plugin/install-plugin`。远程 host 请求不能错误安装到本机。超时应轮询同一安装任务，不能再发第二次安装。

完整库含 4848 项未注明许可、50 项 `Proprietary`、11 项 `UNLICENSED` 以及各类特定条款；索引可展示不意味着可统一重新授权或随 Aurora 批量再分发。按需获取时保留原 LICENSE/NOTICE，并显示索引原始许可。需要 OAuth、API Key 或外部订阅的能力继续走其授权流程。

当前市场入口实现见 `60-plugin-marketplace.js`、`62-plugin-market-adapter.js`、`95-conversation-view.js`：识别现代/未知客户端策略，修正 buildFlavor 过滤，再选择 bridge/client/both 请求适配；远端目录拒绝 API Key 登录时回退本地目录。旧设计稿中的 React authContext 伪装不能当作当前实现依据。适配目标是具有这些原生接口的 Codex 系列客户端；不能据此宣称所有 ChatGPT 聊天桌面版本都支持相同插件机制。

## 两类批量历史修复

### 供应商与路径修复

上游 `provider_sync.rs` 扫描 sessions 与 archived_sessions，只修改 `session_meta.model_provider` 及相关本地索引；同步 canonical `threads`、`local_thread_catalog`、metadata/sync state。存在备份、变更校验、加锁、保留无项目状态等额外约束。原日志中加密的推理内容不能通过切换 provider 解密。`sync_journal.rs` 按行/字段 before-after 校验回滚，避免覆盖修复以后发生的变更。

Aurora 入口为 `codex.repair.preview/apply/backups/restorePreview/restore`。必须先预览，执行时重新验证 revision；支持当前/归档/全部、选中会话、原供应商筛选和路径检查。相关实现由 `historyRepair.ts` 与 `historyRepairIO.ts` 管理。

### 原生消息索引修复

上游依据：`session_index_scan.rs`、`session_index_repair.rs`、`docs/session-index-repair.md`。Aurora 实现：`src/core/sessionIndexRepair.ts`，入口 `codex.indexRepair.preview/apply/backups/restorePreview/restore`。

已实现的写入范围是 `thread_history_1.sqlite` 的 `thread_items` 原生 `userMessage` 投影与 `thread_turns.first_user_item_id`。任务缺少轮次时，只在 canonical threads 的 rollout 路径归属、完整开始/结束边界和首条身份同时成立时补建。普通文字通过 response_item 和独立 user_message/唯一 item_completed 对照；重复正文逐次消费证据，不能仅凭文本或文件名认领。目标通过目标事件与首轮内部 objective 原文共同确认。支持明确身份的孤立/悬空首条恢复以及原始和原生后继边界共同证明的旧 inProgress；不修改其运行状态。

扫描读取全文 SHA-256。写入前、取得 SQLite IMMEDIATE 锁后、提交前复核来源。索引与供应商修复共用 CODEX_HOME 生命周期锁，执行前检查客户端进程。先创建 SQLite 一致性快照，再写 before/after 行日志。恢复按原生 ID 和本批次写入后的字段匹配，保留后来新增的其他消息与无关字段。日志状态可识别事务提交前后中断；备份在 `.aurora-history-repair/index-backups`。

当前明确跳过：未知必填 schema、不支持的附件、身份/序号冲突、未完成尾行、混入其他任务、来源变化、缺少归属证据及子任务继承分片。与上游相比，Aurora 采用更保守的分片处理，不声称所有历史损坏都能修复。原始 JSONL 始终只读。CDP 前端历史分页补载是另一项能力，数据库修复成功不能代替前端补载验收。

`node scripts/test-session-index.mjs` 的 18 组独立 SQLite 检查覆盖真实插入、幂等、同文多次发送、目标、孤立首条、归档、active 限制、缺失轮次补建、未知 schema、附件首条、截断/污染、同长度来源变更、取得写锁后的变更、事务失败回滚、恢复冲突及保留后续无关更新。测试在临时目录运行，未改用户真实会话。

## 许可与发布

CodexPlusPlus 根许可为 **AGPL-3.0-only**。复制的 renderer、桥接和相关派生实现不能继续统一标为 MIT。随二进制分发应提供对应源码及构建材料，保留版权/许可证与修改说明；网络提供修改版程序时需满足 AGPL 第 13 节对应源码要求。

主题上游 `cidala-tiger/dream-skin/glass-vision/skin-packs/snow-skin` 的 MIT LICENSE 已保留；Whale 的代码 MIT 许可与图片/音效范围不同，见原 `PROVENANCE.md`。素材按上游声明原样随插件运行分发，不赋予再许可、不声称 Aurora 原创。materialized agent-pet 另附 WHALE-LICENSE / WHALE-PROVENANCE.md。

发布前的实际验收至少包括：冷启动能找到资产；五包实际脚本装载；插件启停后无残留效果；原生窗口版本检测失败能明确提示；目录刷新与单包固定版本安装；原生列表发现已装插件；启用后能调用其实际功能；缺少授权明确呈现；批量修复预览不写文件；执行校验过期版本；成功/失败/中断均有可解释结果；备份冲突保留现状。无需远端权限的 renderer 测试、真实 CDP 客户端验收、外部供应商调用测试应分别记录，不能互相代替。
