#!/usr/bin/env python3
"""Controlled visual-boundary and cancellation tests; Chromium, mock screenshot bytes."""
from pathlib import Path
import importlib.util,json,base64,io
from PIL import Image
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('reg',ROOT/'tests/browser-regression.py');r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
s=(ROOT/'content/content.js').read_text().replace('  startObserver();\n})();','  globalThis.__T={state,captureTurnVisualEvidence,deepCapture};\n  startObserver();\n})();')
img=Image.new('RGB',(2,2));b=io.BytesIO();img.save(b,format='JPEG');url='data:image/jpeg;base64,'+base64.b64encode(b.getvalue()).decode()
results=[]
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 page=r.make_page(browser,'<!doctype html><style>body{margin:0}</style><main><section style="height:20000px" data-turn="assistant" data-testid="conversation-turn-1">Panel largo</section></main>',s)
 page.evaluate('(url)=>{window.browser.runtime.sendMessage=async()=>({ok:true,dataUrl:url});}',url)
 result=page.evaluate('''async()=>{const turn=document.querySelector('section'),warnings=[];const count=await __T.captureTurnVisualEvidence(turn,1,1,warnings);const last=__T.state.visualSnapshots.at(-1);return {count,lastBottom:last.viewportRect.turnBottom,finalBottom:turn.getBoundingClientRect().bottom,coverage:__T.state.visualCoverage[0]};}''')
 assert result['count']==12 and result['lastBottom']==result['finalBottom'],result
 assert result['coverage']['limited'] and not result['coverage']['reachedBottom'],result
 results.append({'test':'Last captured viewport, not an unphotographed advance, determines visual bottom coverage','result':'passed','details':result})
 page.evaluate('scrollTo(0,1200)');page.wait_for_timeout(100)
 result=page.evaluate('''async()=>{const initial=document.scrollingElement.scrollTop;setTimeout(()=>__T.state.cancelled=true,100);try{await __T.deepCapture({deepScan:true,rawDom:false,visualEvidence:false},[]);return {threw:false};}catch(error){return {threw:true,message:String(error.message),initial,final:document.scrollingElement.scrollTop};}}''')
 assert result['threw'] and result['initial']==result['final'],result
 results.append({'test':'Cancellation during census restores the original scroll position','result':'passed','details':result})
 browser.close()
out=ROOT/'tests/out';out.mkdir(exist_ok=True)
report={'version':'1.3.2','environment':'Chromium with mocked screenshot bytes; blocked network','firefox_live_test':False,'tests':results}
(out/'visual-coverage-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(report,ensure_ascii=False,indent=2))
