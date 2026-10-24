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
        return `<span class="badge ${(Object.hasOwn(map, status) ? map[status] : 'badge-unassessed')}">${escHtml(status)}</span>`;
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

    function safeParseJSON(content, data = {}, errorPrefix = 'AI') {
        if (data?.choices?.[0]?.finish_reason === 'length') throw new Error(`${errorPrefix} 输出被截断，请降低单批页数或增加输出上限。`);
        const finish = data?.choices?.[0]?.finish_reason;
        if (finish && finish !== 'stop') throw new Error(`${errorPrefix} 未正常完成输出（${finish}）。`);
        const text = String(content || '').trim();
        const reasoningContent = data?.choices?.[0]?.message?.reasoning_content;
        if (!text && errorPrefix === 'DeepSeek' && reasoningContent) {
            throw new Error(`${errorPrefix} 思考超时，未输出任何结果 (Token限制)。`);
        }
        try { return JSON.parse(text); } catch (_) {}
        const fenced = text.match(/^```(?:json)?\s*([\s\S]+?)```\s*$/i);
        if (fenced) {
            try { return JSON.parse(fenced[1]); } catch (_) {}
        }
        throw new Error(`${errorPrefix} 返回的 JSON 不完整或无效，请重试。`);
    }

    function questionId(value) {
        return String(value ?? '').normalize('NFKC').replace(/\s+/g, '').replace(/[（]/g, '(').replace(/[）]/g, ')').toLowerCase();
    }

    function validateRows(rows, key, phase = '') {
        if (!Array.isArray(rows)) throw new Error(`${key} 必须是数组`);
        for (const row of rows) {
            if (!row || typeof row !== 'object' || typeof row.q_num !== 'string' || !questionId(row.q_num)) throw new Error(`${key} 含无效题号`);
            if ((key === 'answers' || phase === 'answers') && typeof row.answer_text !== 'string') throw new Error('答案缺少转录文本');
            if ((phase === 'qp' || (!phase && key === 'questions' && !('total_marks' in row))) && (typeof row.question_text !== 'string' || !row.question_text.trim())) throw new Error('QP 缺少题干');
            if (phase === 'ms' || (!phase && 'total_marks' in row)) {
                if (row.mark_points?.length > 200) throw new Error('MS 单个小题超过 200 个得分点，请检查题号是否被错误合并');
                if (!Number.isSafeInteger(row.total_marks) || row.total_marks <= 0 || !Array.isArray(row.mark_points) || !row.mark_points.length) throw new Error('MS 分值或得分点无效');
                const ids = new Set();
                for (const point of row.mark_points) {
                    if (!point || typeof point.point_id !== 'string' || !point.point_id.trim() || ids.has(point.point_id.trim()) || typeof point.description !== 'string' || !point.description.trim()) throw new Error('MS 得分点缺失或重复');
                    ids.add(point.point_id.trim());
                    if (point.mark_type != null && !['M', 'A', 'B', 'SC', 'FT'].includes(String(point.mark_type).trim().toUpperCase())) throw new Error('MS 评分类型无效');
                    for (const field of ['group_id', 'route_id', 'rule_notes']) if (point[field] != null && typeof point[field] !== 'string') throw new Error('MS 分组或规则文本无效');
                    if (point.alternatives != null && (!Array.isArray(point.alternatives) || point.alternatives.some(value => typeof value !== 'string'))) throw new Error('MS 等价答案无效');
                    if (point.group_max != null && !(typeof point.group_id === 'string' && point.group_id.trim())) throw new Error('MS 组上限缺少组编号');
                    for (const flag of ['follow_through', 'not_from_wrong_working', 'ignore_subsequent_working']) if (point[flag] != null && typeof point[flag] !== 'boolean') throw new Error('MS 布尔评分规则无效');
                    if (!Number.isSafeInteger(point.marks) || point.marks <= 0 || (point.group_max != null && (!Number.isSafeInteger(point.group_max) || point.group_max <= 0))) throw new Error('MS 得分点分值无效');
                    if (point.depends_on != null && (!Array.isArray(point.depends_on) || point.depends_on.some(id => typeof id !== 'string' || !id.trim()))) throw new Error('MS 依赖关系无效');
                }
            }
        }
        return rows;
    }

    function validateMarkScheme(questions) {
        for (const q of questions) {
            const byId = new Map(q.mark_points.map(p => [p.point_id, p]));
            const groups = new Map();
            for (const point of q.mark_points) if (point.group_id) {
                if (!groups.has(point.group_id)) groups.set(point.group_id, null);
                if (point.group_max != null) {
                    const known = groups.get(point.group_id);
                    if (known != null && known !== point.group_max) throw new Error(`MS ${q.q_num} 同组上限冲突`);
                    groups.set(point.group_id, point.group_max);
                }
            }
            if ([...groups.values()].some(cap => cap == null)) throw new Error(`MS ${q.q_num} 分组缺少上限`);
            const done = new Set();
            function visit(id, path = new Set()) {
                if (!byId.has(id) || path.has(id)) throw new Error(`MS ${q.q_num} 存在缺失或循环依赖`);
                if (done.has(id)) return;
                path.add(id);
                byId.get(id).depends_on.forEach(dep => visit(dep, path));
                path.delete(id); done.add(id);
            }
            byId.forEach((_, id) => visit(id));
        }
        return questions;
    }

    function positiveNumber(value, fallback = 1) {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? n : fallback;
    }

    function normalizeMarkPoint(point, index = 0, qNum = '') {
        const markType = String(point?.mark_type || 'B').trim().toUpperCase();
        return {
            point_id: String(point?.point_id || `${qNum}-point-${index + 1}`).trim(),
            description: String(point?.description || ''),
            mark_type: ['M', 'A', 'B', 'SC', 'FT'].includes(markType) ? markType : 'B',
            marks: positiveNumber(point?.marks, 1),
            alternatives: Array.isArray(point?.alternatives) ? point.alternatives.map(String) : [],
            depends_on: Array.isArray(point?.depends_on) ? [...new Set(point.depends_on.map(id => String(id).trim()))] : [],
            group_id: point?.group_id ? String(point.group_id).trim() : '',
            group_max: point?.group_max == null ? null : positiveNumber(point.group_max, 1),
            route_id: point?.route_id ? String(point.route_id).trim() : '',
            follow_through: Boolean(point?.follow_through || markType === 'FT'),
            not_from_wrong_working: Boolean(point?.not_from_wrong_working),
            ignore_subsequent_working: Boolean(point?.ignore_subsequent_working),
            rule_notes: String(point?.rule_notes || '')
        };
    }

    function mergeQuestions(allQuestions) {
        const merged = new Map(), suppliedFields = new Map();
        for (const raw of allQuestions || []) {
            if (!raw || !raw.q_num) continue;
            const qNum = questionId(raw.q_num);
            if (!merged.has(qNum)) {
                merged.set(qNum, {
                    q_num: qNum,
                    total_marks: Math.max(0, Number(raw.total_marks) || 0),
                    mark_points: [],
                    general_rules: Array.isArray(raw.general_rules) ? raw.general_rules.map(String) : []
                });
            }
            const target = merged.get(qNum);
            const incomingTotal = Math.max(0, Number(raw.total_marks) || 0);
            if (target.total_marks && incomingTotal && target.total_marks !== incomingTotal) throw new Error(`MS ${qNum} 跨页满分冲突，请复核后重试`);
            target.total_marks = target.total_marks || incomingTotal;
            target.general_rules.push(...(Array.isArray(raw.general_rules) ? raw.general_rules.map(String) : []));
            const existing = new Map(target.mark_points.map(p => [p.point_id, p]));
            for (const [index, rawPoint] of (raw.mark_points || []).entries()) {
                const point = normalizeMarkPoint(rawPoint, index, qNum);
                const previous = existing.get(point.point_id);
                if (!previous) {
                    target.mark_points.push(point);
                    existing.set(point.point_id, point);
                    suppliedFields.set(qNum + '\0' + point.point_id, new Set(Object.keys(rawPoint)));
                } else {
                    const supplied = suppliedFields.get(qNum + '\0' + point.point_id) || new Set();
                    // A repeated point may add rules on a continuation page; never discard them.
                    for (const field of ['marks', 'mark_type', 'group_id', 'group_max', 'route_id']) {
                        if (rawPoint[field] != null && supplied.has(field) && previous[field] != null && previous[field] !== '' && previous[field] !== point[field]) throw new Error(`MS ${qNum} 得分点 ${point.point_id} 的 ${field} 冲突`);
                        if (rawPoint[field] != null) previous[field] = point[field];
                        if (Object.hasOwn(rawPoint, field)) supplied.add(field);
                    }
                    previous.depends_on = [...new Set([...previous.depends_on, ...point.depends_on])];
                    previous.alternatives = [...new Set([...previous.alternatives, ...point.alternatives])];
                    for (const field of ['description', 'rule_notes']) if (point[field] && !previous[field].split('\n').includes(point[field])) previous[field] += (previous[field] ? '\n' : '') + point[field];
                    for (const field of ['follow_through', 'not_from_wrong_working', 'ignore_subsequent_working']) previous[field] ||= point[field];
                }
            }
        }
        for (const q of merged.values()) q.general_rules = [...new Set(q.general_rules)];
        return [...merged.values()];
    }

    function mergeAnswers(allAnswers) {
        const answers = Object.create(null), fragments = new Map();
        const rank = { high: 0, medium: 1, low: 2 };
        for (const a of allAnswers || []) {
            if (!a || !a.q_num) continue;
            const qNum = questionId(a.q_num);
            const confidence = Object.hasOwn(rank, a.confidence) ? a.confidence : 'low';
            if (!answers[qNum]) answers[qNum] = { q_num: qNum, answer_text: '', confidence, source_pages: [] };
            const fragment = String(a.answer_text || '').trim();
            const sourcePages = (Array.isArray(a.source_pages) ? a.source_pages : [a.source_page]).filter(page => Number.isInteger(page) && page >= 0);
            const fragmentId = JSON.stringify([qNum, [...new Set(sourcePages)].sort((a,b) => a-b), fragment]);
            if (fragment && fragment !== '（未作答）' && !fragments.has(fragmentId)) {
                answers[qNum].answer_text += (answers[qNum].answer_text ? '\n' : '') + fragment;
                fragments.set(fragmentId, true);
            }
            for (const page of sourcePages) if (!answers[qNum].source_pages.includes(page)) answers[qNum].source_pages.push(page);
            if (rank[confidence] > rank[answers[qNum].confidence]) answers[qNum].confidence = confidence;
        }
        for (const answer of Object.values(answers)) if (!answer.answer_text) answer.answer_text = '（未作答）';
        return answers;
    }

    function mergeQuestionContexts(allQuestions) {
        const contexts = Object.create(null), fragments = new Map();
        for (const q of allQuestions || []) {
            if (!q?.q_num) continue;
            const qNum = questionId(q.q_num);
            if (!contexts[qNum]) { contexts[qNum] = { q_num: qNum, question_text: '', source_pages: [] }; fragments.set(qNum, new Set()); }
            const text = String(q.question_text || '').trim();
            if (text && !fragments.get(qNum).has(text)) { contexts[qNum].question_text += (contexts[qNum].question_text ? '\n' : '') + text; fragments.get(qNum).add(text); }
            for (const page of (Array.isArray(q.source_pages) ? q.source_pages : [])) {
                if (Number.isInteger(page) && page >= 0 && !contexts[qNum].source_pages.includes(page)) contexts[qNum].source_pages.push(page);
            }
        }
        return contexts;
    }

    function classifyPdfPage({ text = '', hasImages = false, hasVectors = false, isMs = false } = {}) {
        const normalized = String(text).replace(/\s+/g, ' ').trim();
        const upper = normalized.toUpperCase();
        const isMsCover = upper.includes('MAXIMUM MARK') && upper.includes('MARK SCHEME');
        const isQpCover = (upper.includes('CANDIDATE') && upper.includes('NUMBER')) || (upper.includes('INSTRUCTIONS') && upper.includes('INFORMATION'));
        const isRules = upper.includes('GENERIC MARKING PRINCIPLE') || upper.includes('CALCULATION SPECIFIC GUIDANCE');
        const explicitBlank = /^(?:(?:THIS (?:IS A |PAGE IS ))?(?:INTENTIONALLY )?BLANK PAGE|THIS PAGE IS (?:INTENTIONALLY )?BLANK)[.!]?$/.test(upper) && !hasImages && !hasVectors;
        const skip = explicitBlank; // Preserve covers with annotations and generic rules: omission is irreversible.
        const reason = explicitBlank ? '明确标注的空白页' : (isMsCover || isQpCover ? '封面' : (isRules ? '通用评分规则页' : ''));
        return { skip, reason, mode: !hasImages && !hasVectors && normalized.length > 50 ? 'text' : 'image' };
    }

    function normalizeStatus(status) {
        const value = typeof status === 'string' ? status.normalize('NFKC').trim() : '';
        return ASSESSED_STATUSES.has(value) ? value : '未评估';
    }

    function scoreQuestion(question) {
        const results = Array.isArray(question?.point_results) ? question.point_results : [];
        const byId = new Map();
        let invalid = false;
        for (const [index, raw] of results.entries()) {
            const point = { ...normalizeMarkPoint(raw, index, question?.q_num), status: normalizeStatus(raw?.status) };
            const previous = byId.get(point.point_id);
            if (previous && JSON.stringify(previous) !== JSON.stringify(point)) {
                previous.status = '未评估'; invalid = true;
            } else if (!previous) byId.set(point.point_id, point);
        }
        const points = [...byId.values()];
        const max = Number.isFinite(Number(question?.total_marks)) ? Math.max(0, Number(question.total_marks)) : 0;
        const groupCaps = new Map();
        for (const p of points) if (p.group_id && p.group_max != null) groupCaps.set(p.group_id, Math.min(groupCaps.get(p.group_id) ?? Infinity, p.group_max));
        const ordered = [], visited = new Set(), path = new Set();
        function visit(point) {
            if (path.has(point.point_id)) { invalid = true; return; }
            if (visited.has(point.point_id)) return;
            path.add(point.point_id);
            for (const id of point.depends_on) {
                if (!byId.has(id)) invalid = true;
                else visit(byId.get(id));
            }
            path.delete(point.point_id); visited.add(point.point_id); ordered.push(point);
        }
        [...points].sort((a,b) => a.point_id.localeCompare(b.point_id)).forEach(visit);
        let limited = false, nodes = 0;
        function allocate(includePossible, route) {
            const awards = Object.create(null), used = new Map();
            let best = { got: 0, awards: Object.create(null) };
            const eligible = p => (p.status === '明确正确' || (includePossible && p.status === '疑似正确')) && (!p.route_id || p.route_id === route);
            function search(index, got) {
                if (++nodes > 200000) { limited = true; return; }
                if (got > best.got) best = { got, awards: { ...awards } };
                if (index === ordered.length || got >= max) return;
                // Bound remaining score by remaining group budgets as well as the question cap.
                let upper = got;
                const remainingGroups = new Map();
                for (let i = index; i < ordered.length; i++) {
                    const p = ordered[i];
                    if (!eligible(p)) continue;
                    if (p.group_id && groupCaps.has(p.group_id)) remainingGroups.set(p.group_id, (remainingGroups.get(p.group_id) || 0) + p.marks);
                    else upper += p.marks;
                }
                for (const [id, marks] of remainingGroups) upper += Math.min(marks, Math.max(0, groupCaps.get(id) - (used.get(id) || 0)));
                if (Math.min(max, upper) <= best.got) return;
                const point = ordered[index];
                const dependenciesMet = point.depends_on.every(id => byId.has(id) && (awards[id] || 0) >= byId.get(id).marks);
                let value = eligible(point) && dependenciesMet ? Math.min(point.marks, max - got) : 0;
                if (point.group_id && groupCaps.has(point.group_id)) value = Math.min(value, Math.max(0, groupCaps.get(point.group_id) - (used.get(point.group_id) || 0)));
                // Weighted points can share the last marks in a capped group. Try smaller
                // allocations too, since freeing one mark may enable a more valuable dependency.
                for (let amount = value; amount > 0; amount = Number.isSafeInteger(amount) ? amount - 1 : 0) {
                    awards[point.point_id] = amount;
                    if (point.group_id) used.set(point.group_id, (used.get(point.group_id) || 0) + amount);
                    search(index + 1, got + amount);
                    if (point.group_id) used.set(point.group_id, used.get(point.group_id) - amount);
                    if (best.got >= max || nodes > 200000) break;
                }
                awards[point.point_id] = 0;
                search(index + 1, got);
                delete awards[point.point_id];
            }
            search(0, 0);
            for (const p of points) if (!Object.hasOwn(best.awards, p.point_id)) best.awards[p.point_id] = 0;
            return best;
        }
        const routes = [...new Set(points.map(p => p.route_id).filter(Boolean))].sort();
        const best = possible => (routes.length ? routes : ['']).map(route => allocate(possible, route)).sort((a,b) => b.got - a.got)[0];
        const score = best(false), potential = best(true);
        const incomplete = invalid || limited || question?.assessment_complete === false || !points.length || points.some(p => p.status === '未评估');
        return { got: score.got, max, possible: Math.max(0, potential.got - score.got), incomplete, awards: score.awards };
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
        let failed = false;
        async function runner() {
            while (true) {
                if (failed) return;
                if (signal?.aborted) throw signal.reason || new Error('Operation cancelled');
                const index = next++;
                if (index >= list.length) return;
                try { output[index] = await worker(list[index], index); } catch (error) { failed = true; throw error; }
            }
        }
        const workers = Array.from({ length: Math.min(concurrency, list.length) }, runner);
        const settled = await Promise.allSettled(workers);
        const rejection = settled.find(result => result.status === 'rejected');
        if (rejection) throw rejection.reason;
        if (signal?.aborted) throw signal.reason || new Error('Operation cancelled');
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
        questionId, validateRows, validateMarkScheme, normalizeMarkPoint, mergeQuestions, mergeAnswers, mergeQuestionContexts,
        classifyPdfPage, normalizeStatus, scoreQuestion, computeReport,
        mapWithConcurrency, parseRetryAfter, isRetryableStatus
    };
});
