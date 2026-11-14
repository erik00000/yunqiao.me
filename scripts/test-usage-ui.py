"""Isolated usage-page race and unknown-value checks. Requires Python Playwright + Chromium."""
import json
from pathlib import Path
import subprocess
import tempfile

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]


def main():
    with tempfile.TemporaryDirectory(prefix='yunqiao-usage-ui-') as temporary:
        bundle = str(Path(temporary) / 'usage.js')
        source = """import React from 'react';
import {createRoot} from 'react-dom/client';
import Usage from './ui/src/pages/Usage.tsx';
window.usageRoot=createRoot(document.getElementById('root'));
window.usageRoot.render(<Usage state={{}}/>);"""
        build = "require('esbuild').buildSync(" + json.dumps({
            'stdin': {'contents': source, 'resolveDir': str(ROOT), 'loader': 'tsx'},
            'bundle': True, 'platform': 'browser', 'format': 'iife', 'outfile': bundle,
            'define': {'process.env.NODE_ENV': '"production"'},
        }) + ')'
        subprocess.run(['node', '-e', build], cwd=ROOT, check=True)
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            page = browser.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.set_content('<div id="root"></div>')
            page.evaluate("""() => {
              window.pending=[]; window.liveCalls=0; window.liveFailure=true; window.hiddenFixture=false;
              Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.hiddenFixture});
              window.liveFixture=[{id:'active',model:'test-model',phase:'streaming',startedAtMs:Date.now(),cacheRead:0}];
              window.summaryFixture=(calls)=>({totals:{calls,cost:0,inputTokens:100,outputTokens:20,errors:0,cacheRead:0,cacheWrite:0,cacheReports:1,cacheWriteReports:0,cacheRate:0},byDay:[],byProvider:[],byModel:[],byAgent:[]});
              window.aurora={
                invoke:async(action,payload)=>{
                  if(action==='usage.summary') return await new Promise(resolve=>window.pending.push({days:payload.days,resolve}));
                  if(action==='usage.recent') return [{ts:new Date().toISOString(),requestId:'failed',status:0,agent:'test',model:'test-model',requestModel:'test-model',providerName:'test-provider',inputTokens:0,outputTokens:0,cacheRead:0,cacheWrite:0,latencyMs:0,cost:0}];
                  if(action==='usage.live'){window.liveCalls++;if(window.liveFailure)throw new Error('实时读取失败');return structuredClone(window.liveFixture);}
                  throw new Error('Unexpected action '+action);
                },onUsage:()=>()=>{}
              };
            }""")
            page.add_script_tag(path=bundle)
            expect(page.get_by_role('heading', name='用量统计')).to_be_visible()
            page.wait_for_function('window.pending.length===1')
            stats = page.locator('.grid.cols-4').first
            assert stats.inner_text().count('—') == 4
            print('PASS Pending statistics show unknown values instead of fabricated zeros', flush=True)

            page.get_by_role('button', name='7 天', exact=True).click()
            page.wait_for_function('window.pending.length===2')
            page.evaluate('window.pending[1].resolve(window.summaryFixture(7))')
            expect(stats).to_contain_text('7')
            page.evaluate('window.pending[0].resolve(window.summaryFixture(14))')
            page.wait_for_timeout(100)
            assert '14' not in stats.inner_text()
            expect(page.get_by_role('alert')).to_contain_text('实时读取失败')
            print('PASS Older range responses cannot overwrite a newer range or hide live polling errors', flush=True)

            page.evaluate('window.liveFailure=false')
            expect(page.get_by_text('输出 待返回', exact=True)).to_be_visible(timeout=3000)
            expect(page.get_by_text('缓存读 0', exact=True)).to_be_visible()
            expect(page.get_by_text('缓存写 未提供', exact=True)).to_be_visible()
            expect(page.get_by_role('alert')).to_have_count(0)
            page.evaluate('window.liveFixture[0].estimatedOutputTokens=0')
            expect(page.get_by_text('输出 约 0', exact=True)).to_be_visible(timeout=3000)
            print('PASS Reported zero, absent usage and output estimates remain distinct', flush=True)

            page.get_by_role('button', name='请求日志 (1)', exact=True).click()
            expect(page.locator('td .chip.bad')).to_have_text('ERR')
            print('PASS Transport failures use an error state in request logs', flush=True)

            before = page.evaluate('window.liveCalls')
            page.evaluate('window.hiddenFixture=true')
            page.wait_for_timeout(1700)
            assert page.evaluate('window.liveCalls') == before
            page.evaluate("window.hiddenFixture=false;document.dispatchEvent(new Event('visibilitychange'))")
            page.wait_for_function(f'window.liveCalls>{before}')
            print('PASS Hidden pages pause live polling and refresh immediately when visible', flush=True)

            page.evaluate('window.usageRoot.unmount()')
            page.evaluate('window.pending.forEach(p=>p.resolve(window.summaryFixture(999)))')
            assert errors == [], errors
            browser.close()
            print('5 usage-page browser checks passed.', flush=True)


if __name__ == '__main__':
    main()
