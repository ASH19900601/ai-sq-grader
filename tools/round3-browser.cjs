/** Two-page OCR/QP and recovery regression, using actual Chromium/PDF.js with API fixtures. */
const {chromium}=require('playwright');
const {multiPagePdf,createServer,browserOptions}=require('./browser-fixtures.cjs');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
(async()=>{
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch(browserOptions());
 const page=await browser.newPage({reducedMotion:'reduce',acceptDownloads:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let calls=0,qp=0,ocr=0,failMS=false,holdQP=false;
 await page.route('https://fixture.example/v1/chat/completions',async route=>{
  calls++;const body=route.request().postDataJSON(),content=body.messages[0].content,text=content[0].text;let result;
  if(text.includes('完整提取这些 Mark Scheme')){
   if(failMS){await route.fulfill({status:400,body:'{"error":"fixture MS failure"}'});return;}
   result={general_rules:[],questions:[{q_num:'1(a)(i)',total_marks:1,mark_points:[{point_id:'B1',description:'Force = 6 N',marks:1}]}]};
  }else if(text.includes('提取这张 CAIE')){
   const index=qp++;
   if(holdQP)await new Promise(r=>setTimeout(r,700));else await new Promise(r=>setTimeout(r,index%2?5:80));
   result={questions:[{q_num:index%2?'1(a)(i)':'1(a)',question_text:index%2?'Calculate the force.':'Mass = 2 kg, acceleration = 3 m/s2.'}]};
  }else if(text.includes('手写答卷 OCR')){
   const index=ocr++;result={answers:[{q_num:index%2?'1(a)(i)':'1(a)',answer_text:index%2?'= 6 N':'F = ma',confidence:'high',source_pages:[index%2?0:1]}]};
  }else{
   assert.match(text,/F = ma/);assert.match(text,/6 N/);assert.equal(content.filter(x=>x.type==='image_url').length,4,'two QP and two student pages must reach final grading');
   result={results:[{point_id:' B1 ',status:'明确正确',reason:'both pages support answer'}]};
  }
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]})}).catch(()=>{});
 });
 try{
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  assert.equal(await page.locator('main').evaluate(e=>e.inert),true);
  await page.evaluate(()=>document.getElementById('eg-year').focus());assert.equal(await page.evaluate(()=>!!document.activeElement.closest('#settingsModal')),true);
  await page.locator('[data-line="line1"] [data-field="baseUrl"]').fill('https://fixture.example/v1');await page.locator('[data-line="line1"] [data-field="apiKey"]').fill('fixture-only');await page.click('#cfgSaveBtn');
  assert.equal(await page.locator('main').evaluate(e=>e.inert),false);await page.click('#confirmPaperBtn');
  const ms={name:'MS.pdf',mimeType:'application/pdf',buffer:multiPagePdf(['1(a)(i) Total marks: 1. B1 F = ma = 6 N. Accept equivalent working.'])};
  const paper={name:'QP.pdf',mimeType:'application/pdf',buffer:multiPagePdf(['1(a) A 2 kg body accelerates at 3 m/s2. Use this data in both parts.','1(a)(i) Calculate force. Show all working in your answer. [1]'])};
  const answer={name:'two-page-answer.pdf',mimeType:'application/pdf',buffer:multiPagePdf(['1(a) F = ma. The calculation continues on the next page.','1(a)(i) = 2 x 3 = 6 N. This completes the calculation.'])};
  await page.setInputFiles('#manualMsInput',ms);await page.setInputFiles('#manualQpInput',paper);await page.setInputFiles('#pdfInput',answer);
  await page.waitForFunction(()=>!document.getElementById('startGradingBtn').disabled);
  await page.evaluate(()=>{Element.prototype.scrollIntoView=function(options){window.lastScrollBehavior=options.behavior;};});
  await page.click('#startGradingBtn');await page.waitForFunction(()=>document.getElementById('progressTitle').textContent==='完成');
  assert.equal(await page.locator('#scoreRate').textContent(),'100%');assert.equal(await page.locator('#maxScore').textContent(),'1');
  assert.equal(await page.evaluate(()=>window.lastScrollBehavior),'auto');assert.match(await page.locator('#answerSourceInfo').textContent(),/two-page-answer.pdf.*2 页/);
  const originalCalls=calls;assert.equal(originalCalls,6);
  fs.mkdirSync(path.resolve(__dirname,'../artifacts'),{recursive:true});await page.locator('#sectionResults').screenshot({path:path.resolve(__dirname,'../artifacts/round3-report.png')});
  await page.check('#eg-use-deepseek');await page.click('#startGradingBtn');
  await page.waitForFunction(()=>document.getElementById('progressTitle').textContent.includes('批改失败'));
  assert.equal(calls,originalCalls,'unconfigured text-only DeepSeek must not invoke the vision service');assert.equal(await page.locator('#scoreRate').textContent(),'100%');assert.equal(await page.locator('#reportRetentionNotice').isVisible(),true);assert.match(await page.locator('#progressLog').textContent(),/DeepSeek.*配置/);
  await page.uncheck('#eg-use-deepseek');failMS=true;await page.click('#startGradingBtn');await page.waitForFunction(()=>document.getElementById('progressLog').textContent.includes('fixture MS failure'));
  assert.equal(await page.locator('#sectionResults').isVisible(),true);assert.equal(await page.locator('#scoreRate').textContent(),'100%');
  const downloaded=page.waitForEvent('download');await page.click('#exportReportBtn');const report=JSON.parse(fs.readFileSync(await(await downloaded).path(),'utf8'));assert.equal(report.summary.totalGot,1);assert.equal(report.retained_after_failure.outcome,'failed');
  failMS=false;holdQP=true;await page.click('#startGradingBtn');await page.waitForFunction(()=>document.getElementById('progressTitle').textContent.includes('QP 题干'));await page.click('#cancelGradingBtn');await page.waitForFunction(()=>document.getElementById('progressTitle').textContent==='已取消');
  assert.equal(await page.locator('#sectionResults').isVisible(),true);assert.equal(await page.locator('#reportRetentionNotice').isVisible(),true);
  // Switching answer sources must clear the inactive native input, permitting same-file reselection.
  await page.click('#tabImages');const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=40;c.height=40;return c.toDataURL().split(',')[1];});
  await page.setInputFiles('#imgInput',{name:'photo.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});await page.waitForFunction(()=>document.getElementById('answerSourceInfo').textContent.includes('photo.png'));
  assert.equal(await page.locator('#pdfInput').inputValue(),'');await page.click('#tabPdf');await page.setInputFiles('#pdfInput',answer);await page.waitForFunction(()=>document.getElementById('answerSourceInfo').textContent.includes('two-page-answer.pdf'));assert.equal(await page.locator('#imgInput').inputValue(),'');
  await page.evaluate(data=>{const dt=new DataTransfer();const bytes=Uint8Array.from(atob(data),c=>c.charCodeAt(0));dt.items.add(new File([bytes],'one.pdf',{type:'application/pdf'}));dt.items.add(new File([bytes],'two.pdf',{type:'application/pdf'}));const input=document.getElementById('manualQpInput');input.files=dt.files;input.dispatchEvent(new Event('change'));},paper.buffer.toString('base64'));
  await page.waitForFunction(()=>document.getElementById('manualQpStatus').textContent.includes('一次只能上传一份'));assert.equal(await page.locator('#startGradingBtn').isDisabled(),true);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({checks:['actual two-page PDF.js rendering','out-of-order page completion stays ordered','OCR page provenance overrides hallucinated metadata','parent/child continuation images reach final grader','padded point ID accepted','failed full rerun retains report and exports provenance','cancelled full rerun retains report','DeepSeek missing config avoids silent paid fallback','reduced-motion JS scrolling','modal background is inert','cross-source same-file reselection','multi-PDF drop rejected explicitly','no page errors'],firstRunRequests:originalCalls},null,2));
 }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
