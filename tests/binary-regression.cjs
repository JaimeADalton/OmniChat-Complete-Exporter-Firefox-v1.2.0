#!/usr/bin/env node
'use strict';
// Run with Node.js >= 18: node tests/binary-regression.cjs [output-directory]
// This simulates a denied constructor lookup; it is NOT Firefox's Xray runtime.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const {webcrypto, createHash} = require('node:crypto');
const {TextEncoder, TextDecoder} = require('node:util');
const {Blob} = require('node:buffer');
const dir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, 'out');
fs.mkdirSync(dir, {recursive:true});
const source = fs.readFileSync(path.join(__dirname, '../content/content.js'), 'utf8');
const exposed = ['normalizedBytes','sha256Bytes','createZip','validateResource','bytesToDataUrl','dataUrlToBytes','binaryPreflight','diagnosticText','recordExportFailure','state'];
const instrumented = source.replace('  startObserver();\n})();', `  globalThis.testAPI = {${exposed.join(',')}};\n})();`);
assert.notEqual(instrumented, source, 'Test-only instrumentation anchor missing');
let savedDiagnostic = null;
const context = vm.createContext({
  TextEncoder, TextDecoder, Blob, crypto: webcrypto,
  console: {log(){},warn(){},error(){}},
  setTimeout, clearTimeout, URL, navigator:{userAgent:'Node test: not Firefox'},
  location:{origin:'https://chatgpt.com',pathname:'/c/test',hostname:'chatgpt.com'},
  browser:{runtime:{onMessage:{addListener(){}}}, storage:{local:{set(data){savedDiagnostic=data;return Promise.resolve();}}}},
  atob:s=>Buffer.from(s,'base64').toString('binary'), btoa:s=>Buffer.from(s,'binary').toString('base64')
});
vm.runInContext(instrumented, context);
const api = context.testAPI;
const tests=[];
const test=async (name,fn)=>{await fn(); tests.push({test:name,result:'passed'});};
const bytes=a=>Array.from(a);
(async()=>{
  // Deny species lookups without altering the globals in the Node host process.
  vm.runInContext(`
    const deny = () => { throw new Error('Permission denied to access property "constructor"'); };
    Object.defineProperty(Uint8Array.prototype, 'constructor', { configurable:true, get:deny });
    globalThis.oldNormalize = function(value) {
      if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
      if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') return new Uint8Array(value).slice();
    };
  `,context);
  await test('The 1.3.0 normalization expression throws the reported constructor error under a denied getter',()=>{
    assert.throws(()=>context.oldNormalize(new Uint8Array([1,2,3])),/Permission denied to access property "constructor"/);
  });
  await test('The new byte copy works with denied constructor lookups and foreign-realm input',()=>{
    const foreign = vm.runInNewContext('new Uint8Array([137,80,78,71,13,10,26,10])');
    const copy=api.normalizedBytes(foreign);assert.deepEqual(bytes(copy),bytes(foreign));
    foreign[0]=0;assert.equal(copy[0],137);
  });
  await test('DataView offsets, typed-array offsets and ArrayBuffer copies are exact and independent',()=>{
    const raw=new Uint8Array([200,201,4,5,6,202]);
    assert.deepEqual(bytes(api.normalizedBytes(new DataView(raw.buffer,2,3))),[4,5,6]);
    assert.deepEqual(bytes(api.normalizedBytes(new Uint8Array(raw.buffer,2,3))),[4,5,6]);
    assert.deepEqual(bytes(api.normalizedBytes(raw.buffer)),bytes(raw));
    const wide=new Uint16Array([0xabcd,0x1234]);
    assert.deepEqual(bytes(api.normalizedBytes(wide)),bytes(new Uint8Array(wide.buffer)));
  });
  await test('TextEncoder foreign-realm UTF-8 output, empty inputs and invalid type rejection',()=>{
    for (const text of ['', 'Español: áéíóú ñ — 漢字 😀\n']) {
      assert.deepEqual(bytes(api.normalizedBytes(text)),bytes(Buffer.from(text,'utf8')));
    }
    assert.equal(api.normalizedBytes(new ArrayBuffer(0)).length,0);
    for(const value of [{},[1,2],null,12]) assert.throws(()=>api.normalizedBytes(value),/Se rechazó/);
  });
  await test('SHA-256 matches native Node crypto with denied constructor lookups',async()=>{
    for(const v of ['abc','España\n',new Uint8Array([0,255,1,128])]){
      const expected=createHash('sha256').update(typeof v==='string'?v:Buffer.from(v)).digest('hex');
      assert.equal(await api.sha256Bytes(v),expected);
    }
  });
  await test('Resource signature validation and base64 round trip do not use typed-array subarray',()=>{
    const png=api.normalizedBytes(new Uint8Array([137,80,78,71,13,10,26,10]));
    api.validateResource(png,'image/png','test.png',8);
    assert.throws(()=>api.validateResource(api.normalizedBytes('bad'),'image/png','test.png'),/cabecera PNG/);
    const large=new Uint8Array(80001);for(let i=0;i<large.length;i++) large[i]=i%256;
    const url=api.bytesToDataUrl(api.normalizedBytes(large),'application/octet-stream');
    assert.deepEqual(bytes(api.dataUrlToBytes(url).bytes),bytes(large));
  });
  await test('Normalization, hashes and ZIP also tolerate denied ArrayBuffer constructor access',async()=>{
    vm.runInContext(`globalThis.originalBufferCtor = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'constructor');
      Object.defineProperty(ArrayBuffer.prototype, 'constructor', { configurable:true, get:deny });`, context);
    try {
      assert.deepEqual(bytes(api.normalizedBytes(new Uint8Array([1,2]))),[1,2]);
      assert.equal(await api.sha256Bytes('abc'),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
      assert.equal(api.createZip([{name:'safe.txt',data:'abc'}])[0],80);
    } finally {
      // Node's own Blob internally uses ArrayBuffer.slice; that is not Firefox's native Blob.
      vm.runInContext("Object.defineProperty(ArrayBuffer.prototype, 'constructor', originalBufferCtor)",context);
    }
  });
  await test('Preflight covers bytes, offsets, real WebCrypto SHA, ZIP and Blob round trip',async()=>{
    assert.equal((await api.binaryPreflight()).result,'passed');
  });
  const files=[
    {name:'conversation.md',data:'# Conversación\n\nEspañol ñ — 漢字 😀\n'},
    {name:'assets/pixel.png',data:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==','base64')},
    {name:'files/range.bin',data:new DataView(new Uint8Array([9,10,20,30,40,50,9]).buffer,1,5)}
  ];
  await test('ZIP assembly with foreign binary, DataView and Unicode; entries carry independent SHA-256',async()=>{
    const entries=[];
    for(const f of files) {const value=api.normalizedBytes(f.data);entries.push({path:f.name,bytes:value.length,sha256:await api.sha256Bytes(value)});}
    const zip=api.createZip([...files,
      {name:'integrity.json',data:JSON.stringify({algorithm:'SHA-256',entries})},
      {name:'SHA256SUMS.txt',data:entries.map(e=>`${e.sha256}  ${e.path}`).join('\n')+'\n'}
    ]);
    fs.writeFileSync(path.join(dir,'binary-regression.zip'),Buffer.from(zip));
    fs.writeFileSync(path.join(dir,'binary-expected.json'),JSON.stringify(entries,null,2));
    assert.throws(()=>api.createZip([{name:'a',data:'1'},{name:'a',data:'2'}]),/duplicadas/);
    assert.throws(()=>api.createZip([{name:'../bad',data:'1'}]),/Nombre ZIP/);
  });
  await test('Failure diagnostic preserves stage and source line, omits URLs and bearer values, and persists locally',()=>{
    api.state.phase='integrity';
    const error=new Error('Permission denied to access property "constructor" https://example.org/private?sig=secret Bearer eySECRET');
    error.stack='Error\n at normalizedBytes (moz-extension://random-uuid/content/content.js:120:10)';
    const report=api.recordExportFailure(error,{format:'zip'});
    assert.equal(report.version,'1.3.1');assert.equal(report.phase,'integrity');
    assert.match(report.stack,/content\/content.js:120:10/);
    assert.doesNotMatch(JSON.stringify(report),/random-uuid|eySECRET|sig=secret|example.org/);
    assert.equal(savedDiagnostic.omnichatLastError,report);
  });
  const result={version:'1.3.1',environment:process.version+' / Node vm isolated contexts + native WebCrypto and Blob',
    firefox_live_test:false,authenticated_chatgpt_test:false,
    error_reproduction:'Simulated denied constructor getter, not a Firefox Xray implementation',tests};
  fs.writeFileSync(path.join(dir,'binary-results.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
