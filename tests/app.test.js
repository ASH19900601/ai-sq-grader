const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SQCore = require('../js/core.js');

const root = path.resolve(__dirname, '..');

function appContext(page) {
    const context = {
        console,
        Option: function Option(text, value) { this.text = text; this.value = value; },
        DOMException,
        AbortController,
        setTimeout,
        clearTimeout,
        SQCore,
        AppConfig: {},
        document: {
            readyState: 'loading',
            addEventListener() {},
            getElementById() { return null; },
            querySelectorAll() { return []; },
            createElement(tag) {
                assert.equal(tag, 'canvas');
                return { width: 0, height: 0, getContext() { return {}; }, toDataURL() { return 'data:image/jpeg;base64,scan'; } };
            }
        },
        pdfjsLib: {
            GlobalWorkerOptions: {},
            OPS: { paintImageXObject: 1, paintJpegXObject: 2, paintInlineImageXObject: 3 },
            getDocument() { return { promise: Promise.resolve({ numPages: 1, getPage: async () => page }) }; }
        }
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(root, 'js/app.js'), 'utf8'), context, { filename: 'app.js' });
    return context;
}

function mockPage(text, operations) {
    return {
        async getTextContent() { return { items: text ? [{ str: text }] : [] }; },
        async getOperatorList() { return { fnArray: operations }; },
        getViewport() { return { width: 600, height: 800 }; },
        render() { return { promise: Promise.resolve() }; }
    };
}

test('actual PDF pipeline renders a scan-only page instead of dropping it', async () => {
    const context = appContext(mockPage('', [1]));
    const pages = await context.pdfToHybrid(new ArrayBuffer(4), 1.5, false, 'scan');
    assert.equal(pages.length, 1);
    assert.equal(pages[0].type, 'image');
    const answerPages = await context.pdfToAnswerImages(new ArrayBuffer(4), 1.5);
    assert.equal(answerPages.length, 1);
    assert.equal(answerPages[0].type, 'image');
});

test('actual PDF pipeline still removes a clearly labelled text-only blank page', async () => {
    const context = appContext(mockPage('BLANK PAGE', []));
    const pages = await context.pdfToHybrid(new ArrayBuffer(4), 1.5, false, 'blank');
    assert.equal(pages.length, 0);
});

test('HTML uses bundled scripts, includes QP upload and has no inline onclick handlers', () => {
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    assert.match(html, /id="manualQpInput"/);
    assert.match(html, /js\/bootstrap\.js/);
    assert.match(html, /Content-Security-Policy/);
    assert.doesNotMatch(html, /<script[^>]+https?:\/\//i);
    assert.doesNotMatch(html, /onclick=/i);
});

test('all locally referenced vendor assets exist', () => {
    for (const file of [
        'vendor/pdfjs/pdf.min.mjs', 'vendor/pdfjs/pdf.worker.min.mjs',
        'vendor/fontawesome/css/all.min.css', 'vendor/fontawesome/webfonts/fa-solid-900.woff2'
    ]) assert.equal(fs.existsSync(path.join(root, file)), true, file);
});

test('proxy example revalidates redirects and omits wildcard CORS/followlocation', () => {
    const php = fs.readFileSync(path.join(root, 'proxy.example.php'), 'utf8');
    assert.match(php, /Only HTTPS URLs are allowed/);
    assert.match(php, /FILTER_FLAG_NO_PRIV_RANGE/);
    assert.match(php, /PDF exceeds size limit/);
    assert.match(php, /SQ_PROXY_RATE_LIMIT/);
    assert.doesNotMatch(php, /Access-Control-Allow-Origin:\s*\*/);
    assert.doesNotMatch(php, /CURLOPT_FOLLOWLOCATION\s*=>\s*true/);
});

test('question 1 never accidentally matches question 10', () => {
    const context = appContext(mockPage('', []));
    const found = context.contextForQuestion('1', { '10': { question_text: 'wrong', source_pages:[1] }, '1(a)':{ question_text:'right', source_pages:[0] } });
    assert.equal(found.question_text, 'right');
});
test('text-mode QP retains its original rendered page for final vision grading', async () => {
    const context = appContext(mockPage('Complete question paper text '.repeat(5), []));
    const pages = await context.pdfToHybrid(new ArrayBuffer(10));
    assert.equal(pages[0].type,'text');
    assert.equal(pages[0].imageContent, 'data:image/jpeg;base64,scan');
});
test('PDF.js receives an isolated buffer and evaluation is disabled', async () => {
    const context = appContext(mockPage('', []));
    const buffer = new ArrayBuffer(10);
    context.pdfjsLib.getDocument = options => {
        assert.notEqual(options.data, buffer);
        assert.equal(options.isEvalSupported,false);
        return { promise:Promise.resolve({ numPages:0, destroy:async () => {} }) };
    };
    await context.pdfToHybrid(buffer);
    assert.equal(buffer.byteLength,10);
});
