import fs from 'node:fs';
import path from 'node:path';
import type { AuroraStore } from '../store/index.js';
import { codexConfigPath } from '../codex.js';
import { applyPlan, patchToml, planned, type PlannedFile } from '../agents/configFiles.js';
import { extensionClientConfig } from './clientConfig.js';
export function setWorkViewDisabled(store:AuroraStore,enabled:boolean,extra:PlannedFile[]=[]):void{
  const file=codexConfigPath(),record=planned(path.join(store.dir,'extension-work-view.json'),'');
  let saved:{previous?:string;changed:boolean;configPath?:string}|null=null;
  if(record.existed){
    try{saved=JSON.parse(record.before);if(!saved||typeof saved!=='object'||Array.isArray(saved)||typeof saved.changed!=='boolean'||(saved.previous!==undefined&&typeof saved.previous!=='string')||(saved.configPath!==undefined&&typeof saved.configPath!=='string'))throw new Error();}
    catch{throw new Error('Work 视图恢复记录损坏，已停止修改；请检查 extension-work-view.json');}
  }
  if(saved?.changed){
    if(!saved.configPath)throw new Error('旧版 Work 视图恢复记录缺少客户端路径，无法确认恢复目标；请先核对原客户端详情模式');
    const actual=fs.existsSync(file)?fs.realpathSync(file):path.resolve(file),normalize=(value:string)=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
    if(normalize(saved.configPath)!==normalize(actual))throw new Error('Work 视图恢复记录属于另一个客户端目录，请切回原目录处理；当前配置未修改');
  }
  if(enabled){
    if(saved?.changed){if(extensionClientConfig(planned(file,'').before).root.desktop?.conversationDetailMode!=='STEPS_COMMANDS')throw new Error('客户端详情模式已被其他程序修改，保留现值；请先处理原恢复记录');if(extra.length)applyPlan('extension-work-view-state',extra);return;}
    const plan=planned(file,''),config=extensionClientConfig(plan.before),previous=config.root.desktop?.conversationDetailMode;
    if(!config.customApi||config.definition.requires_openai_auth!==false)throw new Error('此选项仅适用于已配置 requires_openai_auth=false 的纯 API 供应商');
    if(previous!==undefined&&typeof previous!=='string')throw new Error('客户端详情模式配置无效');
    plan.after=patchToml(plan.before,'desktop',{conversationDetailMode:'STEPS_COMMANDS'});
    record.after=JSON.stringify({previous,changed:true,configPath:fs.realpathSync(file)});
    applyPlan('extension-work-view',[plan,record,...extra]);
  }else if(saved?.changed){
    const plan=planned(file,'');if(extensionClientConfig(plan.before).root.desktop?.conversationDetailMode!=='STEPS_COMMANDS')throw new Error('客户端详情模式已被其他程序修改，保留现值；请手动选择视图模式');
    plan.after=patchToml(plan.before,'desktop',{conversationDetailMode:saved.previous??null});record.after=JSON.stringify({changed:false});applyPlan('extension-work-view-restore',[plan,record,...extra]);
  }else if(extra.length)applyPlan('extension-work-view-state',extra);
}
