"""History-safe client setup UI using isolated IPC fixtures; no native clients or user files."""
import json
from pathlib import Path
import subprocess
import tempfile

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]

FIXTURE = """() => {
 window.generation=0;
 window.resetFixture=(agentId='chatgpt-desktop')=>{
   window.generation++;window.calls=[];window.pending=[];window.holdApply=false;window.applyFailure=null;
   window.historyPlan={total:12,repairable:8,unchanged:4,blocked:0,backupRequired:true,requiresClientExit:true,message:'将活动和归档会话一起迁移到本次配置。',warnings:[]};
   window.historyResult={backedUp:12,repaired:8,unchanged:4,backupId:'fixture-backup',backupPath:'C:/Fixture/history-backup',message:'历史备份和迁移均已完成。'};
   const claude=agentId==='claude-code';const cli=agentId!=='chatgpt-desktop';
   window.state={settings:{},platform:'win32',agents:{},presets:[],providers:[{id:'supplier',name:'历史测试供应商',baseUrl:'https://fixture.invalid/v1',format:claude?'anthropic':'openai-responses',enabled:true,models:[{id:'first-model',contextWindow:272000},{id:'selected-model',contextWindow:128000}],apiKeys:[]}],detected:{[agentId]:{installed:true,configured:true,supportsCodexConfig:true,command:'C:/Fixture/ChatGPT.exe',configPath:'C:/Fixture/.codex/config.toml',evidence:[]}},agentCatalog:[{id:agentId,name:claude?'Claude Code':cli?'Codex CLI':'ChatGPT 桌面版',category:cli?'cli':'desktop',vendor:claude?'Anthropic':'OpenAI',description:'隔离客户端',protocol:claude?'anthropic':'openai-responses',support:'automatic',supportNote:'隔离的自动配置向导'}],codexCoexist:{identity:{available:false},models:[],warnings:[]}};
 };
 window.resetFixture();
 window.aurora={invoke:async(action,payload={})=>{
   window.calls.push({action,payload:structuredClone(payload)});
   if(action==='agent.preview')return {ok:true,revision:'fixture-history-revision-'+window.calls.length,files:[{path:'C:/Fixture/.codex/config.toml',before:'original fixture',after:'reviewed fixture'}],warnings:[],requiresRestart:true,...(window.historyPlan?{history:structuredClone(window.historyPlan)}:{})};
   if(action==='agent.connect'){
     if(window.holdApply)await new Promise(resolve=>window.pending.push(resolve));
     return window.applyFailure?structuredClone(window.applyFailure):{ok:true,message:'隔离配置已应用',path:'C:/Fixture/.codex/config.toml',...(window.historyResult?{history:structuredClone(window.historyResult)}:{})};
   }
   if(action==='agent.lifecycle')return {ok:true,agentId:payload.agentId,kind:'desktop',installed:true,supported:true};
   if(action==='agent.restart')return {ok:true,agentId:payload.agentId,kind:'desktop',operation:'restarted',message:'隔离客户端已重新启动'};
   throw Error('Unexpected isolated RPC '+action);
 }};
}"""


