"""Run after npm run build. Requires Python Playwright and an installed Chromium browser.

Exercises the bundled mobile UI against a mock RPC server without reading real local credentials.
"""
import contextlib
import functools
import http.server
import json
import pathlib
import threading

from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[1]
STATE = {
    'version': '0.6.0', 'gateway': {'running': True},
    'providers': [{'id': 'deepseek', 'name': 'DeepSeek 官方', 'enabled': True, 'format': 'openai-chat', 'models': [{'id': 'deepseek-flash', 'contextWindow': 1000000, 'capabilities': {'tools': True}}]}],
    'agents': {}, 'plugins': [{'id': 'system-prompt', 'name': '统一系统提示', 'enabled': True}],
    'agentCatalog': [
        {'id': 'claude-code', 'name': 'Claude Code', 'support': 'automatic', 'description': '终端编程助手'},
        {'id': 'chatgpt-desktop', 'name': 'ChatGPT Desktop', 'support': 'unsupported', 'description': '官方聊天客户端'},
    ],
}
SESSION = {'path': '/fixture/session.jsonl', 'title': '移动端验收会话', 'agent': 'Codex', 'updatedAt': '2026-11-15T12:00:00Z', 'project': 'aurora'}
CALLS = []
LIVE = [{'id': 'live-1', 'model': 'deepseek-flash', 'agent': 'Claude Code', 'providerName': 'DeepSeek 官方', 'phase': 'streaming', 'startedAtMs': 1794704400000, 'estimatedOutputTokens': 24, 'cacheRead': 0}]


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


def route_rpc(route):
    headers = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'POST,OPTIONS'}
    if route.request.method == 'OPTIONS':
        route.fulfill(status=204, headers=headers)
        return
    if route.request.headers.get('authorization') != 'Bearer mobile-test-token':
        route.fulfill(status=401, headers=headers, json={'error': 'Unauthorized'})
        return
    request = route.request.post_data_json
    action, payload = request['action'], request.get('payload', {})
    CALLS.append(request)
    if action == 'state.get':
        result = STATE
    elif action == 'usage.summary':
        result = {'totals': {'calls': 12 if LIVE else 13, 'inputTokens': 1200, 'outputTokens': 340, 'cost': .04, 'errors': 1, 'cacheRead': 600, 'cacheWrite': 120, 'cacheRate': .75, 'cacheReports': 2, 'cacheWriteReports': 2}}
    elif action == 'usage.recent':
        result = [{'model': 'deepseek-flash', 'agent': 'Claude Code', 'providerName': 'DeepSeek 官方', 'status': 200, 'ts': '2026-11-15T12:00:00Z', 'inputTokens': 800, 'outputTokens': 340, 'cacheRead': 600, 'cacheReadKnown': True, 'cacheWrite': 0, 'cacheWriteKnown': False}]
    elif action == 'usage.live':
        result = LIVE
    elif action == 'agent.preview':
        result = {'ok': True, 'revision': 'revision-1', 'files': [{'path': '~/.claude/settings.json', 'after': '{"env":{"ANTHROPIC_MODEL":"deepseek-flash"}}'}], 'warnings': [], 'message': '已生成预览'}
    elif action == 'agent.connect':
        assert payload.get('revision') == 'revision-1', 'Configuration revision must accompany apply'
        STATE['agents'][payload['agentId']] = {'connected': True, 'providerId': payload['providerId'], 'model': payload['model']}
        result = {'ok': True, 'restartRequired': True}
    elif action == 'provider.toggle':
        STATE['providers'][0]['enabled'] = payload['enabled']
        result = {'ok': True}
    elif action == 'sessions.scan':
        result = [SESSION]
    elif action == 'sessions.read':
        assert payload['path'] == SESSION['path']
        result = [{'role': 'user', 'text': '<img src=x onerror=alert(1)> 是会话文本'}, {'role': 'assistant', 'text': '这是一个测试回复。'}]
    else:
        route.fulfill(status=400, headers=headers, json={'error': f'Unexpected action: {action}'})
        return
    route.fulfill(status=200, headers=headers, json={'result': result})


