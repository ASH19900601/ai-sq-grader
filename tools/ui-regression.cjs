/** Browser checks for layout, accessibility and startup recovery; no API requests. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { createServer, browserOptions } = require('./browser-fixtures.cjs');
(async () => {
    const server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch(browserOptions());
    const page = await browser.newPage({ viewport:{ width:320, height:800 } });
    const url = `http://127.0.0.1:${server.address().port}`;
    const checks = [];
    try {
        await page.goto(url);
        await page.waitForSelector('#settingsModal', { state:'visible' });
        assert.equal(await page.locator('#settingsModal input').evaluateAll(inputs => inputs.filter(input => input.type !== 'checkbox' && !input.labels.length).length), 0);
        const key = page.getByLabel('API Key', { exact:true }); assert.equal(await key.count(), 3);
        checks.push('all configuration inputs have associated labels and accessible names');
        assert.equal(await page.locator('body').evaluate(body => getComputedStyle(body).overflow), 'hidden');
        assert.equal(await page.locator('.modal-content').evaluate(element => getComputedStyle(element).overscrollBehavior), 'contain');
        checks.push('settings modal prevents background scroll from leaking at its boundaries');
        await page.click('#cfgCancelBtn');
        await page.locator('#manualQpInput').focus();
        assert.equal(await page.locator('[for="manualQpInput"]').evaluate(label => getComputedStyle(label).outlineWidth), '3px');
        checks.push('manual PDF keyboard focus is visibly indicated');
        await page.emulateMedia({ media:'print' });
        assert.equal(await page.locator('#sectionResults').isVisible(), false);
        assert.equal(await page.locator('.print-empty-state').isVisible(), true);
        checks.push('printing before grading does not fabricate an empty report');
        await page.emulateMedia({ media:'screen', reducedMotion:'reduce' });
        const duration = await page.locator('#progressBarFill').evaluate(element => parseFloat(getComputedStyle(element).transitionDuration));
        assert.ok(duration < .01);
        checks.push('reduced-motion preference disables progress animation');
        await page.evaluate(() => {
            document.querySelector('#sectionResults').style.display='block';
            document.querySelector('#resultsContainer').innerHTML = `<div class="question-card"><div class="question-body"><div class="student-answer-box">${'longanswer'.repeat(100)}</div><div class="mark-point-row"><div class="mp-description">${'longmark'.repeat(100)}</div><div class="mp-status">status</div><div class="mp-reason">reason</div></div></div></div>`;
        });
        for (const selector of ['.student-answer-box','.mp-description']) {
            assert.ok(await page.locator(selector).evaluate(element => element.scrollWidth <= element.clientWidth+1), selector);
        }
        checks.push('long OCR fragments and point IDs wrap without clipping');
        await page.evaluate(() => { const image=document.createElement('img'); document.querySelector('#imgPreviewArea').append(image); });
        assert.equal(await page.locator('#imgPreviewArea img').evaluate(image => getComputedStyle(image).objectFit), 'contain');
        checks.push('answer previews preserve the complete image rather than cropping');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        checks.push('320px viewport has no horizontal overflow');
        await page.route('**/vendor/pdfjs/pdf.min.mjs', route => route.abort());
        await page.reload();
        await page.waitForSelector('#retryStartupBtn', { state:'visible' });
        assert.match(await page.locator('#startupMessage').textContent(), /加载失败/);
        await page.unroute('**/vendor/pdfjs/pdf.min.mjs');
        await page.click('#retryStartupBtn');
        await page.waitForSelector('#settingsModal', { state:'visible' });
        assert.equal(await page.locator('#startupStatus').isVisible(), false);
        checks.push('missing PDF module shows a recoverable error and reload successfully recovers');
        const noScript = await browser.newPage({ javaScriptEnabled:false });
        await noScript.goto(url);
        assert.match(await noScript.locator('noscript').textContent(), /需要 JavaScript/);
        await noScript.close();
        checks.push('JavaScript-disabled browser receives an explicit explanation');
        console.log(JSON.stringify({ browser:'Chromium', checks },null,2));
    } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
