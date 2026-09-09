#!/usr/bin/env python3
"""Controlled Chromium tests. This is NOT a Firefox or authenticated-session test.
Requires playwright, bs4 and a Chromium executable. Network requests are blocked.
Example: python tests/browser-regression.py --out /tmp/omnichat-tests
"""
from __future__ import annotations
import argparse, base64, hashlib, io, json, zipfile
from pathlib import Path
from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==')
FILE_TEXT = 'Prueba de archivo: España ñ — 漢字\n'
COMMAND = "bash -lc python - <<'PY'\nfor i in range(2):\n    print(i)\nPY\n"
BOOT = r'''() => {
  // about:blank is not a secure context in this restricted test browser.
  // Digest is a test bridge to Python hashlib; native WebCrypto is tested in Node.
  Object.defineProperty(crypto,'subtle',{value:{digest:async (algorithm,source)=>{
    if(algorithm!=='SHA-256') throw new Error('Unexpected test algorithm');
    const view=new Uint8Array(source.buffer || source,source.byteOffset || 0,source.byteLength);
    const values=[];for(let i=0;i<view.length;i++)values.push(view[i]);
    const answer=await window.__digestBridge(values);
    const result=new Uint8Array(answer.length);result.set(answer);return result.buffer;
  }}, configurable:true});
  window.__saved={}; window.__downloads=[]; window.__messages=[];
  window.browser={
    runtime:{
      getManifest:()=>({version:'1.3.2'}),
      onMessage:{addListener:fn=>window.__messages.push(fn)},
      sendMessage:async m=>{
        if(m.type==='OMNICHAT_CAPTURE_VISIBLE') return {ok:false,error:'Visual capture intentionally not provided in this mock'};
        if(m.type==='OMNICHAT_DOWNLOAD_URL') {
          const response=await fetch(m.url);
          const view=new Uint8Array(await response.arrayBuffer());
          let binary='';for(let i=0;i<view.length;i++)binary+=String.fromCharCode(view[i]);
          window.__downloads.push({name:m.filename,data:btoa(binary)});
          return {ok:true,downloadId:window.__downloads.length};
        }
        return {ok:false,error:'Network resources blocked in this test'};
      }
    },
    storage:{local:{
      get:async key=>({[key]:window.__saved[key]}),
      set:async obj=>{Object.assign(window.__saved,obj);}
    }}
  };
  const deny=()=>{throw new Error('Permission denied to access property "constructor"');};
  Object.defineProperty(Uint8Array.prototype,'constructor',{configurable:true,get:deny});
  Object.defineProperty(ArrayBuffer.prototype,'constructor',{configurable:true,get:deny});
}'''

def fixture() -> str:
    import html
    return f'''<!doctype html><meta charset="utf-8"><title>Prueba OmniChat</title>
    <main>
    <section data-testid="conversation-turn-1" data-turn="user">
      <div data-message-author-role="user"><p>Exporta todo: España ñ.</p>
        <img alt="sample.png" src="data:image/png;base64,{base64.b64encode(PNG).decode()}">
        <a download="prueba.md" href="data:text/markdown;base64,{base64.b64encode(FILE_TEXT.encode()).decode()}">prueba.md</a>
      </div>
    </section>
    <section data-testid="conversation-turn-2" data-turn="assistant">
      <div data-message-author-role="assistant">
        <details id="activity"><summary>Trabajo visible</summary>
          <div data-tool-execution data-tool-name="Python">
            <div><pre data-tool-command>{html.escape(COMMAND)}</pre></div>
            <div><pre>0\n1\n</pre></div>
          </div>
        </details>
        <p>Ejemplo, no ejecutado:</p><pre><code class="language-bash">npm run example</code></pre>
        <button id="copy-test" aria-label="Copy" aria-expanded="false">Copy</button>
      </div>
    </section>
    </main>'''

def make_page(browser, html: str, source: str):
    page=browser.new_page(viewport={"width":1200,"height":900})
    page.route('**/*',lambda route:route.abort())
    # Browser policy forbids URL navigation here; use an inert about:blank document.
    page.set_content(html)
    page.expose_function('__digestBridge',lambda values:list(hashlib.sha256(bytes(values)).digest()))
    page.evaluate(BOOT)
    # Only the test copy gets a platform/location fixture, never the distributed extension.
    source = source.replace('  "use strict";', '  "use strict";\n  const location = { origin:"https://chatgpt.com", hostname:"chatgpt.com", pathname:"/", href:"https://chatgpt.com/" };',1)
    page.evaluate(source)
    page.evaluate("window.__copyCount=0; document.getElementById('copy-test')?.addEventListener('click',()=>window.__copyCount++)")
    return page

def send(page, message):
    return page.evaluate('(message)=>window.__messages[0](message)',message)

def export(page, fmt: str, archive=True):
    return send(page, {'type':'OMNICHAT_EXPORT','options':{
        'format':fmt,'deepScan':False,'expandCollapsed':True,'archiveAssets':archive,
        'archiveFiles':archive,'rawDom':True,'eventLog':True,'visualEvidence':False,'assetLimitMb':50}})

def download_data(page) -> bytes:
    return base64.b64decode(page.evaluate('window.__downloads.at(-1).data'))

