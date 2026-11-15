"""Isolated membership recovery tests: mocked IPC, no profile or network access."""
import json
from pathlib import Path
import subprocess
import tempfile

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]


def main():
    with tempfile.TemporaryDirectory(prefix='yunqiao-membership-ui-') as temporary:
        bundle = Path(temporary) / 'ui.js'
        source = """import React from 'react';import {createRoot} from 'react-dom/client';
import Membership from './ui/src/pages/Membership.tsx';import {ToastHost} from './ui/src/components/ui.tsx';
const root=createRoot(document.getElementById('root'));
window.renderMember=()=>root.render(<ToastHost key={window.generation}><Membership state={{}} reload={async()=>{}} go={()=>{}}/></ToastHost>);"""
        options = {'stdin': {'contents': source, 'resolveDir': str(ROOT), 'loader': 'tsx'}, 'outfile': str(bundle), 'bundle': True, 'platform': 'browser', 'format': 'iife', 'define': {'process.env.NODE_ENV': '"production"'}}
        subprocess.run(['node', '-e', 'require("esbuild").buildSync(' + json.dumps(options) + ')'], cwd=ROOT, check=True)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={'width': 1380, 'height': 1000})
            page.route('**/*', lambda route: route.abort())
            errors, checks = [], []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.set_content('<html data-theme="light"><main id="root" style="padding:24px"></main></html>')
            for stylesheet in ['app.css', 'workspace.css']:
                page.add_style_tag(path=str(ROOT / 'ui/src/styles' / stylesheet))
            page.evaluate("""()=>{
              window.generation=0;
              window.reset=()=>{window.generation++;window.calls=[];window.claimError='';window.statusError='';window.groupError='';window.expired=false;window.claimPending=false;window.pendingClaim=null;window.nextGift=null;
                window.memberStatus={ok:true,loggedIn:true,config:{enabled:true},member:{email:'fixture@example.invalid',balance:0},gift:{status:'eligible',eligible:true}};
                window.claimResult={ok:true,message:'平台已确认到账',gift:{status:'claimed',claimed:true},member:{balance:10}};window.renderMember?.();};
              window.aurora={invoke:async(action,payload)=>{window.calls.push({action,payload});
                if(action==='member.status'){if(window.statusError)throw Error(window.statusError);return structuredClone(window.memberStatus);}
                if(action==='member.groups'){if(window.groupError)throw Error(window.groupError);return {ok:true,groups:[{id:7,name:'测试分组',platform:'openai',supported:true}]};}
                if(action==='member.logout'){window.memberStatus={ok:true,loggedIn:false,config:{enabled:true}};return {ok:true};}
                if(action==='member.claim'){
                  if(window.claimPending)await new Promise(resolve=>window.pendingClaim=resolve);
                  if(window.nextGift)window.memberStatus.gift=structuredClone(window.nextGift);
                  if(window.expired){window.memberStatus={ok:true,loggedIn:false,config:{enabled:true},message:'登录已过期，请重新登录。'};return {ok:false,authExpired:true,loggedIn:false,message:'登录已过期，请重新登录。'};}
                  if(window.claimError)throw Error(window.claimError);
                  window.memberStatus.gift=structuredClone(window.claimResult.gift);window.memberStatus.member=structuredClone(window.claimResult.member);return structuredClone(window.claimResult);
                }
                throw Error('Unexpected mock action '+action);
              }};window.reset();
            }""")
            page.add_script_tag(path=str(bundle))
            page.evaluate('window.renderMember()')

            def ready():
                expect(page.get_by_role('button', name='领取 $10 平台额度', exact=True)).to_be_enabled()

            def reset():
                page.evaluate('window.reset()')
                ready()

            def claim_count():
                return page.evaluate("window.calls.filter(call=>call.action==='member.claim').length")

            ready()
            page.evaluate("window.claimError='上游响应中断';window.nextGift={status:'pending',eligible:false,message:'正在核对领取结果'}")
            page.get_by_role('button', name='领取 $10 平台额度', exact=True).click()
            expect(page.get_by_text('到账确认中', exact=True)).to_be_visible()
            expect(page.get_by_role('button', name='重新确认到账', exact=True)).to_be_enabled()
            expect(page.get_by_role('alert')).to_contain_text('上游响应中断')
            assert claim_count() == 1
            assert page.evaluate("window.calls.filter(call=>call.action==='member.status').length") == 2
            page.evaluate("window.claimError='';window.nextGift=null")
            page.get_by_role('button', name='重新确认到账', exact=True).click()
            expect(page.get_by_role('button', name='新客额度已到账', exact=True)).to_be_disabled()
            assert claim_count() == 2
            checks.append('Ambiguous claim reloads status once, preserves the failure, and enables pending confirmation only on another explicit click')

            reset()
            page.evaluate("window.claimError='无法读取领取响应';window.nextGift={status:'ineligible',eligible:false,reason:'本机已领取'}")
            page.get_by_role('button', name='领取 $10 平台额度', exact=True).click()
            expect(page.get_by_role('button', name='领取 $10 平台额度', exact=True)).to_be_disabled()
            expect(page.get_by_role('alert')).to_contain_text('无法读取领取响应')
            assert claim_count() == 1
            checks.append('Reconciliation replaces stale eligibility with the server ineligible result')

            reset()
            page.evaluate("window.claimError='领取请求结果未知';window.statusError='状态接口离线'")
            page.get_by_role('button', name='领取 $10 平台额度', exact=True).click()
            expect(page.get_by_text('资格待确认', exact=True)).to_be_visible()
            expect(page.get_by_role('button', name='请先刷新领取状态', exact=True)).to_be_disabled()
            expect(page.get_by_role('alert')).to_contain_text('领取请求结果未知；状态确认失败：状态接口离线')
            assert claim_count() == 1
            page.evaluate("window.statusError='';window.memberStatus.gift={status:'pending',eligible:false}")
            page.get_by_role('button', name='重试', exact=True).click()
            expect(page.get_by_role('button', name='重新确认到账', exact=True)).to_be_enabled()
            assert claim_count() == 1
            checks.append('Failed status verification blocks a new claim; the error retry only reads status')

            reset()
            page.evaluate("window.expired=true;window.statusError='配置服务暂不可用'")
            page.get_by_role('button', name='领取 $10 平台额度', exact=True).click()
            expect(page.get_by_role('textbox', name='平台会员邮箱', exact=True)).to_be_visible()
            expect(page.get_by_role('button', name='退出会员登录', exact=True)).to_have_count(0)
            expect(page.get_by_role('alert')).to_contain_text('登录已过期')
            expect(page.get_by_role('alert')).to_contain_text('配置服务暂不可用')
            assert claim_count() == 1
            checks.append('Expired authentication clears the logged-in UI even when follow-up config/status reads also fail')

            reset()
            page.evaluate("window.groupError='分组服务暂不可用'")
            page.get_by_role('button', name='领取 $10 平台额度', exact=True).click()
            expect(page.get_by_role('button', name='新客额度已到账', exact=True)).to_be_disabled()
            expect(page.get_by_text('平台已确认到账', exact=True).first).to_be_visible()
            expect(page.get_by_role('alert')).to_contain_text('分组服务暂不可用')
            expect(page.get_by_role('button', name='添加云桥供应商 →', exact=True)).to_be_disabled()
            assert claim_count() == 1
            checks.append('Group discovery failure stays separate from a confirmed claim and its receipt')

            reset()
            page.evaluate("window.statusError='到账后的状态读取失败'")
            page.get_by_role('button', name='领取 $10 平台额度', exact=True).click()
            expect(page.get_by_role('button', name='新客额度已到账', exact=True)).to_be_disabled()
            expect(page.get_by_text('平台已确认到账', exact=True).first).to_be_visible()
            assert claim_count() == 1
            checks.append('A successful claim result remains authoritative if the following status read fails')

            reset()
            page.evaluate("window.claimPending=true;window.claimError='稍后确认';window.nextGift={status:'pending',eligible:false}")
            page.get_by_role('button', name='领取 $10 平台额度', exact=True).click()
            expect(page.get_by_role('button', name='正在确认到账…', exact=True)).to_be_disabled()
            assert claim_count() == 1
            page.evaluate('window.pendingClaim()')
            expect(page.get_by_role('button', name='重新确认到账', exact=True)).to_be_enabled()
            assert claim_count() == 1
            checks.append('An in-flight claim disables duplicate clicks and is not repeated by failure recovery')

            reset()
            page.get_by_role('button', name='领取 $10 平台额度', exact=True).click()
            expect(page.get_by_role('button', name='新客额度已到账', exact=True)).to_be_disabled()
            page.evaluate("window.statusError='退出后的状态服务离线'")
            page.get_by_role('button', name='退出会员登录', exact=True).click()
            expect(page.get_by_role('textbox', name='平台会员邮箱', exact=True)).to_be_visible()
            expect(page.get_by_role('button', name='退出会员登录', exact=True)).to_have_count(0)
            expect(page.get_by_role('button', name='新客额度已到账', exact=True)).to_have_count(0)
            expect(page.locator('.member-steps').locator('..').get_by_text('平台已确认到账', exact=True)).to_have_count(0)
            expect(page.get_by_text('fixture@example.invalid', exact=True)).to_have_count(0)
            expect(page.get_by_role('alert')).to_contain_text('退出后的状态服务离线')
            expect(page.get_by_role('button', name='请先刷新领取状态', exact=True)).to_be_disabled()
            assert page.evaluate("window.calls.filter(call=>call.action==='member.logout').length") == 1
            assert claim_count() == 1
            checks.append('Logout clears the account and receipt immediately even if the following status read fails')

            page.evaluate('window.reset();window.memberStatus.canRefresh=true;window.renderMember()')
            ready()
            expect(page.get_by_text('登录状态会自动续期，无需每小时重新登录。', exact=False)).to_be_visible()
            page.evaluate('window.reset();window.memberStatus.canRefresh=false;window.renderMember()')
            ready()
            expect(page.get_by_text('当前登录不支持自动续期，访问令牌到期后需要重新绑定。', exact=False)).to_be_visible()
            page.get_by_role('button', name='退出会员登录', exact=True).click()
            page.get_by_text('通过平台访问令牌绑定', exact=True).click()
            expect(page.get_by_text('此方式不能自动续期，令牌到期后需重新绑定。', exact=False)).to_be_visible()
            assert claim_count() == 0
            checks.append('Renewable and legacy/manual sessions have truthful renewal guidance; the token binding form explains its limit')

            assert not errors, errors
            browser.close()
            for check in checks:
                print('PASS', check)
            print(json.dumps({'ok': True, 'checks': checks, 'browserErrors': errors}, ensure_ascii=False))


if __name__ == '__main__':
    main()
