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
            line1: { label: '默认线路', baseUrl: '', apiKey: '', model: 'gpt-6.1-sol' },
            line2: { label: '备用线路', baseUrl: '', apiKey: '', model: 'gpt-4o-mini' },
            deepseek: { label: 'DeepSeek', baseUrl: '', apiKey: '', model: 'deepseek-chat' }
        },
        proxyUrl: '', rememberKeys: false
    };

    const memory = new Map();
    const blocked = new WeakSet();
    const storage = name => { try { return root[name]; } catch (_) { return null; } };
    let lastStorageWarning = '';
    const cloneDefaults = () => JSON.parse(JSON.stringify(DEFAULTS));
    function readJson(storage, key, fallback = {}) {
        let text;
        try { text = storage && !blocked.has(storage) ? storage.getItem(key) : memory.get(key); }
        catch (_) { text = memory.get(key); }
        if (!text) return fallback;
        try { return JSON.parse(text) || fallback; } catch (_) { return fallback; }
    }
    function writeJson(storage, key, value) {
        const text = JSON.stringify(value);
        memory.set(key, text);
        try { if (storage) { storage.setItem(key, text); blocked.delete(storage); } else { lastStorageWarning = '浏览器存储不可用，配置仅在当前页面有效，刷新或关闭页面后可能丢失。'; } } catch (_) { if (storage) blocked.add(storage); lastStorageWarning = '浏览器存储不可用，配置仅在当前页面有效，刷新或关闭页面后可能丢失。'; }
    }
    function remove(storage, key) { memory.delete(key); try { storage?.removeItem(key); } catch (_) {} }

    function publicConfig(cfg, includeKeys = false) {
        const output = { lines: {}, proxyUrl: includeKeys ? cfg.proxyUrl || '' : '', rememberKeys: Boolean(cfg.rememberKeys) };
        for (const [key, defaults] of Object.entries(DEFAULTS.lines)) {
            const line = { ...defaults, ...(cfg.lines?.[key] || {}) };
            output.lines[key] = { label: line.label, baseUrl: line.baseUrl, model: line.model };
            if (includeKeys) output.lines[key].apiKey = line.apiKey || '';
        }
        return output;
    }

    function migrateLegacy() {
        const legacy = readJson(storage('localStorage'), LEGACY_KEY, null);
        if (!legacy) return;
        // A v2 configuration is newer than the obsolete v1 entry. Never overwrite it.
        if (readJson(storage('localStorage'), STORAGE_KEY, null)) { remove(storage('localStorage'), LEGACY_KEY); return; }
        const secrets = { proxyUrl: legacy.proxyUrl || '' };
        for (const key of Object.keys(DEFAULTS.lines)) secrets[key] = legacy.lines?.[key]?.apiKey || '';
        writeJson(storage('sessionStorage'), SESSION_KEY, secrets);
        writeJson(storage('localStorage'), STORAGE_KEY, publicConfig({ ...legacy, rememberKeys: false }, false));
        remove(storage('localStorage'), LEGACY_KEY);
    }

    function load() {
        migrateLegacy();
        const persisted = readJson(storage('localStorage'), STORAGE_KEY, {});
        const secrets = readJson(storage('sessionStorage'), SESSION_KEY, {});
        const cfg = cloneDefaults();
        cfg.proxyUrl = Object.hasOwn(secrets, 'proxyUrl') ? secrets.proxyUrl : persisted.proxyUrl || '';
        if (persisted.proxyUrl && !persisted.rememberKeys) {
            if (!Object.hasOwn(secrets, 'proxyUrl')) secrets.proxyUrl = persisted.proxyUrl;
            writeJson(storage('sessionStorage'), SESSION_KEY, secrets);
            persisted.proxyUrl = '';
            writeJson(storage('localStorage'), STORAGE_KEY, persisted);
        }
        cfg.rememberKeys = Boolean(persisted.rememberKeys);
        for (const key of Object.keys(DEFAULTS.lines)) {
            cfg.lines[key] = { ...DEFAULTS.lines[key], ...(persisted.lines?.[key] || {}) };
            cfg.lines[key].apiKey = Object.hasOwn(secrets, key) ? secrets[key] : (cfg.rememberKeys ? persisted.lines?.[key]?.apiKey || '' : '');
        }
        return cfg;
    }

    function save(cfg) {
        lastStorageWarning = '';
        const secrets = { proxyUrl: cfg.proxyUrl || '' };
        for (const key of Object.keys(DEFAULTS.lines)) secrets[key] = cfg.lines?.[key]?.apiKey || '';
        writeJson(storage('sessionStorage'), SESSION_KEY, secrets);
        writeJson(storage('localStorage'), STORAGE_KEY, publicConfig(cfg, Boolean(cfg.rememberKeys)));
        remove(storage('localStorage'), LEGACY_KEY);
    }

    function clearSecrets() {
        const cfg = load();
        for (const line of Object.values(cfg.lines)) line.apiKey = '';
        cfg.proxyUrl = '';
        cfg.rememberKeys = false;
        save(cfg);
        return cfg;
    }

    function endpointFor(baseUrl) {
        let parsed;
        try { parsed = new URL(String(baseUrl).trim()); } catch (_) { throw new Error('API Base URL 无效。'); }
        if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('API URL 不得含用户名、密码、查询参数或片段。');
        if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) throw new Error('API 必须使用 HTTPS（本机调试除外）。');
        let pathname = parsed.pathname.replace(/\/+$/, '');
        if (!pathname.endsWith('/chat/completions')) pathname += '/chat/completions';
        parsed.pathname = pathname;
        return parsed.href;
    }
    function lineIsConfigured(line) {
        if (![line?.baseUrl, line?.apiKey, line?.model].every(value => typeof value === 'string' && value.trim())) return false;
        try { endpointFor(line.baseUrl); return true; } catch (_) { return false; }
    }
    function getLine(key) {
        const cfg = load();
        if (!Object.hasOwn(cfg.lines, key)) throw new Error('所选 API 线路不存在，请重新选择。');
        return cfg.lines[key];
    }
    function proxyEndpoint(value) {
        if (!value) return '';
        let parsed;
        try { parsed = new URL(String(value).trim()); } catch (_) { throw new Error('PDF 代理 URL 无效。'); }
        if (parsed.username || parsed.password || parsed.hash) throw new Error('PDF 代理 URL 不得含用户名、密码或片段（#）。');
        if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) throw new Error('PDF 代理必须使用 HTTPS（本机调试除外）。');
        return parsed.href;
    }
    function getProxyUrl() { return proxyEndpoint(load().proxyUrl); }
    function isConfigured() { return availableVisionLines().length > 0; }
    function hasDeepSeek() { return lineIsConfigured(load().lines.deepseek); }
    function availableVisionLines() {
        const cfg = load();
        return ['line1', 'line2'].filter(key => lineIsConfigured(cfg.lines[key]))
            .map(key => ({ key, label: cfg.lines[key].label || key }));
    }

    function abortError() { const error = new Error('请求已取消'); error.name = 'AbortError'; return error; }
    function wait(ms, externalSignal) {
        if (externalSignal?.aborted) return Promise.reject(abortError());
        return new Promise((resolve, reject) => {
            const cleanup = () => externalSignal?.removeEventListener('abort', onAbort);
            const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
            const onAbort = () => { clearTimeout(timer); cleanup(); reject(abortError()); };
            externalSignal?.addEventListener('abort', onAbort, { once: true });
        });
    }

    async function readModelResponse(response) {
        const limit = 4 * 1024 * 1024;
        const tooLarge = () => Object.assign(new Error('API 响应超过 4 MiB 上限，请减少单批内容或检查服务端响应。'), { retryable: false });
        if (Number(response.headers?.get?.('Content-Length')) > limit) { await response.body?.cancel?.(); throw tooLarge(); }
        if (!response.body?.getReader) {
            const text = await response.text();
            if (new TextEncoder().encode(text).byteLength > limit) throw tooLarge();
            return text;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parts = [];
        let bytes = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                bytes += value.byteLength;
                if (bytes > limit) { await reader.cancel(); throw tooLarge(); }
                parts.push(decoder.decode(value, { stream: true }));
            }
            parts.push(decoder.decode());
            return parts.join('');
        } finally { reader.releaseLock(); }
    }

    async function fetchAttempt(url, options, externalSignal, timeoutMs) {
        if (externalSignal?.aborted) throw abortError();
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        externalSignal?.addEventListener('abort', onAbort, { once: true });
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await root.fetch(url, { ...options, signal: controller.signal });
            // Read the body before releasing timeout/cancellation; headers alone are not completion.
            const text = await readModelResponse(response);
            return { ok: response.ok, status: response.status, headers: response.headers, text };
        }
        catch (error) {
            if (externalSignal?.aborted) throw abortError();
            if (controller.signal.aborted) throw new Error(`API 请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
            throw error;
        } finally {
            clearTimeout(timeout);
            controller.abort();
            externalSignal?.removeEventListener('abort', onAbort);
        }
    }

    async function chat(lineKey, payload, options = {}) {
        const line = getLine(lineKey);
        if (!line.baseUrl || !line.apiKey || !line.model) throw new Error(`线路「${lineKey}」未完整配置。`);
        const url = endpointFor(line.baseUrl);
        const body = { ...payload, model: line.model };
        const retries = Math.max(0, Math.min(5, Math.floor(Number(options.retries ?? 3)) || 0));
        const bounded = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Number(value))) : fallback;
        const timeoutMs = bounded(options.timeoutMs ?? 60000, 60000, 5000, 300000);
        const retryBaseMs = bounded(options.retryBaseMs ?? 750, 750, 0, 10000);
        let lastError;
        for (let attempt = 0; attempt <= retries; attempt++) {
            if (options.signal?.aborted) throw abortError();
            let response;
            try {
                response = await fetchAttempt(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + line.apiKey },
                    body: JSON.stringify(body),
                    redirect: 'error'
                }, options.signal, timeoutMs);
            } catch (error) {
                lastError = error;
                if (error.name === 'AbortError') throw error;
                const message = String(error.message || '').replaceAll(line.apiKey, '[redacted]');
                if (attempt === retries || error.retryable === false) {
                    if (/fetch|network|Failed to fetch|Load failed/i.test(message)) throw new Error('无法连接 AI 接口，请检查网络、API 地址，以及服务商是否允许当前网站的跨域请求（CORS）。');
                    throw new Error(message || 'API 请求失败');
                }
                const delay = Math.min(10000, retryBaseMs * (2 ** attempt)) + (retryBaseMs ? Math.floor(Math.random() * 251) : 0);
                await wait(delay, options.signal);
                continue;
            }
            if (response.ok) {
                let data;
                try { data = JSON.parse(response.text); } catch (_) { throw new Error('API 返回无效 JSON，请检查接口地址及服务状态。'); }
                if (data?.error) {
                    const detail = typeof data.error === 'string' ? data.error : data.error.message || '服务未返回可用结果';
                    throw new Error(`API 错误: ${String(detail).replaceAll(line.apiKey, '[redacted]').slice(0, 200)}`);
                }
                if (!Array.isArray(data?.choices) || !data.choices.length || !data.choices[0]?.message) throw new Error('API 未返回 Chat Completions 消息，请检查模型与接口兼容性。');
                return data;
            }
            const detail = response.text.replaceAll(line.apiKey, '[redacted]');
            const error = new Error(`API 返回错误 (${response.status}): ${detail.slice(0, 200)}`);
            error.status = response.status;
            lastError = error;
            if (!root.SQCore?.isRetryableStatus(response.status) || attempt === retries) throw error;
            const retryAfter = root.SQCore.parseRetryAfter(response.headers?.get?.('Retry-After'));
            if (retryAfter > 300000) throw new Error('AI 服务要求等待超过 5 分钟，请稍后手动重试。');
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
    let returnFocus;
    const inertBeforeModal = new Map();
    function openModal() {
        const modal = root.document?.getElementById('settingsModal');
        if (!modal) return;
        if (modal.style.display !== 'flex') returnFocus = root.document.activeElement;
        for (const element of root.document.body?.children || []) {
            if (element === modal || element.contains?.(modal)) continue;
            if (!inertBeforeModal.has(element)) inertBeforeModal.set(element, element.inert);
            element.inert = true;
        }
        fillModal(); modal.style.display = 'flex'; modal.querySelector('input')?.focus();
    }
    function closeModal() {
        const modal = root.document?.getElementById('settingsModal');
        if (!modal) return;
        modal.style.display = 'none';
        modal.querySelectorAll('[data-field="apiKey"]').forEach(input => { input.value = ''; });
        const proxy = root.document.getElementById('cfg-proxyUrl'); if (proxy) proxy.value = '';
        for (const [element, inert] of inertBeforeModal) element.inert = inert;
        inertBeforeModal.clear();
        returnFocus?.focus();
    }
    function initUI(onSaved) {
        root.document?.getElementById('settingsBtn')?.addEventListener('click', openModal);
        root.document?.getElementById('bannerConfigBtn')?.addEventListener('click', openModal);
        root.document?.getElementById('cfgCancelBtn')?.addEventListener('click', closeModal);
        root.document?.getElementById('cfgSaveBtn')?.addEventListener('click', () => {
            const cfg = readModal();
            const complete = ['line1', 'line2'].filter(key => [cfg.lines[key].baseUrl, cfg.lines[key].apiKey, cfg.lines[key].model].every(Boolean));
            if (!complete.length) return root.alert('请至少完整配置一条视觉线路。');
            try {
                for (const [key, line] of Object.entries(cfg.lines)) {
                    if (!line.baseUrl && !line.apiKey) continue; // Optional untouched lines have a default model only.
                    if (![line.baseUrl, line.apiKey, line.model].every(Boolean)) throw new Error(`线路「${line.label || key}」填写不完整，请补全地址、密钥和模型，或清空地址与密钥。`);
                    endpointFor(line.baseUrl);
                }
                proxyEndpoint(cfg.proxyUrl);
            } catch (error) { return root.alert(error.message); }
            try { save(cfg); } catch (_) { return root.alert('配置保存失败，请检查浏览器存储权限。'); } closeModal(); if (typeof onSaved === 'function') onSaved();
            if (lastStorageWarning) root.alert(lastStorageWarning);
        });
        root.document?.getElementById('cfgClearBtn')?.addEventListener('click', () => {
            clearSecrets(); fillModal();
            if (typeof onSaved === 'function') onSaved();
            if (lastStorageWarning) root.alert(lastStorageWarning + ' 浏览器拒绝修改持久存储时，请同时在浏览器设置中清除本网站数据。');
        });
        const modal = root.document?.getElementById('settingsModal');
        modal?.addEventListener('keydown', event => {
            if (event.key === 'Escape') closeModal();
            if (event.key === 'Tab') {
                const elements = [...modal.querySelectorAll('input, button')].filter(el => !el.disabled);
                const first = elements[0], last = elements.at(-1);
                if (event.shiftKey && root.document.activeElement === first) { event.preventDefault(); last?.focus(); }
                else if (!event.shiftKey && root.document.activeElement === last) { event.preventDefault(); first?.focus(); }
            }
        });
        modal?.addEventListener('click', event => { if (event.target === modal) closeModal(); });
    }

    return { load, save, clearSecrets, getLine, getProxyUrl, isConfigured, hasDeepSeek, availableVisionLines, chat, openModal, closeModal, initUI, _test: { publicConfig, migrateLegacy, wait, endpointFor } };
});
