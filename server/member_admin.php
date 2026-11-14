<?php
declare(strict_types=1);
require_once __DIR__ . '/lib.php';
require_once __DIR__ . '/member_service.php';
boot_session();
header('Cache-Control: no-store, private');
header('X-Content-Type-Options: nosniff');
if (!is_logged_in()) { header('Location: index.php'); exit; }
$message = '';
$errorMessage = '';
try {
    $service = new MemberService(MemberService::environment());
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
        check_csrf();
        $userId = filter_var($_POST['userId'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        $action = (string)($_POST['action'] ?? '');
        if ($userId === false || !in_array($action, ['reconcile', 'retry'], true)) throw new MemberError('INVALID_ACTION', '操作参数无效');
        $service->adminReconcile((int)$userId, $action === 'retry');
        $message = '账户 #' . $userId . ' 的 $10 赠金已根据上游核销凭据确认到账。';
    }
    $overview = $service->adminOverview();
} catch (MemberError $error) {
    $errorMessage = $error->getMessage();
    $overview = $service->adminOverview();
} catch (Throwable $error) {
    $errorMessage = '会员存储或配置不可用，请检查 PHP 扩展、配置文件权限与服务器日志。';
    $overview = ['enabled' => false, 'totals' => ['claimed' => 0, 'pending' => 0, 'review' => 0, 'amountUsd' => 0], 'grants' => []];
    error_log('Aurora member administration failure: ' . get_class($error));
}
function member_h($value): string { return htmlspecialchars((string)$value, ENT_QUOTES, 'UTF-8'); }
$labels = ['pending' => '待确认', 'claimed' => '已到账', 'review' => '待核对'];
?>
<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>会员与赠金 · 云桥AI</title>
<style>
:root{font-family:'PingFang SC','Microsoft YaHei',system-ui,sans-serif;color:#233047;background:#f5f7fb;font-size:14px}*{box-sizing:border-box}body{margin:0}.wrap{max-width:1200px;margin:0 auto;padding:36px 28px}a{color:#5265db;text-decoration:none}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:26px;gap:24px}h1{font-size:28px;margin:10px 0}p{line-height:1.8;color:#69758a;margin:0}.tag{border-radius:30px;padding:7px 13px;background:#e7f6ee;color:#24845b;white-space:nowrap}.tag.off{background:#fff0df;color:#a7641b}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin:24px 0}.card{border:1px solid #e3e8f1;background:white;border-radius:16px;padding:22px;box-shadow:0 4px 16px #273c5d04}.card strong{display:block;font-size:30px;margin-top:8px}.panel{padding:24px;border:1px solid #e3e8f1;border-radius:18px;background:white;margin-top:18px}h2{font-size:17px;margin:0 0 12px}.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:710px;text-align:left;font-size:13px}th{color:#7b8595;font-weight:500;background:#fafbfe}th,td{padding:15px 12px;border-bottom:1px solid #eef1f6}form{display:inline}button{border:1px solid #dce2f0;border-radius:8px;background:white;color:#4858bb;padding:8px 11px;cursor:pointer;margin:2px}.status{font-weight:600}.claimed{color:#268461}.pending{color:#b07821}.review{color:#bd4b4b}.notice{padding:14px 18px;border-radius:12px;background:#e7f6ee;color:#236e50;margin:16px 0}.error{background:#fff0ee;color:#ab4940}.empty{text-align:center;padding:45px;color:#8892a5}.small{font-size:12px;color:#8a93a4}.footer{padding:18px 2px}@media(max-width:720px){.wrap{padding:20px 16px}.cards{grid-template-columns:repeat(2,1fr)}header{align-items:flex-start;flex-direction:column}.card{padding:16px}.panel{padding:15px}h1{font-size:24px}}
</style></head><body><main class="wrap">
<header><div><a href="index.php">← 返回云端管理</a><h1>会员与首次使用赠金</h1><p>客户端登录云桥会员后，可领取一次 $10 体验额度。</p></div><span class="tag <?= $overview['enabled'] ? '' : 'off' ?>"><?= $overview['enabled'] ? '会员服务已启用' : '会员服务未就绪' ?></span></header>
<?php if ($message): ?><div class="notice"><?= member_h($message) ?></div><?php endif; ?>
<?php if ($errorMessage): ?><div class="notice error"><?= member_h($errorMessage) ?></div><?php endif; ?>
<div class="cards"><div class="card">已到账会员<strong><?= member_h($overview['totals']['claimed']) ?></strong></div><div class="card">累计赠送额度<strong>$<?= member_h($overview['totals']['amountUsd']) ?></strong></div><div class="card">等待确认<strong><?= member_h($overview['totals']['pending']) ?></strong></div><div class="card">需要核对<strong><?= member_h($overview['totals']['review']) ?></strong></div></div>
<section class="panel"><h2>发放流程</h2><p>登录验证会员身份 → 绑定本机安装 → 固定生成 $10 兑换凭据 → 自动核销到同一会员账户。每个会员账户和每份客户端安装各限一次。</p><p>连接中断时，先用“核对到账”读取上游凭据；尚未到账的申请可用“重试原申请”继续。重试始终使用原有兑换码和同一账户。</p></section>
<section class="panel"><h2>最近 200 条赠金申请</h2><div class="scroll"><table><thead><tr><th>会员 ID</th><th>状态</th><th>申请时间</th><th>上游凭据</th><th>最近结果</th><th>处理</th></tr></thead><tbody>
<?php foreach ($overview['grants'] as $grant): ?><tr><td>#<?= member_h($grant['userId']) ?></td><td class="status <?= member_h($grant['status']) ?>"><?= member_h($labels[$grant['status']] ?? $grant['status']) ?></td><td><?= member_h(date('Y-m-d H:i:s', (int)$grant['createdAt'])) ?></td><td><?= $grant['upstreamId'] ? '#' . member_h($grant['upstreamId']) : '—' ?></td><td class="small"><?= member_h($grant['lastError'] ?: '—') ?></td><td>
<?php if ($grant['status'] !== 'claimed'): ?><form method="post"><input type="hidden" name="_csrf" value="<?= member_h(csrf_token()) ?>"><input type="hidden" name="userId" value="<?= member_h($grant['userId']) ?>"><button name="action" value="reconcile">核对到账</button><?php if ($grant['status'] === 'pending'): ?><button name="action" value="retry">重试原申请</button><?php endif; ?></form><?php else: ?><span class="small"><?= member_h(date('m-d H:i', (int)$grant['claimedAt'])) ?> 已确认</span><?php endif; ?>
</td></tr><?php endforeach; ?>
<?php if (!$overview['grants']): ?><tr><td colspan="6" class="empty">暂无赠金申请。会员首次在客户端领取后会显示在这里。</td></tr><?php endif; ?>
</tbody></table></div></section><p class="footer small">余额和最终核销结果以云桥会员站点为准。此页面不会显示管理员密钥、登录令牌或客户 API Key。</p>
</main><footer style="text-align:center;padding:20px;color:#7b8595;font-size:12px"><a href="https://github.com/jxb412/aurora/tree/v0.6.0" target="_blank" rel="noopener noreferrer">yunqiao.me · v0.6.0 对应源码</a> · <a href="https://github.com/jxb412/aurora/blob/v0.6.0/LICENSE" target="_blank" rel="noopener noreferrer">AGPL-3.0 许可</a></footer>
</body></html>
