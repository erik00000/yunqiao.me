# 客户端配置目录与接入流程

ChatGPT 桌面入口可以直接预览、备份和保存 Codex 共享编程配置。程序安装位置与配置目录分别识别；找不到 `.exe` 或 `.app` 不再阻止配置保存。

| 用途 | Windows | macOS |
| --- | --- | --- |
| Codex 共享配置 | `%USERPROFILE%\.codex\config.toml` | `~/.codex/config.toml` |
| 原客户端登录文件 | `%USERPROFILE%\.codex\auth.json` | `~/.codex/auth.json` |
| 自定义 Codex 配置目录 | 已设置 `CODEX_HOME` 时使用其中的 `config.toml` | 同左 |
| Claude Code 用户配置 | `%USERPROFILE%\.claude\settings.json`，遵循 `CLAUDE_CONFIG_DIR` | `~/.claude/settings.json`，遵循 `CLAUDE_CONFIG_DIR` |
| Gemini CLI | `%USERPROFILE%\.gemini\settings.json` 与 `.env` | `~/.gemini/settings.json` 与 `.env` |

向导显示本次实际使用的配置路径。Claude 桌面版另用系统对应的应用数据目录与 `Claude-3p/configLibrary`，不套用 Claude Code 路径；多目录有冲突时先确认位置。

## 配置流程

1. 选择客户端、供应商和模型。运行时发现的本地 API 配置会导入供应商列表；官方 OAuth 登录记录单独识别。
2. 在“共享编程配置”查看实际路径。已有文件会标为“已发现配置”，首次配置会标为“应用时创建”。
3. 预览脱敏差异后点击“备份并应用配置”。预览不修改配置；应用时检查文件是否被其他程序修改，有冲突则要求重新预览。
4. 重启读取这份配置的客户端。需要云桥一键重启或桌面增强时，展开“程序识别”，重新检测或选择 Windows 主程序/macOS `.app`。选择程序不会自动应用配置；更换程序会断开已有增强连接。
5. 需要撤销时使用“恢复”。桌面入口和 CLI 共用同一份配置与首次备份，修改和恢复状态同步。

共享配置由 Codex CLI 和支持 Codex 编程配置的桌面版本读取。纯聊天版 ChatGPT 不会因此切换 API。保存成功只表示文件已备份并写入，不代表所有桌面版本都已通过运行验证。

## 官方账号与 API 模式

普通 API 模式写入独立供应商及其 Bearer 令牌，不改写 `auth.json`。某些桌面版本可能因此暂时隐藏官方聊天或云功能；保留登录文件与保留界面中的官方身份呈现是不同的行为。

需要同时使用官方账号与第三方模型时，选择“保留官方账号并与第三方模型共存”。此模式需要有效的本机官方登录和模型目录；官方请求与第三方请求使用分开的认证。详情见 [官方账号共存](CODEX-COEXISTENCE.md)。

## 验证

回归测试使用独立临时目录，覆盖未安装桌面程序时的预览、应用、恢复、登录文件字节不变、`CODEX_HOME`、CLI/桌面状态同步和外部编辑冲突。原生应用包测试进一步验证真实界面与 IPC 的完整流程。测试不会修改个人客户端配置或发起付费模型请求。
