const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../js/core.js');
const good = (id, extra={}) => ({point_id:id, description:id, marks:1, status:'明确正确', ...extra});
const ms = (points, extra={}) => ({q_num:'1(a)', total_marks:3, mark_points:points, ...extra});

test('R2-core-01 blank page footer never deletes student text or exam instructions', () => {
    for (const text of ['BLANK PAGE F = 6 N', 'Do not write on the BLANK PAGE', 'BLANK PAGE 1(a) answer = 4']) assert.equal(Core.classifyPdfPage({text}).skip,false,text);
    assert.equal(Core.classifyPdfPage({text:'BLANK PAGE'}).skip,true);
    assert.equal(Core.classifyPdfPage({text:'This page is intentionally blank.'}).skip,true);
});

test('R2-core-02 same OCR row repeated on one page is not repeated in the student transcript', () => {
    const rows = [{q_num:'1',answer_text:'F = 6 N',source_page:0,confidence:'high'}, {q_num:'1',answer_text:'F = 6 N',source_page:0,confidence:'high'}];
    assert.equal(Core.mergeAnswers(rows)['1'].answer_text,'F = 6 N');
    // The same text on another page remains evidence from that page.
    rows.push({...rows[0],source_page:1});
    assert.equal(Core.mergeAnswers(rows)['1'].answer_text,'F = 6 N\nF = 6 N');
    assert.deepEqual(Core.mergeAnswers(rows)['1'].source_pages,[0,1]);
});

test('R2-core-03 absent or invalid OCR confidence lowers confidence instead of preserving high', () => {
    for (const confidence of [undefined,'certain','__proto__']) {
        const result = Core.mergeAnswers([{q_num:'1',answer_text:'part1',confidence:'high'}, {q_num:'1',answer_text:'part2',confidence}]);
        assert.equal(result['1'].confidence,'low');
    }
});

test('R2-core-04 numeric question continuations are not lost through substring deduplication', () => {
    const merged=Core.mergeQuestionContexts([{q_num:'1',question_text:'Given x=20',source_pages:[0]}, {q_num:'1',question_text:'Given x=2',source_pages:[1]}, {q_num:'1',question_text:'Given x=20',source_pages:[2]}]);
    assert.equal(merged['1'].question_text,'Given x=20\nGiven x=2');
    assert.deepEqual(merged['1'].source_pages,[0,1,2]);
});

test('source page indexes never contain negatives that suppress all original images', () => {
    assert.deepEqual(Core.mergeAnswers([{q_num:'1',answer_text:'x',source_pages:[-1,0,1.2]}])['1'].source_pages,[0]);
    assert.deepEqual(Core.mergeQuestionContexts([{q_num:'1',question_text:'x',source_pages:[-1,0,1.2]}])['1'].source_pages,[0]);
});

test('R2-core-05 repeated MS points preserve continuation-page dependencies and restrictions', () => {
    const questions=Core.mergeQuestions([
        ms([good('M')]),
        ms([good('A')]),
        ms([good('A',{depends_on:['M'],group_id:'g',group_max:1,rule_notes:'not from wrong working',not_from_wrong_working:true})])
    ]);
    const point=questions[0].mark_points.find(p=>p.point_id==='A');
    assert.deepEqual(point.depends_on,['M']);assert.equal(point.group_id,'g');assert.equal(point.group_max,1);assert.equal(point.not_from_wrong_working,true);assert.match(point.rule_notes,/not from/);
    const score=Core.scoreQuestion({...questions[0],point_results:questions[0].mark_points.map(p=>({...p,status:p.point_id==='M'?'错误':'明确正确'}))});
    assert.equal(score.got,0);
});

test('R2-core-06 contradictory cross-page totals or duplicate point marks fail instead of silently choosing one', () => {
    assert.throws(()=>Core.mergeQuestions([ms([good('A')],{total_marks:2}),ms([good('B')],{total_marks:3})]),/满分冲突/);
    assert.throws(()=>Core.mergeQuestions([ms([good('A',{marks:1})]),ms([good('A',{marks:2})])]),/marks.*冲突/);
});

test('R2-core-07 phase-aware schemas reject missing MS totals and empty QP text', () => {
    assert.throws(()=>Core.validateRows([{q_num:'1',question_text:'this is not a mark scheme'}],'questions','ms'),/MS/);
    assert.throws(()=>Core.validateRows([{q_num:'1',total_marks:1,mark_points:[good('A')]}],'questions','qp'),/QP/);
    assert.throws(()=>Core.validateRows([{q_num:'1',question_text:'   '}],'questions','qp'),/QP/);
    assert.equal(Core.validateRows([ms([good('A')])],'questions','ms').length,1);
});

test('R2-core-08 malformed optional scoring fields cannot silently turn into different rules', () => {
    for (const extra of [{mark_type:'Z'},{alternatives:'OR 1'},{depends_on:[' ']},{group_id:123},{route_id:{}},{group_max:2},{marks:0.5},{marks:Number.MAX_SAFE_INTEGER+1}]) {
        assert.throws(()=>Core.validateRows([ms([good('A',extra)])],'questions','ms'),/MS/);
    }
    assert.throws(()=>Core.validateMarkScheme(Core.mergeQuestions([ms([good('A',{group_id:'g'})])])),/缺少上限/);
    assert.throws(()=>Core.validateMarkScheme(Core.mergeQuestions([ms([good('A',{group_id:'g',group_max:1}),good('B',{group_id:'g',group_max:2})])])),/上限冲突/);
});

