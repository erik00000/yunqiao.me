import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuroraStore } from '../store/index.js';
import { loadState,effectiveEntry } from './catalog.js';
export function dictationConfiguration(store:AuroraStore):any{
  const entry=effectiveEntry(loadState(store),'builtin:dictation'),provider=entry.config.providerId?store.getProvider(entry.config.providerId):undefined;
  const key=provider?.apiKeys.find(k=>k.enabled&&k.key&&(!k.cooldownUntil||Date.parse(k.cooldownUntil)<Date.now()));
  const configured=!!(provider?.enabled&&key&&entry.config.model);
  return{entry,provider,key,status:{enabled:entry.enabled,configured,provider:'openai',model:entry.config.model||'',message:configured?'使用已选择供应商的 /audio/transcriptions 接口':'请配置支持 OpenAI 音频转写接口的供应商 ID 与 ASR 模型'}};
}
export class DictationBridge{
  private token=randomBytes(24).toString('hex');private running=new Map<string,AbortController>();
  constructor(private store:AuroraStore){}
  cancelAll():void{for(const controller of this.running.values())controller.abort();this.running.clear();this.token=randomBytes(24).toString('hex');}
  async route(route:string,payload:any):Promise<any|null>{
    if(!['/dictation/status','/dictation/transcribe','/dictation/cancel'].includes(route))return null;
    const config=dictationConfiguration(this.store);
    if(route==='/dictation/status')return{...config.status,helperToken:config.status.enabled&&config.status.configured?this.token:undefined};
    const provided=Buffer.from(String(payload.helperToken||'')),expected=Buffer.from(this.token);if(provided.length!==expected.length||!timingSafeEqual(provided,expected))throw new Error('听写桥接凭证无效，请重新开始录音');
    const id=String(payload.requestId||'');if(!/^[a-zA-Z0-9_-]{8,100}$/.test(id))throw new Error('听写请求 ID 无效');
    if(route==='/dictation/cancel'){const controller=this.running.get(id);controller?.abort();return{status:'cancelled',cancelled:!!controller};}
    if(!config.status.enabled||!config.status.configured)throw new Error(config.status.message);
    if(this.running.has(id)||this.running.size>=2)throw new Error('已有听写请求正在进行');
    const encoded=String(payload.audioBase64||'');if(!encoded||encoded.length>35*1024*1024||!/^[a-zA-Z0-9+/]*={0,2}$/.test(encoded))throw new Error('录音数据无效或超过25MB');
    const audio=Buffer.from(encoded,'base64');if(!audio.length||audio.length>25*1024*1024)throw new Error('录音数据无效或超过25MB');
    const type=String(payload.mimeType||'').split(';')[0];if(!['audio/webm','audio/mp4','audio/wav','audio/ogg','audio/mpeg'].includes(type))throw new Error('不支持此录音格式');
    const form=new FormData();form.set('model',config.entry.config.model);form.set('file',new Blob([new Uint8Array(audio)],{type}),type==='audio/wav'?'dictation.wav':type==='audio/mp4'?'dictation.m4a':'dictation.webm');
    if(config.entry.config.language)form.set('language',String(config.entry.config.language));
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25000);this.running.set(id,controller);
    try{
      const response=await fetch(config.provider.baseUrl.replace(/\/$/,'')+'/audio/transcriptions',{method:'POST',redirect:'error',signal:controller.signal,headers:{...config.provider.headers,Authorization:`Bearer ${config.key.key}`},body:form});
      if(!response.ok)throw new Error(`语音服务返回 HTTP ${response.status}，请核实此供应商是否支持 ASR 模型`);
      const result:any=await response.json();if(typeof result.text!=='string')throw new Error('语音服务没有返回 text 字段');return{status:'ok',text:result.text.slice(0,50000)};
    }catch(e){if(controller.signal.aborted)return{status:'cancelled',message:'语音转写已取消或超时'};throw e;}finally{clearTimeout(timer);this.running.delete(id);}
  }
}
