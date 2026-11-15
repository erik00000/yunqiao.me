import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-catalog-resilience-')));
const bundle = path.join(scratch, 'catalog.mjs');
await build({ stdin: { contents: "export * from './src/core/cloud.ts'; export * from './src/core/catalog.ts'; export * from './src/core/releaseSources.ts';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent' });
const { fetchCloudCatalog, catalogSnapshot, ensureCatalog, OFFICIAL_CATALOG_URL } = await import(pathToFileURL(bundle).href);
const catalog = { version: 42, updatedAt: '2026-11-15', providers: [{ key: 'fixture', name: '本地测试目录', format: 'openai-chat', baseUrl: 'https://example.test/v1', models: [{ id: 'real-model' }] }] };
let hits = 0, passed = 0;
const server = http.createServer((req, res) => {
  hits++;
  if (req.url === '/bad-redirect') { res.writeHead(302, { location: 'http://[' }); res.end(); return; }
  if (req.url === '/redirect') { res.writeHead(302, { location: '/catalog' }); res.end(); return; }
  if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); return; }
  if (req.url === '/truncated') { res.writeHead(200, { 'content-type': 'application/json', 'content-length': '999999' }); res.write('{"version":'); setTimeout(() => res.destroy(), 10); return; }
  if (req.url === '/trickle') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); const timer = setInterval(() => res.write(' '), 100); res.on('close', () => clearInterval(timer)); return; }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(catalog));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
async function test(label, run) { await run(); passed++; console.log(`PASS ${label}`); }
try {
  await test('legacy empty, invalid and credential-bearing hidden directory settings safely select the official cached directory', () => {
    const cacheKey = `catalog-${createHash('sha256').update(OFFICIAL_CATALOG_URL).digest('hex').slice(0, 20)}.json`;
    for (const url of ['', 'invalid URL', 'file:///tmp/catalog.json', 'https://user:secret@example.test/catalog', 'https://example.test/catalog#key']) {
      let requested;
      const store = { getSettings: () => ({ catalogUrl: url }), readExtra: name => { requested = name; return catalog; } };
      const result = catalogSnapshot(store); assert.equal(result.source, 'cache'); assert.equal(result.version, 42); assert.equal(requested, cacheKey);
    }
  });
  await test('a valid legacy directory retains its own isolated cache', () => {
    const endpoint = base + '/catalog', cacheKey = `catalog-${createHash('sha256').update(endpoint).digest('hex').slice(0, 20)}.json`;
    let requested; const store = { getSettings: () => ({ catalogUrl: endpoint }), readExtra: name => { requested = name; return catalog; } };
    assert.equal(catalogSnapshot(store).version, 42); assert.equal(requested, cacheKey);
  });
  await test('invalid cache with invalid hidden endpoint falls back to offline presets without breaking state retrieval', () => {
    const store = { getSettings: () => ({ catalogUrl: '' }), readExtra: () => ({ providers: 'broken' }) };
    const result = catalogSnapshot(store); assert.equal(result.source, 'builtin'); assert.ok(result.providers.length > 0);
  });
  await test('valid remote data stays usable when the disk cache cannot be written', async () => {
    const store = { writeExtra: () => { throw new Error('fixture disk full'); }, readExtra: () => ({ ...catalog, version: 1 }) };
    const result = await fetchCloudCatalog(base + '/catalog', store); assert.equal(result.source, 'remote'); assert.equal(result.version, 42); assert.match(result.warning, /缓存保存失败/);
  });
  await test('first-launch shared refresh keeps remote data despite failed persistence', async () => {
    const before = hits, store = { getSettings: () => ({ catalogUrl: base + '/catalog' }), readExtra: () => null, writeExtra: () => { throw new Error('fixture denied'); } };
    const results = await Promise.all([ensureCatalog(store), ensureCatalog(store)]); assert.equal(hits, before + 1); assert.ok(results.every(result => result.version === 42 && result.source === 'remote' && !result.syncing));
  });
  await test('a malformed redirect becomes an ordinary request failure', async () => {
    await assert.rejects(() => fetchCloudCatalog(base + '/bad-redirect'), /重定向/);
    assert.equal((await fetchCloudCatalog(base + '/catalog')).version, 42);
  });
  await test('relative redirects still work and redirect loops remain bounded', async () => {
    assert.equal((await fetchCloudCatalog(base + '/redirect')).version, 42);
    await assert.rejects(() => fetchCloudCatalog(base + '/loop'), /重定向/);
  });
  await test('a truncated response promptly falls back to the last validated cache', async () => {
    const start = Date.now(); const result = await fetchCloudCatalog(base + '/truncated', { readExtra: () => catalog });
    assert.equal(result.source, 'cache'); assert.equal(result.version, 42); assert.ok(Date.now() - start < 3000);
  });
  await test('continuous tiny chunks cannot extend the 12-second startup deadline', async () => {
    const start = Date.now(); await assert.rejects(() => fetchCloudCatalog(base + '/trickle'), /超时/);
    const elapsed = Date.now() - start; assert.ok(elapsed >= 11000 && elapsed < 15000, `elapsed ${elapsed}ms`);
  });
  console.log(`Catalog resilience: ${passed} tests passed`);
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  assert.equal(fs.realpathSync(path.dirname(scratch)), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(scratch).startsWith('aurora-catalog-resilience-'));
  fs.rmSync(scratch, { recursive: true, force: true });
}
