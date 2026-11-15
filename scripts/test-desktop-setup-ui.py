"""Shared Codex configuration works independently of executable discovery; isolated IPC."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]

FIXTURE = """() => {
 window.generation=0;window.calls=[];window.navigatedPage='';
 window.initialDetection={installed:false,configured:true,configPath:'C:/Fixture/.codex/config.toml',supportsCodexConfig:false,evidence:[]};
 window.readyDetection={...window.initialDetection,installed:true,command:'C:/Fixture/Codex.exe',productName:'Codex',version:'2.0',supportsCodexConfig:true,evidence:['已找到 Codex 编程模块']};
 window.resetFixture=()=>{
   window.generation++;window.calls=[];window.pending=[];window.holdSelect=false;window.holdDetect=false;window.selectFailure='';window.selectCanceled=false;window.previewFailure='';window.connectFailure='';window.detectFailure='';window.selectionNextSupport='automatic';window.selectedDetection=structuredClone(window.readyDetection);window.nextDetection=structuredClone(window.readyDetection);
   window.state={settings:{},platform:'win32',agents:{},presets:[],providers:[{id:'supplier',name:'已测试供应商',format:'openai-responses',enabled:true,models:[{id:'gpt-5.4'},{id:'gpt-5.4-codex'}],apiKeys:[]}],detected:{'chatgpt-desktop':structuredClone(window.initialDetection)},agentCatalog:[{id:'chatgpt-desktop',name:'ChatGPT 桌面版',category:'desktop',vendor:'OpenAI',description:'桌面客户端',protocol:'openai-responses',configPath:'C:/Fixture/.codex/config.toml',support:'automatic',supportNote:'共享编程配置可直接应用，程序能力单独识别'}],codexCoexist:{identity:{available:false},models:[],warnings:[]}};
 };
 window.resetFixture();
 window.aurora={invoke:async(action,payload={})=>{
   window.calls.push({action,payload:structuredClone(payload)});
   if(action==='provider.test')return {ok:true,message:'测试通过，供应商 API 可用'};
   if(action==='agent.preview'){
     if(window.previewFailure)return {ok:false,message:window.previewFailure};
     return {ok:true,revision:'reviewed-revision-'+window.calls.length,files:[{path:'C:/Fixture/.codex/config.toml',before:'old',after:'new'}],warnings:[],requiresRestart:true};
   }
   if(action==='agent.connect')return window.connectFailure?{ok:false,message:window.connectFailure}:{ok:true,message:'隔离配置已应用'};
   if(action==='agent.desktop.select'){
     if(window.holdSelect)await new Promise(resolve=>window.pending.push(resolve));
     if(window.selectCanceled)return {ok:false,canceled:true};
     const detected=structuredClone(window.selectedDetection);
     if(window.selectFailure)return {ok:false,message:window.selectFailure,detected};
     window.state.detected['chatgpt-desktop']=detected;
     window.state.agentCatalog[0].support=window.selectionNextSupport;
     return {ok:true,detected};
   }
   if(action==='agent.detect'){
     if(window.holdDetect)await new Promise(resolve=>window.pending.push(resolve));
     if(window.detectFailure)throw Error(window.detectFailure);
     window.state.detected['chatgpt-desktop']=structuredClone(window.nextDetection);
     return structuredClone(window.state.detected);
   }
   if(action==='agent.diagnose')return {ok:true,agentId:'chatgpt-desktop',checkedAt:new Date().toISOString(),checks:[{id:'installation',title:'客户端安装',status:'warning',detail:'可在向导中重新选择实际程序'}],report:'Fixture diagnostic without paths'};
   throw Error('Unexpected isolated RPC '+action);
 }};
}"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--screenshots', type=Path)
    args = parser.parse_args()
    if args.screenshots:
        args.screenshots.mkdir(parents=True, exist_ok=True)
    checks, errors, network = [], [], []
    with tempfile.TemporaryDirectory(prefix='yunqiao-desktop-setup-ui-') as temporary:
        bundle = Path(temporary) / 'ui.js'
        source = """import React from 'react';import {createRoot} from 'react-dom/client';
import Agents from './ui/src/pages/Agents.tsx';import {ToastHost} from './ui/src/components/ui.tsx';
const root=createRoot(document.getElementById('root'));
window.renderAgents=()=>root.render(<ToastHost key={window.generation}><Agents state={structuredClone(window.state)} reload={async()=>window.renderAgents()} go={page=>window.navigatedPage=page}/></ToastHost>);
window.renderAgents();"""
        options = {'stdin': {'contents': source, 'resolveDir': str(ROOT), 'loader': 'tsx'}, 'outfile': str(bundle),
                   'bundle': True, 'platform': 'browser', 'format': 'iife', 'define': {'process.env.NODE_ENV': '"production"'}}
        subprocess.run(['node', '-e', 'require("esbuild").buildSync(' + json.dumps(options) + ')'], cwd=ROOT, check=True)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={'width': 1380, 'height': 1050})
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.route('**/*', lambda route: (network.append(route.request.url), route.abort()))
            page.set_content('<html data-theme="light"><main id="root" style="padding:24px"></main></html>')
            page.add_style_tag(path=str(bundle.with_suffix('.css')))
            for style in ['app.css', 'workspace.css']:
                page.add_style_tag(path=str(ROOT / 'ui/src/styles' / style))
            page.evaluate(FIXTURE)
            page.add_script_tag(path=str(bundle))

            def passed(label):
                checks.append(label)
                print('PASS', label, flush=True)

            def open_wizard(reset=True, setup=None):
                if reset:
                    page.evaluate('window.resetFixture()')
                if setup:
                    page.evaluate(setup)
                page.evaluate('window.renderAgents()')
                page.get_by_role('button', name='开始配置 →', exact=True).click()
                dialog = page.get_by_role('dialog', name='配置 ChatGPT 桌面版', exact=True)
                dialog.locator('.provider-choice').filter(has=page.get_by_text('已测试供应商', exact=True)).click()
                if page.evaluate("window.state.codexCoexist.identity.available"):
                    expect(dialog.get_by_text('共存模式保留官方账号身份；第三方服务仅使用你配置的供应商密钥。', exact=True)).to_be_visible()
                    dialog.get_by_label('保留官方账号并与第三方模型共存', exact=True).uncheck()
                    expect(dialog.get_by_text('API 模式保留官方登录文件', exact=False)).to_be_visible()
                    expect(dialog.get_by_text('官方聊天及云功能可能暂不可用', exact=False)).to_be_visible()
                else:
                    expect(dialog.get_by_text('API 模式保留官方登录文件', exact=False)).to_be_visible()
                dialog.get_by_role('button', name='下一步：选择模型 →', exact=True).click()
                dialog.get_by_role('combobox', name='选择模型', exact=True).select_option('gpt-5.4-codex')
                dialog.get_by_role('button', name='测试连接', exact=True).click()
                expect(dialog.get_by_text('测试通过，供应商 API 可用', exact=False)).to_be_visible()
                return dialog

            def count(action):
                return page.evaluate('action=>window.calls.filter(call=>call.action===action).length', action)

            def panel_for(dialog, expand=False):
                panel = dialog.get_by_role('region', name='共享编程配置', exact=True)
                if expand:
                    panel.locator('.desktop-setup-program > summary').click()
                return panel

            dialog = open_wizard(False)
            panel = panel_for(dialog)
            expect(page.locator('.client-card').get_by_text('发现本地配置', exact=True)).to_be_visible()
            expect(panel.get_by_text('C:/Fixture/.codex/config.toml', exact=True)).to_be_visible()
            expect(panel.get_by_text('已发现配置', exact=True)).to_be_visible()
            expect(panel.get_by_text('尚未定位程序', exact=True)).not_to_be_visible()
            expect(panel.get_by_text('无需先定位客户端程序', exact=False)).to_be_visible()
            expect(panel.get_by_text('原生 ChatGPT 纯聊天界面不会因此切换 API', exact=False)).to_be_visible()
            dialog.get_by_role('button', name='预览配置 →', exact=True).click()
            expect(dialog.get_by_role('button', name='备份并应用配置', exact=True)).to_be_visible()
            assert count('agent.desktop.select') == count('agent.detect') == count('agent.connect') == 0
            dialog.get_by_role('button', name='备份并应用配置', exact=True).click()
            expect(dialog.get_by_role('heading', name='配置已应用', exact=True)).to_be_visible()
            assert count('agent.connect') == 1
            passed('Existing user configuration can be previewed and applied with no executable and no confirmed programming module')

            dialog = open_wizard(setup="window.state.detected['chatgpt-desktop'].configured=false;window.state.codexCoexist.identity.available=true;window.state.codexCoexist.models=[{official:true,upstreamModel:'gpt-official',displayName:'官方模型'}]")
            panel = panel_for(dialog)
            expect(panel.get_by_text('应用时创建', exact=True)).to_be_visible()
            dialog.get_by_role('button', name='预览配置 →', exact=True).click()
            expect(dialog.get_by_role('button', name='备份并应用配置', exact=True)).to_be_visible()
            assert count('agent.connect') == 0
            passed('A missing configuration is described as ready to create and reaches a reviewable preview without installing or selecting a program')

            dialog = open_wizard(setup="window.previewFailure='配置文件正在被修改，请重新预览'")
            panel = panel_for(dialog, expand=True)
            expect(panel.get_by_text('尚未定位程序', exact=True)).to_be_visible()
            dialog.get_by_role('button', name='预览配置 →', exact=True).click()
            expect(dialog.get_by_role('alert')).to_contain_text('配置文件正在被修改')
            page.evaluate('window.selectCanceled=true')
            previews = count('agent.preview')
            panel.get_by_role('button', name='选择程序并预览', exact=True).click()
            expect(dialog.get_by_role('button', name='预览配置 →', exact=True)).to_be_enabled()
            assert count('agent.preview') == previews and count('agent.connect') == 0
            expect(dialog.get_by_role('alert')).to_contain_text('配置文件正在被修改')
            expect(dialog.get_by_role('combobox', name='选择模型')).to_have_value('gpt-5.4-codex')
            expect(dialog.get_by_text('测试通过，供应商 API 可用', exact=False)).to_be_visible()
            passed('Canceling native selection preserves the preview error, chosen provider and model, and successful API test')

            page.evaluate("window.selectCanceled=false;window.selectedDetection={...window.initialDetection,installed:true,command:'D:/Chosen/ChatGPT.exe',version:'1.1',evidence:['尚未发现编程模块'],detectionError:'程序元数据读取失败'};window.selectFailure='所选程序无法读取'")
            panel.get_by_role('button', name='选择程序并预览', exact=True).click()
            expect(dialog.get_by_role('alert')).to_contain_text('所选程序无法读取')
            expect(panel.get_by_text('D:/Chosen/ChatGPT.exe', exact=True)).to_be_visible()
            expect(panel.get_by_text('程序元数据读取失败', exact=True)).to_be_visible()
            panel.locator('.desktop-setup-evidence > summary').click()
            expect(panel.get_by_text('尚未发现编程模块', exact=True)).to_be_visible()
            assert count('agent.preview') == previews and count('agent.connect') == 0
            expect(dialog.get_by_role('combobox', name='选择模型')).to_have_value('gpt-5.4-codex')
            expect(dialog.get_by_text('测试通过，供应商 API 可用', exact=False)).to_be_visible()
            passed('Selection failures expose available program details while preserving model choices and API test results')

            page.evaluate("window.selectFailure='';window.previewFailure='';window.holdSelect=true")
            panel.get_by_role('button', name='选择程序并预览', exact=True).click()
            page.wait_for_function('window.pending.length===1')
            expect(dialog.get_by_role('combobox', name='选择模型')).to_be_disabled()
            expect(dialog.get_by_role('button', name='取消', exact=True)).to_be_disabled()
            expect(panel.get_by_role('button', name='重新检测并预览', exact=True)).to_be_disabled()
            expect(panel.get_by_role('button', name='连接诊断', exact=True)).to_be_disabled()
            page.keyboard.press('Escape')
            expect(dialog).to_be_visible()
            page.evaluate('window.pending.shift()();window.holdSelect=false')
            expect(dialog.get_by_role('button', name='备份并应用配置', exact=True)).to_be_visible()
            assert count('agent.connect') == 0
            selections = page.evaluate("window.calls.filter(call=>call.action==='agent.desktop.select').map(call=>call.payload)")
            assert all(payload == {'agentId': 'chatgpt-desktop'} for payload in selections)
            last_preview = page.evaluate("window.calls.filter(call=>call.action==='agent.preview').at(-1).payload")
            assert last_preview['providerId'] == 'supplier' and last_preview['model'] == 'gpt-5.4-codex'
            passed('Selecting an unconfirmed program locks editing, sends only agentId, and creates a fresh preview without applying automatically')

            page.evaluate("window.connectFailure='配置已在其他窗口变化，请重新预览'")
            dialog.get_by_role('button', name='备份并应用配置', exact=True).click()
            expect(dialog.get_by_role('alert')).to_contain_text('请重新预览')
            expect(dialog.get_by_role('combobox', name='选择模型')).to_have_value('gpt-5.4-codex')
            expect(dialog.get_by_text('测试通过，供应商 API 可用', exact=False)).to_be_visible()
            page.evaluate("window.connectFailure=''")
            dialog.get_by_role('button', name='预览配置 →', exact=True).click()
            dialog.get_by_role('button', name='备份并应用配置', exact=True).click()
            expect(dialog.get_by_role('heading', name='配置已应用', exact=True)).to_be_visible()
            passed('Application conflicts return to the same choices for a new preview and successful retry')

            dialog = open_wizard(setup="window.state.agentCatalog[0].support='manual';window.state.detected['chatgpt-desktop']=structuredClone(window.readyDetection)")
            dialog.get_by_role('button', name='预览配置 →', exact=True).click()
            expect(dialog.get_by_role('button', name='备份并应用配置', exact=True)).not_to_be_visible()
            dialog.get_by_role('button', name='上一步', exact=True).click()
            panel = panel_for(dialog, expand=True)
            page.evaluate('window.selectedDetection=structuredClone(window.initialDetection)')
            panel.get_by_role('button', name='选择程序并预览', exact=True).click()
            expect(dialog.get_by_role('button', name='备份并应用配置', exact=True)).to_be_visible()
            assert count('agent.connect') == 0
            passed('Apply capability follows the latest catalog, independently of detected module support and the originally selected card')

            dialog = open_wizard()
            panel = panel_for(dialog, expand=True)
            page.evaluate('window.holdDetect=true;window.nextDetection=structuredClone(window.initialDetection)')
            panel.get_by_role('button', name='重新检测并预览', exact=True).click()
            page.wait_for_function('window.pending.length===1')
            expect(dialog.get_by_role('combobox', name='选择模型')).to_be_disabled()
            page.evaluate('window.pending.shift()();window.holdDetect=false')
            expect(dialog.get_by_role('button', name='备份并应用配置', exact=True)).to_be_visible()
            assert count('agent.desktop.select') == 0 and count('agent.connect') == 0
            dialog.get_by_role('button', name='上一步', exact=True).click()
            panel = panel_for(dialog, expand=True)
            expect(panel.get_by_text('尚未定位程序', exact=True)).to_be_visible()
            expect(dialog.get_by_role('combobox', name='选择模型')).to_have_value('gpt-5.4-codex')
            expect(dialog.get_by_text('测试通过，供应商 API 可用', exact=False)).to_be_visible()
            panel.get_by_role('button', name='连接诊断', exact=True).click()
            diagnostic = page.get_by_role('dialog', name='ChatGPT 桌面版 · 连接诊断', exact=True)
            expect(diagnostic.get_by_text('可在向导中重新选择实际程序', exact=True)).to_be_visible()
            page.keyboard.press('Escape')
            expect(diagnostic).not_to_be_visible()
            expect(dialog).to_be_visible()
            passed('Redetection without an executable still previews; nested diagnostics preserve the wizard and model selection')

            dialog = open_wizard(setup="window.state.platform='darwin';window.state.detected['chatgpt-desktop']={...window.initialDetection,command:'/Applications/Long Client Name/ChatGPT.app/Contents/MacOS/ChatGPT',configPath:'/Users/Fixture/.codex/config.toml',version:undefined}")
            panel = panel_for(dialog, expand=True)
            expect(panel.get_by_text('.app 应用包', exact=False)).to_be_visible()
            expect(panel.get_by_text('尚未读取到版本', exact=True)).to_be_visible()
            page.evaluate("document.documentElement.dataset.theme='dark'")
            if args.screenshots:
                page.screenshot(path=str(args.screenshots / 'desktop-recovery-dark.png'), animations='disabled')
            page.set_viewport_size({'width': 390, 'height': 844})
            panel.scroll_into_view_if_needed()
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            for button in panel.get_by_role('button').all():
                box = button.bounding_box()
                assert box and box['x'] >= 0 and box['x'] + box['width'] <= 390, box
            if args.screenshots:
                page.screenshot(path=str(args.screenshots / 'desktop-recovery-narrow-dark.png'), animations='disabled')
            passed('macOS program guidance, unknown version, long paths and the narrow dark layout remain usable')
            assert not errors, errors
            assert not network, network
            assert page.evaluate('window.navigatedPage') == ''
            browser.close()
    print(json.dumps({'ok': True, 'checks': checks, 'browserErrors': errors}, ensure_ascii=False))


if __name__ == '__main__':
    main()
