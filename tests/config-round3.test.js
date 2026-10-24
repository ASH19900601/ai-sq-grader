const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
function apiHarness(fetch){
 const ctx={URL,AbortController,setTimeout,clearTimeout,TextDecoder,TextEncoder,SQCore:require('../js/core.js'),fetch};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../js/config.js'),'utf8'),ctx);
 ctx.AppConfig.save({lines:{line1:{baseUrl:'https://fixture.example/v1',apiKey:'fixture-only',model:'fixture'}}});return ctx.AppConfig;
}
test('R3 oversized advertised API responses cancel the body and are not blindly retried',async()=>{
 let calls=0,cancelled=0,read=0;
 const api=apiHarness(async()=>{calls++;return {status:200,ok:true,headers:{get:()=>String(5*1024*1024)},body:{cancel:async()=>{cancelled++;}},text:async()=>{read++;return '{}';}};});
 await assert.rejects(api.chat('line1',{}, {retries:3,retryBaseMs:0}),/4 MiB/);assert.equal(calls,1);assert.equal(cancelled,1);assert.equal(read,0);
});
test('R3 chunked API bodies have the same byte limit without Content-Length',async()=>{
 let calls=0,cancelled=0;
 const api=apiHarness(async()=>{calls++;return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(3*1024*1024));c.enqueue(new Uint8Array(3*1024*1024));},cancel(){cancelled++;}}),{status:200});});
 await assert.rejects(api.chat('line1',{}, {retries:3,retryBaseMs:0}),/4 MiB/);assert.equal(calls,1);assert.equal(cancelled,1);
});
test('R3 multibyte Chinese and emoji survive arbitrary response chunk boundaries',async()=>{
 const content='{"answer":"物理🌟"}',bytes=new TextEncoder().encode(JSON.stringify({choices:[{message:{content}}]}));
 const api=apiHarness(async()=>new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=2)c.enqueue(bytes.slice(i,i+2));c.close();}})));
 const result=await api.chat('line1',{});assert.equal(result.choices[0].message.content,content);
});
test('R3 valid JSON from a wrong API product gets a protocol-specific diagnostic',async()=>{
 const api=apiHarness(async()=>Response.json({output:[{text:'wrong endpoint'}]}));
 await assert.rejects(api.chat('line1',{}),/Chat Completions/);
});
