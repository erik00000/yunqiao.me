import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import https from 'node:https';
import { EventEmitter } from 'node:events';

const workspace = path.resolve(import.meta.dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-update-test-'));
async function load(name, repository) {
  const bundle = path.join(scratch, `${name}.mjs`);
  await build({ stdin: { contents: "export * from './src/core/cloud.ts'; export * from './src/core/releaseSources.ts';", resolveDir: workspace, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent', define: repository === undefined ? {} : { __YUNQIAO_RELEASE_REPOSITORY__: JSON.stringify(repository) } });
  return import(pathToFileURL(bundle).href);
}
const m = await load('updates');
const win = { platform: 'win', arch: 'x64' }, version = '0.6.11-erik.2';
// 以下发布和下载地址仅用于隔离测试，并不表示远端已有此发布。
const asset = (name, changes = {}) => ({ name, state: 'uploaded', size: 50_000_000, browser_download_url: `https://github.com/${m.RELEASE_REPOSITORY}/releases/download/v${version}/${name}`, ...changes });
const setup = `YunQiaoAI-${version}-win-x64-setup.exe`, portable = `YunQiaoAI-${version}-win-x64-portable.exe`;
const release = (changes = {}) => ({ tag_name: `v${version}`, html_url: `https://github.com/${m.RELEASE_REPOSITORY}/releases/tag/v${version}`, draft: false, prerelease: true, body: '维护版说明', published_at: '2026-11-18T00:00:00Z', assets: [asset(portable), asset(setup)], ...changes });
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
async function rejected(data, target = win) {
  const calls = [];
  await assert.rejects(() => m.checkUpdate('0.6.11-erik.1', target, async url => { calls.push(url); if (data instanceof Error) throw data; return data; }), /维护版更新检查未完成/);
  assert.deepEqual(calls, [m.GITHUB_RELEASE_API]);
  assert.ok(!calls.some(url => url.includes('jxb412') || url.includes('pub.php')));
}
try {
  await test('默认更新仓库属于个人维护者，保留明确上游署名', () => {
    assert.equal(m.RELEASE_REPOSITORY, 'erik00000/yunqiao.me');
    assert.equal(m.UPSTREAM_REPOSITORY, 'jxb412/yunqiao.me');
    assert.equal(m.GITHUB_RELEASE_API, 'https://api.github.com/repos/erik00000/yunqiao.me/releases?per_page=100');
    assert.equal(m.GITHUB_RELEASE_PAGE, 'https://github.com/erik00000/yunqiao.me/releases');
    assert.equal(m.OFFICIAL_UPDATE_URL, undefined); assert.equal(m.websiteUpdate, undefined);
  });
  await test('构建时只允许指定维护仓库，运行时环境变量无法覆盖', async () => {
    const previous = process.env.YUNQIAO_RELEASE_REPOSITORY;
    process.env.YUNQIAO_RELEASE_REPOSITORY = 'jxb412/yunqiao.me';
    try {
      const custom = await load('custom', 'erik00000/yunqiao.me');
      assert.equal(custom.RELEASE_REPOSITORY, 'erik00000/yunqiao.me');
      const defaultBuild = await load('runtime-env'); assert.equal(defaultBuild.RELEASE_REPOSITORY, m.RELEASE_REPOSITORY);
    } finally { if (previous === undefined) delete process.env.YUNQIAO_RELEASE_REPOSITORY; else process.env.YUNQIAO_RELEASE_REPOSITORY = previous; }
    for (const [index, value] of ['jxb412/yunqiao.me', 'JXB412/YUNQIAO.ME', 'fixture-owner/maintained', 'erik00000/other', 'https://github.com/evil/repo', 'owner/repo/other', ''].entries()) await assert.rejects(() => load(`invalid-${index}`, value), /erik00000\/yunqiao.me GitHub 发布仓库/);
  });
  await test('维护版预发布可更新，Windows 优先选择安装版', async () => {
    const calls = [];
    const r = await m.checkUpdate('0.6.11-erik.1', win, async url => { calls.push(url); return [release()]; });
    assert.deepEqual(calls, [m.GITHUB_RELEASE_API]); assert.equal(r.source, 'github'); assert.equal(r.assetName, setup); assert.equal(r.hasUpdate, true); assert.equal(r.fallbackUrl, ''); assert.equal(r.releaseUrl, release().html_url);
  });
  await test('只从已存在的合法发布中选择最新匹配版本，不依赖列表顺序', async () => {
    const oldVersion = '0.6.11-erik.1', name = `YunQiaoAI-${oldVersion}-win-x64-setup.exe`;
    const old = release({ tag_name: `v${oldVersion}`, html_url: `https://github.com/${m.RELEASE_REPOSITORY}/releases/tag/v${oldVersion}`, assets: [asset(name, { browser_download_url: `https://github.com/${m.RELEASE_REPOSITORY}/releases/download/v${oldVersion}/${name}` })] });
    const r = await m.checkUpdate(oldVersion, win, async () => [old, release()]); assert.equal(r.version, version);
  });
  await test('没有安装版时保留便携版', () => assert.equal(m.githubUpdate(release({ assets: [asset(portable)] }), '0.6.0', win).assetName, portable));
  await test('CPU 架构必须精确匹配', () => {
    const arm = `YunQiaoAI-${version}-win-arm64-setup.exe`;
    assert.equal(m.githubUpdate(release({ assets: [asset(setup), asset(arm)] }), '0.6.0', { platform: 'win', arch: 'arm64' }).assetName, arm);
    assert.throws(() => m.githubUpdate(release(), '0.6.0', { platform: 'win', arch: 'arm64' }), /当前平台/);
  });
  await test('macOS 和 Linux 继续精确匹配平台安装包', () => {
    const mac = `YunQiaoAI-${version}-mac-arm64.dmg`, linux = `YunQiaoAI-${version}-linux-x64.AppImage`;
    const data = release({ assets: [asset(setup), asset(mac), asset(linux)] });
    assert.equal(m.githubUpdate(data, '0.6.0', { platform: 'mac', arch: 'arm64' }).assetName, mac);
    assert.equal(m.githubUpdate(data, '0.6.0', { platform: 'linux', arch: 'x64' }).assetName, linux);
  });
  await test('macOS 通用安装包仅在缺少精确匹配时使用', () => {
    const intel = `YunQiaoAI-${version}-mac-x64.dmg`, apple = `YunQiaoAI-${version}-mac-arm64.dmg`, universal = `YunQiaoAI-${version}-mac-universal.dmg`;
    for (const [arch, expected, other] of [['x64', intel, apple], ['arm64', apple, intel]]) {
      const target = { platform: 'mac', arch };
      assert.equal(m.githubUpdate(release({ assets: [asset(universal), asset(other), asset(expected)] }), '0.6.0', target).assetName, expected);
      assert.equal(m.githubUpdate(release({ assets: [asset(other), asset(universal)] }), '0.6.0', target).assetName, universal);
      assert.throws(() => m.githubUpdate(release({ assets: [asset(other)] }), '0.6.0', target), /当前平台/);
    }
  });
  await test('无发布、限流、网络或 JSON 错误均明确失败，绝不回退', async () => {
    for (const value of [[], null, {}, '<html>not JSON</html>', new Error('HTTP 404'), new Error('HTTP 403'), new Error('HTTP 429'), new Error('timeout'), new Error('invalid JSON')]) await rejected(value);
  });
  await test('真实 HTTP 请求层拒绝将更新检查重定向到上游或 PHP 镜像', async () => {
    const get = https.get;
    try {
      for (const location of ['https://api.github.com/repos/jxb412/yunqiao.me/releases', 'https://ai.haowucm.cn/pub.php?action=update']) {
        let calls = 0;
        https.get = (_options, callback) => {
          calls++;
          const req = new EventEmitter(); req.destroy = () => {};
          queueMicrotask(() => {
            const res = new EventEmitter(); res.statusCode = 301; res.headers = { location }; res.resume = () => {};
            callback(res);
          });
          return req;
        };
        await assert.rejects(() => m.checkUpdate('0.6.11-erik.1', win), /重定向/);
        assert.equal(calls, 1);
      }
    } finally { https.get = get; }
  });
  await test('草稿、其他预发布通道和无效版本不能作为维护版更新', async () => {
    for (const data of [release({ draft: true }), release({ draft: undefined }), release({ prerelease: undefined }), release({ tag_name: 'v0.8.0-beta.1' }), release({ tag_name: 'v0.8.0', prerelease: true })]) await rejected([data]);
  });
  await test('源码压缩包、blockmap、其他版本及未签名 iOS 文件全部忽略', async () => {
    await rejected([release({ assets: ['Source code.zip', `${setup}.blockmap`, 'YunQiaoAI-0.8.0-win-x64-setup.exe', `YunQiaoAI-${version}-ios-device-unsigned.zip`].map(name => asset(name)) })]);
  });
  await test('跨仓库、上游、PHP 镜像及非法下载地址都不能提供给用户', async () => {
    for (const url of [`http://github.com/${m.RELEASE_REPOSITORY}/releases/download/v${version}/${setup}`, 'javascript:alert(1)', `https://github.com.evil.test/${m.RELEASE_REPOSITORY}/releases/download/v${version}/${setup}`, `https://github.com/jxb412/yunqiao.me/releases/download/v${version}/${setup}`, `https://ai.haowucm.cn/releases/${setup}`, `https://user:pass@github.com/${m.RELEASE_REPOSITORY}/releases/download/v${version}/${setup}`, `https://github.com/${m.RELEASE_REPOSITORY}/releases/download/v0.6.0/${setup}`]) await rejected([release({ assets: [asset(setup, { browser_download_url: url })] })]);
  });
  await test('校验清单不能冒充安装包，也不能引入其他仓库或 PHP 下载', async () => {
    for (const url of [`https://github.com/${m.RELEASE_REPOSITORY}/releases/download/v${version}/SHA256SUMS.txt`, `https://github.com/jxb412/yunqiao.me/releases/download/v${version}/SHA256SUMS.txt`, 'https://ai.haowucm.cn/pub.php?action=update']) {
      await rejected([release({ assets: [asset('SHA256SUMS.txt', { browser_download_url: url })] })]);
      const r = m.githubUpdate(release({ assets: [asset(setup), asset('SHA256SUMS.txt', { browser_download_url: url })] }), '0.6.0', win);
      assert.equal(r.url, asset(setup).browser_download_url); assert.equal(r.fallbackUrl, '');
    }
  });
  await test('发布页、安装包大小和上传状态必须有效', async () => {
    await rejected([release({ html_url: `https://github.com/jxb412/yunqiao.me/releases/tag/v${version}` })]);
    await rejected([release({ assets: [asset(setup, { size: 0 }), asset(portable, { state: 'open' })] })]);
  });
  await test('较旧或相同版本不会暴露下载地址或强制降级', () => {
    for (const current of [version, '0.6.11-erik.10', '0.6.11', '0.8.0']) {
      const r = m.githubUpdate(release(), current, win); assert.equal(r.hasUpdate, false); assert.equal(r.url, ''); assert.equal(r.mandatory, false);
    }
  });
  await test('语义版本正确比较维护编号、正式版和构建元数据', () => {
    assert.equal(m.compareReleaseVersions('0.6.11-erik.2', '0.6.11-erik.1'), 1); assert.equal(m.compareReleaseVersions('0.6.11-erik.10', '0.6.11-erik.9'), 1);
    assert.equal(m.compareReleaseVersions('0.6.11', '0.6.11-erik.1'), 1); assert.equal(m.compareReleaseVersions('0.6.12-erik.1', '0.6.11'), 1);
    assert.equal(m.compareReleaseVersions('0.7.0+abc', 'v0.7.0+xyz'), 0); assert.equal(m.compareReleaseVersions('0.10.0', '0.9.9'), 1);
    for (const value of ['latest', '0.7', '01.7.0', '0.7.0-01', '0.7.0\n', '999999999999999999999.0.0']) assert.throws(() => m.compareReleaseVersions(value, '0.6.0'));
  });
  await test('最低版本要求也支持维护版预发布且不能被较旧发布绕过', async () => {
    const r = await m.checkUpdate('0.6.11-erik.1', { ...win, minimumVersion: version }, async () => [release()]); assert.equal(r.version, version);
    await assert.rejects(() => m.checkUpdate('0.6.11-erik.1', { ...win, minimumVersion: '0.6.11-erik.3' }, async () => [release()]), /尚未发布/);
  });
  await test('旧官网备用请求和无效参数必须在联网之前拒绝', async () => {
    let requests = 0; const request = async () => { requests++; return [release()]; };
    await assert.rejects(() => m.checkUpdate('not-a-version', win, request));
    for (const target of [{ platform: 'android', arch: 'arm64' }, { platform: 'ios', arch: 'x64' }, { platform: 'mac', arch: 'ia32' }, { platform: 'win', arch: 'mips' }, { ...win, source: 'website' }, { ...win, source: 'evil' }, { ...win, minimumVersion: 'latest' }]) await assert.rejects(() => m.checkUpdate('0.6.0', target, request));
    assert.equal(requests, 0);
  });
  await test('没有合法自有发布时不能编造 iOS 或其他平台下载入口', async () => rejected([release()], { platform: 'ios', arch: 'arm64' }));
  await test('生产下载组件只渲染 GitHub 下载，不渲染官网备用或无更新下载', async () => {
    const bundle = path.join(scratch, 'renderer.cjs');
    await build({ stdin: { contents: "import React from 'react'; import { renderToStaticMarkup } from 'react-dom/server'; import UpdateActions from './ui/src/components/UpdateActions.tsx'; export const render = update => renderToStaticMarkup(React.createElement(UpdateActions, { update }));", resolveDir: workspace, loader: 'tsx' }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' });
    const renderer = await import(pathToFileURL(bundle).href);
    const info = { ok: true, ...m.githubUpdate(release(), '0.6.11-erik.1', win) };
    const html = renderer.render(info); assert.match(html, /GitHub 下载/); assert.doesNotMatch(html, /官网备用|官网下载/);
    assert.equal(renderer.render({ ...info, hasUpdate: false, url: '' }), '');
  });
  console.log(`Updates: ${passed} tests passed`);
} finally {
  const resolved = path.resolve(scratch);
  if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('aurora-update-test-')) fs.rmSync(resolved, { recursive: true, force: true });
}
