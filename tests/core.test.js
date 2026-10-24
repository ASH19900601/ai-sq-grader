const test = require('node:test');
const assert = require('node:assert/strict');
const SQCore = require('../js/core.js');

test('buildBehUrl builds QP and MS URLs', () => {
    const state = { level: 'alevel', subjectCode: '9701', peh: 'chemistry-9701', year: '2026', season: 's', paper: '22' };
    assert.match(SQCore.buildBehUrl(state, 'qp'), /9701_s26_qp_22\.pdf$/);
    assert.match(SQCore.buildBehUrl(state, 'ms'), /9701_s26_ms_22\.pdf$/);
    assert.throws(() => SQCore.buildBehUrl(state, 'er'), /Unsupported/);
});

test('HTML output escapes tags and attributes', () => {
    assert.equal(SQCore.escHtml(`a<b>&"'\nx`), 'a&lt;b&gt;&amp;&quot;&#39;<br>x');
    assert.match(SQCore.badgeHtml('未评估'), /badge-unassessed/);
    assert.match(SQCore.badgeHtml('unknown'), /badge-unassessed/);
});

test('isPdfHeader requires a complete header', () => {
    assert.equal(SQCore.isPdfHeader(new Uint8Array([0x25, 0x50, 0x44, 0x46])), true);
    assert.equal(SQCore.isPdfHeader(new Uint8Array([0x25, 0x50])), false);
});

test('safeParseJSON parses standard and fenced JSON', () => {
    assert.equal(SQCore.safeParseJSON('{"questions":[]}').questions.length, 0);
    assert.equal(SQCore.safeParseJSON('```json\n{"answers":[{"q_num":"1","answer_text":"x"}]}\n```').answers[0].answer_text, 'x');
});

test('truncated arrays are rejected instead of silently dropping questions', () => {
    for (const text of ['{"answers":[{"q_num":"1","answer_text":"x"}', '{"questions":[{"q_num":"1","total_marks":1,"mark_points":[]}', '{"results":[{"point_id":"p1","status":"错误"}']) {
        assert.throws(() => SQCore.safeParseJSON(text), /不完整/);
    }
});
test('token-limit output is rejected even when syntactically valid', () => {
    assert.throws(() => SQCore.safeParseJSON('{"questions":[]}', { choices: [{ finish_reason: 'length' }] }), /截断/);
});

test('irrecoverable model output reports an error', () => {
    assert.throws(() => SQCore.safeParseJSON('', { choices: [{ message: { reasoning_content: '...' } }] }, 'DeepSeek'), /思考超时/);
    assert.throws(() => SQCore.safeParseJSON('not json'), /不完整或无效/);
});

test('mergeQuestions deduplicates IDs and preserves complex rules', () => {
    const merged = SQCore.mergeQuestions([
        { q_num: '1', total_marks: 2, mark_points: [{ point_id: 'M1', mark_type: 'M' }, { point_id: 'A1', mark_type: 'A', depends_on: ['M1'] }] },
        { q_num: '1', total_marks: 2, mark_points: [{ point_id: 'A1' }, { point_id: 'B1', group_id: 'any-two', group_max: 2 }] }
    ]);
    assert.equal(merged[0].mark_points.length, 3);
    assert.deepEqual(merged[0].mark_points[1].depends_on, ['M1']);
    assert.equal(merged[0].mark_points[2].group_max, 2);
});

test('mergeAnswers joins fragments and tracks source pages', () => {
    const answers = SQCore.mergeAnswers([
        { q_num: '1', answer_text: 'line 1', confidence: 'high', source_page: 0 },
        { q_num: '1', answer_text: 'line 2', confidence: 'medium', source_page: 1 }
    ]);
    assert.equal(answers['1'].answer_text, 'line 1\nline 2');
    assert.deepEqual(answers['1'].source_pages, [0, 1]);
});

test('scanned and low-text pages are retained', () => {
    assert.deepEqual(SQCore.classifyPdfPage({ text: '', hasImages: true }), { skip: false, reason: '', mode: 'image' });
    assert.equal(SQCore.classifyPdfPage({ text: 'x', hasImages: false }).skip, false);
    assert.equal(SQCore.classifyPdfPage({ text: 'BLANK PAGE', hasImages: true }).skip, false);
    assert.equal(SQCore.classifyPdfPage({ text: 'BLANK PAGE', hasImages: false }).skip, true);
});

test('scoring never exceeds maximum', () => {
    const question = { total_marks: 1, point_results: [{ point_id: 'p1', status: '明确正确' }, { point_id: 'p2', status: '明确正确' }] };
    assert.equal(SQCore.scoreQuestion(question).got, 1);
    assert.deepEqual(SQCore.computeReport([question]), { totalGot: 1, totalMax: 1, rate: '100%', incomplete: false, incompleteQuestions: 0 });
});