def check_zip(data: bytes):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        assert z.testzip() is None
        integrity=json.loads(z.read('integrity.json'))['entries']
        for e in integrity:
            raw=z.read(e['path']);assert len(raw)==e['bytes']
            assert hashlib.sha256(raw).hexdigest()==e['sha256']
        images=[n for n in z.namelist() if n.startswith('assets/')]
        files=[n for n in z.namelist() if n.startswith('files/')]
        assert len(images)==1 and z.read(images[0])==PNG
        assert len(files)==1 and z.read(files[0])==FILE_TEXT.encode()
        c=json.loads(z.read('conversation.json'))
        assert c['summary']['turns']==2
        assert c['summary']['toolExecutions']==1
        assert c['turns'][1]['toolExecutions'][0]['command']==COMMAND
        assert c['diagnostics'][1]['kind']=='binary-preflight' or any(x.get('kind')=='binary-preflight' for x in c['diagnostics'])
        return len(integrity)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--source-zip',type=Path)
    parser.add_argument('--old-extension-zip',type=Path)
    parser.add_argument('--chromium',default='/usr/bin/chromium')
    args=parser.parse_args(); args.out.mkdir(parents=True,exist_ok=True)
    source=(ROOT/'content/content.js').read_text()
    tests=[]
    def passed(name,**details): tests.append({'test':name,'result':'passed',**details})
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=args.chromium,headless=True,args=['--no-sandbox'])
        version=browser.version
        if args.old_extension_zip:
            with zipfile.ZipFile(args.old_extension_zip) as z: old=z.read('content/content.js').decode()
            page=make_page(browser,fixture(),old)
            outcome=export(page,'zip',archive=False)
            assert not outcome['ok'] and 'constructor' in outcome['error'],outcome
            passed('Full 1.3.0 ZIP export fails under simulated denied constructor access',error=outcome['error'])
            page.close()
        page=make_page(browser,fixture(),source)
        summary=send(page,{'type':'OMNICHAT_GET_SUMMARY'});assert summary['version']=='1.3.2'
        outcome=export(page,'zip');assert outcome['ok'],outcome
        data=download_data(page);count=check_zip(data)
        (args.out/'browser-fixture.zip').write_bytes(data)
        passed('Full ZIP export with native browser Blob, hashlib digest bridge and both constructor guards',hashed_entries=count)
        assert page.evaluate('window.__copyCount')==0
        assert not page.locator('#activity').evaluate('(el)=>el.open')
        passed('Copy button receives zero clicks; native disclosure is restored')
        for fmt in ['html','json','markdown']:
            outcome=export(page,fmt);assert outcome['ok'],outcome
            data=download_data(page);assert 'España'.encode() in data
            if fmt=='json':assert json.loads(data)['summary']['toolExecutions']==1
            if fmt=='html':assert b'data:image/png;base64,' in data and b"script-src 'none'" in data
            passed(f'{fmt.upper()} export succeeds with denied constructor lookups')
        # Induce a real preflight failure and assert the report is captured before scroll.
        page.evaluate("Object.defineProperty(crypto.subtle,'digest',{value:async()=>{throw new Error('DIAGNOSTIC-TEST')},configurable:true})")
        outcome=export(page,'zip');assert not outcome['ok'],outcome
        assert outcome['diagnostic']['phase']=='binary_preflight'
        assert 'DIAGNOSTIC-TEST' in outcome['diagnostic']['message']
        assert page.evaluate('window.__saved.omnichatLastError.phase')=='binary_preflight'
        assert page.locator('#omnichat-export-toast').is_visible()
        passed('Preflight failure records phase/stack in local storage and leaves the error visible')
        page.close()
        if args.source_zip:
            with zipfile.ZipFile(args.source_zip) as z:
                nodes=[]
                for name in sorted(n for n in z.namelist() if n.startswith('raw/') and n.endswith('.html')):
                    soup=BeautifulSoup(z.read(name),'html.parser')
                    for tag in soup(['script','iframe','object','embed','link','style']):tag.decompose()
                    for tag in soup.find_all(True):
                        for attr in list(tag.attrs):
                            if attr.lower().startswith('on'):del tag[attr]
                    # Keep the whole saved turn markup; skip head wrappers from standalone raw docs.
                    nodes.append(str(soup.body or soup))
            saved='<!doctype html><title>Saved DOM regression</title><main>'+''.join(nodes)+'</main>'
            page=make_page(browser,saved,source)
            outcome=export(page,'json',archive=False);assert outcome['ok'],outcome
            c=json.loads(download_data(page))
            assert c['summary']['turns']==8,c['summary']
            assert c['summary']['toolExecutions']==22,c['summary']
            assert len(c['turns'][1]['toolExecutions'])==0
            passed('Actual saved user DOM: 8 turns and 22 tool panels; the first explanatory answer is not classified as execution')
            page.close()
        browser.close()
    report={'version':'1.3.2','environment':'Chromium '+version+' via Playwright on about:blank, native Blob, Python hashlib digest bridge; network blocked',
            'firefox_live_test':False,'authenticated_chatgpt_test':False,
            'mocked':'browser.runtime, storage, downloads, location and WebCrypto bridge; denied constructor getters simulate the reported failure; no Firefox Xray implementation',
            'tests':tests}
    (args.out/'browser-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(report,ensure_ascii=False,indent=2))
if __name__=='__main__':main()
