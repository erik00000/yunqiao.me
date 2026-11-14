import fs from 'node:fs';
import path from 'node:path';
import type { DesktopCdp } from '../injector.js';
import { resourceRoot } from './market.js';
export interface NativeModulePlan { source:string;errors:Array<{id:string;message:string}>;requested:string[] }
export function validateNativeModulePlan(prepared:any):void{
  if(!prepared?.ok||!Array.isArray(prepared.modules)||!prepared.modules.length||prepared.modules.length>100)throw new Error(`当前客户端原生模块不兼容：${String(prepared?.diagnostics?.reason||'未识别模块结构').slice(0,150)}`);
  let total=0,entry=false;const seen=new Set<string>();
  for(const module of prepared.modules){const url=new URL(module.url);if(url.protocol!=='app:'||url.hostname!=='-'||!/^\/assets\/[^/]+\.js$/.test(url.pathname)||url.username||url.password||seen.has(url.href))throw new Error('原生补丁模块必须来自当前桌面的 app://-/assets/');seen.add(url.href);
    if(typeof module.patchedSource!=='string'||module.patchedSource.length>24*1024*1024)throw new Error('原生补丁模块过大');total+=module.patchedSource.length;entry ||= module.patchedSource.includes('window.__codexPlusNativeFastCompiled="v1";');
  }if(total>64*1024*1024||!entry)throw new Error('原生补丁缺少完整入口或超过大小限制');
}
export async function prepareNativeModules(cdp:DesktopCdp,settings:Record<string,any>):Promise<NativeModulePlan>{
  const requested=[...(settings.codexAppNativeFastUnlock?['builtin:native-fast-unlock']:[]),...(settings.codexAppNativePredictions?['builtin:native-predictions']:[])];
  if(!requested.length)return{source:'',errors:[],requested};
  try{
    if(!settings.nativeFastLocalApiConfigured&&!settings.nativePredictionsLocalApiConfigured)throw new Error('请先配置实际生效的第三方 API 供应商，再启用此原生增强');
    const root=path.join(resourceRoot(),'assets','inject');const read=(f:string)=>fs.readFileSync(path.join(root,f),'utf8');
    const bootstrap=read('native-fast-unlock.js')+'\n'+read('native-fast-rspack.js')+'\n'+read('native-predictions.js')+`\nwindow.__codexPlusNativeFastUnlock.runtime.update(${JSON.stringify(settings)});window.__codexPlusNativePredictions.runtime.update(${JSON.stringify(settings)});`;
    await cdp.evaluate(bootstrap);
    const prepared=await cdp.evaluate('window.__codexPlusNativeFastUnlock.prepareDocumentModules().then(r=>({ok:r.ok===true,modules:r.ok===true?r.modules:[],diagnostics:r.diagnostics??null}))');
    validateNativeModulePlan(prepared);
    return{source:`${bootstrap}\nwindow.__codexPlusNativeFastAssetPatchReady=true;window.__auroraNativeInstallResult=window.__codexPlusNativeFastUnlock.installModules(${JSON.stringify(prepared.modules)},${JSON.stringify({rewriters:prepared.diagnostics?.rewriters||{}})});`,errors:[],requested};
  }catch(error){return{source:'',errors:requested.map(id=>({id,message:(error as Error).message})),requested};}
}
