/** Optional, billable live vision check. Never writes or prints API credentials. */
const { chromium } = require('playwright');
const { browserOptions } = require('./browser-fixtures.cjs');
global.SQCore = require('../js/core.js');
const config = require('../js/config.js');
(async () => {
    if (!process.env.SQ_API_KEY) throw new Error('Set SQ_API_KEY in the process environment; do not put it in source code.');
    const browser = await chromium.launch(browserOptions());
    let image;
    try {
        const page = await browser.newPage();
        image = await page.evaluate(() => {
            const c = document.createElement('canvas'); c.width=400; c.height=160;
            const ctx = c.getContext('2d'); ctx.fillStyle='white'; ctx.fillRect(0,0,400,160); ctx.fillStyle='black'; ctx.font='64px sans-serif'; ctx.fillText('6 N',50,100);
            return c.toDataURL('image/png');
        });
    } finally { await browser.close(); }
    config.save({ lines:{ line1:{ baseUrl: process.env.SQ_API_BASE || 'https://www.wangshu-api.com/v1', model:process.env.SQ_API_MODEL || 'gpt-6.1-sol', apiKey:process.env.SQ_API_KEY } } });
    const data = await config.chat('line1', { messages:[{ role:'user', content:[{ type:'text', text:'Read the value and unit in the image. Return JSON with a single string property answer.' }, { type:'image_url', image_url:{ url:image } }] }], max_tokens:256, response_format:{type:'json_object'} }, { retries:0 });
    const parsed = SQCore.safeParseJSON(data.choices?.[0]?.message?.content, data);
    if (String(parsed.answer).replace(/\s/g,'').toLowerCase() !== '6n') throw new Error('Vision response did not match the fixture.');
    console.log('Live vision check passed: image + Chat Completions + JSON; fixture read correctly.');
})().catch(error => { console.error(String(error.message).replaceAll(process.env.SQ_API_KEY || '\0', '[redacted]')); process.exitCode=1; });
