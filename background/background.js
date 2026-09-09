"use strict";

function allowedPage(url) {
  try { const u=new URL(url);return u.protocol==='https:' && /^(?:chatgpt\.com|chat\.openai\.com|claude\.ai)$/.test(u.hostname); } catch{return false;}
}
function allowedResource(url) {
  try {
    const u=new URL(url);
    return u.protocol==='https:' && !u.username && !u.password && /^(?:chatgpt\.com|chat\.openai\.com|claude\.ai|(?:[\w-]+\.)*(?:openai\.com|oaiusercontent\.com|oaistatic\.com|anthropic\.com|claude\.ai))$/.test(u.hostname);
  } catch {return false;}
}

browser.runtime.onMessage.addListener(async (message,sender)=>{
  if(!message || typeof message!=="object")return undefined;
  if(!allowedPage(sender?.tab?.url || sender?.url))return {ok:false,error:'Origen de mensaje no autorizado'};
  try {
    if(message.type==='OMNICHAT_CAPTURE_VISIBLE') {
      const windowId=sender.tab.windowId;
      const active=await browser.tabs.query({active:true,windowId});
      if(active[0]?.id!==sender.tab.id)return {ok:false,error:'La conversación dejó de ser la pestaña activa. No se captura otra pestaña.'};
      const dataUrl=await browser.tabs.captureVisibleTab(windowId,{format:'jpeg',quality:72});
      return {ok:true,dataUrl};
    }
    if(message.type==='OMNICHAT_FETCH_RESOURCE') {
      if(!allowedResource(message.url))return {ok:false,error:'El recurso externo no pertenece a los dominios autorizados. Se conserva su referencia.'};
      const max=Math.min(1024*1024*1024,Math.max(1,Number(message.maxBytes)||200*1024*1024));
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
      try {
        // Signed CDN resources do not require sending session cookies to that CDN.
        const response=await fetch(message.url,{credentials:'omit',redirect:'error',signal:controller.signal});
        if(!response.ok)throw new Error(`HTTP ${response.status}`);
        if(Number(response.headers.get('content-length'))>max)throw new Error('Supera el presupuesto de recursos');
        const reader=response.body.getReader(), chunks=[];let size=0;
        try {
          while(true) {
            const {value,done}=await reader.read();if(done)break;
            size+=value.byteLength;if(size>max)throw new Error('Supera el presupuesto de recursos');
            chunks.push(value);
          }
        }catch(e){await reader.cancel().catch(()=>{});throw e;}
        const bytes=new Uint8Array(size);let at=0;
        for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.byteLength;}
        return {ok:true,buffer:bytes.buffer,mime:response.headers.get('content-type')||'application/octet-stream'};
      }finally{clearTimeout(timer);}
    }
    if(message.type==='OMNICHAT_DOWNLOAD_URL') {
      const url=String(message.url||'');
      if(!url.startsWith('blob:'))throw new Error('Solo se admiten exportaciones locales Blob');
      const name=String(message.filename||'omnichat-export.zip').replace(/[\\/\x00-\x1f]/g,'_');
      const downloadId=await browser.downloads.download({url,filename:name,saveAs:false,conflictAction:'uniquify'});
      return {ok:true,downloadId};
    }
  }catch(e){return {ok:false,error:e?.name==='AbortError'?'Tiempo de descarga agotado':String(e.message||e)};}
  return undefined;
});
