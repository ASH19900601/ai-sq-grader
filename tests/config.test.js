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

test('backup vision line alone is sufficient', () => {
    const cfg = configured(); cfg.lines.line2 = cfg.lines.line1; cfg.lines.line1 = {};
    AppConfig.save(cfg); assert.equal(AppConfig.isConfigured(), true);
});
test('remote HTTP and credential-bearing API URLs are rejected', async () => {
    for (const url of ['http://api.example.test/v1', 'https://user:pass@api.example.test/v1', 'https://api.example.test/v1?key=x']) {
        const cfg = configured(); cfg.lines.line1.baseUrl = url; AppConfig.save(cfg);
        await assert.rejects(AppConfig.chat('line1', {}), /HTTPS|不得含/);
    }
});
test('HTTP error text redacts the configured API key', async () => {
    AppConfig.save(configured());
    global.fetch = async () => new Response('secret-1 invalid', { status: 401 });
    await assert.rejects(AppConfig.chat('line1', {}), e => !e.message.includes('secret-1') && e.message.includes('[redacted]'));
});
test('cancellation remains active while reading a response body', async () => {
    AppConfig.save(configured()); const controller = new AbortController();
    global.fetch = async (url, options) => ({ ok: true, text: () => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
        setTimeout(() => controller.abort(), 5);
    }) });
    await assert.rejects(AppConfig.chat('line1', {}, { signal: controller.signal }), e => e.name === 'AbortError');
});
test('browser storage write failure falls back to memory', () => {
    const originalLocal = global.localStorage, originalSession = global.sessionStorage;
    const denied = { getItem:() => null, setItem:() => { throw new Error('quota'); }, removeItem:() => {} };
    try {
        global.localStorage=denied;global.sessionStorage=denied;
        AppConfig.save(configured());
        assert.equal(AppConfig.load().lines.line1.apiKey,'secret-1');
        assert.equal(AppConfig.isConfigured(),true);
    } finally { global.localStorage=originalLocal;global.sessionStorage=originalSession; }
});
test('proxy URL tokens default to session-only storage', () => {
    const cfg = configured(); cfg.proxyUrl='https://proxy.example/?token=private-proxy-token&url=';
    AppConfig.save(cfg);
    assert.doesNotMatch(global.localStorage.getItem('sq_grader_config_v2'),/private-proxy-token/);
    assert.equal(AppConfig.getProxyUrl(),cfg.proxyUrl);
});
test('previously persisted proxy tokens migrate out of default local storage', () => {
    const cfg = configured();cfg.proxyUrl='https://proxy.example/?token=old-proxy-token&url=';
    global.localStorage.setItem('sq_grader_config_v2',JSON.stringify(cfg));
    assert.equal(AppConfig.getProxyUrl(),cfg.proxyUrl);
    assert.doesNotMatch(global.localStorage.getItem('sq_grader_config_v2'),/old-proxy-token/);
});

test('new settings are never overwritten by an obsolete legacy configuration', () => {
    const latest = configured(); latest.lines.line1.model='new-model';
    AppConfig.save(latest);
    const old=configured();old.lines.line1.model='obsolete-model';
    global.localStorage.setItem('sq_grader_config_v1',JSON.stringify(old));
    assert.equal(AppConfig.load().lines.line1.model,'new-model');
    assert.equal(global.localStorage.getItem('sq_grader_config_v1'),null);
});

test('complete Chat Completions URLs and surrounding whitespace work without a duplicated path', async () => {
    const cfg=configured();cfg.lines.line1.baseUrl=' https://API.EXAMPLE.TEST/v1/chat/completions/ ';
    AppConfig.save(cfg);
    global.fetch=async (url,options)=>{
        assert.equal(url,'https://api.example.test/v1/chat/completions');
        assert.equal(options.redirect,'error');
        return Response.json({choices:[{message:{content:'{}'}}]});
    };
    await AppConfig.chat('line1',{});
});

test('invalid endpoint configuration never advertises a usable vision line', () => {
    const cfg=configured();cfg.lines.line1.baseUrl='https://';AppConfig.save(cfg);
    assert.equal(AppConfig.isConfigured(),false);
    assert.deepEqual(AppConfig.availableVisionLines(),[]);
});

test('an unknown route cannot silently send requests through the default provider', async () => {
    AppConfig.save(configured());let called=false;global.fetch=async()=>{called=true;};
    await assert.rejects(AppConfig.chat('line-does-not-exist',{}),/线路不存在/);
    assert.equal(called,false);
});

test('forget credentials clears both storage scopes and the proxy without deleting model or URL settings', () => {
    const cfg=configured(true);cfg.proxyUrl='https://proxy.example/?token=private&url=';
    AppConfig.save(cfg);AppConfig.clearSecrets();
    assert.equal(AppConfig.load().lines.line1.apiKey,'');
    assert.equal(AppConfig.load().lines.line1.baseUrl,cfg.lines.line1.baseUrl);
    assert.equal(AppConfig.load().lines.line1.model,cfg.lines.line1.model);
    assert.equal(AppConfig.getProxyUrl(),'');
    assert.equal(AppConfig.load().rememberKeys,false);
    for (const storage of [global.localStorage,global.sessionStorage]) {
        for (const value of storage.data.values()) assert.doesNotMatch(value,/secret-1|token=private/);
    }
});

