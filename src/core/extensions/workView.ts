import type { AuroraStore } from '../store/index.js';
import { codexConfigPath, readTomlValue } from '../codex.js';
import { applyPlan, patchToml, planned } from '../agents/configFiles.js';
export function setWorkViewDisabled(store:AuroraStore,enabled:boolean):void{
  const file=codexConfigPath(),saved=store.readExtra<{previous?:string;changed:boolean;backup?:string}|null>('extension-work-view.json',null);
  if(enabled){
    if(saved?.changed)return;
    const profile=readTomlValue('profile'),provider=profile?readTomlValue(`profiles.${profile}.model_provider`):readTomlValue('model_provider');
    if(!provider||['openai','amazon-bedrock','amazonBedrock'].includes(provider)||readTomlValue(`model_providers.${provider}.requires_openai_auth`)!=='false')throw new Error('此选项仅适用于已配置 requires_openai_auth=false 的纯 API 供应商');
    const plan=planned(file,''),previous=readTomlValue('desktop.conversationDetailMode');plan.after=patchToml(plan.before,'desktop',{conversationDetailMode:'STEPS_COMMANDS'});
    const backup=applyPlan('extension-work-view',[plan]);store.writeExtra('extension-work-view.json',{previous,changed:true,backup});
  }else if(saved?.changed){
    if(readTomlValue('desktop.conversationDetailMode')!=='STEPS_COMMANDS')throw new Error('客户端详情模式已被其他程序修改，保留现值；请手动选择视图模式');
    const plan=planned(file,'');plan.after=patchToml(plan.before,'desktop',{conversationDetailMode:saved.previous??null});applyPlan('extension-work-view-restore',[plan]);store.writeExtra('extension-work-view.json',{changed:false});
  }
}
