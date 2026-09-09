import json, base64
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent; output=Path(__file__).resolve().parent/'out'; output.mkdir(parents=True,exist_ok=True)
html=(root/'popup/popup.html').read_text();js=(root/'popup/popup.js').read_text()
report={'version':'1.3.1','environment':'Chromium popup DOM, browser APIs simulated','firefox_live_test':False,'tests':[]}
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 page=b.new_page(viewport={'width':460,'height':1000});page.route('**/*',lambda r:r.abort());page.set_content(html)
 page.add_style_tag(content=(root/'popup/popup.css').read_text())
 page.evaluate('''() => {
  window.__captured=[];window.__version='1.3.0';window.__exports=0;
  window.__report={version:'1.3.1',phase:'binary_preflight',message:'TEST-ERROR',stack:'content/content.js:120:1'};
  window.browser={
    runtime:{getManifest:()=>({version:'1.3.1'})},
    storage:{local:{get:async(key)=>key==='omnichatLastError'?{omnichatLastError:window.__report}:{},set:async()=>{}}},
    tabs:{query:async()=>[{id:1}],sendMessage:async(id,m)=>{
      if(m.type==='OMNICHAT_GET_SUMMARY')return {ok:true,version:window.__version,platformLabel:'ChatGPT',title:'Prueba',turns:2,codeBlocks:2,media:1,files:1,toolExecutions:1};
      if(m.type==='OMNICHAT_GET_LAST_ERROR')return {ok:true,diagnostic:window.__report};
      if(m.type==='OMNICHAT_EXPORT'){window.__exports++;return {ok:false,error:'[binary_preflight] TEST-ERROR',diagnostic:window.__report};}
      return {ok:true};
    }},
    downloads:{download:async(m)=>{window.__captured.push({filename:m.filename,data:await(await fetch(m.url)).text()});return 1;}}
  };
 }''')
 page.evaluate(js)
 page.evaluate("document.dispatchEvent(new Event('DOMContentLoaded'))")
 page.wait_for_function("document.getElementById('status').textContent.includes('otra versión')")
 assert page.locator('#export').is_disabled()
 report['tests'].append({'test':'Outdated content script disables export and asks for page reload','result':'passed'})
 assert page.locator('#diagnostic').is_visible()
 page.locator('#diagnostic').click()
 page.wait_for_function('window.__captured.length===1')
 data=page.evaluate('window.__captured[0]')
 assert json.loads(data['data'])['phase']=='binary_preflight'
 assert data['filename']=='OmniChat-diagnostico-v1.3.1.json'
 report['tests'].append({'test':'Diagnostic persists across popup reopening and downloads as JSON from popup Blob','result':'passed'})
 page.evaluate("window.__version='1.3.1'");page.locator('#refresh').click()
 page.wait_for_function("!document.getElementById('export').disabled")
 page.locator('#export').click()
 page.wait_for_function("document.getElementById('status').textContent.includes('TEST-ERROR')")
 assert page.evaluate('window.__exports')==1
 assert page.locator('#diagnostic').is_visible()
 report['tests'].append({'test':'New version exports, displays failure phase and leaves diagnosis available','result':'passed'})
 page.screenshot(path=str(output/'popup-check.png'),full_page=True)
 b.close()
(output/'popup-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(report,ensure_ascii=False,indent=2))
