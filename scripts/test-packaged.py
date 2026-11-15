"""Acceptance of an unpacked Windows/macOS application, using isolated profiles.

Run after packaging: python scripts/test-packaged.py
Requires Python Playwright. Refuses an old/missing app.asar before launching an EXE.
"""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]


def free_port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


def sha256(file):
    with Path(file).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def release_resource_manifest():
    """Share the reviewed distribution exclusions with the resource build step."""
    policy = json.loads((ROOT / 'scripts/extension-resource-policy.json').read_text(encoding='utf-8'))
    source = ROOT / 'third_party/codexplusplus'
    manifest = json.loads((source / 'FILES.sha256.json').read_text(encoding='utf-8'))
    assert policy['schemaVersion'] == 1
    assert len(manifest) == policy['sourceFiles'], 'Pinned resource count changed; review the distribution policy'
    assert json.loads((source / 'UPSTREAM.json').read_text(encoding='utf-8'))['commit'] == policy['upstreamCommit']
    excluded = set(policy['excluded'])
    assert len(excluded) == len(policy['excluded']), 'Duplicate resource exclusion'
    paths = set()
    for record in manifest:
        name = record['path']
        assert isinstance(name, str) and name and '\\' not in name, 'Invalid resource path'
        assert all(part and part not in ('.', '..') and not re.search(r'[<>:"|?*\x00-\x1f]|[. ]$', part) for part in name.split('/')), name
        assert name != 'FILES.sha256.json' and name.lower() not in paths, 'Duplicate resource path'
        paths.add(name.lower())
        assert type(record['bytes']) is int and record['bytes'] >= 0 and re.fullmatch(r'[a-f0-9]{64}', record['sha256']), name
        if name.endswith('.test.cjs') or name.startswith('source/'):
            assert name in excluded, f'Unreviewed source-only resource: {name}'
    assert excluded <= {record['path'] for record in manifest}, 'Excluded source assets are missing'
    return [record for record in manifest if record['path'] not in excluded]


def verify_packaged_resources(bundled):
    """Require the exact reviewed subset, including no unmanifested test files."""
    bundled = Path(bundled).absolute()
    for directory in (bundled, *bundled.parents):
        assert not directory.is_symlink() and not getattr(directory, 'is_junction', lambda: False)(), f'Linked resource directory: {directory}'
    expected = release_resource_manifest()
    actual = set()
    for file in bundled.rglob('*'):
        assert not file.is_symlink() and not getattr(file, 'is_junction', lambda: False)(), f'Linked packaged resource: {file}'
        assert file.is_file() or file.is_dir(), f'Not a regular packaged resource: {file}'
        if file.is_file():
            actual.add(file.relative_to(bundled).as_posix())
    assert actual == {record['path'] for record in expected} | {'FILES.sha256.json'}, 'Unexpected or missing packaged resource files'
    manifest = json.loads((bundled / 'FILES.sha256.json').read_text(encoding='utf-8'))
    assert manifest == expected, 'Packaged resource manifest differs from the reviewed source subset'
    for record in expected:
        file = bundled / record['path']
        assert file.stat().st_size == record['bytes'] and sha256(file) == record['sha256'], f'Packaged resource integrity mismatch: {record["path"]}'
    return manifest


def read_asar(file, relative):
    """Read one ordinary file from Electron's Chromium-pickle ASAR header."""
    with Path(file).open('rb') as stream:
        first = stream.read(8)
        if len(first) != 8:
            raise AssertionError('app.asar is incomplete; finish packaging first')
        size, header_size = struct.unpack('<II', first)
        assert size == 4 and 8 <= header_size <= 32 * 1024 * 1024, 'Invalid ASAR header'
        header = stream.read(header_size)
        assert len(header) == header_size, 'Incomplete ASAR header'
        text_size = struct.unpack('<I', header[4:8])[0]
        tree = json.loads(header[8:8 + text_size])
        entry = tree
        for part in relative.split('/'):
            entry = entry['files'][part]
        assert not entry.get('unpacked') and not entry.get('link'), 'Expected an ordinary packed file'
        assert 0 <= entry['size'] <= 4 * 1024 * 1024, 'Unexpected test metadata size'
        stream.seek(8 + header_size + int(entry['offset']))
        content = stream.read(entry['size'])
        assert len(content) == entry['size'], 'Incomplete packed file'
        return content


