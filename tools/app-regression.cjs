/** Regression checks using real UI/PDF worker; all model responses are fixtures. */
const {chromium}=require('playwright');
const {pdf,createServer,browserOptions}=require('./browser-fixtures.cjs');
const assert=require('node:assert/strict');
const fs=require('node:fs');
(async()=>{
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch(browserOptions());const page=await browser.newPage({acceptDownloads:true});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));let calls=0,failQP=false;
 await page.route('https://fixture.example/v1/chat/completions',async route=>{
  calls++;const content=route.request().postDataJSON().messages[0].content;const text=content[0].text;let result;
  if(text.includes('完整提取这些 Mark Scheme'))result={general_rules:[],questions:[{q_num:'1(a)',total_marks:1,mark_points:[{point_id:'B1',description:'6 N',marks:1}]}]};
  else if(text.includes('提取这张 CAIE') && failQP){await route.fulfill({status:400,contentType:'application/json',body:'{"error":"fixture QP failure"}'});return;}
  else if(text.includes('提取这张 CAIE'))result={questions:[{q_num:'1(a)',question_text:'Calculate the force.'}]};
  else if(text.includes('手写答卷 OCR'))result={answers:[]}; // Valid OCR of a genuinely blank answer.
  else {assert.equal(content.filter(x=>x.type==='image_url').length,2);result={results:[{point_id:'B1',status:'错误',reason:'未作答'}]};}
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]})});
 });
 try{
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('[data-line="line1"] [data-field="baseUrl"]').fill('https://fixture.example/v1');
  await page.locator('[data-line="line1"] [data-field="apiKey"]').fill('fixture-not-a-real-key');await page.click('#cfgSaveBtn');
  const upload={name:'paper.pdf',mimeType:'application/pdf',buffer:pdf('1(a) Calculate force using a mass of 2 kg and acceleration 3 m/s^2. [1]')};
  // Pre-confirmation upload race: previous regression covered only already-confirmed selection.
  await page.evaluate(()=>{const original=File.prototype.arrayBuffer;window.restoreArrayBuffer=()=>{File.prototype.arrayBuffer=original;};File.prototype.arrayBuffer=async function(){await new Promise(r=>setTimeout(r,150));return original.call(this);};});
  await page.setInputFiles('#manualMsInput',upload);await page.selectOption('#eg-year','2025');await page.waitForTimeout(250);
  assert.equal(await page.locator('#manualMsStatus').textContent(),'点击或拖入 MS PDF 文件');await page.evaluate(()=>window.restoreArrayBuffer());
  await page.click('#confirmPaperBtn');
  await page.setInputFiles('#pdfInput',upload);await page.waitForFunction(()=>document.getElementById('pdfPreviewInfo').textContent.includes('已加载'));
  assert.equal(await page.locator('#startGradingBtn').isDisabled(),true);assert.match(await page.locator('#startHint').textContent(),/QP 和 MS/);
  // Invalid file selection must reset native input value so choosing the same file can fire change again.
  await page.setInputFiles('#manualMsInput',{name:'broken.pdf',mimeType:'application/pdf',buffer:Buffer.from('not a PDF')});
  await page.waitForFunction(()=>document.getElementById('manualMsStatus').textContent.includes('❌'));
  assert.equal(await page.locator('#manualMsInput').inputValue(),'');
  await page.setInputFiles('#manualMsInput',upload);await page.setInputFiles('#manualQpInput',upload);
  await page.waitForFunction(()=>!document.getElementById('startGradingBtn').disabled);
  await page.locator('#tabPdf').focus();await page.keyboard.press('ArrowRight');assert.equal(await page.locator('#tabImages').getAttribute('aria-selected'),'true');
  await page.keyboard.press('Home');assert.equal(await page.locator('#tabPdf').getAttribute('aria-selected'),'true');
  await page.click('#startGradingBtn');await page.waitForFunction(()=>document.getElementById('sectionResults').style.display==='block');
  assert.equal(await page.locator('#totalScore').textContent(),'0');assert.equal(await page.locator('#scoreRate').textContent(),'0%');assert.equal(calls,4);
  const header=page.locator('.question-header');await header.click();assert.equal(await header.getAttribute('aria-expanded'),'false');await header.click();assert.equal(await header.getAttribute('aria-expanded'),'true');
  async function report(){const pending=page.waitForEvent('download');await page.click('#exportReportBtn');return JSON.parse(fs.readFileSync(await(await pending).path(),'utf8'));}
  const a=await report(),b=await report();assert.ok(a.created_at);assert.equal(a.created_at,b.created_at);assert.equal(a.questions[0].point_results[0].status,'错误');
  await page.click('#settingsBtn');await page.click('#cfgClearBtn');assert.equal(await page.locator('#startGradingBtn').isDisabled(),true);assert.match(await page.locator('#startHint').textContent(),/AI 视觉线路/);
  assert.equal(await page.locator('[data-line="line1"] [data-field="apiKey"]').inputValue(),'');await page.click('#cfgCancelBtn');
  // Internal abort for a failed parsing phase must retain the actionable error.
  await page.click('#settingsBtn');
  await page.locator('[data-line="line1"] [data-field="apiKey"]').fill('fixture-not-a-real-key');
  await page.click('#cfgSaveBtn');failQP=true;await page.click('#startGradingBtn');
  await page.waitForFunction(()=>document.getElementById('progressTitle').textContent==='批改失败；未生成不完整报告');
  assert.match(await page.locator('#progressLog').textContent(),/fixture QP failure/);
  assert.equal(await page.locator('#sectionResults').isVisible(),true);
  assert.equal(await page.locator('#scoreRate').textContent(),'0%');
  assert.equal(await page.locator('#reportRetentionNotice').isVisible(),true);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({checks:['pre-confirmation stale upload','missing-paper preflight','same-file retry after rejection','keyboard upload tabs','valid empty OCR proceeds using originals','blank answer yields complete 0%','accessible report disclosure','stable export assessment time','forget credentials disables grading','parsing failure preserves actual cause','no page errors'],requests:calls},null,2));
 }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