test('R2-core-09 conflicting duplicate grading rows cannot become an apparently complete mark', () => {
    const score=Core.scoreQuestion({total_marks:1,point_results:[good('A',{status:'未评估'}),good('A')]});
    assert.equal(score.incomplete,true);assert.equal(score.got,0);
    assert.equal(Core.scoreQuestion({total_marks:1,point_results:[good('A'),good('A')]}).got,1);
});

test('R2-core-10 score maximizes legitimate marks across competing groups and dependencies', () => {
    const points=[good('a-unrelated',{group_id:'g',group_max:1}),good('m-method',{group_id:'g',group_max:1}),good('z-answer',{depends_on:['m-method']})];
    for (const order of [points,[...points].reverse(),[points[1],points[0],points[2]]]) {
        const score=Core.scoreQuestion({total_marks:2,point_results:order});
        assert.equal(score.got,2);assert.equal(score.awards['a-unrelated'],0);assert.equal(score.awards['m-method'],1);assert.equal(score.awards['z-answer'],1);
        assert.equal(Object.values(score.awards).reduce((a,b)=>a+b,0),score.got);
    }
    const weighted=Core.scoreQuestion({total_marks:5,point_results:[good('a-method',{marks:2,group_id:'g',group_max:3}),good('b-method',{marks:2,group_id:'g',group_max:3}),good('c-answer',{marks:2,depends_on:['b-method']})]});
    assert.equal(weighted.got,5);assert.equal(weighted.awards['a-method'],1);assert.equal(weighted.awards['b-method'],2);assert.equal(weighted.awards['c-answer'],2);
});

function exhaustive(points,max) {
    let best=0;const awards={};
    function visit(i,got) {
        if(i===points.length) {best=Math.max(best,got);return;}
        const p=points[i], caps=new Map();
        for(const point of points) if(point.group_id && point.group_max!=null) caps.set(point.group_id,point.group_max);
        for(let score=0;score<=p.marks;score++) {
            if(got+score>max) continue;
            if(score && (p.depends_on||[]).some(id=>(awards[id]||0)<points.find(p=>p.point_id===id).marks)) continue;
            if(p.group_id && caps.has(p.group_id)) {
                const used=points.slice(0,i).filter(q=>q.group_id===p.group_id).reduce((n,q)=>n+(awards[q.point_id]||0),0);
                if(used+score>caps.get(p.group_id)) continue;
            }
            awards[p.point_id]=score;visit(i+1,got+score);
        }
        delete awards[p.point_id];
    }
    visit(0,0);return best;
}
test('optimizer agrees with exhaustive scoring on 80 small weighted dependency/group fixtures', () => {
    let seed=52639;const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
    for(let t=0;t<80;t++) {
        const cap=1+random(4),max=1+random(8),points=[];
        for(let i=0;i<5;i++) points.push(good('p'+i,{marks:1+random(2),...(random(2)?{group_id:'g',group_max:cap}:{}),depends_on:i&&random(3)===0?['p'+random(i)]:[]}));
        const expected=exhaustive(points,max);
        const score=Core.scoreQuestion({total_marks:max,point_results:[...points].reverse()});
        assert.equal(score.got,expected,JSON.stringify({points,max}));
        assert.equal(score.incomplete,false);assert.equal(Object.values(score.awards).reduce((a,b)=>a+b,0),score.got);
    }
});

test('R2-core-11 failed or cancelled concurrency pools settle their started workers before releasing the next run', async () => {
    let inFlight=0;
    const failure=Core.mapWithConcurrency([0,1,2],2,async value=>{
        if(value===0) {await new Promise(r=>setTimeout(r,2));throw new Error('fail');}
        inFlight++;await new Promise(r=>setTimeout(r,15));inFlight--;
    });
    await assert.rejects(failure,/fail/);assert.equal(inFlight,0);
    const controller=new AbortController();
    await assert.rejects(Core.mapWithConcurrency([1],1,async()=>{controller.abort();return 1;},controller.signal));
});


test('R2-core-12 a model reply with multiple JSON sections cannot silently discard later questions', () => {
    const first = '```json\n{"questions":[{"q_num":"1","question_text":"first"}]}\n```';
    const second = '```json\n{"questions":[{"q_num":"2","question_text":"second"}]}\n```';
    assert.throws(() => Core.safeParseJSON(first+'\n'+second), /不完整或无效/);
    assert.throws(() => Core.safeParseJSON('Only part of the answer follows:\n'+first), /不完整或无效/);
    assert.equal(Core.safeParseJSON(first).questions[0].q_num,'1');
});

test('oversized malformed MS is rejected before synchronous scoring can freeze a browser', () => {
    assert.throws(() => Core.validateRows([ms(Array.from({length:201},(_,i)=>good('p'+i)))],'questions','ms'),/200/);
});
