/** API configuration, safer secret storage, timeout and retry policy. */
(function (root, factory) {
    const api = factory(root);
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.AppConfig = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';
    const STORAGE_KEY = 'sq_grader_config_v2';
    const LEGACY_KEY = 'sq_grader_config_v1';
    const SESSION_KEY = 'sq_grader_session_keys_v1';
    const DEFAULTS = {
        lines: {
            line1: { label: '默认线路', baseUrl: '', apiKey: '', model: 'gpt-4o' },
            line2: { label: '备用线路', baseUrl: '', apiKey: '', model: 'gpt-4o-mini' },
            deepseek: { label: 'DeepSeek', baseUrl: '', apiKey: '', model: 'deepseek-chat' }
        },
        proxyUrl: '', rememberKeys: false
    };

    const cloneDefaults = () => JSON.parse(JSON.stringify(DEFAULTS));
    function readJson(storage, key, fallback = {}) {
        try { return JSON.parse(storage?.getItem(key) || '') || fallback; } catch (_) { return fallback; }
    }
    function writeJson(storage, key, value) { storage?.setItem(key, JSON.stringify(value)); }

    function publicConfig(cfg, includeKeys = false) {
        const output = { lines: {}, proxyUrl: cfg.proxyUrl || '', rememberKeys: Boolean(cfg.rememberKeys) };
        for (const [key, defaults] of Object.entries(DEFAULTS.lines)) {
            const line = { ...defaults, ...(cfg.lines?.[key] || {}) };
            output.lines[key] = { label: line.label, baseUrl: line.baseUrl, model: line.model };
            if (includeKeys) output.lines[key].apiKey = line.apiKey || '';
        }
        return output;
    }

    function migrateLegacy() {
        const legacy = readJson(root.localStorage, LEGACY_KEY, null);
        if (!legacy) return;
        const secrets = {};
        for (const key of Object.keys(DEFAULTS.lines)) secrets[key] = legacy.lines?.[key]?.apiKey || '';
        writeJson(root.sessionStorage, SESSION_KEY, secrets);
        writeJson(root.localStorage, STORAGE_KEY, publicConfig({ ...legacy, rememberKeys: false }, false));
        root.localStorage?.removeItem(LEGACY_KEY);
    }

    function load() {
        migrateLegacy();
        const persisted = readJson(root.localStorage, STORAGE_KEY, {});
        const secrets = readJson(root.sessionStorage, SESSION_KEY, {});
        const cfg = cloneDefaults();
        cfg.proxyUrl = persisted.proxyUrl || '';
        cfg.rememberKeys = Boolean(persisted.rememberKeys);
        for (const key of Object.keys(DEFAULTS.lines)) {
            cfg.lines[key] = { ...DEFAULTS.lines[key], ...(persisted.lines?.[key] || {}) };
            cfg.lines[key].apiKey = secrets[key] || (cfg.rememberKeys ? persisted.lines?.[key]?.apiKey || '' : '');
        }
        return cfg;
    }

    function save(cfg) {
        const secrets = {};
        for (const key of Object.keys(DEFAULTS.lines)) secrets[key] = cfg.lines?.[key]?.apiKey || '';
        writeJson(root.sessionStorage, SESSION_KEY, secrets);
        writeJson(root.localStorage, STORAGE_KEY, publicConfig(cfg, Boolean(cfg.rememberKeys)));
        root.localStorage?.removeItem(LEGACY_KEY);
    }

    function getLine(key) { const cfg = load(); return cfg.lines[key] || cfg.lines.line1; }
    function getProxyUrl() { return load().proxyUrl || ''; }
    function isConfigured() { const line = load().lines.line1; return Boolean(line.baseUrl && line.apiKey && line.model); }
    function hasDeepSeek() { const line = load().lines.deepseek; return Boolean(line.baseUrl && line.apiKey && line.model); }
    function availableVisionLines() {
        const cfg = load();
        return ['line1', 'line2'].filter(key => cfg.lines[key].baseUrl && cfg.lines[key].apiKey && cfg.lines[key].model)
            .map(key => ({ key, label: cfg.lines[key].label || key }));
    }

    function abortError() { const error = new Error('请求已取消'); error.name = 'AbortError'; return error; }
    function wait(ms, externalSignal) {
        if (externalSignal?.aborted) return Promise.reject(abortError());
        return new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, ms);
            externalSignal?.addEventListener('abort', () => { clearTimeout(timer); reject(abortError()); }, { once: true });
        });
    }

    async function fetchAttempt(url, options, externalSignal, timeoutMs) {
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        externalSignal?.addEventListener('abort', onAbort, { once: true });
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try { return await root.fetch(url, { ...options, signal: controller.signal }); }
        catch (error) {
            if (externalSignal?.aborted) throw abortError();
            if (controller.signal.aborted) throw new Error(`API 请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
            throw error;
        } finally {
            clearTimeout(timeout);
            externalSignal?.removeEventListener('abort', onAbort);
        }
    }

    async function chat(lineKey, payload, options = {}) {
        const line = getLine(lineKey);
        if (!line.baseUrl || !line.apiKey || !line.model) throw new Error(`线路「${lineKey}」未完整配置。`);
        let parsed;
        try { parsed = new URL(line.baseUrl); } catch (_) { throw new Error('API Base URL 无效。'); }
        if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('API Base URL 仅支持 HTTP/HTTPS。');
        const url = line.baseUrl.replace(/\/+$/, '') + '/chat/completions';
        const body = { model: line.model, ...payload };
        const retries = Math.max(0, Math.min(5, Number(options.retries ?? 3)));
        const timeoutMs = Math.max(5000, Number(options.timeoutMs || 60000));
        const retryBaseMs = Math.max(0, Number(options.retryBaseMs ?? 750));
        let lastError;
        for (let attempt = 0; attempt <= retries; attempt++) {
            if (options.signal?.aborted) throw abortError();
            let response;
            try {
                response = await fetchAttempt(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + line.apiKey },
                    body: JSON.stringify(body)
                }, options.signal, timeoutMs);
            } catch (error) {
                lastError = error;
                if (error.name === 'AbortError' || attempt === retries) throw error;
                const delay = Math.min(10000, retryBaseMs * (2 ** attempt)) + (retryBaseMs ? Math.floor(Math.random() * 251) : 0);
                await wait(delay, options.signal);
                continue;
            }
            if (response.ok) return response.json();
            const detail = await response.text().catch(() => '');
            const error = new Error(`API 返回错误 (${response.status}): ${detail.slice(0, 200)}`);
            error.status = response.status;
            lastError = error;
            if (!root.SQCore?.isRetryableStatus(response.status) || attempt === retries) throw error;
            const retryAfter = root.SQCore.parseRetryAfter(response.headers?.get?.('Retry-After'));
            const backoff = Math.min(10000, retryBaseMs * (2 ** attempt)) + (retryBaseMs ? Math.floor(Math.random() * 251) : 0);
            await wait(Math.max(retryAfter, backoff), options.signal);
        }
        throw lastError || new Error('API 请求失败');
    }

    function fillModal() {
        const cfg = load();
        root.document?.querySelectorAll('.line-config').forEach(block => {
            const data = cfg.lines[block.dataset.line] || {};
            block.querySelectorAll('[data-field]').forEach(input => { input.value = data[input.dataset.field] || ''; });
        });
        const proxy = root.document?.getElementById('cfg-proxyUrl'); if (proxy) proxy.value = cfg.proxyUrl;
        const remember = root.document?.getElementById('cfgRememberKeys'); if (remember) remember.checked = cfg.rememberKeys;
    }
    function readModal() {
        const cfg = load();
        root.document.querySelectorAll('.line-config').forEach(block => {
            const key = block.dataset.line; cfg.lines[key] ||= {};
            block.querySelectorAll('[data-field]').forEach(input => { cfg.lines[key][input.dataset.field] = input.value.trim(); });
        });
        cfg.proxyUrl = root.document.getElementById('cfg-proxyUrl')?.value.trim() || '';
        cfg.rememberKeys = Boolean(root.document.getElementById('cfgRememberKeys')?.checked);
        return cfg;
    }
    function openModal() { const modal = root.document?.getElementById('settingsModal'); if (modal) { fillModal(); modal.style.display = 'flex'; } }
    function closeModal() { const modal = root.document?.getElementById('settingsModal'); if (modal) modal.style.display = 'none'; }
    function initUI(onSaved) {
        root.document?.getElementById('settingsBtn')?.addEventListener('click', openModal);
        root.document?.getElementById('bannerConfigBtn')?.addEventListener('click', openModal);
        root.document?.getElementById('cfgCancelBtn')?.addEventListener('click', closeModal);
        root.document?.getElementById('cfgSaveBtn')?.addEventListener('click', () => {
            const cfg = readModal();
            if (!cfg.lines.line1.baseUrl || !cfg.lines.line1.apiKey || !cfg.lines.line1.model) return root.alert('线路 1 的 Base URL、API Key 和模型名称为必填项。');
            save(cfg); closeModal(); if (typeof onSaved === 'function') onSaved();
        });
        const modal = root.document?.getElementById('settingsModal');
        modal?.addEventListener('click', event => { if (event.target === modal) closeModal(); });
    }

    return { load, save, getLine, getProxyUrl, isConfigured, hasDeepSeek, availableVisionLines, chat, openModal, closeModal, initUI, _test: { publicConfig, migrateLegacy, wait } };
});