test('an explicitly cleared session credential never resurrects a remembered credential', () => {
    AppConfig.save(configured(true));
    global.sessionStorage.setItem('sq_grader_session_keys_v1',JSON.stringify({line1:'',proxyUrl:''}));
    assert.equal(AppConfig.load().lines.line1.apiKey,'');
});

test('nonfinite timeout options do not become an immediate timeout', async () => {
    AppConfig.save(configured());
    const original=global.setTimeout;const delays=[];
    global.setTimeout=(fn,delay,...args)=>{delays.push(delay);return original(fn,delay,...args);};
    global.fetch=async()=>Response.json({choices:[{message:{content:'{}'}}]});
    try { await AppConfig.chat('line1',{}, {timeoutMs:Infinity,retryBaseMs:NaN}); }
    finally {global.setTimeout=original;}
    assert.equal(delays[0],60000);
});

test('HTTP-200 provider error envelopes display the real error without leaking the configured key', async () => {
    AppConfig.save(configured());
    global.fetch=async()=>Response.json({error:{message:'quota exhausted secret-1'}});
    await assert.rejects(AppConfig.chat('line1',{}),e=>/quota exhausted/.test(e.message)&&!e.message.includes('secret-1'));
});

test('network failure explains browser CORS and endpoint troubleshooting', async () => {
    AppConfig.save(configured());global.fetch=async()=>{throw new TypeError('Failed to fetch');};
    await assert.rejects(AppConfig.chat('line1',{}, {retries:0}),/CORS/);
});

test('network exceptions are redacted as well as HTTP bodies', async () => {
    AppConfig.save(configured());global.fetch=async()=>{throw new Error('service rejected secret-1');};
    await assert.rejects(AppConfig.chat('line1',{}, {retries:0}),e=>e.message.includes('[redacted]')&&!e.message.includes('secret-1'));
});

test('Retry-After longer than one minute is not retried before the advertised time', async () => {
    AppConfig.save(configured());
    const original=global.setTimeout;const delays=[];let calls=0;
    global.setTimeout=(fn,delay,...args)=>{delays.push(delay);return original(fn,delay===120000?0:delay,...args);};
    global.fetch=async()=>++calls===1?new Response('limited',{status:429,headers:{'Retry-After':'120'}}):Response.json({choices:[{message:{content:'{}'}}]});
    try {await AppConfig.chat('line1',{}, {retries:1,retryBaseMs:0});}
    finally {global.setTimeout=original;}
    assert.ok(delays.includes(120000));
    assert.equal(calls,2);
});

test('storage becomes persistent again after a temporary quota error is resolved', () => {
    const original=global.localStorage;let denied=true;
    const temporary=new MemoryStorage();
    temporary.setItem=function(key,value){if(denied)throw new Error('quota');MemoryStorage.prototype.setItem.call(this,key,value);};
    global.localStorage=temporary;
    try {
        const cfg=configured();AppConfig.save(cfg);denied=false;
        cfg.lines.line1.model='recovered';AppConfig.save(cfg);
        // A separate tab edits the now available store. Reads must stop using stale memory.
        const stored=JSON.parse(temporary.getItem('sq_grader_config_v2'));stored.lines.line1.model='other-tab';
        temporary.setItem('sq_grader_config_v2',JSON.stringify(stored));
        assert.equal(AppConfig.load().lines.line1.model,'other-tab');
    } finally {global.localStorage=original;}
});

test('invalid proxy URLs are rejected before sending a broken download request', () => {
    for (const proxyUrl of ['https://proxy.example/?url=#fragment','http://proxy.example/?url=','https://user:pass@proxy.example/?url=','not a url']) {
        const cfg=configured();cfg.proxyUrl=proxyUrl;AppConfig.save(cfg);
        assert.throws(()=>AppConfig.getProxyUrl(),/代理/);
    }
    const cfg=configured();cfg.proxyUrl=' https://PROXY.EXAMPLE/?token=x&url= ';AppConfig.save(cfg);
    assert.equal(AppConfig.getProxyUrl(),'https://proxy.example/?token=x&url=');
});

test('absurd cooldowns never overflow timers into immediate repeated requests', async () => {
    AppConfig.save(configured());let calls=0;
    global.fetch=async()=>{calls++;return new Response('limited',{status:429,headers:{'Retry-After':'99999999999'}});};
    await assert.rejects(AppConfig.chat('line1',{}, {retries:1,retryBaseMs:0}),/稍后手动重试/);
    assert.equal(calls,1);
});

test('proxy migration never resurrects an explicitly cleared session URL on later loads', () => {
    const cfg=configured();cfg.proxyUrl='https://proxy.example/?token=obsolete&url=';
    global.localStorage.setItem('sq_grader_config_v2',JSON.stringify(cfg));
    global.sessionStorage.setItem('sq_grader_session_keys_v1',JSON.stringify({line1:'',proxyUrl:''}));
    assert.equal(AppConfig.getProxyUrl(),'');
    assert.equal(AppConfig.getProxyUrl(),'');
    assert.doesNotMatch(global.localStorage.getItem('sq_grader_config_v2'),/token=obsolete/);
    assert.equal(JSON.parse(global.sessionStorage.getItem('sq_grader_session_keys_v1')).proxyUrl,'');
});
