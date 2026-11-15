"""Plugin management browser acceptance with real package schemas and controlled RPC faults."""
import json
from pathlib import Path
import subprocess
import tempfile
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]


def main():
    with tempfile.TemporaryDirectory(prefix='yunqiao-plugin-ui-') as temporary:
        bundle = Path(temporary) / 'plugin-ui.js'
        source = """import React from 'react';import {createRoot} from 'react-dom/client';
import Plugins from './ui/src/pages/Plugins.tsx';import CodexEnhance from './ui/src/pages/CodexEnhance.tsx';import {ToastHost} from './ui/src/components/ui.tsx';
const root=createRoot(document.getElementById('root'));
window.renderPage=(page='plugins')=>{window.page=page;const Page=page==='codex'?CodexEnhance:Plugins;root.render(<ToastHost><Page key={page+window.generation} state={structuredClone(window.appState)} reload={async()=>window.renderPage(window.page)} go={target=>{window.navigation=target;}}/></ToastHost>);};window.renderPage();"""
        build = "require('esbuild').buildSync(" + json.dumps({'stdin': {'contents': source, 'resolveDir': str(ROOT), 'loader': 'tsx'}, 'bundle': True, 'platform': 'browser', 'format': 'iife', 'outfile': str(bundle), 'define': {'process.env.NODE_ENV': '"production"'}}) + ')'
        subprocess.run(['node', '-e', build], cwd=ROOT, check=True)
        packages = []
        for name in ['image-overlay', 'agent-pet', 'typing-effects']:
            manifest = json.loads((ROOT / f'third_party/codexplusplus/materialized/extensions/{name}/codexpp.json').read_text(encoding='utf-8'))
            packages.append({'id': 'bundled:' + name, 'name': manifest['name'], 'description': manifest['description'], 'source': 'bundled', 'version': manifest['version'], 'license': 'AGPL-3.0-only', 'installed': True, 'enabled': False, 'status': 'installed', 'configSchema': manifest['config'], 'config': {key: value.get('default') for key, value in manifest['config'].items()}})
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={'width': 1380, 'height': 1100})
            errors, checks = [], []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('dialog', lambda dialog: dialog.accept())
            page.set_content('<html data-theme="light"><main id="root" style="padding:24px"></main></html>')
            for style in ['app.css', 'workspace.css']:
                page.add_style_tag(path=str(ROOT / 'ui/src/styles' / style))
            page.evaluate("""packages=>{
              window.generation=0;window.calls=[];window.fail={};window.navigation='';
              window.ext={ok:true,upstream:{repository:'https://example.test/source',version:'2.6.9',revision:'fixture123',license:'AGPL-3.0-only'},client:{installed:true,version:'1',running:false},connection:{port:9222},runtime:{connected:false,applied:[],errors:[]},items:[...packages,
                {id:'builtin:unsupported',name:'暂不支持功能',description:'尚未适配',source:'builtin',installed:true,enabled:true,status:'unsupported',reason:'缺少原生接口'},
                {id:'public:new',name:'待安装插件',description:'公开插件',source:'public',installed:false,enabled:false,status:'available',version:'1',license:'MIT',tags:['special-search-tag'],requiresAuth:true,requiresRestart:true},
                {id:'public:update',name:'待更新插件',description:'目录提供新版本',source:'public',installed:true,enabled:false,status:'installed',version:'1',availableVersion:'2',updateAvailable:true,requiresRestart:true},
                {id:'full:missing',name:'缺失文件插件',description:'可修复',source:'full',installed:true,enabled:false,status:'installed',version:'1',missingFiles:true},
                {id:'full:removed',name:'已下架插件',description:'保留本机版本',source:'full',installed:true,enabled:true,status:'installed',version:'1',catalogMissing:true} ]};
              window.appState={plugins:[],builtinMiddleware:[{id:'system-prompt',name:'统一提示词',description:'追加提示词',defaultOptions:{text:'中文回答'}}]};
              window.assets=[{id:'skill:fixture',kind:'skill',name:'Fixture Skill',enabled:true,mutable:true,path:'/fixture/skills/demo'},{id:'plugin:fixture',kind:'plugin',name:'Native Plugin',enabled:true,mutable:false,path:'/fixture/plugins/demo'}];
              window.aurora={invoke:async(action,payload={})=>{
                window.calls.push({action,payload:structuredClone(payload)});
                if(window.fail[action])throw new Error(window.fail[action]);
                if(action==='extension.list')return structuredClone(window.ext);
                if(action==='extension.refresh')return {ok:true};
                if(action==='extension.configure') {if(payload.port<1024)return {ok:false,message:'调试端口无效'};return {ok:true};}
                if(action==='extension.connect'){window.ext.runtime.connected=true;return {ok:true};}
                if(action==='extension.disconnect'){window.ext.runtime.connected=false;return {ok:true};}
                if(action==='app.chooseImage')return {ok:true,path:'C:/fixture/background.png'};
                if(action.startsWith('extension.')){const item=window.ext.items.find(x=>x.id===payload.id);if(!item)throw new Error('Unknown item');
                  if(action==='extension.config'){if(payload.config.opacity>100)return {ok:false,message:'opacity 数值超出范围'};item.config=payload.config;return {ok:true};}
                  if(action==='extension.install'){item.installed=true;item.enabled=false;item.status='installed';item.version=item.availableVersion||item.version;item.updateAvailable=false;item.missingFiles=false;return {ok:true,message:'已安装，启用后重启客户端生效'};}
                  if(action==='extension.toggle'){item.enabled=payload.enabled;return {ok:true};}
                  if(action==='extension.remove'){item.installed=false;item.enabled=false;item.status='available';return {ok:true};}}
                if(action==='plugin.sample')return 'function onRequest(ir, ctx) { return ir; }';
                if(action==='plugin.save'){const index=window.appState.plugins.findIndex(x=>x.id===payload.id);const record={...(index<0?{}:window.appState.plugins[index]),...payload,id:payload.id||'plg-fixture'};if(index<0)window.appState.plugins.push(record);else window.appState.plugins[index]=record;return record;}
                if(action==='plugin.delete'){window.appState.plugins=window.appState.plugins.filter(x=>x.id!==payload.id);return {ok:true};}
                if(action==='codex.assets')return window.badAssetResult?{ok:false,message:'资源目录不可读'}:{assets:structuredClone(window.assets)};
                if(action==='codex.flags')return {flags:{},schema:[]};
                if(action==='codex.diagnose')return {ok:true,total:0,byProvider:[],samples:[]};
                if(action==='codex.toggleAsset'){window.assets.find(x=>x.id===payload.id).enabled=payload.enabled;return {ok:true,message:'设置已保存'};}
                throw new Error('Unexpected '+action);
              }};
            }""", packages)
            page.add_script_tag(path=str(bundle))
            expect(page.locator('.extension-card')).to_have_count(8)
            card = lambda name: page.locator('.extension-card').filter(has=page.get_by_role('heading', name=name, exact=True))
            card('背景图').get_by_role('button', name='设置', exact=True).click()
            dialog = page.get_by_role('dialog', name='背景图 · 插件设置', exact=True)
            dialog.get_by_role('button', name='选择图片', exact=True).click()
            expect(dialog.get_by_label('图片', exact=True)).to_have_value('C:/fixture/background.png')
            page.evaluate("window.fail['app.chooseImage']='图片选择器不可用'")
            dialog.get_by_role('button', name='选择图片', exact=True).click()
            expect(dialog.get_by_role('alert')).to_have_text('图片选择器不可用')
            page.evaluate("delete window.fail['app.chooseImage']")
            dialog.get_by_label('透明度（%）', exact=True).fill('999')
            dialog.get_by_role('button', name='保存设置', exact=True).click()
            expect(dialog.get_by_role('alert')).to_have_text('opacity 数值超出范围')
            dialog.get_by_label('透明度（%）', exact=True).fill('45')
            dialog.get_by_role('button', name='保存设置', exact=True).click()
            expect(dialog).not_to_be_visible()
            assert page.evaluate("window.ext.items.find(x=>x.id==='bundled:image-overlay').config.opacity") == 45
            checks.append('Real upstream format:file exposes the image chooser; picker and validation failures remain inside the open modal')

            card('背景图').get_by_role('button', name='设置', exact=True).click()
            dialog.get_by_text('高级 JSON 配置', exact=True).click()
            dialog.get_by_label('桌面插件配置', exact=True).fill('{broken')
            before = page.evaluate("window.calls.filter(x=>x.action==='extension.config').length")
            dialog.get_by_role('button', name='保存设置', exact=True).click()
            expect(dialog.get_by_role('alert')).to_contain_text('不是有效 JSON')
            assert page.evaluate("window.calls.filter(x=>x.action==='extension.config').length") == before
            dialog.get_by_role('button', name='取消', exact=True).click()
            checks.append('Malformed advanced configuration is rejected locally without invoking the backend')

            card('打字特效').get_by_role('button', name='设置', exact=True).click()
            typing = page.get_by_role('dialog', name='打字特效 · 插件设置', exact=True)
            typing.get_by_role('button', name='移除插件', exact=True).click()
            expect(typing).not_to_be_visible()
            expect(card('打字特效').get_by_role('button', name='安装', exact=True)).to_be_visible()
            card('打字特效').get_by_role('button', name='安装', exact=True).click()
            expect(card('打字特效').get_by_role('switch')).not_to_be_checked()
            card('打字特效').get_by_role('switch').click()
            expect(card('打字特效').get_by_role('switch')).to_be_checked()
            page.evaluate("window.ext.items.find(x=>x.id==='bundled:typing-effects').status='error';window.ext.runtime.errors=[{id:'bundled:typing-effects',message:'原生输入框不存在'}]")
            page.get_by_role('button', name='刷新状态', exact=True).click()
            expect(card('打字特效').get_by_text('运行异常', exact=True)).to_be_visible()
            page.get_by_text('有 1 个扩展未能生效，查看原因', exact=True).click()
            expect(page.get_by_text('bundled:typing-effects：原生输入框不存在', exact=True)).to_be_visible()
            checks.append('Bundled extension removal and reinstall preserve explicit enablement while runtime errors never claim activation')

            card('Agent 桌宠').get_by_role('button', name='设置', exact=True).click()
            pet = page.get_by_role('dialog', name='Agent 桌宠 · 插件设置', exact=True)
            expect(pet.get_by_text('支持随附图片、动图与音效。自定义音效导入、大肥鱼余额及专项统计尚未接入。', exact=True)).to_be_visible()
            assert pet.get_by_label('大肥鱼余额接口', exact=True).count() == 0
            assert pet.get_by_label('自定义按压音', exact=True).count() == 0
            assert pet.get_by_label('音效组', exact=True).locator('option').all_text_contents() == ['鸭子音效', '特效音效']
            pet.get_by_role('button', name='取消', exact=True).click()
            checks.append('Pet settings disclose backend limitations and expose only supported native sound choices')

            disabled = card('暂不支持功能').get_by_role('switch')
            expect(disabled).to_be_enabled()
            disabled.click()
            expect(disabled).not_to_be_checked()
            expect(disabled).to_be_disabled()
            checks.append('Legacy unsupported enhancements can be disabled while unsupported enabling stays blocked')

            page.get_by_role('button', name='同步市场索引', exact=True).click()
            page.wait_for_function("window.calls.some(x=>x.action==='extension.refresh')")
            assert page.evaluate("window.calls.filter(x=>x.action==='extension.refresh').at(-1).payload") == {}
            page.get_by_role('button', name='完整索引 2', exact=True).click()
            page.get_by_role('button', name='同步市场索引', exact=True).click()
            page.wait_for_function("window.calls.filter(x=>x.action==='extension.refresh').length===2")
            assert page.evaluate("window.calls.filter(x=>x.action==='extension.refresh').at(-1).payload") == {'source': 'full'}
            page.get_by_role('button', name='全部插件', exact=True).click()
            page.get_by_label('搜索桌面插件', exact=True).fill(' special-search-tag ')
            expect(page.locator('.extension-card')).to_have_count(1)
            expect(card('待安装插件')).to_be_visible()
            page.get_by_label('搜索桌面插件', exact=True).fill('')
            checks.append('All-market refresh includes both catalogs, source refresh is scoped, and tag search ignores surrounding spaces')

            page.evaluate("window.fail['extension.list']='插件列表暂不可读'")
            page.get_by_role('button', name='刷新状态', exact=True).click()
            expect(page.get_by_role('alert')).to_contain_text('插件列表暂不可读')
            expect(page.locator('.extension-card')).to_have_count(8)
            page.evaluate("delete window.fail['extension.list']")
            page.get_by_role('button', name='重新检测', exact=True).click()
            expect(page.get_by_role('alert')).to_have_count(0)
            checks.append('A failed plugin list refresh retains visible installed entries and can recover without restarting')

            card('待安装插件').get_by_role('button', name='安装', exact=True).click()
            expect(card('待安装插件').get_by_role('switch')).not_to_be_checked()
            expect(card('待安装插件').get_by_text('已安装', exact=True)).to_be_visible()
            expect(card('待安装插件').get_by_text('需服务授权', exact=True)).to_be_visible()
            card('待安装插件').get_by_role('switch').click()
            expect(card('待安装插件').get_by_role('switch')).to_be_checked()
            checks.append('Market installation remains disabled until explicit enabling and preserves authorization and restart notices')

            expect(card('待更新插件').get_by_text('v1', exact=True)).to_be_visible()
            card('待更新插件').get_by_role('button', name='更新', exact=True).click()
            expect(card('待更新插件').get_by_text('v2', exact=True)).to_be_visible()
            expect(card('待更新插件').get_by_role('button', name='更新', exact=True)).to_have_count(0)
            expect(card('缺失文件插件').get_by_role('switch')).to_be_disabled()
            card('缺失文件插件').get_by_role('button', name='修复安装', exact=True).click()
            expect(card('缺失文件插件').get_by_role('switch')).to_be_enabled()
            checks.append('Installed version, update and missing-package repair actions follow the backend contract')

            removed = card('已下架插件')
            expect(removed.get_by_role('button', name='更新', exact=True)).to_have_count(0)
            removed.get_by_role('button', name='管理', exact=True).click()
            detail = page.get_by_role('dialog', name='已下架插件', exact=True)
            expect(detail.get_by_text('当前市场目录已不再收录此插件。已安装的版本仍可停用或移除。', exact=True)).to_be_visible()
            page.evaluate("window.fail['extension.remove']='原生配置写入失败'")
            detail.get_by_role('button', name='移除插件', exact=True).click()
            expect(detail.get_by_role('alert')).to_have_text('原生配置写入失败')
            page.evaluate("delete window.fail['extension.remove']")
            detail.get_by_role('button', name='移除插件', exact=True).click()
            expect(detail).not_to_be_visible()
            checks.append('Delisted plugins remain manageable and uninstall failures stay visible without dismissing details')

            page.get_by_role('button', name='连接设置', exact=True).click()
            connection = page.get_by_role('dialog', name='连接 ChatGPT 桌面版', exact=True)
            connection.get_by_label('桌面调试端口', exact=True).fill('100')
            connection.get_by_role('button', name='保存连接设置', exact=True).click()
            expect(connection.get_by_role('alert')).to_have_text('调试端口无效')
            connection.get_by_role('button', name='取消', exact=True).click()
            page.evaluate("window.ext.client.versionChanged=true;window.ext.client.version='2'")
            page.get_by_role('button', name='刷新状态', exact=True).click()
            expect(page.get_by_role('button', name='启动并连接', exact=True)).to_be_disabled()
            page.get_by_role('checkbox').check()
            expect(page.get_by_role('button', name='启动并连接', exact=True)).to_be_enabled()
            page.evaluate("window.ext.client.version='3'")
            page.get_by_role('button', name='刷新状态', exact=True).click()
            expect(page.get_by_role('checkbox')).not_to_be_checked()
            expect(page.get_by_role('button', name='启动并连接', exact=True)).to_be_disabled()
            checks.append('Connection validation stays in its modal and a new client version requires a new compatibility acknowledgement')

            page.get_by_role('button', name='网关中间件', exact=True).click()
            page.get_by_role('button', name='新建插件', exact=True).click()
            custom = page.get_by_role('dialog', name='编辑自定义插件', exact=True)
            custom.get_by_label('插件名称', exact=True).fill('可用中间件')
            custom.get_by_label('中间件参数', exact=True).fill('[]')
            custom.get_by_role('button', name='保存配置', exact=True).click()
            expect(custom.get_by_role('alert')).to_contain_text('JSON 对象')
            custom.get_by_label('中间件参数', exact=True).fill('{"text":"fixture"}')
            page.evaluate("window.fail['plugin.save']='中间件保存失败'")
            custom.get_by_role('button', name='保存配置', exact=True).click()
            expect(custom.get_by_role('alert')).to_have_text('中间件保存失败')
            page.evaluate("delete window.fail['plugin.save']")
            custom.get_by_role('button', name='保存配置', exact=True).click()
            expect(custom).not_to_be_visible()
            expect(page.get_by_role('switch', name='启用可用中间件', exact=True)).not_to_be_checked()
            page.get_by_role('switch', name='启用可用中间件', exact=True).click()
            expect(page.get_by_role('switch', name='启用可用中间件', exact=True)).to_be_checked()
            assert page.evaluate("window.calls.filter(x=>x.action==='plugin.save').at(-1).payload") == {'id': 'plg-fixture', 'enabled': True}
            expect(page.get_by_text('等待请求验证', exact=True)).to_be_visible()
            page.evaluate("window.appState.middlewareStatus={'plg-fixture':{status:'error',checkedAt:'2026-11-15T01:00:00Z',message:'中间件执行失败，已保留原请求'}};window.renderPage()")
            expect(page.get_by_text('最近运行失败', exact=True)).to_be_visible()
            expect(page.get_by_text('中间件执行失败，已保留原请求', exact=True)).to_be_visible()
            page.evaluate("window.appState.middlewareStatus['plg-fixture'].status='blocked';window.appState.middlewareStatus['plg-fixture'].message='已按配置拦截';window.renderPage()")
            expect(page.get_by_text('最近请求被拦截', exact=True)).to_be_visible()
            page.evaluate("window.appState.middlewareStatus['plg-fixture'].status='ok';window.appState.middlewareStatus['plg-fixture'].message='';window.renderPage()")
            expect(page.get_by_text('最近运行正常', exact=True)).to_be_visible()
            assert page.locator('.middleware-status time').get_attribute('datetime') == '2026-11-15T01:00:00Z'
            page.get_by_role('switch', name='启用可用中间件', exact=True).click()
            expect(page.get_by_role('switch', name='启用可用中间件', exact=True)).not_to_be_checked()
            expect(page.get_by_text('最近运行正常', exact=True)).to_have_count(0)
            assert page.evaluate("window.calls.filter(x=>x.action==='plugin.save').at(-1).payload") == {'id': 'plg-fixture', 'enabled': False}
            checks.append('Custom middleware validates JSON, displays backend save errors in the editor and starts disabled')
            checks.append('Middleware separates enabled state from waiting, successful, failed and blocked execution with verification time')

            page.get_by_role('button', name='删除可用中间件', exact=True).click()
            deletion = page.get_by_role('dialog', name='删除「可用中间件」？', exact=True)
            page.evaluate("window.fail['plugin.delete']='删除失败'")
            deletion.get_by_role('button', name='删除插件', exact=True).click()
            expect(deletion.get_by_role('alert')).to_have_text('删除失败')
            page.evaluate("delete window.fail['plugin.delete']")
            deletion.get_by_role('button', name='删除插件', exact=True).click()
            expect(deletion).not_to_be_visible()
            expect(page.get_by_role('switch', name='启用可用中间件', exact=True)).to_have_count(0)
            checks.append('Custom middleware deletion keeps failure visible and removes the card only after success')

            page.evaluate("window.renderPage('codex')")
            expect(page.get_by_role('switch', name='启用Fixture Skill', exact=True)).to_be_checked()
            page.get_by_role('switch', name='启用Fixture Skill', exact=True).click()
            expect(page.get_by_role('switch', name='启用Fixture Skill', exact=True)).not_to_be_checked()
            page.get_by_role('button', name='管理云桥插件 →', exact=True).click()
            assert page.evaluate('window.navigation') == 'plugins'
            page.evaluate('window.badAssetResult=true')
            page.get_by_role('button', name='重新检测', exact=True).click()
            expect(page.get_by_role('alert')).to_have_text('资源读取失败：资源目录不可读')
            expect(page.get_by_text('Native Plugin', exact=True)).to_be_visible()
            checks.append('Workspace asset failure preserves the last list and the native-plugin card links to managed plugins')

            page.evaluate("window.aurora=undefined;window.generation++;window.renderPage('plugins')")
            expect(page.get_by_text('请在电脑上管理桌面插件', exact=True)).to_be_visible()
            expect(page.get_by_role('button', name='启动并连接', exact=True)).to_have_count(0)
            page.get_by_role('button', name='网关中间件', exact=True).click()
            expect(page.get_by_role('button', name='新建插件', exact=True)).to_be_disabled()
            expect(page.get_by_role('switch')).to_have_count(0)
            assert not errors, errors
            checks.append('Remote mode exposes no desktop mutation controls or editable middleware scripts; no renderer exceptions')
            browser.close()
            report = {'passed': True, 'count': len(checks), 'checks': checks, 'scope': 'Chromium UI with real bundled manifest schemas and controlled IPC responses; no real client injection or downloads'}
            (ROOT / 'docs/PLUGIN-UI-VALIDATION.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            print(json.dumps(report, ensure_ascii=True), flush=True)


if __name__ == '__main__':
    main()
