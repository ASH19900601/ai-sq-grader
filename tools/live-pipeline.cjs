/** Optional billable, real-model pipeline. HTTP bridge uses Node's configured egress proxy. */
const { chromium } = require('playwright');
const { pdf, createServer, browserOptions } = require('./browser-fixtures.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
    const key=process.env.SQ_API_KEY;
    if (!key) throw new Error('SQ_API_KEY is required.');
    const base=process.env.SQ_API_BASE || 'https://www.wangshu-api.com/v1';
    const model=process.env.SQ_API_MODEL || 'gpt-6.1-sol';
    const endpoint=base.replace(/\/+$/,'')+'/chat/completions';
    const server=createServer(); await new Promise(r => server.listen(0,'127.0.0.1',r));
    const browser=await chromium.launch(browserOptions());
    const page=await browser.newPage({viewport:{width:1280,height:1000}});
    let requests=0;const errors=[];page.on('pageerror',e=>errors.push(e.message));
    try {
        await page.route(endpoint, async route => {
            try {
                requests++;
                const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:route.request().postData(),signal:AbortSignal.timeout(120000)});
                await route.fulfill({status:response.status,contentType:'application/json',body:await response.text()});
            } catch (_) { await route.fulfill({status:502,body:'{"error":"Live upstream unavailable"}'}).catch(()=>{}); }
        });
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.locator('[data-line="line1"] [data-field="baseUrl"]').fill(base);
        await page.locator('[data-line="line1"] [data-field="apiKey"]').fill(key);
        await page.locator('[data-line="line1"] [data-field="model"]').fill(model);
        await page.click('#cfgSaveBtn');await page.click('#confirmPaperBtn');
        const upload=text=>({name:'synthetic.pdf',mimeType:'application/pdf',buffer:pdf(text)});
        await page.setInputFiles('#manualQpInput',upload('1(a) Mass = 2 kg, acceleration = 3 m/s^2. Calculate force. [1]'));
        await page.setInputFiles('#manualMsInput',upload('1(a) Total marks: 1. B1: F = ma = 2 x 3 = 6 N. Accept 6N.'));
        const image=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=1000;c.height=400;const x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,1000,400);x.fillStyle='black';x.font='44px sans-serif';x.fillText('1(a) F = ma = 2 x 3 = 6 N',50,150);return c.toDataURL('image/png').split(',')[1];});
        await page.click('#tabImages');await page.setInputFiles('#imgInput',{name:'answer.png',mimeType:'image/png',buffer:Buffer.from(image,'base64')});
        await page.waitForFunction(()=>!document.getElementById('startGradingBtn').disabled);
        await page.click('#startGradingBtn');
        await page.waitForFunction(()=>['完成','批改失败；未生成不完整报告'].includes(document.getElementById('progressTitle').textContent),{},{timeout:300000});
        const log=(await page.locator('#progressLog').textContent()).replaceAll(key,'[redacted]');
        assert.equal(await page.locator('#progressTitle').textContent(),'完成',log);
        assert.equal(await page.locator('#scoreRate').textContent(),'100%',log);
        assert.equal(await page.locator('#totalScore').textContent(),'1');
        assert.equal(await page.locator('#maxScore').textContent(),'1');
        assert.deepEqual(errors,[]);
        const artifact=path.resolve(__dirname,'../artifacts');fs.mkdirSync(artifact,{recursive:true});
        await page.screenshot({path:path.join(artifact,'live-report.png'),fullPage:true});
        const evidence={model,requests,fixture:'Synthetic physics force question with one B1 mark; correct answer 6 N.',score:1,max:1,rate:'100%',transport:'Real Chromium UI and PDF.js; API POST bridged through Node environment egress proxy. Browser-to-provider CORS not established by bridge.',log};
        fs.writeFileSync(path.join(artifact,'live-validation.json'),JSON.stringify(evidence,null,2));
        console.log(JSON.stringify({...evidence,log:undefined},null,2));
    } finally {await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(String(e.message).replaceAll(process.env.SQ_API_KEY||'\0','[redacted]'));process.exitCode=1;});
