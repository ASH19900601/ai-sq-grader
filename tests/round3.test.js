const test=require('node:test');
const assert=require('node:assert/strict');
const {harness}=require('./helpers/app-harness.cjs');
test('R3 OCR cannot redirect a genuine page fragment to model-supplied source pages',async()=>{
 const h=harness();h.context.AppConfig.chat=async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({answers:[{q_num:'1(a)',answer_text:'6 N',source_pages:[1],confidence:'high'}]})}}]});
 const answers=await h.context.extractUserAnswers([{type:'image',content:'data:image/jpeg;base64,page0',pageNumber:1}],[{q_num:'1(a)'}]);
 assert.deepEqual(Array.from(answers['1(a)'].source_pages),[0]);
});
test('R3 final grading retains continuation images indexed under parent and child questions',async()=>{
 const h=harness();let captured;
 h.run("state.qpPages=[{type:'image',content:'qp',pageNumber:1}];state.userPages=[{type:'image',content:'answer0',pageNumber:1},{type:'image',content:'answer1',pageNumber:2},{type:'image',content:'unrelated',pageNumber:3}];");
 h.context.AppConfig.chat=async(key,payload)=>{captured=payload.messages[0].content;return {choices:[{message:{content:'{"results":[{"point_id":"B1","status":"明确正确"}]}'}}]};};
 await h.context.compareAnswers([{q_num:'1(a)(i)',total_marks:1,mark_points:[{point_id:'B1',description:'6 N',marks:1}],general_rules:[]}],{
  '1(a)':{answer_text:'F = ma',source_pages:[0]},'1(a)(i)':{answer_text:'= 6 N',source_pages:[1]},'1(a)(ii)':{answer_text:'unrelated sibling',source_pages:[2]},'10(a)':{answer_text:'wrong question',source_pages:[2]}
 },{});
 assert.match(captured[0].text,/F = ma/);assert.match(captured[0].text,/6 N/);assert.doesNotMatch(captured[0].text,/sibling|wrong question/);
 assert.deepEqual(Array.from(captured.filter(x=>x.type==='image_url').map(x=>x.image_url.url)),['qp','answer0','answer1']);
});
test('R3 harmless padded result IDs are normalized before lookup',async()=>{
 const h=harness();h.run("state.qpPages=[{type:'image',content:'data:image/jpeg;base64,q',pageNumber:1}];state.userPages=[{type:'image',content:'data:image/jpeg;base64,a',pageNumber:1}];");
 h.context.AppConfig.chat=async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({results:[{point_id:' B1 ',status:'明确正确',reason:'valid'}]})}}]});
 const results=await h.context.compareAnswers([{q_num:'1(a)',total_marks:1,mark_points:[{point_id:'B1',description:'6 N',marks:1}],general_rules:[]}],{},{});
 assert.equal(results[0].point_results[0].status,'明确正确');
});
test('R3 colliding padded IDs cannot overwrite contradictory assessment rows',async()=>{
 const h=harness();h.run("state.qpPages=[{type:'image',content:'q',pageNumber:1}];state.userPages=[{type:'image',content:'a',pageNumber:1}];");
 h.context.AppConfig.chat=async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({results:[{point_id:'B1',status:'明确正确'},{point_id:' B1 ',status:'错误'}]})}}]});
 const results=await h.context.compareAnswers([{q_num:'1',total_marks:1,mark_points:[{point_id:'B1',description:'6 N',marks:1}],general_rules:[]}],{},{});
 assert.equal(results[0].assessment_complete,false);
});
test('R3 failed full regrading retains the last report and the matching parsed inputs',async()=>{
 const h=harness();h.run("state.results=[{q_num:'old'}];state.reportCreatedAt='old-time';state.msStructure=[{q_num:'old-ms'}];state.qpStructure={old:{}};state.userAnswers={old:{}};renderResults=rows=>{state.results=rows;};resolvePaperBuffer=async()=>new ArrayBuffer(4);pdfToHybrid=async()=>[{}];parseMarkScheme=async()=>[{q_num:'new-ms',total_marks:1,mark_points:[{}]}];parseQuestionPaper=async()=>{throw new Error('new run failed');};");
 await h.context.runGradingPipeline();assert.equal(h.run('state.results[0].q_num'),'old');assert.equal(h.run('state.msStructure[0].q_num'),'old-ms');assert.equal(h.node('sectionResults').style.display,'block');assert.match(h.node('reportRetentionNotice').textContent,/上次报告/);
});
test('R3 selecting DeepSeek without usable credentials stops before using a paid vision fallback',async()=>{
 const h=harness();h.run('state.useDeepseek=true');h.context.AppConfig.hasDeepSeek=()=>false;let calls=0;h.context.AppConfig.chat=async()=>{calls++;return {choices:[{message:{content:'{"questions":[]}'}}]};};
 await assert.rejects(h.context.parseMarkScheme([{type:'text',content:'mark scheme',pageNumber:1}]),/DeepSeek.*配置/);assert.equal(calls,0);
});
test('R3 synchronous PDF rendering errors still release allocated canvas memory',async()=>{
 const h=harness();const canvas={width:0,height:0,getContext:()=>({})};h.context.document.createElement=()=>canvas;
 await assert.rejects(h.context.renderPdfPage({getViewport:()=>({width:100,height:100}),render(){throw new Error('unsupported render');}},1),/unsupported/);
 assert.equal(canvas.width,0);assert.equal(canvas.height,0);
});
test('R3 cancellation without a prior report never displays a fabricated retained report',async()=>{
 const h=harness();h.run("resolvePaperBuffer=async()=>{state.runController.abort();throw new DOMException('cancel','AbortError');};");
 await h.context.runGradingPipeline();assert.equal(h.run('state.results'),null);assert.equal(h.node('sectionResults').style.display,'none');assert.equal(h.node('reportRetentionNotice').hidden,true);
});
