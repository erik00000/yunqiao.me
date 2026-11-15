# 历史会话供应商区域迁移

“区域”指 Codex / ChatGPT 编程模块按原生 `model_provider` 隔离的历史列表。它是客户端配置里的供应商标识，例如 `openai`、`yunqiao`、旧版 `aurora` 或自定义 provider；不是模型名，也不是云桥自己的供应商 UUID。迁移后需要在原客户端选择对应 provider 才能看到并续接该区域的会话。

操作入口：**历史会话 → 批量修复历史 / 区域迁移 → 供应商区域迁移**。先选来源和目标，扫描预览，勾选要处理的会话，退出原客户端后确认执行。例如把 `old-relay` 的历史迁到 `openai`，可让它归属官方账号与中转共存使用的区域；正文与原账号的加密内容保持原样，迁移归属不保证跨账号加密上下文可以继续使用。

云桥新的 API 配置使用 `yunqiao`。旧版 `aurora` 会话仍可扫描和迁移：应用新配置后，选择来源 `aurora`、目标 `yunqiao`，预览并执行需要迁移的会话。仅更换配置标识不会自动改写正在使用的历史数据库；原会话内容与迁移前备份继续保留。

## 只读发现与预览

`codex.repair.providers` 返回：

```ts
{
  ok: boolean,
  currentProvider: string,
  targets: Array<{ id: string, name: string, current: boolean }>,
  sources: Array<{ id: string, count: number, active: number, archived: number }>,
  warnings: string[]
}
```

目标来自完整 TOML 解析后的根配置与旧式 `profiles` 表中当前活动 profile，包括内置 `openai`。不自动识别新版 CLI 通过 `--profile` 选中的独立配置文件。允许合法的引号、点号和中文标识；跳过非对象 provider、未激活 profile 的专有 provider、内部保留别名 `codex_plus_managed`。配置损坏时拒绝执行，不返回解析器携带的原始配置文本。

来源和数量按唯一原生 `threads.id` 去重，活动/归档状态以同一行的 `archived` 为准。历史 provider 即使已从配置删除仍显示。日志里残留的旧 provider 不会把已经迁至另一区域的原生会话重新选中。仅有日志、重复 canonical 行、无有效 provider 的记录会提示，其数量不会伪装成可迁移区域。

`codex.repair.preview` / `apply` 接受相同选项：

```ts
{
  sourceProvider?: string, // 留空为归属修复；指定时只匹配 native threads
  targetProvider?: string, // 留空为当前有效 profile/provider
  scope?: 'active' | 'archived' | 'all',
  ids?: string[],
  fixPaths?: boolean,
  revision?: string       // apply 必填，与最后一次预览一致
}
```

预览逐项返回原生归属、日志元数据归属、目标和修改原因。指定来源后，如果本机 `local_thread_catalog` 既不属于来源也不属于目标，该项阻止迁移；多个 canonical 行、子任务、缺少原文件或必要索引、无法确认的路径和不完整 JSONL 同样跳过。

历史列表 `SessionSummary.modelProvider` 优先读取原生索引，缺索引时才使用 `session_meta`；`archived` 优先使用原生状态，缺失时依据目录。重复 canonical 身份不猜测供应商区域。

## 写入、备份与恢复

先退出原客户端，再确认预览中的会话。执行同步所有相关 JSONL 的 `session_meta.model_provider`、原生 `threads` 和已确认本地主机的 `local_thread_catalog`。远程主机目录、会话 ID、模型参数、聊天正文、加密内容、活动配置及登录凭据保持原样；会话文件不发生物理迁移，归档标记也不改变。

写入前保存完整原文件、SQLite `VACUUM INTO` 快照以及字段级日志。配置/文件/索引哈希和写锁再次校验后才执行；SQL 更新使用原值条件，拒绝覆盖变化的归属。单库事务和跨库失败补偿配合日志保护一致性；多个 SQLite 库与 JSONL 不能承诺断电时整体原子提交，中断批次必须先检查并恢复，才允许新的迁移。

`codex.repair.restorePreview` / `restore` 根据备份批次仅恢复本次修改的字段及原始文件，不整库替换。继续聊过的文件、后续改动或被删除的原生行会形成冲突并保留现状。原始备份持续保留。

## 验证

`scripts/test-history-repair.mjs` 覆盖区域发现、活动 profile、退役来源、跨 provider / 归档范围、按 ID 选择、元数据和原生归属不一致、远程目录保护、字节级恢复、重复 canonical 身份、配置错误脱敏，以及单库/分库 SQLite 写入失败后的文件与索引回滚。全部使用隔离临时目录。

历史后端 37 项通过，其中包含旧 `aurora` 到 `yunqiao` 的来源发现、活动/归档会话迁移与精确恢复。原生消息索引回归 18 项通过。`python scripts/test-history-ui.py` 的 7 项检查通过实际 React 界面调用隔离的修复服务与真实 SQLite，验证部分迁移、界面恢复、预览过期和实际数据库写入失败回滚。
