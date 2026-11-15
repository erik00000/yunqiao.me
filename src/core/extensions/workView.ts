import path from 'node:path';
import type { AuroraStore } from '../store/index.js';
import { codexConfigPath } from '../codex.js';
import { applyPlan, patchToml, planned, type PlannedFile } from '../agents/configFiles.js';
import { extensionClientConfig } from './clientConfig.js';
export function setWorkViewDisabled(store:AuroraStore,enabled:boolean,extra:PlannedFile[]=[]):void{
  const file=codexConfigPath(),saved=store.readExtra<{previous?:string;changed:boolean;backup?:string}|null>('extension-work-view.json',null);
  if(enabled){
    if(saved?.changed){if(extra.length)applyPlan('extension-work-view-state',extra);return;}
    const plan=planned(file,''),config=extensionClientConfig(plan.before),previous=config.root.desktop?.conversationDetailMode;
    if(!config.customApi||config.definition.requires_openai_auth!==false)throw new Error('此选项仅适用于已配置 requires_openai_auth=false 的纯 API 供应商');
    if(previous!==undefined&&typeof previous!=='string')throw new Error('客户端详情模式配置无效');
    plan.after=patchToml(plan.before,'desktop',{conversationDetailMode:'STEPS_COMMANDS'});
    applyPlan('extension-work-view',[plan,planned(path.join(store.dir,'extension-work-view.json'),JSON.stringify({previous,changed:true})),...extra]);
  }else if(saved?.changed){
    const plan=planned(file,'');if(extensionClientConfig(plan.before).root.desktop?.conversationDetailMode!=='STEPS_COMMANDS')throw new Error('客户端详情模式已被其他程序修改，保留现值；请手动选择视图模式');
    plan.after=patchToml(plan.before,'desktop',{conversationDetailMode:saved.previous??null});applyPlan('extension-work-view-restore',[plan,planned(path.join(store.dir,'extension-work-view.json'),JSON.stringify({changed:false})),...extra]);
  }else if(extra.length)applyPlan('extension-work-view-state',extra);
}
