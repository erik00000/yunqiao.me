# 远端目录与版本服务

现有站点：`https://ai.haowucm.cn`，服务器网站目录 `/www/wwwroot/ai.haowucm.cn`。2026-11-15 只读核实已有四个 PHP 入口和 releases 目录；公开目录正常返回 v6、44 家供应商。本轮未覆盖正在运行的站点或发布更新元数据。

## 客户端读取

| 接口 | 用途 |
| --- | --- |
| `/pub.php?action=catalog` | 获取公开供应商预设和模型元数据 |
| `/pub.php?action=update` | 查询版本与安装包链接 |

桌面「系统设置 → 云端与更新」可以修改这两个 URL。目录拉取校验协议、地址、字段与数量；失败时使用本地最后成功的缓存并提示来源。目录不包含用户 API Key，也不自动应用可执行脚本。

厂商模板与用户配置分离：导入目录创建供应商模板，用户自行填写密钥。列表中保留原始模型 ID；价格/上下文信息以服务商实际说明为准。

## PHP 后台源码

入口在 `server/`，依赖 PHP 8。目录、管理密码和版本信息保存在站点外部的数据目录（默认 `/www/aurora-data`）。Web 用户需对该目录有必要读写权限。

新部署没有固定默认管理密码。设置环境变量 `AURORA_ADMIN_PASSWORD`，或在第一次初始化后由管理员通过 SSH 读取数据目录中的 `initial-admin-password.txt`。已部署站点的现有密码配置保持不变；不要通过删字段恢复所谓默认密码。

本轮源码包含后台写操作的 POST 限制、登录会话更新、公开目录白名单等修复。本机完成 PHP 语法解析；真实 PHP 运行/部署验收需要在服务器进行。

## 部署

SSH 主机默认为 `58.49.150.136:4413`，用户默认为 `root`。所有密码通过交互输入或 `AURORA_SSH_PASSWORD` 环境变量传入；源码与安装包不内置 SSH 密码。主机指纹保存在 `scripts/ssh-host-fingerprint.txt`，换服务器时先核实并配置 `AURORA_SSH_FINGERPRINT`。

```powershell
# 只显示部署计划
python scripts/deploy_php.py

# 审阅源码后部署四个 PHP 文件
python scripts/deploy_php.py --apply

# 只显示当前版本安装包及 SHA256
python scripts/deploy_release.py

# 上传当前版本安装包，不自动发布更新元数据
python scripts/deploy_release.py --apply
```

PHP 脚本先暂存到网站目录之外并逐个运行 `php -l`，检查通过后保留旧文件至 `/www/aurora-backups/<时间>/`，再逐文件原子替换。不重新初始化供应商目录、账号密码或版本信息；也不递归修改网站所有权。若服务器 PHP CLI 路径不同，先调整脚本使用的 CLI 路径。

安装包上传脚本只上传 package.json 当前版本的 setup/portable 两个文件，拒绝覆盖已经存在的同名版本。上传后，在后台另行核实版本、下载地址与说明，再发布更新信息。

## 目录示例

```json
{
  "version": 1,
  "providers": [{
    "key": "example",
    "name": "示例供应商",
    "vendor": "示例厂商",
    "region": "cn",
    "format": "openai-chat",
    "baseUrl": "https://api.example.com/v1",
    "models": [{ "id": "example-chat" }]
  }]
}
```

可用协议：`openai-chat`、`openai-responses`、`anthropic`、`gemini`。协议必须与上游接口匹配；API 路径、价格和模型能力在添加/更新后应进行连接验证。
