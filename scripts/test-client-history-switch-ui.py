"""History-safe client setup UI using isolated IPC fixtures; no native clients or user files."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]

FIXTURE = """() => {
 window.generation=0;
 window.resetFixture=(agentId='chatgpt-desktop')=>{
   window.generation++;window.calls=[];window.pending=[];window.holdApply=false;window.applyFailure=null;window.previewFailure=null;window.previewWarnings=[];
   window.historyPlan={total:12,repairable:8,unchanged:4,blocked:0,preserved:0,skipped:0,skippedReasons:[],filesToBackUp:12,indexDatabasesToBackUp:2,blockedReasons:[],backupRequired:true,requiresClientExit:true,message:'将活动和归档会话一起迁移到本次配置。',warnings:[]};
   window.historyResult={backedUp:12,indexBackedUp:2,preserved:0,skipped:0,skippedReasons:[],repaired:8,unchanged:4,backupId:'fixture-backup',backupPath:'C:/Fixture/history-backup',message:'历史备份和迁移均已完成。'};
   const claude=agentId==='claude-code';const cli=agentId!=='chatgpt-desktop';
   window.state={settings:{},platform:'win32',agents:{},presets:[],providers:[{id:'supplier',name:'历史测试供应商',baseUrl:'https://fixture.invalid/v1',format:claude?'anthropic':'openai-responses',enabled:true,models:[{id:'first-model',contextWindow:272000},{id:'selected-model',contextWindow:128000}],apiKeys:[]}],detected:{[agentId]:{installed:true,configured:true,supportsCodexConfig:true,command:'C:/Fixture/ChatGPT.exe',configPath:'C:/Fixture/.codex/config.toml',evidence:[]}},agentCatalog:[{id:agentId,name:claude?'Claude Code':cli?'Codex CLI':'ChatGPT 桌面版',category:cli?'cli':'desktop',vendor:claude?'Anthropic':'OpenAI',description:'隔离客户端',protocol:claude?'anthropic':'openai-responses',support:'automatic',supportNote:'隔离的自动配置向导'}],codexCoexist:{identity:{available:false},models:[],warnings:[]}};
 };
 window.resetFixture();
 window.aurora={invoke:async(action,payload={})=>{
   window.calls.push({action,payload:structuredClone(payload)});
   if(action==='agent.preview')return window.previewFailure?structuredClone(window.previewFailure):{ok:true,revision:'fixture-history-revision-'+window.calls.length,files:[{path:'C:/Fixture/.codex/config.toml',before:'original fixture',after:'reviewed fixture'}],warnings:structuredClone(window.previewWarnings),requiresRestart:true,...(window.historyPlan?{history:structuredClone(window.historyPlan)}:{})};
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
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--screenshots', type=Path, help='Optional local evidence directory')
    args = parser.parse_args()
    if args.screenshots:
        args.screenshots.mkdir(parents=True, exist_ok=True)
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
            expect(summary).to_contain_text('共 12 个会话记录 · 8 个需要修复 · 4 个无需修改')
            expect(summary).to_contain_text('应用配置时自动备份历史并修复可处理的会话，无需另行批量操作')
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
            expect(outcome).to_contain_text('已备份 12 个会话文件和 2 个索引数据库')
            expect(outcome).to_contain_text('已修复 8 个会话，4 个无需修改')
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

            dialog = open_preview()
            dialog.get_by_role('button', name='上一步', exact=True).click()
            page.evaluate("window.previewFailure={ok:false,message:'无法读取历史目录，请检查文件访问权限。'}")
            dialog.get_by_role('button', name='预览配置 →', exact=True).click()
            expect(dialog.get_by_role('alert')).to_contain_text('无法读取历史目录，请检查文件访问权限')
            expect(dialog.get_by_role('button', name='备份历史并应用配置', exact=True)).to_have_count(0)
            expect(dialog.get_by_role('combobox', name='选择模型', exact=True)).to_have_value('selected-model')
            assert count('agent.connect') == count('agent.restart') == 0
            page.evaluate('window.previewFailure=null')
            dialog.get_by_role('button', name='预览配置 →', exact=True).click()
            expect(dialog.get_by_role('button', name='备份历史并应用配置', exact=True)).to_be_enabled()
            assert count('agent.preview') == 3 and count('agent.connect') == 0
            passed('A real history read failure shows the concrete error and allows a fresh preview without losing selection or writing configuration')

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

            page.set_viewport_size({'width': 800, 'height': 850})
            page.evaluate("document.documentElement.dataset.theme='dark'")
            dialog = open_preview(setup="""window.historyPlan={total:108,repairable:1,unchanged:0,blocked:0,preserved:107,filesToBackUp:1,indexDatabasesToBackUp:2,backupRequired:true,requiresClientExit:true,message:'将备份现有文件和索引，原样保留缺少原文件的索引。',warnings:[]};window.historyResult={backedUp:1,indexBackedUp:2,repaired:1,unchanged:0,preserved:107,backupId:'fixture-backup',backupPath:'C:/Fixture/history-backup'}""")
            summary = dialog.get_by_role('region', name='历史会话自动处理', exact=True)
            expect(summary).to_contain_text('107 条索引原样保留')
            expect(summary).to_contain_text('将备份 1 个会话文件和 2 个索引数据库')
            expect(summary).to_contain_text('不影响应用配置')
            expect(dialog.get_by_role('button', name='备份历史并应用配置', exact=True)).to_be_enabled()
            dialog.get_by_role('button', name='备份历史并应用配置', exact=True).scroll_into_view_if_needed()
            assert dialog.evaluate('(element)=>element.scrollWidth<=element.clientWidth+1')
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            if args.screenshots:
                page.screenshot(path=str(args.screenshots / 'missing-source-107-apply-enabled.png'))
            assert count('agent.connect') == 0
            dialog.get_by_role('button', name='备份历史并应用配置', exact=True).click()
            expect(dialog.get_by_role('heading', name='配置已应用', exact=True)).to_be_visible()
            outcome = dialog.get_by_role('status', name='历史会话处理结果', exact=True)
            expect(outcome).to_contain_text('已备份 1 个会话文件和 2 个索引数据库')
            expect(outcome).to_contain_text('已修复 1 个会话，0 个无需修改')
            expect(outcome).to_contain_text('107 条未找到原文件的会话索引已随数据库备份并原样保留')
            expect(outcome).not_to_contain_text('已备份 108')
            expect(dialog).not_to_contain_text('无需再手动修复')
            assert count('agent.connect') == 1 and count('agent.restart') == 0
            passed('107 missing-source index records are preserved while one valid conversation can be backed up and applied, with accurate results')

            dialog = open_preview(setup="""window.historyPlan={total:107,repairable:0,unchanged:0,blocked:0,preserved:107,filesToBackUp:0,indexDatabasesToBackUp:2,backupRequired:true,requiresClientExit:true,warnings:[]};window.historyResult={backedUp:0,indexBackedUp:2,repaired:0,unchanged:0,preserved:107,backupId:'fixture-index-backup',backupPath:'C:/Fixture/history-backup'}""")
            expect(dialog.get_by_role('region', name='历史会话自动处理', exact=True)).to_contain_text('将备份 0 个会话文件和 2 个索引数据库')
            expect(dialog.get_by_role('button', name='备份历史并应用配置', exact=True)).to_be_enabled()
            dialog.get_by_role('button', name='备份历史并应用配置', exact=True).click()
            outcome = dialog.get_by_role('status', name='历史会话处理结果', exact=True)
            expect(outcome).to_contain_text('已备份 0 个会话文件和 2 个索引数据库')
            expect(outcome).to_contain_text('已修复 0 个会话，0 个无需修改')
            expect(outcome).to_contain_text('107 条未找到原文件的会话索引')
            expect(dialog).not_to_contain_text('无需再手动修复')
            assert count('agent.connect') == 1 and count('agent.restart') == 0
            passed('Index-only history still permits configuration and reports database backup instead of inventing backed-up conversations')

            dialog = open_preview(setup="""window.historyPlan={total:121,repairable:9,unchanged:1,blocked:0,preserved:111,filesToBackUp:42,indexDatabasesToBackUp:8,backupRequired:true,requiresClientExit:true,blockedReasons:[],message:'将完整备份 42 个会话文件和 8 个索引数据库。58 个会话在不同索引库中留有无日志索引副本，另有 53 个单库无日志索引；均保持原样。',warnings:[]};window.historyResult={backedUp:42,indexBackedUp:8,repaired:9,unchanged:1,preserved:111,backupId:'fixture-multi-database-backup',backupPath:'C:/Fixture/history-backup'}""")
            summary = dialog.get_by_role('region', name='历史会话自动处理', exact=True)
            expect(summary).to_contain_text('共 121 个会话记录 · 9 个需要修复 · 1 个无需修改 · 111 条索引原样保留')
            expect(summary).to_contain_text('将备份 42 个会话文件和 8 个索引数据库')
            apply_button = dialog.get_by_role('button', name='备份历史并应用配置', exact=True)
            expect(apply_button).to_be_enabled()
            expect(dialog.get_by_role('alert', name='历史问题处理', exact=True)).to_have_count(0)
            apply_button.scroll_into_view_if_needed()
            assert dialog.evaluate('(element)=>element.scrollWidth<=element.clientWidth+1')
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            if args.screenshots:
                page.screenshot(path=str(args.screenshots / 'multiple-databases-121-apply-enabled.png'))
            assert count('agent.connect') == 0
            apply_button.click()
            expect(dialog.get_by_role('heading', name='配置已应用', exact=True)).to_be_visible()
            outcome = dialog.get_by_role('status', name='历史会话处理结果', exact=True)
            expect(outcome).to_contain_text('已备份 42 个会话文件和 8 个索引数据库')
            expect(outcome).to_contain_text('已修复 9 个会话，1 个无需修改')
            expect(outcome).to_contain_text('111 条未找到原文件的会话索引已随数据库备份并原样保留')
            expect(outcome).not_to_contain_text('已备份 121')
            expect(outcome).not_to_contain_text('已修复 121')
            expect(dialog).not_to_contain_text('无需再手动修复')
            assert count('agent.connect') == 1 and count('agent.restart') == 0
            passed('121 records across eight index databases allow apply when 58 cross-database index copies and 53 other missing-source records are preserved, reporting 42 actual file backups and 9 repairs')

            page.set_viewport_size({'width': 800, 'height': 850})
            dialog = open_preview(setup="""window.historyPlan={total:120,repairable:10,unchanged:0,blocked:0,preserved:79,skipped:31,skippedReasons:['会话记录不是完整有效的 JSON，保留原始字节','同一会话在多个数据库有原生索引，保留原归属'],filesToBackUp:41,indexDatabasesToBackUp:8,backupRequired:true,requiresClientExit:true,warnings:Array(12).fill('较长历史说明：数据库结构保持原样。')};window.historyResult={backedUp:41,indexBackedUp:8,repaired:10,unchanged:0,preserved:79,skipped:31,skippedReasons:['会话记录不是完整有效的 JSON，保留原始字节','同一会话在多个数据库有原生索引，保留原归属'],backupId:'fixture-skipped-backup',backupPath:'C:/Fixture/skipped-history-backup'}""")
            summary = dialog.get_by_role('region', name='历史会话自动处理', exact=True)
            expect(summary).to_contain_text('共 120 个会话记录 · 10 个需要修复 · 0 个无需修改 · 79 条索引原样保留 · 31 个备份后跳过修复')
            expect(summary).to_contain_text('将备份 41 个会话文件和 8 个索引数据库')
            expect(summary).to_contain_text('暂不可修复的 31 个会话会先完整备份，再保留原内容并继续应用配置')
            details = summary.locator('details')
            expect(details).not_to_have_attribute('open', '')
            expect(summary.get_by_text('会话记录不是完整有效的 JSON，保留原始字节', exact=True)).not_to_be_visible()
            expect(summary.get_by_text('较长历史说明：数据库结构保持原样。', exact=True)).not_to_be_visible()
            expect(dialog.get_by_role('alert')).to_have_count(0)
            apply_button = dialog.get_by_role('button', name='备份历史并应用配置', exact=True)
            expect(apply_button).to_be_enabled()
            apply_button.scroll_into_view_if_needed()
            expect(apply_button).to_be_in_viewport()
            assert dialog.evaluate('(element)=>element.scrollWidth<=element.clientWidth+1')
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            if args.screenshots:
                page.screenshot(path=str(args.screenshots / 'skipped-history-120-apply-enabled.png'))
            details.locator('summary').click()
            expect(summary.get_by_text('会话记录不是完整有效的 JSON，保留原始字节', exact=True)).to_be_visible()
            expect(summary.get_by_text('较长历史说明：数据库结构保持原样。', exact=True)).to_have_count(1)
            details.locator('summary').click()
            assert count('agent.connect') == count('agent.restart') == 0
            apply_button.click()
            outcome = dialog.get_by_role('status', name='历史会话处理结果', exact=True)
            expect(outcome).to_contain_text('已备份 41 个会话文件和 8 个索引数据库')
            expect(outcome).to_contain_text('已修复 10 个会话，0 个无需修改')
            expect(outcome).to_contain_text('79 条未找到原文件的会话索引已随数据库备份并原样保留')
            expect(outcome).to_contain_text('31 个会话未修复，已完整备份并原样保留')
            expect(outcome.get_by_text('会话记录不是完整有效的 JSON，保留原始字节', exact=True)).not_to_be_visible()
            outcome.get_by_text('查看未修复原因', exact=True).click()
            expect(outcome.get_by_text('会话记录不是完整有效的 JSON，保留原始字节', exact=True)).to_be_visible()
            outcome.get_by_text('查看历史备份位置', exact=True).click()
            expect(outcome).to_contain_text('C:/Fixture/skipped-history-backup')
            expect(dialog).not_to_contain_text('无需再手动修复')
            assert count('agent.connect') == 1 and count('agent.restart') == 0
            passed('120 mixed records back up 41 files and eight databases, repair 10 conversations, preserve 79 missing indexes and skip 31 ambiguous records without blocking Apply or flooding the preview')

            dialog = open_preview(setup="""window.historyPlan={total:3,repairable:0,unchanged:0,blocked:0,preserved:0,skipped:3,skippedReasons:['原始历史内容无法解析'],filesToBackUp:3,indexDatabasesToBackUp:1,backupRequired:true,requiresClientExit:true,warnings:[]};window.historyResult={backedUp:3,indexBackedUp:1,repaired:0,unchanged:0,preserved:0,skipped:3,skippedReasons:['原始历史内容无法解析'],backupPath:'C:/Fixture/all-skipped-backup'}""")
            expect(dialog.get_by_role('button', name='备份历史并应用配置', exact=True)).to_be_enabled()
            dialog.get_by_role('button', name='备份历史并应用配置', exact=True).click()
            outcome = dialog.get_by_role('status', name='历史会话处理结果', exact=True)
            expect(outcome).to_contain_text('已修复 0 个会话，0 个无需修改')
            expect(outcome).to_contain_text('3 个会话未修复，已完整备份并原样保留')
            expect(dialog).not_to_contain_text('无需再手动修复')
            assert count('agent.connect') == 1 and count('agent.restart') == 0
            passed('An entirely unrepairable history still applies configuration after backup and explicitly reports zero repairs')

            dialog = open_preview(setup="""window.historyPlan={total:0,repairable:0,unchanged:0,blocked:0,preserved:0,skipped:0,skippedReasons:['索引数据库结构未知，无法计算会话数量'],filesToBackUp:0,indexDatabasesToBackUp:1,backupRequired:true,requiresClientExit:true,warnings:[]};window.historyResult={backedUp:0,indexBackedUp:1,repaired:0,unchanged:0,preserved:0,skipped:0,skippedReasons:['索引数据库结构未知，无法计算会话数量'],backupPath:'C:/Fixture/unknown-database-backup'}""")
            expect(dialog.get_by_role('region', name='历史会话自动处理', exact=True)).to_contain_text('部分历史索引无法核验，将完整备份并原样保留')
            dialog.get_by_role('button', name='备份历史并应用配置', exact=True).click()
            outcome = dialog.get_by_role('status', name='历史会话处理结果', exact=True)
            expect(outcome).to_contain_text('已备份 0 个会话文件和 1 个索引数据库')
            expect(outcome).to_contain_text('无法核验的历史索引已完整备份并原样保留，未修改其中的会话内容')
            expect(dialog).not_to_contain_text('无需再手动修复')
            assert count('agent.connect') == 1 and count('agent.restart') == 0
            passed('An unknown index database with no countable sessions is backed up without claiming its history was repaired')

            page.set_viewport_size({'width': 860, 'height': 620})
            dialog = open_preview(setup="""window.historyPlan.skipped=2;window.historyPlan.total=14;window.historyPlan.skippedReasons=['会话元数据存在冲突，保留原内容'];window.historyPlan.warnings=Array(15).fill('索引结构未知，原样备份。')""")
            apply_button = dialog.get_by_role('button', name='备份历史并应用配置', exact=True)
            apply_button.scroll_into_view_if_needed()
            expect(apply_button).to_be_in_viewport()
            expect(apply_button).to_be_enabled()
            expect(dialog.get_by_role('alert')).to_have_count(0)
            expect(dialog.get_by_text('会话元数据存在冲突，保留原内容', exact=True)).not_to_be_visible()
            page.evaluate("window.applyFailure={ok:false,message:'磁盘空间不足，历史备份未完成，配置尚未修改。'}")
            apply_button.click()
            expect(dialog.get_by_role('alert')).to_contain_text('磁盘空间不足，历史备份未完成，配置尚未修改')
            expect(dialog.get_by_role('heading', name='配置已应用', exact=True)).to_have_count(0)
            expect(dialog.get_by_role('status', name='历史会话处理结果', exact=True)).to_have_count(0)
            expect(dialog.get_by_role('button', name='预览配置 →', exact=True)).to_be_enabled()
            assert count('agent.connect') == 1 and count('agent.restart') == 0
            passed('A small viewport keeps Apply available for skipped history while an actual backup write failure shows no success and permits a new preview')
            page.set_viewport_size({'width': 1380, 'height': 1050})

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
