"""Electron integration checks against an isolated profile and local mock upstream.
Requires: pip install playwright; npm run build. No real client configuration is touched.
"""
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from playwright.sync_api import sync_playwright
import json
import os
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]

class Upstream(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_GET(self): self.reply({'data': [{'id': 'aurora-test-model'}, {'id': 'aurora-test-reasoning'}]})
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.reply({'id': 'test-chat', 'object': 'chat.completion', 'model': body.get('model'), 'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': '连接测试成功'}, 'finish_reason': 'stop'}], 'usage': {'prompt_tokens': 4, 'completion_tokens': 4}})
    def reply(self, value):
        body = json.dumps(value).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)

def main():
    profile = Path(tempfile.mkdtemp(prefix='aurora-ui-'))
    data = profile / 'data'; data.mkdir()
    clients = profile / 'clients'; (clients / '.claude').mkdir(parents=True)
    original = '{\n  "permissions": { "allow": ["Read"] },\n  "env": { "USER_VARIABLE": "preserved" }\n}\n'
    config = clients / '.claude' / 'settings.json'; config.write_text(original, encoding='utf-8')
    session = clients / '.claude' / 'projects' / 'aurora-ui' / 'ui-session.jsonl'; session.parent.mkdir(parents=True)
    session.write_text('\n'.join(json.dumps(x, ensure_ascii=False) for x in [
        {'type': 'user', 'sessionId': 'ui-session', 'cwd': str(clients), 'timestamp': '2026-11-15T01:00:00Z', 'message': {'role': 'user', 'content': '这是云桥界面验证会话'}},
        {'type': 'assistant', 'timestamp': '2026-11-15T01:00:01Z', 'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': '会话读取成功，配置保持完整。'}]}},
    ]), encoding='utf-8')
    port, debug_port = free_port(), free_port()
    (data / 'settings.json').write_text(json.dumps({'theme': 'light', 'gatewayPort': port, 'autoCheckUpdate': False, 'closeToTray': False}), encoding='utf-8')
    server = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    env = dict(os.environ, AURORA_HOME=str(data), YUNQIAO_HOME=str(data), AURORA_CLIENT_HOME=str(clients), AURORA_UI_TEST='1')
    env.pop('ELECTRON_RUN_AS_NODE', None)
    logs = open(profile / 'electron.log', 'w', encoding='utf-8')
    process = subprocess.Popen([str(ROOT / 'node_modules/electron/dist/electron.exe'), str(ROOT), f'--remote-debugging-port={debug_port}', f'--user-data-dir={profile / "chromium"}'], env=env, stdout=logs, stderr=logs, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    report = []
    def passed(label): report.append(label); print('PASS', label, flush=True)
    try:
        for _ in range(100):
            try: urllib.request.urlopen(f'http://127.0.0.1:{debug_port}/json/version', timeout=.5); break
            except Exception:
                if process.poll() is not None: raise RuntimeError('Electron exited. See ' + str(profile / 'electron.log'))
                time.sleep(.2)
        with sync_playwright() as pw:
            browser = pw.chromium.connect_over_cdp(f'http://127.0.0.1:{debug_port}')
            page = browser.contexts[0].pages[0]
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.get_by_role('heading', name='连接你的 AI 客户端.').wait_for(timeout=20000)
            assert page.locator('article.client-card').count() >= 10
            assert not page.evaluate('document.querySelector("main").scrollWidth > document.querySelector("main").clientWidth')
            (ROOT / 'docs/images').mkdir(exist_ok=True)
            page.screenshot(animations="disabled", path=str(ROOT / 'docs/images/clients-v0.5.png'))
            passed('Electron sandbox + IPC + initial client workspace')
            page.get_by_role('button', name='桌面应用', exact=True).click()
            assert page.locator('article.client-card').count() > 0
            assert page.locator('article.client-card').filter(has=page.get_by_role('heading', name='Claude Code', exact=True)).count() == 0
            page.get_by_role('button', name='全部客户端', exact=True).click()
            passed('Client category filtering')
            card = page.locator('article.client-card').filter(has=page.get_by_role('heading', name='Claude Code', exact=True))
            card.get_by_role('button', name='开始配置').click()
            modal = page.get_by_role('dialog')
            modal.get_by_label('供应商名称', exact=True).fill('本地验证供应商')
            modal.get_by_label('API 地址', exact=True).fill(f'http://127.0.0.1:{server.server_port}')
            modal.get_by_label('API Key', exact=True).fill('test-only-no-real-key')
            modal.get_by_label('模型 ID', exact=True).fill('aurora-test-model')
            modal.get_by_role('button', name='保存并选模型').click()
            modal.get_by_label('选择模型', exact=True).wait_for()
            modal.get_by_role('button', name='测试连接', exact=True).click()
            modal.get_by_text('连通正常', exact=False).wait_for(timeout=15000)
            modal.get_by_role('button', name='预览配置').click()
            modal.get_by_text('当前配置', exact=True).wait_for()
            assert 'test-only-no-real-key' not in modal.inner_text()
            page.screenshot(animations="disabled", path=str(ROOT / 'docs/images/connect-v0.5.png'))
            modal.get_by_role('button', name='备份并应用配置').click()
            page.wait_for_timeout(600)
            if modal.locator('.notice.warning').count() > len(modal.locator('.config-preview').all()):
                print('Wizard notices:', modal.locator('.notice.warning').all_inner_texts(), flush=True)
            modal.get_by_role('heading', name='配置已应用', exact=True).wait_for()
            updated = json.loads(config.read_text(encoding='utf-8'))
            assert updated['permissions']['allow'] == ['Read']
            assert updated['env']['USER_VARIABLE'] == 'preserved'
            assert updated['env']['ANTHROPIC_BASE_URL'].startswith(f'http://127.0.0.1:{port}')
            modal.get_by_role('button', name='完成', exact=True).click()
            passed('Client -> add provider -> model -> live connection test -> redacted preview -> apply')
            card.get_by_role('button', name='恢复', exact=True).click()
            page.get_by_role('dialog').get_by_role('button', name='恢复原配置', exact=True).click()
            page.get_by_role('dialog').wait_for(state='hidden')
            assert config.read_text(encoding='utf-8') == original
            passed('Restore original client configuration byte-for-byte')
            page.locator('nav').get_by_role('button', name='历史会话', exact=True).click()
            page.get_by_text('这是云桥界面验证会话', exact=True).first.click()
            page.get_by_text('会话读取成功，配置保持完整。', exact=False).wait_for()
            with page.expect_download() as download_info:
                page.get_by_role('button', name='导出', exact=True).click()
            downloaded = profile / 'session.md'; download_info.value.save_as(downloaded)
            assert '会话读取成功' in downloaded.read_text(encoding='utf-8')
            passed('Session discovery, reading and real Markdown download')
            page.locator('nav').get_by_role('button', name='厂商目录', exact=True).click()
            page.get_by_label('搜索厂商或模型').fill('DeepSeek')
            page.locator('.catalog-card').first.wait_for(timeout=25000)
            assert page.locator('.catalog-card').count() >= 1
            passed('Live remote catalog loading and model/vendor search')
            page.get_by_role('button', name='切换浅色 / 深色').click()
            page.wait_for_function('document.documentElement.dataset.theme === "dark"')
            page.screenshot(animations="disabled", path=str(ROOT / 'docs/images/dark-v0.5.png'))
            page.get_by_role('button', name='切换浅色 / 深色').click()
            page.keyboard.press('Control+k')
            page.get_by_label('搜索功能', exact=True).fill('系统设置')
            page.get_by_role('dialog').get_by_role('button', name='系统设置').click()
            page.get_by_role('heading', name='系统设置', exact=True).wait_for()
            passed('Persistent theme switch and keyboard command navigation')
            page.get_by_role('button', name='网关与隐私', exact=True).click()
            page.get_by_label('网关端口', exact=True).fill('1')
            page.get_by_role('button', name='保存设置', exact=True).click()
            page.get_by_text('端口应为 1024–65535 之间的整数', exact=True).wait_for()
            page.get_by_role('button', name='放弃修改', exact=True).click()
            passed('Settings validation prevents invalid gateway port')
            rollback = page.evaluate('''async port => {
                const original = await window.aurora.invoke('state.get');
                const result = await window.aurora.invoke('settings.save', {gatewayPort: port});
                const after = await window.aurora.invoke('state.get');
                return {failed: !!result.error, originalPort: original.settings.gatewayPort, savedPort: after.settings.gatewayPort, running: after.gateway.running, actualPort: after.gateway.port};
            }''', server.server_port)
            assert rollback['failed'] and rollback['running'] and rollback['originalPort'] == rollback['savedPort'] == rollback['actualPort'], rollback
            passed('Occupied port rolls back settings and restores the actual listener')
            page.get_by_role('button', name='云端与更新', exact=True).click()
            page.screenshot(animations="disabled", path=str(ROOT / 'docs/images/settings-v0.5.png'))
            for name, title in [('模型管理', '模型'), ('路由分组', '路由分组'), ('运行概览', '仪表盘'), ('我的供应商', '我的供应商'), ('本地账号', '本地账号'), ('用量与账单', '用量')]:
                page.locator('nav').get_by_role('button', name=name, exact=False).click()
                page.locator('main h1').wait_for()
                assert page.locator('main h1').inner_text()
            passed('All primary navigation pages render')
            page.locator('nav').get_by_role('button', name='插件中心', exact=True).click()
            page.get_by_role('heading', name='插件中心', exact=True).wait_for()
            assert page.get_by_role('switch').count() > 0
            switch = page.get_by_role('switch').first
            switch.click()
            page.wait_for_function('document.querySelector("button[role=switch]")?.getAttribute("aria-checked") === "true"')
            plugins = page.evaluate('async () => (await window.aurora.invoke("state.get")).plugins')
            assert any(p['enabled'] and p.get('builtin') for p in plugins)
            switch.click()
            passed('Built-in plugin can be enabled, persisted and disabled in the UI')
            page.locator('nav').get_by_role('button', name='Codex 工作台', exact=True).click()
            page.locator('main h1').wait_for()
            assert page.get_by_text('MCP 服务器', exact=False).count() > 0
            passed('Codex extension workspace renders local resource categories')
            assert not errors, errors
            # Verify real browser path uses token authentication and does not expose secrets.
            web = pw.chromium.launch(headless=True)
            web_page = web.new_page(viewport={'width': 390, 'height': 844})
            web_page.goto(f'http://127.0.0.1:{port}')
            web_page.get_by_role('heading', name='连接你的工作空间').wait_for()
            token = json.loads((data / 'settings.json').read_text(encoding='utf-8'))['gatewayToken']
            web_page.get_by_label('网关访问令牌', exact=True).fill(token)
            web_page.get_by_role('button', name='连接工作空间', exact=True).click()
            web_page.get_by_role('heading', name='连接你的 AI 客户端.').wait_for()
            assert not web_page.evaluate('document.querySelector("main").scrollWidth > document.querySelector("main").clientWidth')
            web_page.screenshot(animations="disabled", path=str(ROOT / 'docs/images/web-mobile-v0.5.png'))
            passed('Authenticated browser console + mobile responsive layout')
            web.close()
            browser.close()
        (ROOT / 'docs/UI-VALIDATION.json').write_text(json.dumps({'checks': report, 'count': len(report), 'profile': 'isolated temporary data and client directories', 'mockUpstream': True}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(f'UI checks: {len(report)} passed. Isolated artifacts: {profile}', flush=True)
    finally:
        if process.poll() is None:
            process.terminate()
            try: process.wait(timeout=10)
            except subprocess.TimeoutExpired: process.kill()
        server.shutdown(); logs.close()

if __name__ == '__main__': main()
