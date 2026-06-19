/**
 * core.js — 纯逻辑核心（同构：浏览器 / Node 共用同一份实现）
 *
 * 只包含与 DOM、网络、pdf.js 无关的纯函数，保证 GUI 与 CLI 调用同一实现、结果一致。
 * 浏览器：window.SQCore ；Node：require('./core.js')
 */
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.SQCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    function escHtml(s) {
        return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    }

    function badgeHtml(status) {
        const map = { '明确正确': 'badge-correct', '疑似正确': 'badge-possible', '错误': 'badge-wrong', 'MS之外': 'badge-extra' };
        return `<span class="badge ${map[status] || 'badge-wrong'}">${escHtml(status)}</span>`;
    }

    /** 构建 BestExamHelp 下载 URL；type = 'qp' | 'ms' */
    function buildBehUrl(state, type) {
        const lvlPath = state.level === 'alevel' ? 'cambridge-international-a-level' : 'cambridge-igcse';
        const yy = String(state.year).slice(2);
        const fn = `${state.subjectCode}_${state.season}${yy}_${type}_${state.paper}.pdf`;
        return `https://bestexamhelp.com/exam/${lvlPath}/${state.peh}/${state.year}/${fn}`;
    }

    function isPdfHeader(bytes) {
        const h = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        return h[0] === 0x25 && h[1] === 0x50 && h[2] === 0x44 && h[3] === 0x46;
    }

    /**
     * 健壮 JSON 解析：处理代码块包裹与被截断的输出，分级抢救
     * questions / answers / point_results。
     * @param {string} content 模型输出文本
     * @param {object} data    原始响应（用于检测 deepseek reasoning 超时）
     * @param {string} errorPrefix 'AI' | 'DeepSeek'
     */
    function safeParseJSON(content, data = {}, errorPrefix = 'AI') {
        const isDeepSeek = errorPrefix === 'DeepSeek';
        const reasoningContent = data?.choices?.[0]?.message?.reasoning_content;
        if (!content && isDeepSeek && reasoningContent) {
            throw new Error(`${errorPrefix} 思考超时，未输出任何结果 (Token限制)。`);
        }

        try { return JSON.parse(content); } catch (e) {}

        const match = content.match(/```(?:json)?\s*([\s\S]+?)```/);
        if (match) { try { return JSON.parse(match[1]); } catch (e) {} }
        const str = match ? match[1] : content;

        // 抢救题目
        const questions = [];
        const qMatches = str.match(/\{\s*"q_num"\s*:\s*"[^"]+"[\s\S]+?\}(?=\s*,\s*\{\s*"q_num"|$)/g);
        if (qMatches) {
            for (const qStr of qMatches) {
                let c = qStr.trim(); if (c.endsWith(',')) c = c.slice(0, -1);
                for (const att of [c, c + ']}', c + '"]}', c + '}']) { try { questions.push(JSON.parse(att)); break; } catch (e) {} }
            }
        }
        if (questions.length > 0) return { questions };

        // 抢救答案
        const ansMatches = str.match(/\{\s*"q_num"\s*:\s*"[^"]+"\s*,\s*"answer_text"[\s\S]+?\}(?=\s*,\s*\{\s*"q_num"|$)/g);
        if (ansMatches) {
            const answers = [];
            for (const qStr of ansMatches) {
                let c = qStr.trim(); if (c.endsWith(',')) c = c.slice(0, -1);
                for (const att of [c, c + '}']) { try { answers.push(JSON.parse(att)); break; } catch (e) {} }
            }
            if (answers.length > 0) return { answers };
        }

        // 抢救判题结果
        const resMatches = str.match(/\{\s*"point_id"\s*:\s*"[^"]+"\s*,\s*"status"[\s\S]+?\}(?=\s*,\s*\{\s*"point_id"|$)/g);
        if (resMatches) {
            const results = [];
            for (const qStr of resMatches) {
                let c = qStr.trim(); if (c.endsWith(',')) c = c.slice(0, -1);
                for (const att of [c, c + '}']) { try { results.push(JSON.parse(att)); break; } catch (e) {} }
            }
            if (results.length > 0) return { results };
        }

        throw new Error(`${errorPrefix} 返回内容无法解析为 JSON: ` + content.slice(-100));
    }

    /** 合并重复题号的 MS 题目结构 */
    function mergeQuestions(allQuestions) {
        const merged = {};
        for (const q of allQuestions) {
            if (!merged[q.q_num]) merged[q.q_num] = q;
            else {
                merged[q.q_num].mark_points = merged[q.q_num].mark_points.concat(q.mark_points);
                merged[q.q_num].total_marks = Math.max(merged[q.q_num].total_marks, q.total_marks);
            }
        }
        return Object.values(merged);
    }

    /** 合并同题号的答卷识别结果（按行拼接） */
    function mergeAnswers(allAnswers) {
        const answers = {};
        for (const a of allAnswers) {
            if (!answers[a.q_num]) answers[a.q_num] = { q_num: a.q_num, answer_text: '', confidence: a.confidence };
            answers[a.q_num].answer_text += (answers[a.q_num].answer_text ? '\n' : '') + a.answer_text;
        }
        return answers;
    }

    /**
     * 根据比对结果计算总分。
     * 仅「明确正确」计入得分；满分为各题 total_marks 之和。
     * @returns {{ totalGot:number, totalMax:number, rate:string }}
     */
    function computeReport(results) {
        let totalGot = 0, totalMax = 0;
        for (const q of results) {
            totalGot += (q.point_results || []).filter(p => p.status === '明确正确').length;
            totalMax += q.total_marks || 0;
        }
        const rate = totalMax > 0 ? Math.round(totalGot / totalMax * 100) + '%' : '-';
        return { totalGot, totalMax, rate };
    }

    return { escHtml, badgeHtml, buildBehUrl, isPdfHeader, safeParseJSON, mergeQuestions, mergeAnswers, computeReport };
});
