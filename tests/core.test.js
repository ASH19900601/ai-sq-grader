/**
 * CLI 测试（Node 内置 node:test，无需安装依赖）
 * 运行：node --test
 * 验证的 SQCore 与 GUI 共用同一实现，故 CLI 结果即代表 GUI 行为。
 */
const test = require('node:test');
const assert = require('node:assert');
const SQCore = require('../js/core.js');

test('buildBehUrl：A-Level MS 链接', () => {
    const state = { level: 'alevel', subjectCode: '9701', peh: 'chemistry-9701', year: '2023', season: 's', paper: '42' };
    assert.strictEqual(SQCore.buildBehUrl(state, 'ms'),
        'https://bestexamhelp.com/exam/cambridge-international-a-level/chemistry-9701/2023/9701_s23_ms_42.pdf');
});

test('escHtml：转义特殊字符与换行', () => {
    assert.strictEqual(SQCore.escHtml('a<b>&"\nx'), 'a&lt;b&gt;&amp;"<br>x');
});

test('badgeHtml：状态映射到对应 class', () => {
    assert.ok(SQCore.badgeHtml('明确正确').includes('badge-correct'));
    assert.ok(SQCore.badgeHtml('疑似正确').includes('badge-possible'));
    assert.ok(SQCore.badgeHtml('未知状态').includes('badge-wrong'));
});

test('isPdfHeader：识别 %PDF', () => {
    assert.strictEqual(SQCore.isPdfHeader(new Uint8Array([0x25, 0x50, 0x44, 0x46])), true);
    assert.strictEqual(SQCore.isPdfHeader(new Uint8Array([1, 2, 3, 4])), false);
});

test('safeParseJSON：标准 JSON 直接解析', () => {
    const out = SQCore.safeParseJSON('{"questions":[{"q_num":"1(a)","total_marks":2,"mark_points":[]}]}');
    assert.strictEqual(out.questions.length, 1);
});

test('safeParseJSON：去除 ```json 代码块包裹', () => {
    const out = SQCore.safeParseJSON('```json\n{"answers":[{"q_num":"1","answer_text":"x"}]}\n```');
    assert.strictEqual(out.answers[0].answer_text, 'x');
});

test('safeParseJSON：从被截断的 questions 中抢救', () => {
    // 缺少收尾 ]}，但每个 question 完整
    const truncated = '{"questions":[{"q_num":"1(a)","total_marks":2,"mark_points":[]},{"q_num":"1(b)","total_marks":3,"mark_points":[]}';
    const out = SQCore.safeParseJSON(truncated);
    assert.strictEqual(out.questions.length, 2);
    assert.strictEqual(out.questions[1].q_num, '1(b)');
});

test('safeParseJSON：从被截断的 point_results 中抢救', () => {
    const truncated = '{"results":[{"point_id":"1-1","status":"明确正确","reason":"ok"},{"point_id":"1-2","status":"错误","reason":"no"}';
    const out = SQCore.safeParseJSON(truncated);
    assert.strictEqual(out.results.length, 2);
    assert.strictEqual(out.results[0].status, '明确正确');
});

test('safeParseJSON：DeepSeek 思考超时抛错', () => {
    assert.throws(() => SQCore.safeParseJSON('', { choices: [{ message: { reasoning_content: '...' } }] }, 'DeepSeek'), /思考超时/);
});

test('safeParseJSON：完全无法解析抛错', () => {
    assert.throws(() => SQCore.safeParseJSON('这不是 JSON', {}, 'AI'), /无法解析/);
});

test('mergeQuestions：合并重复题号、取较大满分', () => {
    const merged = SQCore.mergeQuestions([
        { q_num: '1(a)', total_marks: 2, mark_points: [{ point_id: 'p1' }] },
        { q_num: '1(a)', total_marks: 3, mark_points: [{ point_id: 'p2' }] },
        { q_num: '2', total_marks: 1, mark_points: [] }
    ]);
    assert.strictEqual(merged.length, 2);
    const q1 = merged.find(q => q.q_num === '1(a)');
    assert.strictEqual(q1.total_marks, 3);
    assert.strictEqual(q1.mark_points.length, 2);
});

test('mergeAnswers：同题号按行拼接', () => {
    const ans = SQCore.mergeAnswers([
        { q_num: '1', answer_text: 'line1', confidence: 'high' },
        { q_num: '1', answer_text: 'line2', confidence: 'low' },
        { q_num: '2', answer_text: 'only', confidence: 'high' }
    ]);
    assert.strictEqual(ans['1'].answer_text, 'line1\nline2');
    assert.strictEqual(ans['2'].answer_text, 'only');
});

test('computeReport：仅明确正确计分，得分率正确', () => {
    const results = [
        { total_marks: 2, point_results: [{ status: '明确正确' }, { status: '疑似正确' }] },
        { total_marks: 2, point_results: [{ status: '明确正确' }, { status: '错误' }] }
    ];
    const r = SQCore.computeReport(results);
    assert.strictEqual(r.totalGot, 2);
    assert.strictEqual(r.totalMax, 4);
    assert.strictEqual(r.rate, '50%');
});

test('computeReport：满分为 0 时得分率显示 -', () => {
    const r = SQCore.computeReport([{ total_marks: 0, point_results: [] }]);
    assert.strictEqual(r.rate, '-');
});