def main():
    checks, errors, network = [], [], []
    with tempfile.TemporaryDirectory(prefix='yunqiao-history-switch-ui-') as temporary:
        bundle = Path(temporary) / 'ui.js'
        source = """import React from 'react';import {createRoot} from 'react-dom/client';
import Agents from './ui/src/pages/Agents.tsx';import {ToastHost} from './ui/src/components/ui.tsx';
const root=createRoot(document.getElementById('root'));
window.renderAgents=()=>root.render(<ToastHost key={window.generation}><Agents state={structuredClone(window.state)} reload={async()=>window.renderAgents()} go={()=>{}}/></ToastHost>);
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

            def count(action):
                return page.evaluate('action=>window.calls.filter(call=>call.action===action).length', action)

            def last_payload(action):
                return page.evaluate('action=>window.calls.filter(call=>call.action===action).at(-1).payload', action)

            def open_preview(agent='chatgpt-desktop', setup=None):
                page.evaluate('agent=>window.resetFixture(agent)', agent)
                if setup:
                    page.evaluate(setup)
                page.evaluate('window.renderAgents()')
                page.get_by_role('button', name='开始配置 →', exact=True).click()
                name = page.evaluate('window.state.agentCatalog[0].name')
                dialog = page.get_by_role('dialog', name='配置 ' + name, exact=True)
                dialog.get_by_role('button', name='下一步：选择模型 →', exact=True).click()
                dialog.get_by_role('combobox', name='选择模型', exact=True).select_option('selected-model')
                dialog.get_by_role('combobox', name='接入方式', exact=True).select_option('direct')
                dialog.get_by_role('combobox', name='客户端执行权限', exact=True).select_option('full-access')
                dialog.get_by_role('button', name='预览配置 →', exact=True).click()
                expect(dialog.get_by_text('reviewed fixture', exact=True)).to_be_visible()
                return dialog

            dialog = open_preview()
            summary = dialog.get_by_role('region', name='历史会话自动处理', exact=True)
            expect(summary).to_contain_text('共 12 个会话 · 8 个需要修复 · 4 个无需修改')
            expect(summary).to_contain_text('应用配置时自动备份历史并完成修复，无需另行批量操作')
            expect(summary).to_contain_text('请先保存工作')
            expect(summary.get_by_role('checkbox')).to_have_count(0)
            expect(dialog.get_by_role('button', name='备份历史并应用配置', exact=True)).to_be_enabled()
            assert count('agent.connect') == count('agent.restart') == 0
            passed('Shared Codex setup previews full-history backup and repair with no skip control or implicit process action')

            page.evaluate("window.applyFailure={ok:false,code:'CLIENT_HISTORY_BUSY',message:'请保存工作并退出相关客户端；原配置和历史尚未修改。'}")
            dialog.get_by_role('button', name='备份历史并应用配置', exact=True).click()
            expect(dialog.get_by_role('alert')).to_contain_text('原配置和历史尚未修改')
            expect(dialog.get_by_role('button', name='已退出，重新应用', exact=True)).to_be_enabled()
            expect(dialog.get_by_text('reviewed fixture', exact=True)).to_be_visible()
            expect(dialog.get_by_role('heading', name='配置已应用', exact=True)).to_have_count(0)
            first = last_payload('agent.connect')
            assert first['providerId'] == 'supplier' and first['model'] == 'selected-model'
            assert first['mode'] == 'direct' and first['permissionMode'] == 'full-access'
            assert count('agent.preview') == 1 and count('agent.restart') == 0
            passed('Busy client refusal preserves the reviewed provider, model, routing, permissions and revision without starting or stopping a client')

            page.evaluate('window.applyFailure=null;window.holdApply=true')
            dialog.get_by_role('button', name='已退出，重新应用', exact=True).click()
            expect(dialog.get_by_role('button', name='正在备份历史并应用…', exact=True)).to_be_disabled()
            expect(dialog.get_by_role('button', name='取消', exact=True)).to_be_disabled()
            page.keyboard.press('Escape')
            expect(dialog).to_be_visible()
            assert count('agent.connect') == 2 and last_payload('agent.connect') == first
            page.evaluate('window.pending.shift()()')
            expect(dialog.get_by_role('heading', name='配置已应用', exact=True)).to_be_visible()
            outcome = dialog.get_by_role('status', name='历史会话处理结果', exact=True)
            expect(outcome).to_contain_text('已备份 12 个会话，已修复 8 个，4 个无需修改')
            outcome.get_by_text('查看历史备份位置', exact=True).click()
            expect(outcome).to_contain_text('C:/Fixture/history-backup')
            expect(dialog).to_contain_text('无需再手动修复')
            assert count('agent.connect') == 2
            passed('Retry submits the identical reviewed request, locks duplicate actions while backing up, and reports completed backup and migration counts')

            dialog.get_by_role('button', name='重新启动客户端', exact=True).click()
            confirmation = page.get_by_role('dialog', name='重新启动 ChatGPT 桌面版', exact=True)
            expect(confirmation).to_be_visible()
            assert count('agent.restart') == 0
            confirmation.get_by_role('button', name='确认重新启动', exact=True).click()
            expect(confirmation).to_have_count(0)
            expect(dialog.get_by_text('隔离客户端已重新启动', exact=True)).to_be_visible()
            assert count('agent.restart') == 1
            passed('Successful automatic history repair keeps the existing explicit restart flow immediately available')

            dialog = open_preview(setup='window.historyPlan.blocked=2;window.historyPlan.total=14')
            expect(dialog.get_by_role('button', name='备份历史并应用配置', exact=True)).to_be_disabled()
            expect(dialog.get_by_role('alert')).to_contain_text('2 个会话暂不能安全修复，已停止应用；当前配置保持不变')
            assert count('agent.connect') == 0
            page.evaluate('window.historyPlan.blocked=0;window.historyPlan.total=12')
            dialog.get_by_role('button', name='重新检查历史', exact=True).click()
            expect(dialog.get_by_role('button', name='备份历史并应用配置', exact=True)).to_be_enabled()
            assert count('agent.preview') == 2 and count('agent.connect') == 0
            passed('Blocked history disables all configuration writes and can be rescanned without losing selection')

            page.evaluate("window.applyFailure={ok:false,message:'历史迁移失败，已恢复原配置和历史。'}")
            dialog.get_by_role('button', name='备份历史并应用配置', exact=True).click()
            expect(dialog.get_by_role('alert')).to_contain_text('历史迁移失败，已恢复原配置和历史')
            expect(dialog.get_by_role('heading', name='配置已应用', exact=True)).to_have_count(0)
            expect(dialog.get_by_role('combobox', name='选择模型', exact=True)).to_have_value('selected-model')
            expect(dialog.get_by_role('button', name='预览配置 →', exact=True)).to_be_visible()
            expect(dialog.get_by_role('button', name='已退出，重新应用', exact=True)).to_have_count(0)
            assert count('agent.restart') == 0
            passed('Transaction failure never displays success or restarts a client and requires a fresh preview')

            dialog = open_preview(agent='codex-cli')
            expect(dialog.get_by_role('button', name='备份历史并应用配置', exact=True)).to_be_enabled()
            page.evaluate("window.applyFailure={ok:false,code:'CLIENT_HISTORY_BUSY',message:'请先结束旧的 Codex 终端会话。'}")
            dialog.get_by_role('button', name='备份历史并应用配置', exact=True).click()
            expect(dialog.get_by_role('button', name='已退出，重新应用', exact=True)).to_be_visible()
            assert count('agent.restart') == count('agent.lifecycle') == 0
            passed('Codex CLI uses the same mandatory history flow and never terminates or reopens a terminal on a busy result')

            dialog = open_preview(setup='window.historyPlan={total:0,repairable:0,unchanged:0,blocked:0,backupRequired:false,requiresClientExit:false,message:"没有已有历史会话。"}')
            expect(dialog.get_by_role('button', name='备份并应用配置', exact=True)).to_be_enabled()
            expect(dialog.get_by_role('button', name='备份历史并应用配置', exact=True)).to_have_count(0)
            dialog = open_preview(agent='claude-code')
            expect(dialog.get_by_role('region', name='历史会话自动处理', exact=True)).to_have_count(0)
            expect(dialog.get_by_role('button', name='备份并应用配置', exact=True)).to_be_enabled()
            passed('Empty history retains the ordinary apply action and non-Codex clients do not receive the Codex history UI')

            assert not errors, errors
            assert not network, network
            browser.close()
    print(json.dumps({'ok': True, 'checks': checks, 'browserErrors': errors}, ensure_ascii=False))


if __name__ == '__main__':
    main()