def main():
    handler = functools.partial(QuietHandler, directory=str(ROOT / 'www'))
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 390, 'height': 844}, device_scale_factor=1, is_mobile=True, has_touch=True)
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route('**/api/rpc', route_rpc)
        page.goto(f'http://127.0.0.1:{server.server_port}')
        page.get_by_label('网关地址').fill('http://gateway.test:3425')
        page.get_by_label('访问令牌').fill('wrong-token')
        page.get_by_role('button', name='连接工作台').click()
        expect(page.get_by_role('alert')).to_contain_text('连接被拒绝')
        page.get_by_label('访问令牌').fill('mobile-test-token')
        page.get_by_role('button', name='连接工作台').click()
        expect(page.get_by_role('heading', name='一切，尽在掌握')).to_be_visible()
        expect(page.get_by_text('yunqiao.me', exact=True)).to_be_visible()
        expect(page.get_by_label('缓存用量')).to_contain_text('75.0%')
        expect(page.get_by_label('实时请求')).to_contain_text('输出 约 24')
        expect(page.get_by_label('实时请求')).to_contain_text('缓存读 0')
        expect(page.get_by_label('实时请求')).to_contain_text('缓存写 未提供')
        expect(page.get_by_text('缓存读 600 · 缓存写 —', exact=True)).to_be_visible()
        LIVE.clear()
        expect(page.get_by_label('实时请求')).to_contain_text('0 个进行中', timeout=6000)
        expect(page.locator('.stat').filter(has_text='请求次数')).to_contain_text('13', timeout=6000)
        page.get_by_role('button', name='客户端', exact=True).click()
        page.get_by_role('button', name='Claude Code').click()
        page.get_by_role('button', name='预览电脑上的配置变更').click()
        expect(page.get_by_text('已生成预览')).to_be_visible()
        page.get_by_role('button', name='确认应用到电脑').click()
        expect(page.get_by_role('dialog')).to_have_count(0)
        expect(page.get_by_role('button', name='Claude Code')).to_contain_text('已接入')
        page.get_by_role('button', name='ChatGPT Desktop').click()
        expect(page.get_by_text('此客户端暂不支持通过云桥自动更换模型服务。请在电脑端查看官方接入方式。')).to_be_visible()
        expect(page.get_by_role('button', name='预览电脑上的配置变更')).to_have_count(0)
        page.get_by_role('button', name='关闭', exact=True).click()
        page.get_by_role('button', name='供应商', exact=True).click()
        page.get_by_role('switch', name='DeepSeek 官方 启用状态').click()
        expect(page.get_by_role('switch')).to_have_attribute('aria-checked', 'false')
        page.get_by_text('查看模型', exact=True).click()
        expect(page.get_by_text('上下文 · 工具', exact=False)).to_be_visible()
        page.get_by_role('button', name='会话', exact=True).click()
        page.get_by_role('button', name='移动端验收会话').click()
        expect(page.get_by_text('<img src=x onerror=alert(1)> 是会话文本', exact=True)).to_be_visible()
        expect(page.get_by_role('dialog').locator('img')).to_have_count(0)
        page.get_by_role('button', name='关闭', exact=True).click()
        page.get_by_role('button', name='我的', exact=True).click()
        page.get_by_label('主题').select_option('dark')
        expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
        assert 'mobile-test-token' not in page.evaluate('JSON.stringify(localStorage)'), 'Token must remain in memory only'
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'Mobile viewport must not overflow'
        page.get_by_label('主题').select_option('light')
        page.get_by_role('button', name='工作台', exact=True).click()
        (ROOT / 'build').mkdir(exist_ok=True)
        page.screenshot(path=str(ROOT / 'build/mobile-workspace.png'), full_page=True)
        page.get_by_role('button', name='我的', exact=True).click()
        page.get_by_role('button', name='断开连接', exact=True).click()
        expect(page.get_by_label('访问令牌')).to_have_value('')
        live_calls = len([call for call in CALLS if call['action'] == 'usage.live'])
        page.wait_for_timeout(1700)
        assert len([call for call in CALLS if call['action'] == 'usage.live']) == live_calls, 'Disconnect must stop live polling'
        assert not errors, errors
        assert any(c['action'] == 'agent.connect' for c in CALLS)
        browser.close()
    server.shutdown()
    print(json.dumps({'passed': True, 'checks': ['auth failure', 'connect', 'brand', 'cache hit rate', 'live reported zero vs missing cache', 'live estimates', 'completion refresh', 'preview/apply revision', 'unsupported client', 'provider toggle', 'models', 'sessions safe text', 'theme', 'no overflow', 'no persisted token', 'disconnect stops polling'], 'rpc_calls': len(CALLS)}, ensure_ascii=True))


if __name__ == '__main__':
    main()
