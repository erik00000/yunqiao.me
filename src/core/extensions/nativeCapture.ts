import type { DesktopCdp } from '../injector.js';
/** Upstream locates the native client method; a conditional breakpoint captures its constructor without pausing execution. */
export function captureNativeClient(cdp:DesktopCdp):()=>Promise<void>{
  let stopped=false,busy=false,breakpoint='',enabled=false;const started=Date.now();
  const tick=async()=>{if(stopped||busy||!cdp.connected||breakpoint||Date.now()-started>120000)return;busy=true;try{
    const state=await cdp.evaluate('({captured:!!window.__codexPlusAppServerClientClass,location:window.__codexPlusAppServerClientCapture||null})');if(state?.captured)return;
    const location=state?.location;if(!location||typeof location.urlRegex!=='string'||!Number.isSafeInteger(location.lineNumber)||!Number.isSafeInteger(location.columnNumber)||location.lineNumber<0||location.columnNumber<0)return;
    const decoded=location.urlRegex.replace(/\\(.)/g,'$1');const url=new URL(decoded);if(url.protocol!=='app:'||url.hostname!=='-'||!/^\/assets\/[^/]+\.js$/.test(url.pathname))return;
    await cdp.send('Debugger.enable');enabled=true;if(stopped)return;
    const condition="(()=>{try{if(window.__codexPlusAppServerClientClass)return false;const ctor=this.constructor;if(typeof ctor!=='function'||ctor===Object||ctor===Function)return false;if(typeof ctor.prototype?.sendRequest!=='function'&&typeof this.sendRequest!=='function')return false;window.__codexPlusAppServerClientClass=ctor;}catch{}return false;})()";
    const result=await cdp.send('Debugger.setBreakpointByUrl',{lineNumber:location.lineNumber,columnNumber:location.columnNumber,urlRegex:'^'+location.urlRegex+'$',condition});breakpoint=result.breakpointId||'';
    if(stopped&&breakpoint){await cdp.send('Debugger.removeBreakpoint',{breakpointId:breakpoint}).catch(()=>{});breakpoint='';}
  }catch{/* Other native transports remain available when class discovery is unsupported. */}finally{busy=false;}};
  const timer=setInterval(()=>void tick(),1500);timer.unref?.();void tick();
  return async()=>{stopped=true;clearInterval(timer);if(breakpoint)await cdp.send('Debugger.removeBreakpoint',{breakpointId:breakpoint}).catch(()=>{});if(enabled)await cdp.send('Debugger.disable').catch(()=>{});};
}
