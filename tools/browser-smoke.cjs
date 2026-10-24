/** Actual Chromium/PDF.js pipeline with deterministic API fixtures. No credentials required. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { pdf, createServer, browserOptions } = require('./browser-fixtures.cjs');
const server = createServer();

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch(browserOptions());
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    let gradeCalls = 0, calls = 0, gradingMode = 'normal';
    await page.route('https://fixture.example/v1/chat/completions', async route => {
        calls++;
        const body = route.request().postDataJSON();
        const content = body.messages[0].content;
        const text = content[0].text;
        let result;
        if (text.includes('完整提取这些 Mark Scheme')) result = { general_rules: ['Accept equivalent units'], questions: [{ q_num: '1(a)', total_marks: 1, mark_points: [{ point_id: '1a-B1', description: 'Force = 6 N', marks: 1 }] }, { q_num: '1(b)', total_marks: 1, mark_points: [{ point_id: '1b-B1', description: 'Acceleration = 2', marks: 1 }] }] };
        else if (text.includes('提取这张 CAIE')) result = { questions: [{ q_num: '1(a)', question_text: 'Calculate force' }, { q_num: '1(b)', question_text: 'Calculate acceleration' }] };
        else if (text.includes('手写答卷 OCR')) result = { answers: [{ q_num: '1(a)', answer_text: '6 N', confidence: 'high' }, { q_num: '1(b)', answer_text: '2', confidence: 'high' }] };
        else {
            gradeCalls++;
            assert.ok(content.filter(item => item.type === 'image_url').length >= 2, 'original QP and answer images must reach final grader');
            assert.ok(text.includes('Accept equivalent units'));
            if (gradingMode === 'cancel') { await new Promise(resolve => setTimeout(resolve, 1500)); }
            if (gradeCalls === 2) { await route.fulfill({ status: 400, contentType: 'application/json', body:'{"error":"fixture failure"}' }); return; }
            result = { results: [{ point_id: text.includes('【题号】1(a)') ? '1a-B1' : '1b-B1', status: '明确正确', reason: '符合评分点' }] };
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices:[{ finish_reason:'stop', message:{ content: JSON.stringify(result) } }] }) });
    });
    try {
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.locator('[data-line="line1"] [data-field="baseUrl"]').fill('https://fixture.example/v1');
        await page.locator('[data-line="line1"] [data-field="apiKey"]').fill('fixture-only-not-a-secret');
        await page.locator('[data-line="line1"] [data-field="model"]').fill('gpt-6.1-sol');
        await page.click('#cfgSaveBtn');
        await page.click('#confirmPaperBtn');
        const upload = { name: 'fixture.pdf', mimeType:'application/pdf', buffer:pdf('1(a) Calculate the force using the diagram. 1(b) Calculate acceleration.') };
        await page.setInputFiles('#manualMsInput', upload);
        await page.setInputFiles('#manualQpInput', upload);
        await page.setInputFiles('#pdfInput', upload);
        await page.waitForFunction(() => !document.getElementById('startGradingBtn').disabled);
        await page.click('#startGradingBtn');
        await page.waitForFunction(() => document.getElementById('sectionResults').style.display === 'block');
        assert.equal(await page.locator('#scoreRate').textContent(), '-');
        assert.equal(await page.locator('.question-card.incomplete').count(), 1);
        await page.waitForFunction(() => !document.getElementById('retryFailedBtn').disabled);
        await page.click('#retryFailedBtn');
        await page.waitForFunction(() => document.getElementById('scoreRate').textContent === '100%');
        assert.equal(gradeCalls, 3, 'retry only failed question');
        const downloadEvent = page.waitForEvent('download'); await page.click('#exportReportBtn');
        const download = await downloadEvent;
        const report = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
        assert.equal(report.summary.totalGot, 2);
        assert.equal(report.questions.length, 2);
        assert.ok(!JSON.stringify(report).includes('fixture-only-not-a-secret'));
        // Reusing the same manual PDFs must work: PDF.js must not detach retained buffers.
        await page.click('#startGradingBtn');
        await page.waitForFunction(() => document.getElementById('progressTitle').textContent === '完成');
        assert.equal(await page.locator('#scoreRate').textContent(), '100%');
        gradingMode = 'cancel';
        await page.click('#startGradingBtn');
        await page.waitForFunction(() => document.getElementById('progressTitle').textContent.includes('逐题判分'));
        await page.click('#cancelGradingBtn');
        await page.waitForFunction(() => document.getElementById('progressTitle').textContent === '已取消');
        assert.equal(await page.locator('#sectionResults').isVisible(), true);
        assert.equal(await page.locator('#scoreRate').textContent(), '100%');
        assert.equal(await page.locator('#reportRetentionNotice').isVisible(), true);
        await page.selectOption('#eg-year', '2025');
        assert.equal(await page.locator('#startGradingBtn').isDisabled(), true);
        assert.equal(await page.locator('#manualMsInput').inputValue(), '');
        await page.click('#confirmPaperBtn');
        // Exercise actual image decoding and supported photo upload as well.
        const png = await page.evaluate(() => { const c = document.createElement('canvas'); c.width=300; c.height=400; c.getContext('2d').fillText('6 N',20,20); return c.toDataURL('image/png').split(',')[1]; });
        await page.click('#tabImages');
        await page.setInputFiles('#imgInput', { name:'answer.png', mimeType:'image/png', buffer:Buffer.from(png,'base64') });
        await page.waitForFunction(() => document.querySelectorAll('#imgPreviewArea img').length === 1);
        await page.setViewportSize({ width:390, height:844 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow on mobile');
        // A delayed upload from the old paper must never restore its buffer.
        await page.evaluate(() => { const original=File.prototype.arrayBuffer; File.prototype.arrayBuffer=async function() { await new Promise(r => setTimeout(r,150)); return original.call(this); }; });
        await page.setInputFiles('#manualQpInput',upload);
        await page.selectOption('#eg-year','2024');
        await page.waitForTimeout(300);
        assert.equal(await page.locator('#manualQpStatus').textContent(),'点击或拖入 QP PDF 文件');
        assert.equal(await page.locator('#startGradingBtn').isDisabled(),true);
        fs.mkdirSync(path.join(root,'artifacts'), { recursive:true });
        await page.screenshot({ path:path.join(root,'artifacts/mobile-smoke.png'), fullPage:true });
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ browser:'Chromium', checks:['real PDF worker and vector rendering','full pipeline','failure warning','targeted retry','JSON export without credentials','repeat grading','cancel preserves clearly labelled prior report','paper reset','photo decoding','mobile layout','stale upload invalidation', 'no browser exceptions'], apiFixtureRequests:calls, gradeCalls }, null, 2));
    } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode=1; server.close(); });
