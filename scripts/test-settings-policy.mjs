/** Application-owned update/model-sync settings survive legacy reads, saves and imports. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const workspace = path.resolve(import.meta.dirname, '..');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-settings-policy-')));
let passed = 0;
const check = (label, fn) => { fn(); passed++; console.log(`PASS ${label}`); };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
try {
  const bundle = path.join(scratch, 'api.cjs');
  await build({ stdin: { contents: "export * from './src/core/store/index.ts'; export * from './src/core/releaseSources.ts';", resolveDir: workspace, loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { AuroraStore, GITHUB_RELEASE_API } = createRequire(import.meta.url)(bundle);
  const fresh = new AuroraStore(path.join(scratch, 'fresh'));
  check('New stores persist the GitHub release API and automatic model sync immediately', () => {
    const settings = fresh.getSettings(), disk = read(path.join(fresh.dir, 'settings.json'));
    assert.equal(settings.updateUrl, GITHUB_RELEASE_API); assert.equal(settings.autoSyncModels, true);
    assert.equal(disk.updateUrl, GITHUB_RELEASE_API); assert.equal(disk.autoSyncModels, true);
  });
  const legacyDir = path.join(scratch, 'legacy'); fs.mkdirSync(legacyDir);
  const token = 'fixture-existing-gateway-token', catalog = 'http://127.0.0.1:43001/test-catalog';
  fs.writeFileSync(path.join(legacyDir, 'settings.json'), JSON.stringify({ gatewayToken: token, gatewayPort: 4401, theme: 'dark', updateUrl: 'https://ai.haowucm.cn/pub.php?action=update', autoSyncModels: false, catalogUrl: catalog }));
  const legacy = new AuroraStore(legacyDir); let writes = 0;
  const save = legacy.settings.write.bind(legacy.settings);
  legacy.settings.write = value => { writes++; save(value); };
  check('Legacy website update settings migrate once without changing tokens or catalog configuration', () => {
    const current = legacy.getSettings(); legacy.getSettings();
    assert.equal(current.updateUrl, GITHUB_RELEASE_API); assert.equal(current.autoSyncModels, true); assert.equal(writes, 1);
    assert.equal(current.gatewayToken, token); assert.equal(current.gatewayPort, 4401); assert.equal(current.theme, 'dark'); assert.equal(current.catalogUrl, catalog);
    const reopened = new AuroraStore(legacyDir).getSettings(); assert.equal(reopened.updateUrl, GITHUB_RELEASE_API); assert.equal(reopened.autoSyncModels, true); assert.equal(reopened.gatewayToken, token);
  });
  check('Settings saves cannot restore a custom update source or disable the hidden automatic sync policy', () => {
    const settings = legacy.saveSettings({ updateUrl: 'invalid legacy value', autoSyncModels: false, catalogUrl: catalog + '/alternate', closeToTray: false });
    assert.equal(settings.updateUrl, GITHUB_RELEASE_API); assert.equal(settings.autoSyncModels, true); assert.equal(settings.catalogUrl, catalog + '/alternate'); assert.equal(settings.closeToTray, false);
    const disk = read(path.join(legacyDir, 'settings.json')); assert.equal(disk.updateUrl, GITHUB_RELEASE_API); assert.equal(disk.autoSyncModels, true);
  });
  check('Imported legacy backups normalize both policies and export durable normalized values', () => {
    const backup = legacy.exportAll(); backup.settings.updateUrl = 'https://third-party.invalid/update'; backup.settings.autoSyncModels = false; backup.settings.catalogUrl = catalog;
    legacy.importAll(backup);
    const exported = legacy.exportAll().settings, reopened = new AuroraStore(legacyDir).getSettings();
    assert.equal(exported.updateUrl, GITHUB_RELEASE_API); assert.equal(exported.autoSyncModels, true); assert.equal(exported.catalogUrl, catalog);
    assert.equal(reopened.updateUrl, GITHUB_RELEASE_API); assert.equal(reopened.autoSyncModels, true); assert.equal(reopened.gatewayToken, token);
  });
  check('Invalid imports still leave all existing configuration unchanged', () => {
    const original = fs.readFileSync(path.join(legacyDir, 'settings.json'), 'utf8');
    const backup = legacy.exportAll(); backup.settings.autoSyncModels = false; backup.settings.updateUrl = 'https://third-party.invalid/update'; backup.settings.gatewayPort = -1;
    assert.throws(() => legacy.importAll(backup), /网关端口/);
    assert.equal(fs.readFileSync(path.join(legacyDir, 'settings.json'), 'utf8'), original);
  });
  check('A settings object written by an older integration is normalized on the next read', () => {
    legacy.settings.write({ ...legacy.getSettings(), updateUrl: '', autoSyncModels: false });
    const current = legacy.getSettings(); assert.equal(current.updateUrl, GITHUB_RELEASE_API); assert.equal(current.autoSyncModels, true);
    assert.equal(read(path.join(legacyDir, 'settings.json')).autoSyncModels, true);
  });
  console.log(`\nSettings policy: ${passed} checks passed.`);
} finally {
  assert(path.basename(scratch).startsWith('aurora-settings-policy-'));
  assert.equal(fs.realpathSync(path.dirname(scratch)), fs.realpathSync(os.tmpdir()));
  fs.rmSync(scratch, { recursive: true, force: true });
}
