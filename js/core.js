/**
 * core.js — browser/Node shared logic. Keep this module free of DOM and network access.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.SQCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const ASSESSED_STATUSES = new Set(['明确正确', '疑似正确', '错误', 'MS之外']);

    function escHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .replace(/\n/g, '<br>');
    }

    function badgeHtml(status) {
        const map = {
            '明确正确': 'badge-correct',
            '疑似正确': 'badge-possible',
            '错误': 'badge-wrong',
            'MS之外': 'badge-extra',
            '未评估': 'badge-unassessed'
        };
        return `<span class="badge ${map[status] || 'badge-unassessed'}">${escHtml(status)}</span>`;
    }

    function buildBehUrl(state, type) {
        if (!['qp', 'ms'].includes(type)) throw new Error('Unsupported paper type');
        const lvlPath = state.level === 'alevel' ? 'cambridge-international-a-level' : 'cambridge-igcse';
        const yy = String(state.year).slice(2);
        const fn = `${state.subjectCode}_${state.season}${yy}_${type}_${state.paper}.pdf`;
        return `https://bestexamhelp.com/exam/${lvlPath}/${state.peh}/${state.year}/${fn}`;
    }

    function isPdfHeader(bytes) {
        const h = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        return h.length >= 4 && h[0] === 0x25 && h[1] === 0x50 && h[2] === 0x44 && h[3] === 0x46;
    }

    function rescueArray(text, key, validator) {
        const keyMatch = new RegExp(`"${key}"\\s*:\\s*\\[`).exec(text);
        if (!keyMatch) return [];
        const start = keyMatch.index + keyMatch[0].length;
        let objectStart = -1;
        let depth = 0;
        let inString = false;
        let escaped = false;
        const values = [];
        for (let i = start; i < text.length; i++) {
            const ch = text[i];
            if (inString) {
                if (escaped) escaped = false;
                else if (ch === '\\') escaped = true;
                else if (ch === '"') inString = false;
                continue;
            }
            if (ch === '"') { inString = true; continue; }
            if (ch === '{') {
                if (depth === 0) objectStart = i;
                depth++;
            } else if (ch === '}' && depth > 0) {
                depth--;
                if (depth === 0 && objectStart >= 0) {
                    try {
                        const value = JSON.parse(text.slice(objectStart, i + 1));
                        if (validator(value)) values.push(value);
                    } catch (_) {}
                    objectStart = -1;
                }
            } else if (ch === ']' && depth === 0) break;
        }
        return values;
    }

    function safeParseJSON(content, data = {}, errorPrefix = 'AI') {
        const text = String(content || '').trim();
        const reasoningContent = data?.choices?.[0]?.message?.reasoning_content;
        if (!text && errorPrefix === 'DeepSeek' && reasoningContent) {
            throw new Error(`${errorPrefix} 思考超时，未输出任何结果 (Token限制)。`);
        }
        try { return JSON.parse(text); } catch (_) {}
        const fenced = text.match(/```(?:json)?\s*([\s\S]+?)```/i);
        if (fenced) {
            try { return JSON.parse(fenced[1]); } catch (_) {}
        }
        const source = fenced ? fenced[1] : text;
        const specs = [
            ['answers', v => typeof v?.q_num === 'string' && Object.hasOwn(v, 'answer_text')],
            ['results', v => typeof v?.point_id === 'string' && typeof v?.status === 'string'],
            ['questions', v => typeof v?.q_num === 'string' && (Object.hasOwn(v, 'total_marks') || Array.isArray(v?.mark_points))]
        ];
        for (const [key, validator] of specs) {
            const rescued = rescueArray(source, key, validator);
            if (rescued.length) return { [key]: rescued };
        }
        throw new Error(`${errorPrefix} 返回内容无法解析为 JSON: ${text.slice(-100)}`);
    }

    function positiveNumber(value, fallback = 1) {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? n : fallback;
    }

    function normalizeMarkPoint(point, index = 0, qNum = '') {
        const markType = String(point?.mark_type || 'B').toUpperCase();
        return {
            point_id: String(point?.point_id || `${qNum}-point-${index + 1}`),
            description: String(point?.description || ''),
            mark_type: ['M', 'A', 'B', 'SC', 'FT'].includes(markType) ? markType : 'B',
            marks: positiveNumber(point?.marks, 1),
            alternatives: Array.isArray(point?.alternatives) ? point.alternatives.map(String) : [],
            depends_on: Array.isArray(point?.depends_on) ? point.depends_on.map(String) : [],
            group_id: point?.group_id ? String(point.group_id) : '',
            group_max: point?.group_max == null ? null : positiveNumber(point.group_max, 1),
            route_id: point?.route_id ? String(point.route_id) : '',
            follow_through: Boolean(point?.follow_through || markType === 'FT'),
            not_from_wrong_working: Boolean(point?.not_from_wrong_working),
            ignore_subsequent_working: Boolean(point?.ignore_subsequent_working),
            rule_notes: String(point?.rule_notes || '')
        };
    }

    function mergeQuestions(allQuestions) {
        const merged = new Map();
        for (const raw of allQuestions || []) {
            if (!raw || !raw.q_num) continue;
            const qNum = String(raw.q_num);
            if (!merged.has(qNum)) {
                merged.set(qNum, {
                    q_num: qNum,
                    total_marks: Math.max(0, Number(raw.total_marks) || 0),
                    mark_points: [],
                    general_rules: Array.isArray(raw.general_rules) ? raw.general_rules.map(String) : []
                });
            }
            const target = merged.get(qNum);
            target.total_marks = Math.max(target.total_marks, Math.max(0, Number(raw.total_marks) || 0));
            target.general_rules.push(...(Array.isArray(raw.general_rules) ? raw.general_rules.map(String) : []));
            const existingIds = new Set(target.mark_points.map(p => p.point_id));
            for (const [index, rawPoint] of (raw.mark_points || []).entries()) {
                const point = normalizeMarkPoint(rawPoint, index, qNum);
                if (!existingIds.has(point.point_id)) {
                    target.mark_points.push(point);
                    existingIds.add(point.point_id);
                }
            }
        }
        for (const q of merged.values()) q.general_rules = [...new Set(q.general_rules)];
        return [...merged.values()];
    }

    function mergeAnswers(allAnswers) {
        const answers = {};
        for (const a of allAnswers || []) {
            if (!a || !a.q_num) continue;
            const qNum = String(a.q_num);
            if (!answers[qNum]) answers[qNum] = { q_num: qNum, answer_text: '', confidence: a.confidence || 'low', source_pages: [] };
            const fragment = String(a.answer_text || '').trim();
            if (fragment && fragment !== '（未作答）') answers[qNum].answer_text += (answers[qNum].answer_text ? '\n' : '') + fragment;
            const sourcePages = Array.isArray(a.source_pages) ? a.source_pages : [a.source_page];
            for (const page of sourcePages) if (Number.isInteger(page) && !answers[qNum].source_pages.includes(page)) answers[qNum].source_pages.push(page);
            if (a.confidence === 'low') answers[qNum].confidence = 'low';
            else if (a.confidence === 'medium' && answers[qNum].confidence !== 'low') answers[qNum].confidence = 'medium';
        }
        for (const answer of Object.values(answers)) if (!answer.answer_text) answer.answer_text = '（未作答）';
        return answers;
    }

    function mergeQuestionContexts(allQuestions) {
        const contexts = {};
        for (const q of allQuestions || []) {
            if (!q?.q_num) continue;
            const qNum = String(q.q_num);
            if (!contexts[qNum]) contexts[qNum] = { q_num: qNum, question_text: '', source_pages: [] };
            const text = String(q.question_text || '').trim();
            if (text && !contexts[qNum].question_text.includes(text)) contexts[qNum].question_text += (contexts[qNum].question_text ? '\n' : '') + text;
            for (const page of (Array.isArray(q.source_pages) ? q.source_pages : [])) {
                if (Number.isInteger(page) && !contexts[qNum].source_pages.includes(page)) contexts[qNum].source_pages.push(page);
            }
        }
        return contexts;
    }

    function classifyPdfPage({ text = '', hasImages = false, isMs = false } = {}) {
        const normalized = String(text).replace(/\s+/g, ' ').trim();
        const upper = normalized.toUpperCase();
        const isMsCover = upper.includes('MAXIMUM MARK') && upper.includes('MARK SCHEME');
        const isQpCover = (upper.includes('CANDIDATE') && upper.includes('NUMBER')) || (upper.includes('INSTRUCTIONS') && upper.includes('INFORMATION'));
        const isRules = upper.includes('GENERIC MARKING PRINCIPLE') || upper.includes('CALCULATION SPECIFIC GUIDANCE');
        const explicitBlank = upper.includes('BLANK PAGE') && normalized.length < 500 && !hasImages;
        const skip = explicitBlank || (isMs ? (isMsCover || isRules) : isQpCover);
        const reason = explicitBlank ? '明确标注的空白页' : (isMsCover || isQpCover ? '封面' : (isRules ? '通用评分规则页' : ''));
        return { skip, reason, mode: !hasImages && normalized.length > 50 ? 'text' : 'image' };
    }

    function normalizeStatus(status) {
        return ASSESSED_STATUSES.has(status) ? status : '未评估';
    }

    function scoreQuestion(question) {
        const results = Array.isArray(question?.point_results) ? question.point_results : [];
        const byId = new Map(results.map((point, index) => {
            const normalized = { ...normalizeMarkPoint(point, index, question?.q_num || ''), ...point };
            normalized.status = normalizeStatus(point.status);
            return [normalized.point_id, normalized];
        }));
        const memo = new Map();
        function isEligible(point, visiting = new Set()) {
            if (memo.has(point.point_id)) return memo.get(point.point_id);
            if (visiting.has(point.point_id) || point.status !== '明确正确') return false;
            visiting.add(point.point_id);
            const eligible = (point.depends_on || []).every(id => byId.has(id) && isEligible(byId.get(id), visiting));
            visiting.delete(point.point_id);
            memo.set(point.point_id, eligible);
            return eligible;
        }
        const awards = {};
        const groupUsed = new Map();
        let got = 0;
        for (const point of byId.values()) {
            let awarded = isEligible(point) ? positiveNumber(point.marks, 1) : 0;
            if (awarded > 0 && point.group_id && point.group_max != null) {
                const used = groupUsed.get(point.group_id) || 0;
                awarded = Math.max(0, Math.min(awarded, positiveNumber(point.group_max, 1) - used));
                groupUsed.set(point.group_id, used + awarded);
            }
            awards[point.point_id] = awarded;
            got += awarded;
        }
        const max = Math.max(0, Number(question?.total_marks) || 0);
        got = Math.min(got, max);
        const possible = results.filter(p => p.status === '疑似正确').reduce((sum, p) => sum + positiveNumber(p.marks, 1), 0);
        const incomplete = question?.assessment_complete === false || results.some(p => normalizeStatus(p.status) === '未评估');
        return { got, max, possible: Math.min(possible, Math.max(0, max - got)), incomplete, awards };
    }

    function computeReport(results) {
        let totalGot = 0, totalMax = 0, incompleteQuestions = 0;
        for (const q of results || []) {
            const score = scoreQuestion(q);
            totalGot += score.got;
            totalMax += score.max;
            if (score.incomplete) incompleteQuestions++;
        }
        totalGot = Math.min(totalGot, totalMax);
        const incomplete = incompleteQuestions > 0;
        const rate = totalMax > 0 && !incomplete ? Math.round(totalGot / totalMax * 100) + '%' : '-';
        return { totalGot, totalMax, rate, incomplete, incompleteQuestions };
    }

    async function mapWithConcurrency(items, limit, worker, signal) {
        const list = Array.from(items || []);
        const concurrency = Math.max(1, Math.floor(Number(limit) || 1));
        const output = new Array(list.length);
        let next = 0;
        async function runner() {
            while (true) {
                if (signal?.aborted) throw signal.reason || new Error('Operation cancelled');
                const index = next++;
                if (index >= list.length) return;
                output[index] = await worker(list[index], index);
            }
        }
        await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, runner));
        return output;
    }

    function parseRetryAfter(value, now = Date.now()) {
        if (!value) return 0;
        const seconds = Number(value);
        if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
        const date = Date.parse(value);
        return Number.isFinite(date) ? Math.max(0, date - now) : 0;
    }

    function isRetryableStatus(status) {
        return [408, 409, 425, 429, 500, 502, 503, 504].includes(Number(status));
    }

    return {
        escHtml, badgeHtml, buildBehUrl, isPdfHeader, safeParseJSON,
        normalizeMarkPoint, mergeQuestions, mergeAnswers, mergeQuestionContexts,
        classifyPdfPage, normalizeStatus, scoreQuestion, computeReport,
        mapWithConcurrency, parseRetryAfter, isRetryableStatus
    };
});