class CatalogHandler(BaseHTTPRequestHandler):
    catalog = (ROOT / 'server/seed-catalog.json').read_bytes()

    def log_message(self, *_):
        pass

    def do_GET(self):
        if self.path != '/catalog':
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(self.catalog)))
        self.end_headers()
        self.wfile.write(self.catalog)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exe', type=Path, default=ROOT / 'release/win-unpacked/YunQiaoAI.exe')
    parser.add_argument('--launcher', type=Path, help='Launch a portable wrapper and verify its extracted runtime against --exe')
    parser.add_argument('--version', default='0.6.0')
    args = parser.parse_args()
    executable = args.exe.resolve()
    assert executable.is_file(), f'Build the release first: {executable}'
    launcher = args.launcher.resolve() if args.launcher else executable
    assert launcher.is_file(), f'Portable wrapper is missing: {launcher}'
    resources = executable.parent.parent / 'Resources' if sys.platform == 'darwin' else executable.parent / 'resources'
    asar = resources / 'app.asar'
    assert asar.is_file(), 'Packaged app.asar is missing'
    package = json.loads(read_asar(asar, 'package.json'))
    assert package['version'] == args.version, f"Refusing old artifact {package['version']}; expected {args.version}"
    built_main = ROOT / 'dist/main/main.cjs'
    assert built_main.is_file(), 'Build the current source before packaged acceptance'
    assert read_asar(asar, 'dist/main/main.cjs') == built_main.read_bytes(), 'Packaged main process differs from the current build'
    assert package['license'] == 'AGPL-3.0-only'
    assert b'GNU AFFERO GENERAL PUBLIC LICENSE' in read_asar(asar, 'LICENSE')
    assert b'Facebook, Inc.' in read_asar(asar, 'THIRD_PARTY_NOTICES.md')
    bundled = resources / 'codexplusplus'
    manifest = verify_packaged_resources(bundled)

    profile = Path(tempfile.mkdtemp(prefix='yunqiao-packaged-'))
    data, clients, chromium = profile / 'data', profile / 'clients', profile / 'chromium'
    for folder in [data, clients / '.claude', clients / '.codex', chromium, profile / 'appdata', profile / 'localappdata']:
        folder.mkdir(parents=True, exist_ok=True)
    fixture_files = {
        clients / '.claude/settings.json': '{"permissions":{"allow":["Read"]},"env":{"FIXTURE":"unchanged"}}\n',
        clients / '.codex/config.toml': 'model = "fixture-model"\n',
        clients / '.codex/auth.json': '{"auth_mode":"chatgpt","tokens":{"refresh_token":"fixture-not-a-real-login"}}\n',
    }
    for file, value in fixture_files.items():
        file.write_text(value, encoding='utf-8')
    original = {file: file.read_bytes() for file in fixture_files}
    catalog = ThreadingHTTPServer(('127.0.0.1', 0), CatalogHandler)
    threading.Thread(target=catalog.serve_forever, daemon=True).start()
    port, debug_port = free_port(), free_port()
    (data / 'settings.json').write_text(json.dumps({
        'theme': 'light', 'gatewayHost': '127.0.0.1', 'gatewayPort': port,
        'autoStartGateway': True, 'autoCheckUpdate': False, 'closeToTray': False,
        'autoSyncModels': False, 'updateUrl': 'https://ai.haowucm.cn/pub.php?action=update',
        'catalogUrl': f'http://127.0.0.1:{catalog.server_port}/catalog',
    }), encoding='utf-8')
    environment = dict(os.environ, YUNQIAO_TEST_ISOLATED='1', AURORA_HOME=str(data), YUNQIAO_HOME=str(data), AURORA_CLIENT_HOME=str(clients),
                       APPDATA=str(profile / 'appdata'), LOCALAPPDATA=str(profile / 'localappdata'))
    for key in ['ELECTRON_RUN_AS_NODE', 'AURORA_EXTENSION_ASSETS', 'AURORA_DEV', 'AURORA_UI_URL', 'AURORA_SHOT', 'AURORA_PAGE']:
        environment.pop(key, None)
    logs = (profile / 'packaged.log').open('w', encoding='utf-8')
    process = None
    checks = ['Packaged version and AGPL notices', f'All {len(manifest)} distributed resource hashes match pinned source; upstream tests and Rust reference sources are absent']
    errors = []
    try:
        process = subprocess.Popen([
            str(launcher), f'--remote-debugging-port={debug_port}', f'--user-data-dir={chromium}',
        ], cwd=profile, env=environment, stdout=logs, stderr=logs,
           creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        deadline = time.monotonic() + (60 if args.launcher else 35)
        while time.monotonic() < deadline:
            assert process.poll() is None, f'Packaged executable exited with code {process.returncode}; see {profile / "packaged.log"}'
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{debug_port}/json/version', timeout=.5).close()
                break
            except (OSError, urllib.error.URLError):
                time.sleep(.2)
        else:
            raise AssertionError(f'Packaged CDP startup timed out; see {profile / "packaged.log"}')
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{debug_port}')
            context = browser.contexts[0]
            page = context.pages[0] if context.pages else context.wait_for_event('page')
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.get_by_role('heading', name='连接你的 AI 客户端.', exact=True).wait_for(timeout=30000)
            location = urllib.parse.unquote(page.url).replace('\\', '/').lower()
            assert '/resources/app.asar/dist/ui/index.html' in location, location
            state = page.evaluate("async () => {const s=await window.aurora.invoke('state.get');return {version:s.version,dataDir:s.dataDir,gateway:s.gateway,providers:s.providers.length};}")
            assert state['version'] == args.version and Path(state['dataDir']).resolve() == data.resolve(), state
            assert state['providers'] == 0, 'Acceptance must use a fresh supplier profile'
            packaged = page.evaluate("() => window.aurora.invoke('app.isDev')")
            runtime_asar = Path(packaged['root']).resolve()
            assert packaged['dev'] is False and runtime_asar.is_file(), packaged
            if args.launcher:
                assert sha256(runtime_asar) == sha256(asar), 'Portable wrapper extracted a different app.asar'
                assert verify_packaged_resources(runtime_asar.parent / 'codexplusplus') == manifest
                checks.append(f'Portable wrapper extracts the verified application and exactly {len(manifest)} distributed resources')
            else:
                assert runtime_asar == asar.resolve(), packaged
            expect(page.locator('.app')).to_have_attribute('data-platform', 'darwin' if sys.platform == 'darwin' else 'win32')
            expect(page.locator('.win-controls')).to_have_count(0 if sys.platform == 'darwin' else 1)
            expect(page.locator('.quick-search kbd')).to_have_text('⌘ K' if sys.platform == 'darwin' else 'Ctrl K')
            checks.append('Actual native packaged application renders app.asar with platform-specific controls and isolated data')

            deadline = time.monotonic() + 15
            while not page.evaluate("async () => (await window.aurora.invoke('gateway.status')).running === true"):
                assert time.monotonic() < deadline, 'Packaged gateway startup timed out'
                page.wait_for_timeout(200)
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=5) as response:
                health = json.load(response)
                assert health == {'ok': True, 'running': True}, health
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{port}/api/state', timeout=5)
                raise AssertionError('Unauthenticated management request was accepted')
            except urllib.error.HTTPError as error:
                assert error.code == 401, error.code
            checks.append('Packaged gateway health is ready and management rejects missing credentials')

            extensions = page.evaluate("""async () => {
                const r=await window.aurora.invoke('extension.list');
                if(r.error)throw new Error(r.error);
                return {ok:r.ok,bundled:r.items.filter(i=>i.source==='bundled').map(i=>i.id),builtin:r.items.filter(i=>i.source==='builtin').length,catalogs:r.catalogs};
            }""")
            assert extensions['ok'] and extensions['builtin'] == 32, extensions
            assert set(extensions['bundled']) == {'bundled:' + name for name in ['agent-pet', 'typing-effects', 'image-overlay', 'usage-statusline', 'proxy-request-status']}
            assert extensions['catalogs']['public']['count'] == 520 and extensions['catalogs']['full']['count'] == 5491
            checks.append('Installed runtime loads 5 complete packages, 32 builtins and both pinned markets')

            images = ROOT / 'docs/images'
            images.mkdir(exist_ok=True)
            page.get_by_role('button', name='系统设置', exact=True).click()
            page.get_by_role('button', name='版本更新', exact=True).click()
            expect(page.get_by_role('button', name='检查更新', exact=True)).to_be_visible()
            expect(page.get_by_label('远端目录地址', exact=True)).to_have_count(0)
            expect(page.get_by_text('供应商目录', exact=True)).to_have_count(0)
            expect(page.get_by_text('更新接口地址', exact=True)).to_have_count(0)
            settings = page.evaluate("async () => (await window.aurora.invoke('state.get')).settings")
            assert settings['autoSyncModels'] is True
            assert settings['updateUrl'] == 'https://api.github.com/repos/jxb412/aurora/releases/latest'
            page.screenshot(path=str(images / 'settings-v0.6.png'), animations='disabled', style='.toast-wrap{visibility:hidden!important}')
            checks.append('Packaged settings hide catalog controls and migrate legacy preferences to automatic sync and GitHub releases')
            build = page.evaluate("async () => (await window.aurora.invoke('state.get')).build")
            assert build and build['id'] and build['builtAt'], 'Actual package must identify its build, not only its version number'
            if build['channel'] == 'local':
                expect(page.get_by_text('本地调试版', exact=False)).to_be_visible()
            page.get_by_role('button', name='数据与关于', exact=True).click()
            expect(page.get_by_role('link', name='项目源码 ↗', exact=True)).to_have_attribute('href', 'https://github.com/jxb412/aurora')
            checks.append('The packaged build is identifiable and source links do not depend on an unpublished release tag')
            page.locator('nav').get_by_role('button', name='历史会话', exact=True).click()
            page.get_by_role('button', name='批量修复历史 / 区域迁移', exact=True).click()
            dialog = page.get_by_role('dialog', name='历史会话 · 批量修复', exact=True)
            expect(dialog.get_by_label('目标供应商标识', exact=True)).to_be_enabled()
            regions = page.evaluate("async () => await window.aurora.invoke('codex.repair.providers')")
            assert regions['ok'] and any(item['id'] == 'openai' for item in regions['targets'])
            dialog.get_by_role('button', name='关闭', exact=True).click()
            checks.append('Native packaged IPC exposes history region selection and provider discovery')

            page.locator('nav').get_by_role('button', name='插件中心', exact=True).click()
            page.get_by_role('heading', name='ChatGPT 桌面版插件', exact=True).wait_for(timeout=15000)
            page.get_by_role('button', name='官方拓展包 5', exact=True).click()
            expect(page.locator('.extension-card')).to_have_count(5)
            expect(page.get_by_text('云桥桌面扩展', exact=True)).to_be_visible()
            assert 'CODEX++' not in page.locator('main').inner_text().upper()
            assert page.get_by_role('alert').count() == 0
            page.screenshot(path=str(images / 'plugins-v0.6.png'), animations='disabled', style='.toast-wrap{visibility:hidden!important}')
            checks.append('Packaged plugin page renders the five bundled packages without errors')

            page.locator('nav').get_by_role('button', name='云桥会员', exact=True).click()
            page.get_by_role('heading', name='云桥会员', exact=True).wait_for()
            expect(page.get_by_label('平台会员邮箱', exact=True)).to_be_visible()
            expect(page.get_by_label('平台会员密码', exact=True)).to_have_value('')
            expect(page.get_by_label('会员访问令牌', exact=True)).to_have_value('')
            # Wait only for the public configuration read; never log in, bind or claim a gift.
            page.wait_for_function("() => !document.querySelector('button[type=submit]')?.disabled || !!document.querySelector('[role=alert], main .notice')", timeout=40000)
            membership_warning = page.get_by_role('alert').all_text_contents()
            page.screenshot(path=str(images / 'membership-v0.6.png'), animations='disabled', style='.toast-wrap{visibility:hidden!important}')
            checks.append('Packaged membership onboarding renders without authenticated user state')
            page.locator('nav').get_by_role('button', name='客户端接入', exact=True).click()
            expect(page.get_by_role('button', name='重新启动客户端', exact=True).first).to_be_visible()
            expect(page.get_by_role('button', name='新终端打开', exact=True).first).to_be_visible()
            lifecycle = page.evaluate("() => window.aurora.invoke('agent.lifecycle', {agentId:'claude-desktop'})")
            assert lifecycle['ok'] and lifecycle['kind'] == 'desktop' and not lifecycle['installed'] and not lifecycle['supported'], lifecycle
            service = page.evaluate("() => window.aurora.invoke('agent.restart', {agentId:'deepseek'})")
            assert not service['ok'] and service['operation'] == 'unsupported', service
            rejected = page.evaluate("() => window.aurora.invoke('agent.restart', {agentId:'claude-desktop', pid:1})")
            assert rejected.get('error'), 'Native lifecycle accepted a renderer-supplied process ID'
            checks.append('Packaged client cards expose restart and terminal actions; native IPC rejects API services and process overrides without launching any client')
            assert not errors, errors
            assert all(file.read_bytes() == before for file, before in original.items()), 'A read-only check changed a client config'
            checks.append('Read-only views leave isolated client configurations unchanged')

            supplier = page.evaluate("""() => window.aurora.invoke('provider.save', {
                name:'Native configuration acceptance',baseUrl:'http://127.0.0.1:9/v1',format:'openai-responses',enabled:true,
                apiKeys:[{id:'fixture',label:'fixture',key:'fixture-not-a-real-key',enabled:true,weight:1}],models:[{id:'gpt-6.1-sol'}]
            })""")
            detected = page.evaluate("async () => (await window.aurora.invoke('agent.detect'))['chatgpt-desktop']")
            assert detected['configured'] is True and detected['installed'] is False, detected
            assert Path(detected['configPath']).resolve() == (clients / '.codex/config.toml').resolve()
            page.locator('nav').get_by_role('button', name='我的供应商', exact=True).click()
            page.locator('nav').get_by_role('button', name='客户端接入', exact=True).click()
            # The fixture was saved through IPC; refresh UI state before opening
            # a wizard whose initial provider choice is intentionally preserved.
            page.get_by_role('button', name='检测本地客户端', exact=True).click()
            expect(page.locator('nav').get_by_role('button', name='我的供应商', exact=True).locator('.badge')).to_have_text('1')
            card = page.locator('.client-card').filter(has=page.get_by_text('ChatGPT 桌面版', exact=True))
            expect(card.get_by_text('发现本地配置', exact=True)).to_be_visible()
            card.get_by_role('button', name='开始配置 →', exact=True).click()
            wizard = page.get_by_role('dialog', name='配置 ChatGPT 桌面版', exact=True)
            wizard.get_by_role('button', name='下一步：选择模型 →', exact=True).click()
            expect(wizard.get_by_role('region', name='共享编程配置')).to_be_visible()
            wizard.get_by_role('button', name='预览配置 →', exact=True).click()
            expect(wizard.get_by_role('button', name='备份并应用配置', exact=True)).to_be_visible()
            assert (clients / '.codex/config.toml').read_bytes() == original[clients / '.codex/config.toml']
            wizard.get_by_role('button', name='备份并应用配置', exact=True).click()
            expect(wizard.get_by_role('heading', name='配置已应用', exact=True)).to_be_visible()
            configured = (clients / '.codex/config.toml').read_text(encoding='utf-8')
            assert 'model_provider = "aurora"' in configured and supplier['id'] + '/gpt-6.1-sol' in configured
            assert (clients / '.codex/auth.json').read_bytes() == original[clients / '.codex/auth.json']
            shared = page.evaluate("async () => (await window.aurora.invoke('state.get')).agents")
            assert all(shared[client]['connected'] is True for client in ['codex-cli', 'chatgpt-desktop'])
            wizard.get_by_role('button', name='完成', exact=True).click()
            restored = page.evaluate("() => window.aurora.invoke('agent.disconnect', {agentId:'chatgpt-desktop'})")
            assert restored['ok'], restored
            assert all(file.read_bytes() == before for file, before in original.items()), 'Shared configuration restore changed original bytes'
            assert not errors, errors
            checks.append('Native wizard previews, backs up, applies and restores shared Codex configuration without a desktop executable; auth bytes stay intact and CLI state stays synchronized')
            report = {
                'version': args.version, 'platform': sys.platform, 'passed': True, 'count': len(checks), 'checks': checks,
                'executable': str(executable.relative_to(ROOT)) if executable.is_relative_to(ROOT) else str(executable),
                'exeSha256': sha256(executable), 'asarSha256': sha256(asar),
                **({'portable': str(launcher.relative_to(ROOT)), 'portableSha256': sha256(launcher)} if args.launcher and launcher.is_relative_to(ROOT) else {}),
                'build': build,
                'resourceFilesVerified': len(manifest), 'profile': 'isolated temporary app, gateway and client directories',
                'membershipPublicConfigWarning': membership_warning,
                'screenshots': ['docs/images/settings-v0.6.png', 'docs/images/plugins-v0.6.png', 'docs/images/membership-v0.6.png'],
            }
            (ROOT / f'docs/PACKAGED-VALIDATION-{args.version}.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            print(json.dumps(report, ensure_ascii=True), flush=True)
            browser.close()
    finally:
        if process and process.poll() is None:
            if args.launcher and os.name == 'nt':
                subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        catalog.shutdown()
        catalog.server_close()
        logs.close()
        print(f'Isolated acceptance logs: {profile}', flush=True)


if __name__ == '__main__':
    main()
