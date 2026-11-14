# 三个参考项目与真实用户需求调研

调研日期：2026-11-15（Asia/Shanghai）。通过 GitHub 公开 API 阅读三个项目当前 README、按评论数排序的 Issues 样本、重点 issue 正文和部分评论，以及 cc-switch Discussions 前 50 条公开主题。该样本适合发现需求，不是全站统计，不能推导「某类问题占一半」之类比例。已关闭的 issue 说明历史需求，不能据此断言当前版本仍有同样缺陷。

CodexPlusPlus 的仓库元数据 `has_discussions=false`；其 Discussions API 返回 410。magpie 的 Discussions API 也返回 410。因此这两者以 Issues 和 issue 评论作为用户讨论来源，没有虚构独立讨论区内容。

## 项目长处

| 项目与来源 | 当前公开能力 | Aurora 值得吸收的设计 |
| --- | --- | --- |
| [CodexPlusPlus README](https://github.com/BigPizzaV3/CodexPlusPlus#readme) | 统一 Agent 管理；本地网关；供应商池与模型组；会话；Codex 增强；Claude Desktop 增强；MCP、Skills、扩展；多开与工具协作 | 让客户端、扩展和会话处于同一工作台；高级能力按需启用；插件安装显示能力并默认关闭未经审核的代码 |
| [cc-switch README](https://github.com/farion1231/cc-switch#readme) | 按工具配置供应商；预设；连接字段最小修改和备份；四协议路由/聚合；MCP、Skills、Prompts；会话；用量；云同步与 WSL | 先选客户端后选供应商；改动预览；保留用户原配置；模型与供应商易搜索；清楚区分直连、路由、聚合 |
| [magpie README](https://github.com/yetone/magpie#readme) | 本地网关；四协议；供应商/订阅；多账号路由；会话黏性；隐私遮蔽；插件中间件；WebUI/Docker/CLI；远程管理 | 连接、模型、路由共享数据；请求失败的可解释性；移动端/无界面管理；供应商目录动态刷新 |

三个项目都已具备较丰富功能，不能再把 cc-switch 简单描述为「只有切配置」，也不能笼统认定 magpie「只支持 macOS」。CodexPlusPlus README 明确说明不修改官方应用安装文件，但其部分增强仍依赖官方页面结构/CDP，需要版本适配。研究产品思路不等于直接合并源码；若后续引入代码，按对应许可证单独审查并保留声明（当前 CodexPlusPlus 为 AGPL-3.0，cc-switch 为 MIT）。

## 用户真正关心的事

| 用户讨论证据 | 需求判断 | 对 Aurora 的设计要求 | 优先级 |
| --- | --- | --- | --- |
| [cc-switch #1855](https://github.com/farion1231/cc-switch/issues/1855) 的新 CLI 工具跟踪表及评论，含 Qwen、WorkBuddy/CodeBuddy、Kimi、Cursor 等 | 用户想按自己手头客户端接入，而不是先理解供应商协议 | 客户端入口、能力矩阵、明确自动配置/手动配置/受限状态；稳定适配器接口 | P0 |
| [cc-switch Discussion #1883](https://github.com/farion1231/cc-switch/discussions/1883)「openrouter 怎么配置给 claude code」、[#1698](https://github.com/farion1231/cc-switch/discussions/1698) 硅基流动模型配置问题 | 预设存在并不等于用户能完成配置 | 就地新增供应商、自动解释协议、模型拉取、最终可用性测试 | P0 |
| [Codex++ #327](https://github.com/BigPizzaV3/CodexPlusPlus/issues/327) 工具调用必须有对应 tool 消息；[cc-switch #2282](https://github.com/farion1231/cc-switch/issues/2282) thinking 回传错误 | 跨协议可用性比供应商数量更关键 | 工具往返和推理字段回归；保存原错误；明确已验证组合 | P0 |
| [cc-switch Discussion #1938](https://github.com/farion1231/cc-switch/discussions/1938) Codex Responses 404；[#1973](https://github.com/farion1231/cc-switch/discussions/1973) DashScope content 字段错误 | 填对地址后仍可能选错协议或模型能力 | 预览最终 endpoint、协议与路径；不能仅用 `/models` 成功宣称对话一定可用 | P0 |
| [Codex++ #352](https://github.com/BigPizzaV3/CodexPlusPlus/issues/352) 更新后历史不可见；[cc-switch #7257](https://github.com/farion1231/cc-switch/issues/7257) 区分 provider 分桶和跨供应商加密上下文 | 用户最怕切换/升级后任务断掉 | 保留备份、只读聚合历史；区别「看得到」和「能继续」；不自动重写会话文件 | P0 |
| [magpie #994](https://github.com/yetone/magpie/issues/994) 固定 provider ID；[#2642](https://github.com/yetone/magpie/issues/2642) 原生压缩只能原账号读 | 账号/供应商切换与上下文存在绑定 | 稳定配置标识；遇到不能跨账号续接的上下文明确提示，而非删除信息或承诺无损迁移 | P0 |
| [Codex++ #3001](https://github.com/BigPizzaV3/CodexPlusPlus/issues/3001) 新会话找不到模型；[#1594](https://github.com/BigPizzaV3/CodexPlusPlus/issues/1594) 上下文被固定值覆盖 | 用户需要模型和参数真实生效 | 远端目录版本、刷新模型、原始 ID、配置与实际调用一致；上下文非硬编码 | P0 |
| [magpie #1418](https://github.com/yetone/magpie/issues/1418) 用户希望满载时换上游；[维护者评论](https://github.com/yetone/magpie/issues/1418#issuecomment-6082716324) 要求查看候选及跳过原因 | 自动重试需要解释，并区分是否已经交付流式输出 | 展示重试/候选结果、耗时与冷却；输出后不偷偷重放 | P0/P1 |
| [cc-switch Discussions #898](https://github.com/farion1231/cc-switch/discussions/898)、[#1665](https://github.com/farion1231/cc-switch/discussions/1665) 请求无 GUI 服务器支持 | 桌面界面不能成为管理 API 的唯一入口 | 保留独立网关 CLI、受控 RPC、远程伴侣 | P0 |
| [Codex++ #101](https://github.com/BigPizzaV3/CodexPlusPlus/issues/101) 移动连接与更新；评论讨论 API 登录和官方手机连接差异；[magpie #545](https://github.com/yetone/magpie/issues/545) 局域网能力共享 | 用户希望离开电脑后仍能查看和管理 | iOS 内置管理 UI、访问令牌、远程会话查看、明确电脑在线要求 | P0 |
| [cc-switch Discussion #1687](https://github.com/farion1231/cc-switch/discussions/1687) Skills 搜不到；[Codex++ #558](https://github.com/BigPizzaV3/CodexPlusPlus/issues/558) 插件市场空白 | 插件的发现、来源和错误状态都影响体验 | 区分内置插件、MCP、Skills；搜索/空状态/错误状态；清单与权限可查看 | P1 |
| [cc-switch Discussion #1038](https://github.com/farion1231/cc-switch/discussions/1038) GLM quota 脚本；[#2171](https://github.com/farion1231/cc-switch/discussions/2171) 离线额度估计 | 用户关心还剩多少、离线时是否能看 | 真实额度与估算用量分开；显示更新时间；失败保留缓存而非显示假零 | P1 |
| [cc-switch Discussion #1823](https://github.com/farion1231/cc-switch/discussions/1823)、[issue #4043](https://github.com/farion1231/cc-switch/issues/4043) Windows 和 WSL 同时管理 | 一个客户端可能有多个安装位置 | 把运行环境/配置路径作为绑定维度，不假定一机一个固定路径 | P1 |
| [magpie #2278](https://github.com/yetone/magpie/issues/2278) 会话页内存压力报告 | 历史多了界面仍须能响应 | 有界读取、索引缓存、分页、取消旧搜索；性能验收数据量写清楚 | P1 |

## 与本项目最相关的产品结论

第一优先级是让一个普通用户能完成「我用 Claude / Codex → 我有某供应商 Key → 选模型 → 应用」，并知道究竟成功在哪里。第二优先级是配置和历史可信：备份、恢复、真实错误、模型实际能力。第三优先级才是扩展数量和高级自动化。

首页以客户端为中心，供应商是可复用的连接资源，厂商是模型来源维度。把三个名词混成一页会迫使用户先学内部结构。首次流程和高级管理共用数据，但信息密度不同。

本次设计不宣称可以把任意 API 塞进所有官方桌面 App。特别是 [cc-switch Discussion #2397](https://github.com/farion1231/cc-switch/discussions/2397) 提到 Claude Desktop 新的 gateway 能力，说明必须核对最新官方入口，不能照旧知识一概判为不支持；ChatGPT Desktop 和 Codex Desktop 也必须分别建模。

详细流程、界面、架构、阶段和验收见 [DESIGN.md](DESIGN.md)。
