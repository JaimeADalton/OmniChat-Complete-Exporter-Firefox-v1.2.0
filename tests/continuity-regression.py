#!/usr/bin/env python3
"""Regression against saved conversation DOM and controlled window virtualization.
No external requests; Chromium + mocks, NOT Firefox or an authenticated session.
Optional --source-zip uses a private user export without bundling it in this package.
"""
from __future__ import annotations
import argparse,base64,hashlib,importlib.util,json,io,zipfile,html
from pathlib import Path
from playwright.sync_api import sync_playwright
from bs4 import BeautifulSoup
ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('regression',ROOT/'tests/browser-regression.py')
helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
API=['state','deepCapture','turnContinuity','finalizeCaptureCoverage','extractTurnSnapshot',
     'getTurnElements','isLikelyFileLink','buildConversationObject','buildHtml',
     'buildMarkdown','buildCommandsMarkdown','buildReport','rewriteRawHtml','sanitizeClone',
     'captureTurnVisualEvidence','summarizeTurns']
def expose(source):
    available=[name for name in API if f'function {name}(' in source or name=='state']
    return source.replace('  startObserver();\n})();',
          f'  globalThis.__TEST = {{{",".join(available)}}};\n  startObserver();\n}})();')

def dynamic_html():
    heights=[450,2400,120,500]+[500]*8
    rows=''.join(f'<div class="slot" data-n="{i+1}" style="height:{height}px"></div>' for i,height in enumerate(heights))
    return '<!doctype html><meta charset="utf-8"><style>body{margin:0}section{padding:0;margin:0}pre{margin:0}details{font-size:12px}</style><main>'+rows+'</main>'
