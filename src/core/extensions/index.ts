import fs from 'node:fs';
import path from 'node:path';
import type { AuroraStore } from '../store/index.js';
import { desktopInfo, validateDebugPort } from '../injector.js';
import { BUILTINS, BUNDLED, effectiveEntry, loadState, saveState, manifest, validateConfig } from './catalog.js';
import { installedPlugins, installNative, loadIndex, nativeKey, packageRoot, refreshIndex, removeNative, resourceRoot, toggleNative, type MarketSource } from './market.js';
import { runtimeFor } from './runtime.js';
import { setWorkViewDisabled } from './workView.js';
import { desktopModelCatalog } from './models.js';
import { dictationConfiguration } from './dictation.js';
import { stepwiseSettings } from './stepwise.js';
const activeJobs=new Map<string,Promise<any>>();
function sourceKey(id:string):{source:MarketSource;id:string}|null{const m=/^(public|full):(.+)$/.exec(id);return m?{source:m[1] as MarketSource,id:m[2]}:null;}
export async function listExtensions(store:AuroraStore,payload:any={}):Promise<any>{
  const state=loadState(store),rt=runtimeFor(store),runtime=await rt.status(),client=await desktopInfo(state.connection.lastVersion,state.connection.exePath,state.connection.port);
  const upstream=JSON.parse(fs.readFileSync(path.join(resourceRoot(),'UPSTREAM.json'),'utf8'));const applied=new Set(runtime.applied),errors=new Map(runtime.errors.map(e=>[e.id,e.message]));
  const missingConfig=new Map<string,string>(),dictation=dictationConfiguration(store).status,stepwise=stepwiseSettings(store).settings;
  if(dictation.enabled&&!dictation.configured)missingConfig.set('builtin:dictation',dictation.message);
  if(stepwise.enabled&&(!stepwise.baseUrlConfigured||!stepwise.apiKeyConfigured||!stepwise.model))missingConfig.set('builtin:stepwise','请先为 ChatGPT 桌面版配置可用供应商与模型，或在下一步建议设置中指定供应商 ID 与模型');
  const status=(id:string,installed:boolean,enabled:boolean,unsupported?:string)=>id==='builtin:reasoning-collapse'||id==='builtin:disable-work-view'?'installed':unsupported?'unsupported':errors.has(id)?'error':missingConfig.has(id)?'installed':applied.has(id)?'active':enabled?'needs-connection':installed?'installed':'available';
  let items:any[]=[...BUILTINS.map(b=>{const id=`builtin:${b.id}`,e=effectiveEntry(state,id);return{...b,id,version:'2.6.9',source:'builtin',license:'AGPL-3.0-only',...e,status:status(id,true,e.enabled,b.unsupported),reason:b.unsupported||errors.get(id)||missingConfig.get(id)||(b.id==='reasoning-collapse'?'开关已保存；仅处理经云桥网关的 ChatGPT/Codex Responses 请求':b.id==='disable-work-view'?'设置写入客户端配置，重启客户端生效':undefined),configSchema:b.configSchema};}),...BUNDLED.map(name=>{const m=manifest(name),id=`bundled:${name}`,e=effectiveEntry(state,id);return{id,name:m.name,description:m.description,version:m.version,source:'bundled',license:name==='agent-pet'?'AGPL-3.0-only；鲸鱼素材另见 PROVENANCE.md':'AGPL-3.0-only',...e,status:status(id,e.installed,e.enabled),reason:errors.get(id),configSchema:m.config||{},upstreamId:name};})];
  const installed=installedPlugins(store),catalogs:any={};
  for(const source of ['public','full'] as const){const index=loadIndex(store,source);catalogs[source]={count:index.plugins.length,revision:index.revision,updatedAt:index.updatedAt,repository:index.repository};
    items.push(...index.plugins.map(p=>{const id=nativeKey(source,p.id),saved=installed[id],present=!!saved&&fs.existsSync(packageRoot(store,saved));return{id,name:p.displayName||p.name,description:p.description,version:p.version,source,license:p.license||'未声明许可',installed:present,enabled:!!saved?.enabled,status:present?'installed':'available',reason:!present&&saved?'本地插件文件已丢失':saved?.enabled?'已写入客户端插件配置；重启客户端后按原生规则加载':p.requiresAuth?'此插件需要登录对应服务，安装不会自动授权':undefined,requiresRestart:true,requiresAuth:p.requiresAuth,tags:p.tags,author:p.author,skills:p.skills,bytes:p.bytes,revision:index.revision};}));
  }
  if(payload.source)items=items.filter(i=>i.source===payload.source);
  if(payload.query){const q=String(payload.query).toLowerCase();items=items.filter(i=>`${i.name} ${i.description} ${(i.tags||[]).join(' ')}`.toLowerCase().includes(q));}
  const total=items.length;if(payload.limit)items=items.slice(Math.max(0,Number(payload.offset)||0),Math.max(0,Number(payload.offset)||0)+Math.min(1000,Math.max(1,Number(payload.limit)||200)));
  return{ok:true,upstream:{repository:upstream.repository,version:'2.6.9',revision:upstream.commit,license:upstream.license},client:{...client,connected:runtime.connected,compatible:runtime.connected||client.supportsCodexConfig},items,total,catalogs,connection:state.connection,runtime};
}
export async function runExtensionAction(deps:{store:AuroraStore},action:string,payload:any={}):Promise<any|null>{
  if(!action.startsWith('extension.'))return null;const store=deps.store;
  if(action==='extension.list')return listExtensions(store,payload);
  const key=store.dir;if(activeJobs.has(key))throw new Error('另一个扩展操作正在进行，请等待完成');
  const job=(async()=>{
    const state=loadState(store),runtime=runtimeFor(store);
    if(action==='extension.configure'){
      if(payload.port!==undefined)state.connection.port=validateDebugPort(payload.port);
      if(payload.exePath!==undefined){if(typeof payload.exePath!=='string')throw new Error('程序路径无效');const exe=payload.exePath.trim();if(exe&&(!path.isAbsolute(exe)||!fs.existsSync(exe)||!fs.statSync(exe).isFile()))throw new Error('指定的桌面程序不存在');state.connection.exePath=exe||undefined;state.connection.lastVersion=undefined;}
      await runtime.disconnect();saveState(store,state);return{ok:true,connection:state.connection};
    }
    if(action==='extension.connect')return runtime.connect(payload);
    if(action==='extension.disconnect'){await runtime.disconnect();return{ok:true};}
    if(action==='extension.refresh'){const sources=payload.source?[payload.source]:['public','full'];for(const source of sources){if(!['public','full'].includes(source))throw new Error('未知插件市场');await refreshIndex(store,source);}return{ok:true,message:'插件目录已更新'};}
    const id=String(payload.id||''),native=sourceKey(id);
    if(native){if(action==='extension.install'){const item=await installNative(store,native.source,native.id);return{ok:true,item,message:'插件已校验并安装，启用后重启客户端生效'};}if(action==='extension.toggle'){if(typeof payload.enabled!=='boolean')throw new Error('启用状态无效');return{ok:true,item:toggleNative(store,native.source,native.id,payload.enabled)};}if(action==='extension.remove'){removeNative(store,native.source,native.id);return{ok:true,message:'已移除客户端注册，保留源码与许可证缓存'};}throw new Error('此原生插件不支持该操作');}
    const builtin=BUILTINS.find(b=>`builtin:${b.id}`===id),bundled=id.startsWith('bundled:')&&BUNDLED.includes(id.slice(8));if(!builtin&&!bundled)throw new Error('未知扩展');
    const entry=effectiveEntry(state,id);
    if(action==='extension.install'){entry.installed=true;}
    else if(action==='extension.toggle'){if(typeof payload.enabled!=='boolean')throw new Error('启用状态无效');if(builtin?.unsupported&&payload.enabled)throw new Error(builtin.unsupported);if(!entry.installed&&payload.enabled)throw new Error('请先安装扩展');entry.enabled=payload.enabled;}
    else if(action==='extension.remove'){if(builtin)throw new Error('系统增强可停用，不能移除');entry.installed=false;entry.enabled=false;}
    else if(action==='extension.config'){const schema=bundled?manifest(id.slice(8)).config||{}:builtin?.configSchema||{};entry.config={...entry.config,...validateConfig(schema,payload.config)};}
    else throw new Error('未知扩展操作');
    if(id==='builtin:model-whitelist-unlock'&&entry.enabled&&desktopModelCatalog(store).status!=='ok')throw new Error('请先在客户端页为 ChatGPT 桌面版应用供应商配置');
    if(id==='builtin:disable-work-view'&&action==='extension.toggle')setWorkViewDisabled(store,entry.enabled);
    state.entries[id]=entry;saveState(store,state);await runtime.apply();return{ok:true,item:{id,...entry},runtime:await runtime.status()};
  })();activeJobs.set(key,job);try{return await job;}finally{activeJobs.delete(key);}
}
