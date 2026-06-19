/**
 * config.js — 客户端 API 配置管理（SQ 批改器）
 * 三条线路：line1(默认/视觉)、line2(备用/视觉)、deepseek(处理纯文本 MS)。
 * 所有密钥仅保存在浏览器 localStorage，绝不上传服务器。
 */
const AppConfig = (() => {
    const STORAGE_KEY = 'sq_grader_config_v1';

    const DEFAULTS = {
        lines: {
            line1:    { label: '默认线路', baseUrl: '', apiKey: '', model: 'gpt-4o' },
            line2:    { label: '备用线路', baseUrl: '', apiKey: '', model: 'gpt-4o-mini' },
            deepseek: { label: 'DeepSeek', baseUrl: '', apiKey: '', model: 'deepseek-chat' }
        },
        proxyUrl: ''
    };

    function load() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return structuredClone(DEFAULTS);
            const parsed = JSON.parse(raw);
            return {
                lines: {
                    line1:    { ...DEFAULTS.lines.line1,    ...(parsed.lines?.line1 || {}) },
                    line2:    { ...DEFAULTS.lines.line2,    ...(parsed.lines?.line2 || {}) },
                    deepseek: { ...DEFAULTS.lines.deepseek, ...(parsed.lines?.deepseek || {}) }
                },
                proxyUrl: parsed.proxyUrl || ''
            };
        } catch (e) {
            console.warn('配置读取失败，使用默认值', e);
            return structuredClone(DEFAULTS);
        }
    }

    function save(cfg) { localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); }

    function getLine(key) {
        const cfg = load();
        return cfg.lines[key] || cfg.lines.line1;
    }

    function getProxyUrl() { return load().proxyUrl || ''; }

    function isConfigured() {
        const l1 = load().lines.line1;
        return Boolean(l1.baseUrl && l1.apiKey);
    }

    function hasDeepSeek() {
        const d = load().lines.deepseek;
        return Boolean(d.baseUrl && d.apiKey);
    }

    // 可用于批改的视觉线路（line1 / line2），填充主界面下拉
    function availableVisionLines() {
        const cfg = load();
        return ['line1', 'line2']
            .filter(k => cfg.lines[k].baseUrl && cfg.lines[k].apiKey)
            .map(k => ({ key: k, label: cfg.lines[k].label || k }));
    }

    /**
     * 直连 OpenAI 兼容接口
     * @param {string} lineKey  'line1' | 'line2' | 'deepseek'
     * @param {object} payload  chat completions 请求体
     */
    async function chat(lineKey, payload) {
        const line = getLine(lineKey);
        if (!line.baseUrl || !line.apiKey) {
            throw new Error(`线路「${lineKey}」未配置，请先在「配置」中填写 API 信息。`);
        }
        const url = line.baseUrl.replace(/\/+$/, '') + '/chat/completions';
        const body = { model: line.model, ...payload };
        if (!body.model) body.model = line.model;

        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + line.apiKey },
            body: JSON.stringify(body)
        });
        if (!resp.ok) {
            const err = await resp.text().catch(() => '');
            throw new Error(`API 返回错误 (${resp.status}): ${err.slice(0, 200)}`);
        }
        return resp.json();
    }

    // ===================== 设置弹窗 =====================
    function fillModal() {
        const cfg = load();
        document.querySelectorAll('.line-config').forEach(block => {
            const key = block.dataset.line;
            const data = cfg.lines[key] || {};
            block.querySelectorAll('[data-field]').forEach(input => {
                input.value = data[input.dataset.field] || '';
            });
        });
        const proxyEl = document.getElementById('cfg-proxyUrl');
        if (proxyEl) proxyEl.value = cfg.proxyUrl || '';
    }

    function readModal() {
        const cfg = load();
        document.querySelectorAll('.line-config').forEach(block => {
            const key = block.dataset.line;
            cfg.lines[key] = cfg.lines[key] || {};
            block.querySelectorAll('[data-field]').forEach(input => {
                cfg.lines[key][input.dataset.field] = input.value.trim();
            });
        });
        const proxyEl = document.getElementById('cfg-proxyUrl');
        if (proxyEl) cfg.proxyUrl = proxyEl.value.trim();
        return cfg;
    }

    function openModal() {
        const modal = document.getElementById('settingsModal');
        if (!modal) return;
        fillModal();
        modal.style.display = 'flex';
    }

    function closeModal() {
        const modal = document.getElementById('settingsModal');
        if (modal) modal.style.display = 'none';
    }

    function initUI(onSaved) {
        const settingsBtn = document.getElementById('settingsBtn');
        const saveBtn = document.getElementById('cfgSaveBtn');
        const cancelBtn = document.getElementById('cfgCancelBtn');
        const bannerBtn = document.getElementById('bannerConfigBtn');

        if (settingsBtn) settingsBtn.addEventListener('click', openModal);
        if (bannerBtn) bannerBtn.addEventListener('click', openModal);
        if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
        if (saveBtn) saveBtn.addEventListener('click', () => {
            const cfg = readModal();
            if (!cfg.lines.line1.baseUrl || !cfg.lines.line1.apiKey) {
                alert('线路 1 的 Base URL 和 API Key 为必填项。');
                return;
            }
            save(cfg);
            closeModal();
            if (typeof onSaved === 'function') onSaved();
        });

        const modal = document.getElementById('settingsModal');
        if (modal) modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
    }

    return {
        load, save, getLine, getProxyUrl, isConfigured, hasDeepSeek,
        availableVisionLines, chat, openModal, closeModal, initUI
    };
})();
