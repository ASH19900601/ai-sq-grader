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

test('truncated answers are rescued as answers, not questions', () => {
    const parsed = SQCore.safeParseJSON('{"answers":[{"q_num":"1","answer_text":"x"},{"q_num":"2","answer_text":"y"}');
    assert.deepEqual(parsed.answers.map(answer => answer.q_num), ['1', '2']);
    assert.equal(parsed.questions, undefined);
});

test('truncated question and result arrays are rescued', () => {
    const questions = SQCore.safeParseJSON('{"questions":[{"q_num":"1","total_marks":1,"mark_points":[]},{"q_num":"2","total_marks":2,"mark_points":[]}');
    assert.equal(questions.questions.length, 2);
    const results = SQCore.safeParseJSON('{"results":[{"point_id":"p1","status":"错误"},{"point_id":"p2","status":"明确正确"}');
    assert.equal(results.results.length, 2);
});

test('irrecoverable model output reports an error', () => {
    assert.throws(() => SQCore.safeParseJSON('', { choices: [{ message: { reasoning_content: '...' } }] }, 'DeepSeek'), /思考超时/);
    assert.throws(() => SQCore.safeParseJSON('not json'), /无法解析/);
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