DYNAMIC=r'''() => {
  const content = n => n===3 ? 'haz lo que tengas que hacer para que me des la extension lista para descargar e instalar preparada para usar, por ejemplo, en esta misma conversacion' : 'Mensaje '+n;
  window.__copyCount=0;
  window.__mounts=[];
  const update=()=>{
    for(const slot of document.querySelectorAll('.slot')) {
      const n=Number(slot.dataset.n),r=slot.getBoundingClientRect();
      // Long-lived anchors can coexist with messages only mounted near viewport.
      const keep=[1,2,4].includes(n) || (r.bottom>10 && r.top<innerHeight-10);
      if(keep && !slot.firstChild) {
        const role=n%2?'user':'assistant';
        const code=n%2?'':`<details id="activity-${n}"><summary>Herramienta visible ${n}</summary><div data-tool-execution data-tool-name="Python"><div><pre data-tool-command>print(${n})\n</pre></div><div><pre>${n}\n</pre></div></div></details>`;
        slot.innerHTML=`<section data-testid="conversation-turn-${n}" data-turn-id="test-${n}" data-turn="${role}"><div data-message-author-role="${role}"><p>${content(n)}</p>${code}<button aria-label="Copy" aria-expanded="false" onclick="window.__copyCount++">Copy</button></div></section>`;
        window.__mounts.push(n);
      } else if(!keep && slot.firstChild) slot.replaceChildren();
    }
  };
  addEventListener('scroll',update,{passive:true});update();
}'''


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--out',type=Path,required=True)
    ap.add_argument('--source-zip',type=Path)
    ap.add_argument('--old-source',type=Path)
    a=ap.parse_args();a.out.mkdir(parents=True,exist_ok=True)
    source=(ROOT/'content/content.js').read_text(); print('START',flush=True)
    tests=[]
    def passed(name,**details): tests.append(dict(test=name,result='passed',**details)); print('PASSED '+name,flush=True)
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
        version=browser.version
        for label,src in [('1.3.1',a.old_source.read_text())] if a.old_source else []:
            print('OLD DYNAMIC',flush=True); page=helper.make_page(browser,dynamic_html(),expose(src));page.evaluate(DYNAMIC)
            result=page.evaluate('''async()=>{const warnings=[];const turns=await __TEST.deepCapture({deepScan:true,expandCollapsed:true,rawDom:true,visualEvidence:false,format:'json'},warnings);return {orders:turns.map(t=>t.orderHint),warnings};}''')
            assert 3 not in result['orders'],result
            passed('Reproduce skipped short message in 1.3.1 shell-jump strategy',orders=result['orders'])
            page.close()
        print('NEW DYNAMIC',flush=True); page=helper.make_page(browser,dynamic_html(),expose(source));page.evaluate(DYNAMIC)
        result=page.evaluate('''async()=>{const warnings=[];const turns=await __TEST.deepCapture({deepScan:true,expandCollapsed:true,rawDom:true,visualEvidence:false,format:'json'},warnings);__TEST.finalizeCaptureCoverage(turns,warnings);return {orders:turns.map(t=>t.orderHint),text:turns.find(t=>t.orderHint===3)?.text,coverage:__TEST.turnContinuity(turns),diagnostics:__TEST.state.diagnostics,copy:__copyCount,warnings};}''')
        assert result['orders']==list(range(1,13)),result
        assert 'haz lo que tengas que hacer' in result['text']
        assert result['coverage']['missingOrderHints']==[]
        assert result['copy']==0
        assert not page.locator('details[open]').count()
        passed('Overlapping mounted-window sweep recovers 12/12 including short message 3; controls restored; zero Copy clicks',**result)
        page.close()
        page=helper.make_page(browser,helper.fixture(),expose(source))
        result=page.evaluate('''()=>{const t=[{orderHint:1},{orderHint:2},{orderHint:4}];return {gap:__TEST.turnContinuity(t),zero:__TEST.turnContinuity([{orderHint:0},{orderHint:1}]),unknown:__TEST.turnContinuity([{id:'a'}])};}''')
        assert result['gap']['missingOrderHints']==[3]
        assert result['gap']['expectedTotal'] is None
        assert not result['gap']['completeConversationVerified']
        assert result['zero']['missingOrderHints']==[] and result['unknown']['status']=='indices_unavailable'
        passed('Continuity report flags missing 3 without claiming full coverage, supports zero-based and unknown indices')
        result=page.evaluate('''()=>{const cases=[
          ['https://firefox-source-docs.mozilla.org/dom/scriptSecurity/xray_vision.html',false,false],
          ['https://example.org/guide.htm',false,false],
          ['https://example.org/report.html',true,true],
          ['sandbox:/mnt/data/prototype.html',false,true],
          ['https://example.org/report.pdf',false,true],
          ['https://github.com/org/repo/blob/main/README.md',false,false],
          ['https://chatgpt.com/backend-api/file.html',false,false]];
          return cases.map(([url,download,expected])=>{const a=document.createElement('a');a.href=url;if(download)a.setAttribute('download','report.html');return {url,expected,actual:__TEST.isLikelyFileLink(a,url)}});
        }''')
        assert all(c['actual']==c['expected'] for c in result),result
        passed('HTML documentation is a link, explicit downloads and sandbox HTML remain attachments',cases=result)
        page.evaluate('''()=>{document.querySelector('main').innerHTML='<section data-testid="conversation-turn-1" data-turn="user"><p>A</p></section><div data-message-author-role="user" data-message-id="orphan">Mensaje temporal sin shell</div><article data-testid="conversation-turn-4" data-turn="assistant"><p>B</p></article>';}''')
        assert page.evaluate('__TEST.getTurnElements().length')==3
        passed('Mixed persistent shells and orphan mounted role nodes are all included once')
        # Source/final ordinals can differ from discovery order. Test re-labeling.
        result=page.evaluate('''()=>{const turns=__TEST.getTurnElements().map(n=>__TEST.extractTurnSnapshot(n));__TEST.state.visualSnapshots=[{index:1,label:'Turno 99 de 99 · vista 1',turnOrdinal:99,turnId:turns[1].id,tile:1,bytes:new Uint8Array([0]),mime:'image/jpeg'}];const c=__TEST.buildConversationObject(turns,{eventLog:false},{archived:new Map()},[]);return c.visualEvidence[0];}''')
        assert result['turnOrdinal']==2 and result['label']=='Turno 2 de 3 · vista 1' and result['captureTurnOrdinal']==99
        passed('Visual labels use stable identity and final order while retaining original discovery labels')
        page.close()
        if a.source_zip:
            with zipfile.ZipFile(a.source_zip) as z:
                c=json.loads(z.read('conversation.json'))
                raw='\n'.join(t['rawHtml'] for t in c['turns'])
            # Remove any active markup before replay; all requests are blocked too.
            soup=BeautifulSoup('<main>'+raw+'</main>','html.parser')
            for tag in soup(['script','iframe','object','embed','link','style']):tag.decompose()
            for tag in soup.find_all(True):
                for k in list(tag.attrs):
                    if k.lower().startswith('on'):del tag[k]
            page=helper.make_page(browser,str(soup),expose(source))
            result=page.evaluate('''()=>{const turns=__TEST.getTurnElements().map(n=>__TEST.extractTurnSnapshot(n));return {turns:turns.length,tools:turns.reduce((n,t)=>n+t.toolExecutions.length,0),orders:turns.map(t=>t.orderHint),htmlFiles:turns.flatMap(t=>t.files).filter(f=>/\\.html?(?:$|[?#])/.test(f.href||'')),coverage:__TEST.turnContinuity(turns),commands:turns.flatMap(t=>t.toolExecutions.map(e=>e.command))};}''')
            assert result['turns']==11
            assert result['tools']==34
            assert result['coverage']['missingOrderHints']==[3]
            assert result['htmlFiles']==[]
            expected=[e['command'] for t in c['turns'] for e in t['toolExecutions']]
            assert result.pop('commands')==expected
            passed('Real uploaded 1.3.1 DOM: 11 saved turns, same 34 commands byte-for-text, missing 3 flagged, no six HTML false attachments',**result)
            # Complete export with this saved DOM and disabled downloads verifies that
            # coverage.json is inside the package and hashed, not only in memory.
            outcome=helper.export(page,'zip',archive=False);assert outcome['ok'],outcome
            rawzip=helper.download_data(page)
            with zipfile.ZipFile(io.BytesIO(rawzip)) as z:
                assert z.testzip() is None
                coverage=json.loads(z.read('turn-coverage.json'))
                assert coverage['missingOrderHints']==[3]
                for entry in json.loads(z.read('integrity.json'))['entries']:
                    rawentry=z.read(entry['path']);assert len(rawentry)==entry['bytes']
                    assert hashlib.sha256(rawentry).hexdigest()==entry['sha256']
            passed('Full ZIP replay of real saved DOM includes truthful, hash-verified turn-coverage.json')
            page.close()
        browser.close()
    report={'version':'1.3.2','environment':'Chromium '+version+' / Playwright with blocked network, mocked extension messaging and hashlib digest bridge',
            'firefox_live_test':False,'authenticated_chatgpt_test':False,'tests':tests}
    (a.out/'continuity-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(report,ensure_ascii=False,indent=2))

if __name__=='__main__':main()