test('dependencies and any-N caps are applied', () => {
    const score = SQCore.scoreQuestion({ total_marks: 4, point_results: [
        { point_id: 'M1', status: '错误' },
        { point_id: 'A1', depends_on: ['M1'], status: '明确正确' },
        { point_id: 'B1', group_id: 'g', group_max: 1, status: '明确正确' },
        { point_id: 'B2', group_id: 'g', group_max: 1, status: '明确正确' }
    ] });
    assert.equal(score.got, 1);
    assert.equal(score.awards.A1, 0);
    assert.equal(score.awards.B2, 0);
});

test('unassessed points make the report incomplete', () => {
    const report = SQCore.computeReport([{ total_marks: 2, assessment_complete: false, point_results: [
        { point_id: 'p1', status: '明确正确' }, { point_id: 'p2', status: '未评估' }
    ] }]);
    assert.equal(report.totalGot, 1);
    assert.equal(report.rate, '-');
    assert.equal(report.incomplete, true);
});

test('mapWithConcurrency enforces the limit and keeps order', async () => {
    let active = 0, peak = 0;
    const output = await SQCore.mapWithConcurrency([1, 2, 3, 4, 5], 2, async value => {
        active++; peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active--; return value * 2;
    });
    assert.equal(peak, 2);
    assert.deepEqual(output, [2, 4, 6, 8, 10]);
});

test('retry helpers parse delays and statuses', () => {
    assert.equal(SQCore.parseRetryAfter('2'), 2000);
    assert.equal(SQCore.isRetryableStatus(429), true);
    assert.equal(SQCore.isRetryableStatus(400), false);
});

test('per-point awards sum to the capped total', () => {
    const score = SQCore.scoreQuestion({ total_marks: 1, point_results: [{ point_id: 'a', status: '明确正确' }, { point_id: 'b', status: '明确正确' }] });
    assert.equal(Object.values(score.awards).reduce((a,b) => a+b,0), score.got);
});
test('group cap applies even when a later member omits its cap', () => {
    const score = SQCore.scoreQuestion({ total_marks: 4, point_results: [{ point_id: 'a', group_id: 'g', group_max: 1, status: '明确正确' }, { point_id: 'b', group_id: 'g', status: '明确正确' }] });
    assert.equal(score.got, 1);
});
test('alternative routes cannot combine to award extra marks', () => {
    const score = SQCore.scoreQuestion({ total_marks: 4, point_results: [{ point_id: 'a', route_id: 'r1', marks: 2, status: '明确正确' }, { point_id: 'b', route_id: 'r2', marks: 3, status: '明确正确' }] });
    assert.equal(score.got, 3);
});
test('possible marks respect dependencies and group caps', () => {
    const score = SQCore.scoreQuestion({ total_marks: 4, point_results: [{ point_id: 'a', status: '错误' }, { point_id: 'b', depends_on: ['a'], status: '疑似正确' }] });
    assert.equal(score.possible, 0);
});
test('empty point lists do not claim a complete assessment', () => {
    assert.equal(SQCore.scoreQuestion({ total_marks: 2, point_results: [] }).incomplete, true);
});
test('untrusted question identifiers cannot mutate dictionary prototypes', () => {
    const answers = SQCore.mergeAnswers([{ q_num: '__proto__', answer_text: 'x' }]);
    assert.equal(answers.__proto__.answer_text, 'x');
    assert.equal({}.answer_text, undefined);
    assert.equal(SQCore.questionId(' １（a） (i) '), '1(a)(i)');
});
test('vector diagrams and generic marking rules are retained', () => {
    assert.equal(SQCore.classifyPdfPage({ text: 'text '.repeat(30), hasVectors: true }).mode, 'image');
    assert.equal(SQCore.classifyPdfPage({ text: 'GENERIC MARKING PRINCIPLES', isMs: true }).skip, false);
});
test('malformed MS fields and cyclic dependencies are rejected', () => {
    assert.throws(() => SQCore.validateRows([{ q_num: '1', total_marks: Infinity, mark_points: [] }], 'questions'), /MS/);
    const q = SQCore.mergeQuestions([{ q_num: '1', total_marks: 2, mark_points: [{ point_id: 'a', depends_on: ['b'] }, { point_id: 'b', depends_on: ['a'] }] }]);
    assert.throws(() => SQCore.validateMarkScheme(q), /循环依赖/);
});
test('pool stops scheduling new work after a worker fails', async () => {
    const seen = [];
    await assert.rejects(SQCore.mapWithConcurrency([1,2,3], 1, async x => { seen.push(x); throw new Error('failed'); }), /failed/);
    assert.deepEqual(seen, [1]);
});
