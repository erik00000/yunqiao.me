import { createHash } from 'node:crypto';
import type { AuroraStore } from '../store/index.js';
import { readTomlValue } from '../codex.js';
export function desktopModelCatalog(store:AuroraStore):any{
  const agents=store.listAgents(),agent=agents['chatgpt-desktop']||agents['codex-desktop']||agents['codex-cli'];
  const profile=readTomlValue('profile'),configured=profile?readTomlValue(`profiles.${profile}.model_provider`):readTomlValue('model_provider');
  const provider=agent?.providerId?store.getProvider(agent.providerId):undefined;
  if(!agent?.connected||configured!=='aurora'||!provider?.enabled)return{status:'not_configured',models:[],modelMetadata:{},message:'请先使用云桥为 ChatGPT 桌面版配置并应用供应商'};
  const models=provider.models.map(m=>m.id);const model=readTomlValue('model')||agent.model||models[0]||'';
  const modelMetadata=Object.fromEntries(provider.models.map(m=>[m.id,{displayName:m.displayName||m.id,description:provider.name,...(m.contextWindow?{contextWindow:m.contextWindow,maxContextWindow:m.contextWindow}:{}),...(m.capabilities?.thinking===false?{defaultReasoningEffort:'none',supportedReasoningEfforts:[{reasoningEffort:'none',description:'此模型未启用额外思考'}]}:{})}]));
  return{status:'ok',models,model,default_model:model,model_provider:'aurora',codex_model_provider:'aurora',provider_name:provider.name,modelMetadata,sources:[{id:`aurora:${provider.id}`,name:provider.name}],responses_api:{status:agent.mode==='gateway'||provider.format==='openai-responses'?'configured':'unknown',message:'使用已保存的供应商模型目录'}};
}
export function modelCatalogFingerprint(store:AuroraStore):string{return createHash('sha256').update(JSON.stringify(desktopModelCatalog(store))).digest('hex');}
