import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const known = new Map<string, {file:string;at:number}>();
function roots():string[]{ const dir=process.env.AURORA_CLIENT_HOME?path.join(process.env.AURORA_CLIENT_HOME,'.codex'):process.env.CODEX_HOME||path.join(os.homedir(),'.codex');return [path.join(dir,'sessions'),path.join(dir,'archived_sessions')]; }
export function resolveRollout(sessionId:string):string|null{
  const id=String(sessionId||'').replace(/^local:/,'');if(!/^[a-zA-Z0-9_-]{8,150}$/.test(id))throw new Error('会话 ID 无效');
  const searchRoots=roots(),key=JSON.stringify([searchRoots,id]);
  const matches=(file:string):boolean=>{let fd:number|undefined;try{const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())return false;fd=fs.openSync(file,'r');const buf=Buffer.alloc(32768),n=fs.readSync(fd,buf,0,buf.length,0);return buf.subarray(0,n).toString('utf8').split('\n').some(line=>{try{const row=JSON.parse(line);return row.type==='session_meta'&&row.payload?.id===id;}catch{return false;}});}catch{return false;}finally{if(fd!==undefined)fs.closeSync(fd);}};
  const cached=known.get(key);if(cached&&Date.now()-cached.at<30000&&matches(cached.file))return cached.file;known.delete(key);
  let visited=0;let found:string|null=null;
  function walk(dir:string,depth:number){if(found||depth>7||visited>=10000)return;let entries:fs.Dirent[];try{if(fs.lstatSync(dir).isSymbolicLink())return;entries=fs.readdirSync(dir,{withFileTypes:true});}catch{return;}
    for(const e of entries){if(found||visited>=10000)return;visited++;if(e.isSymbolicLink())continue;const file=path.join(dir,e.name);if(e.isDirectory())walk(file,depth+1);else if(e.isFile()&&e.name.endsWith('.jsonl')&&e.name.includes(id)&&matches(file))found=file;}
  }
  searchRoots.forEach(root=>walk(root,0));if(found){if(known.size>=500)known.delete(known.keys().next().value!);known.set(key,{file:found,at:Date.now()});}return found;
}
const numeric=(v:any):number|null=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
export function parseUsageLines(text:string):any[]{
  const events:any[]=[];let turn:string|null=null;let context:number|null=null;let previousSignature='';
  for(const line of text.split('\n')){let row:any;try{row=JSON.parse(line);}catch{continue;}const p=row?.payload||{};
    if(row.type==='turn_context'){turn=p.turn_id||turn;context=numeric(p.model_context_window)??context;}
    if(row.type==='event_msg'&&['task_started','turn_started'].includes(p.type))turn=p.turn_id||p.id||null;
    if(row.type!=='event_msg'||p.type!=='token_count'||!p.info?.last_token_usage)continue;
    const info=p.info,last=info.last_token_usage,total=info.total_token_usage||{};context=numeric(info.model_context_window)??context;
    const signature=JSON.stringify([turn,last,total]);if(signature===previousSignature)continue;previousSignature=signature;
    events.push({t:row.timestamp||null,turn_id:p.turn_id||turn,input_tokens:numeric(last.input_tokens),cached_input_tokens:numeric(last.cached_input_tokens??last.cache_read_input_tokens),cache_write_tokens:numeric(last.cache_creation_input_tokens??last.cache_write_input_tokens),output_tokens:numeric(last.output_tokens),reasoning_output_tokens:numeric(last.reasoning_output_tokens),total_tokens:numeric(last.total_tokens),context_window:context,turn_output_tokens:numeric(total.output_tokens),source:'codex-rollout'});
  }return events.slice(-60);
}
export function threadUsage(sessionId:string):any{
  const file=resolveRollout(sessionId);if(!file)return {status:'unavailable',events:[],message:'尚未找到此会话的本地 token 用量记录'};
  const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('会话日志不是普通文件');
  const limit=4*1024*1024,offset=Math.max(0,stat.size-limit);const fd=fs.openSync(file,'r');let text='';try{const buf=Buffer.alloc(Math.min(stat.size,limit));const n=fs.readSync(fd,buf,0,buf.length,offset);text=buf.subarray(0,n).toString('utf8');}finally{fs.closeSync(fd);}if(offset)text=text.slice(text.indexOf('\n')+1);
  const events=parseUsageLines(text);return {status:'ok',events,source:'codex-rollout',message:events.length?'原生客户端在每次模型调用完成后写入 token_count；缺失的缓存字段显示未知':'会话尚未产生 token_count，用量显示未知'};
}
/** Keep vendored source intact; add explicit raw counters to upstream's live status line. */
export function enhanceUsageSource(source:string):string{
  const patches:[string,string][]=[
    ['const segment = codexPlusUsageLatestTurn(events);\n    let input = 0;', 'const segment = codexPlusUsageLatestTurn(events);\n    if (segment.some(e => e.cached_input_tokens == null || e.input_tokens == null)) return null;\n    let input = 0;'],
    ['speed: codexPlusUsageRate(events),','speed: codexPlusUsageRate(events),\n      raw: latest,'],
    ['const fingerprint = [speed, cache, context, stale, contextWindow].join("|");','const raw = snapshot?.raw || {};\n    const count = value => value == null ? "未知" : Number(value).toLocaleString("zh-CN");\n    const counters = `输入 ${count(raw.input_tokens)} · 输出 ${count(raw.output_tokens)} · 缓存读 ${count(raw.cached_input_tokens)} · 缓存写 ${count(raw.cache_write_tokens)}`;\n    const fingerprint = [speed, cache, context, stale, contextWindow, counters].join("|");'],
    ['parts.context.value.textContent = text.context(context);','parts.context.value.textContent = text.context(context);\n    let detail = node.querySelector("[data-aurora-usage-details]");\n    if (!detail) { detail = document.createElement("span"); detail.dataset.auroraUsageDetails = "true"; detail.style.cssText = "margin-left:8px;font-size:11px;opacity:.78;white-space:normal"; node.appendChild(detail); }\n    detail.textContent = counters; detail.title = "最近一次模型调用的实际上报值；未知表示客户端未上报，0 表示实际为零。缓存率按本轮输入 token 加权。";'],
  ];
  let result=source.replace(/\r\n/g,'\n');for(const [before,after]of patches){if(!result.includes(before))throw new Error('上游用量状态栏结构变化，停止应用计数补丁');result=result.replace(before,after);}return result;
}
