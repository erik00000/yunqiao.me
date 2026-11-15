# 远端目录与版本服务

现有站点：`https://ai.haowucm.cn`，服务器网站目录 `/www/wwwroot/ai.haowucm.cn`。2026-11-15 只读核实已有四个 PHP 入口和 releases 目录；公开目录正常返回 v6、44 家供应商。本轮未覆盖正在运行的站点或发布更新元数据。

## 客户端读取

| 接口 | 用途 |
| --- | --- |
| `/pub.php?action=catalog` | 获取公开供应商预设和模型元数据 |
| `/pub.php?action=update` | GitHub 不可用时查询官网备用版本与安装包链接 |

客户端启动时自动读取官方目录并缓存，设置页不再显示目录地址、验证按钮和自动模型同步开关。保存有启用密钥的供应商后自动同步模型；升级和导入旧备份时会统一开启。目录拉取校验协议、地址、字段与数量；失败时使用本地最后成功的缓存并提示来源。目录不包含用户 API Key，也不自动应用可执行脚本。

桌面「系统设置 → 版本更新」默认查询 `https://api.github.com/repos/jxb412/aurora/releases/latest`，匹配当前操作系统与处理器的安装包，跳过草稿、预发布、源码和未签名 iOS ZIP。GitHub 不可用或缺少匹配安装包时自动查询官网。客户也可点击「官网备用」，此时必须取得同版本或更新版本的官网安装包，旧版或未同步的包不会提供下载。检查更新不会自动打开浏览器，网站管理首页不作为下载入口。

官网仍使用现有更新接口，客户端传入 `platform`、`arch`、`current`。Windows 包名遵循 `YunQiaoAI-版本-win-架构-setup.exe`（或 `portable.exe`）；macOS 为 `YunQiaoAI-版本-mac-架构.dmg`，Linux 为 `YunQiaoAI-版本-linux-架构.AppImage`。备用文件应放在官网 HTTPS `/releases/` 下，并与后台版本一致。

2026-11-15 只读检查：GitHub v0.5.0 标记为预发布，v0.6.0 为草稿，尚无正式版，`releases/latest` 返回 404；官网仍为 0.4.0。本地 0.6.0 会回退官网检查并判定无需更新，不会提示降级。本轮未改变线上发布状态。

厂商模板与用户配置分离：导入目录创建供应商模板，用户自行填写密钥。列表中保留原始模型 ID；价格/上下文信息以服务商实际说明为准。

## PHP 后台源码

入口在 `server/`，依赖 PHP 8.1+ 与 `mbstring`；会员和模型同步还需 `pdo_sqlite`、`openssl`、`curl`。目录、管理密码和版本信息保存在站点外部的数据目录（默认 `/www/aurora-data`）。Web 用户需对该目录有必要读写权限。

新部署没有固定默认管理密码。设置环境变量 `AURORA_ADMIN_PASSWORD`，或在第一次初始化后由管理员通过 SSH 读取数据目录中的 `initial-admin-password.txt`。已部署站点的现有密码配置保持不变；不要通过删字段恢复所谓默认密码。

后台写操作要求 POST、管理员会话和 CSRF。管理 JSON 响应禁止缓存，登录失败次数通过独立 IP 文件锁更新，并发会话也遵守五次失败后锁定五分钟的限制；计数落盘失败不会放行登录。

配置初始化只适用于 `config.json` 不存在的新部署。已有文件缺少或损坏密码字段时明确报错，保留管理密码、版本元数据和统计。设置、版本与匿名 ping 共享稳定配置锁；访问统计使用另一稳定锁和原子替换，管理员清空统计也参与同一锁。统计写入失败保留原文件，公开目录仍可读取；管理端清空失败返回错误。

目录导入拒绝畸形 JSON、非对象请求、遗漏 `providers`、错误的供应商记录、重复标识及超过 4MB 的请求。导入完整校验通过后才替换目录；显式 `providers: []` 仍表示管理员有意导入空目录。目录保存失败不递增调用者可见的版本号。公开更新按实际选中的平台下载地址返回对应 SHA256，包括通用平台回退。

会员账本首次创建由初始化锁与 SQLite 事务保护。已有空文件、缺少必要表/列、丢失站点来源记录或来源不匹配时停止操作，不能自动新建赠金历史。验证失败和初始化标记写入失败不会留下可复用的数据库连接；管理员页面显示服务不可用，避免在错误处理时再次抛出异常。完全丢失账本及初始化标记仍需要依赖备份和运营监控发现，不能把无痕丢失与全新部署自动区分。

2026-11-15 本地使用 `tmp/php/php.exe`（PHP 8.4.27）实际运行隔离测试，未访问生产账号或发放真实赠金：

| 测试 | 结果 |
| --- | --- |
| `scripts/test-server-storage.php` | 7项，配置损坏、写入失败、发布校验和统计回滚 |
| `scripts/test-config-concurrency.php` | 5项，9进程保留160次ping及120次统计递增 |
| `scripts/test-admin-auth.php` | 4项，8并发登录、锁定过期及存储失败 |
| `scripts/test-server-api.php` | 18项，真实本机PHP HTTP登录、CSRF、错误导入、容量限制、更新和统计故障 |
| `scripts/test-members.php` | 18项，8进程发放去重、首次初始化、空/缺表账本、失败重试 |
| `scripts/test-catalog-sync.php` | 8项，候选白名单、失败保留缓存、精选和并发管理员修改 |
| `scripts/test-catalog-publish.php` | 4项，模拟目录/审计写入失败，准确反馈已生效结果和幂等补记 |

Windows 便携 PHP 没有全局 `php.ini`，会员测试需附加 `-d extension_dir=D:/btc/aurora/tmp/php/ext -d extension=pdo_sqlite -d extension=openssl`，HTTP 测试附加 `-d extension_dir=D:/btc/aurora/tmp/php/ext -d extension=mbstring`。所有 `server/*.php` 和 `scripts/*.php` 已通过该解释器 `php -l`。这些测试验证本地实现；Linux PHP-FPM、Nginx、实际磁盘权限和真实上游仍需部署环境验收。本轮没有部署或改写线上配置。

精选目录和同步审计仍分别保存。目录写入失败返回错误；目录已生效后审计写入失败则返回成功与 `auditSaved:false` 警示，后台页面明确说明已生效及补记方法。重新选择相同模型可安全重试补记，不重复加入模型或递增公开版本。进程在两个文件提交之间被强制终止时仍可能缺少审计，需要管理员核对后补记；跨文件提交不具备数据库事务的崩溃恢复保证。

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
