const test = require('node:test');
const assert = require('node:assert/strict');

class MemoryStorage {
    constructor() { this.data = new Map(); }
    getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
    setItem(key, value) { this.data.set(key, String(value)); }
    removeItem(key) { this.data.delete(key); }
    clear() { this.data.clear(); }
}

global.localStorage = new MemoryStorage();
global.sessionStorage = new MemoryStorage();
global.SQCore = require('../js/core.js');
const AppConfig = require('../js/config.js');

test.beforeEach(() => {
    global.localStorage.clear();
    global.sessionStorage.clear();
});

function configured(rememberKeys = false) {
    return {
        lines: {
            line1: { label: 'vision', baseUrl: 'https://api.example.test/v1', apiKey: 'secret-1', model: 'vision-model' },
            line2: { label: 'backup', baseUrl: '', apiKey: '', model: '' },
            deepseek: { label: 'text', baseUrl: '', apiKey: '', model: '' }
        }, proxyUrl: '', rememberKeys
    };
}

test('API keys default to sessionStorage and are omitted from localStorage', () => {
    AppConfig.save(configured(false));
    assert.match(global.sessionStorage.getItem('sq_grader_session_keys_v1'), /secret-1/);
    assert.doesNotMatch(global.localStorage.getItem('sq_grader_config_v2'), /secret-1/);
    assert.equal(AppConfig.load().lines.line1.apiKey, 'secret-1');
});

test('persistent key storage requires explicit opt-in', () => {
    AppConfig.save(configured(true));
    assert.match(global.localStorage.getItem('sq_grader_config_v2'), /secret-1/);
});

test('legacy localStorage secrets migrate to the current session and are scrubbed', () => {
    global.localStorage.setItem('sq_grader_config_v1', JSON.stringify(configured(false)));
    const loaded = AppConfig.load();
    assert.equal(loaded.lines.line1.apiKey, 'secret-1');
    assert.equal(global.localStorage.getItem('sq_grader_config_v1'), null);
    assert.doesNotMatch(global.localStorage.getItem('sq_grader_config_v2'), /secret-1/);
});

test('chat retries 429, honors bounded policy, and sends configured model', async () => {
    AppConfig.save(configured(false));
    let calls = 0;
    global.fetch = async (url, options) => {
        calls++;
        assert.equal(url, 'https://api.example.test/v1/chat/completions');
        assert.equal(options.headers.Authorization, 'Bearer secret-1');
        assert.equal(JSON.parse(options.body).model, 'vision-model');
        if (calls === 1) return new Response('limited', { status: 429, headers: { 'Retry-After': '0' } });
        return Response.json({ choices: [{ message: { content: '{}' } }] });
    };
    const result = await AppConfig.chat('line1', { messages: [] }, { retries: 1, retryBaseMs: 0 });
    assert.equal(calls, 2);
    assert.ok(result.choices);
});

test('chat does not retry a non-retryable 400 response', async () => {
    AppConfig.save(configured(false));
    let calls = 0;
    global.fetch = async () => { calls++; return new Response('bad request', { status: 400 }); };
    await assert.rejects(AppConfig.chat('line1', { messages: [] }, { retries: 3, retryBaseMs: 0 }), /400/);
    assert.equal(calls, 1);
});

test('chat respects cancellation before the request starts', async () => {
    AppConfig.save(configured(false));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(AppConfig.chat('line1', { messages: [] }, { signal: controller.signal }), error => error.name === 'AbortError');
});
