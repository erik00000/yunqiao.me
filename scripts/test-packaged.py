"""Read-only acceptance of the actual unpacked Windows release, using isolated profiles.

Run after packaging: python scripts/test-packaged.py
Requires Python Playwright. Refuses an old/missing app.asar before launching an EXE.
"""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
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
    resources = executable.parent / 'resources'
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
    manifest = json.loads((bundled / 'FILES.sha256.json').read_text(encoding='utf-8'))
    assert manifest == json.loads((ROOT / 'third_party/codexplusplus/FILES.sha256.json').read_text(encoding='utf-8'))
    assert len(manifest) == 217, f'Expected 217 pinned assets, found {len(manifest)}'
    for record in manifest:
        file = (bundled / record['path']).resolve()
        assert file.is_relative_to(bundled.resolve()), 'Asset path escapes the packaged resource directory'
        assert file.is_file() and file.stat().st_size == record['bytes'], record['path']
        assert sha256(file) == record['sha256'], record['path']

    profile = Path(tempfile.mkdtemp(prefix='yunqiao-packaged-'))
    data, clients, chromium = profile / 'data', profile / 'clients', profile / 'chromium'
    for folder in [data, clients / '.claude', clients / '.codex', chromium, profile / 'appdata', profile / 'localappdata']:
        folder.mkdir(parents=True, exist_ok=True)
    fixture_files = {
        clients / '.claude/settings.json': '{"permissions":{"allow":["Read"]},"env":{"FIXTURE":"unchanged"}}\n',
        clients / '.codex/config.toml': 'model = "fixture-model"\n',
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
    environment = dict(os.environ, AURORA_HOME=str(data), YUNQIAO_HOME=str(data), AURORA_CLIENT_HOME=str(clients),
                       APPDATA=str(profile / 'appdata'), LOCALAPPDATA=str(profile / 'localappdata'))
    for key in ['ELECTRON_RUN_AS_NODE', 'AURORA_EXTENSION_ASSETS', 'AURORA_DEV', 'AURORA_UI_URL', 'AURORA_SHOT', 'AURORA_PAGE']:
        environment.pop(key, None)
    logs = (profile / 'packaged.log').open('w', encoding='utf-8')
    process = None
    checks = ['Packaged version and AGPL notices', 'All 217 packaged resource hashes match pinned source']
    errors = []
    try:
        process = subprocess.Popen([
            str(launcher), f'--remote-debugging-port={debug_port}', f'--user-data-dir={chromium}',
        ], cwd=profile, env=environment, stdout=logs, stderr=logs,
           creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        deadline = time.monotonic() + (60 if args.launcher else 35)
        while time.monotonic() < deadline:
            assert process.poll() is None, f'Packaged executable exited; see {profile / "packaged.log"}'
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
                for record in manifest:
                    file = runtime_asar.parent / 'codexplusplus' / record['path']
                    assert file.is_file() and sha256(file) == record['sha256'], record['path']
                checks.append('Portable wrapper extracts the verified application and all 217 pinned resources')
            else:
                assert runtime_asar == asar.resolve(), packaged
            checks.append('Actual packaged EXE renders app.asar with an isolated data directory')

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
            checks.append('The actual EXE exposes history region selection and native provider discovery through IPC')

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
            assert not errors, errors
            assert all(file.read_bytes() == before for file, before in original.items()), 'A read-only check changed a client config'
            checks.append('No page exceptions or changes to isolated client configuration')
            report = {
                'version': args.version, 'passed': True, 'count': len(checks), 'checks': checks,
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
