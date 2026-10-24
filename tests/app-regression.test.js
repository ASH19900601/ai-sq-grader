const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/app-harness.cjs');
test('switching paper before first confirmation invalidates a pending paper upload',()=>{
    const h=harness();h.run("const pending=beginUpload('ms');markSelectionDirty();");
    assert.equal(h.run('pending()'),false);assert.equal(h.run('state.pendingUploads'),0);
});
test('superseded upload is cancelled and never keeps new upload permanently busy',()=>{
    const h=harness();h.run("const oldUpload=beginUpload('answer');const newUpload=beginUpload('answer');endUpload(oldUpload);");
    assert.equal(h.run('oldUpload.signal.aborted'),true);
    assert.equal(h.run('newUpload()'),true);assert.equal(h.run('state.pendingUploads'),1);
    h.run('endUpload(newUpload)');assert.equal(h.run('state.pendingUploads'),0);
});
test('PDF loading is destroyed immediately on cancellation',async()=>{
    const h=harness();let destroyed=0,rejectLoad;
    h.context.pdfjsLib.getDocument=()=>({promise:new Promise((_,reject)=>rejectLoad=reject),destroy(){destroyed++;rejectLoad(new Error('destroyed'));}});
    const controller=new AbortController();const loaded=h.context.loadPdf(new ArrayBuffer(4),controller.signal);controller.abort();
    await assert.rejects(loaded,e=>e.name==='AbortError');assert.ok(destroyed>=1);
});
test('encrypted PDFs receive an actionable password message',async()=>{
    const h=harness();h.context.pdfjsLib.getDocument=()=>({promise:Promise.reject(Object.assign(new Error('bad'),{name:'PasswordException'})),destroy(){}});
    await assert.rejects(h.context.loadPdf(new ArrayBuffer(4)),/解除密码保护/);
});
test('cancelled PDF render releases the canvas and cancels the render task',async()=>{
    const h=harness();let canvas={width:0,height:0,getContext(){return {};}},cancelled=0,rejectRender;
    h.context.document.createElement=()=>canvas;
    const page={getViewport:()=>({width:100,height:100}),render:()=>({promise:new Promise((_,reject)=>rejectRender=reject),cancel(){cancelled++;rejectRender(new Error('render cancelled'));}})};
    const controller=new AbortController();const pending=h.context.renderPdfPage(page,1,controller.signal);controller.abort();
    await assert.rejects(pending,e=>e.name==='AbortError');assert.equal(cancelled,1);assert.equal(canvas.width,0);assert.equal(canvas.height,0);
});
test('download size header prevents reading an oversized response into memory',async()=>{
    const h=harness();let read=false,cancelled=false;
    await assert.rejects(h.context.readPdfResponse({body:{cancel:async()=>{cancelled=true;}},headers:{get:()=>String(26*1024*1024)},arrayBuffer(){read=true;}}),/25 MiB/);assert.equal(read,false);assert.equal(cancelled,true);
});
test('chunked oversized PDF download is cancelled before the full body arrives',async()=>{
    const h=harness();let cancelled=false,released=false,reads=0;
    const response={headers:{get:()=>null},body:{getReader:()=>({read:async()=>({done:false,value:new Uint8Array(++reads*14*1024*1024)}),cancel:async()=>{cancelled=true;},releaseLock(){released=true;}})}};
    await assert.rejects(h.context.readPdfResponse(response),/25 MiB/);assert.equal(cancelled,true);assert.equal(released,true);assert.equal(reads,2);
});
test('bad source-page indexes fall back to actual original images',()=>{
    const h=harness();const content=[];
    const count=h.context.appendSourceImages(content,[{type:'image',pageNumber:1,content:'data:image/jpeg;base64,x'}],[-1,999],'answer');
    assert.equal(count,1);assert.equal(content[1].image_url.url,'data:image/jpeg;base64,x');
});
test('busy state restores previously disabled controls rather than enabling them',()=>{
    const h=harness();const a={id:'a',disabled:true},b={id:'b',disabled:false};h.context.document.querySelectorAll=()=>[a,b];
    h.context.setBusy(true);h.context.setBusy(false);assert.equal(a.disabled,true);assert.equal(b.disabled,false);
});
test('start prerequisites identify missing QP/MS before expensive model work',()=>{
    const h=harness();h.run("state.paperConfirmed=true;state.userPages=[{type:'image'}];updateStartButton();");
    assert.equal(h.node('startGradingBtn').disabled,true);assert.match(h.node('startHint').textContent,/QP 和 MS/);
    h.run('state.manualMsBuf=new ArrayBuffer(5);state.manualQpBuf=new ArrayBuffer(5);updateStartButton()');
    assert.equal(h.node('startGradingBtn').disabled,false);
});
test('export preserves assessment timestamp rather than labelling export time as grading time',async()=>{
    const h=harness();let blob;h.context.setTimeout=fn=>fn();h.context.document.createElement=()=>({click(){}});h.context.URL.createObjectURL=value=>{blob=value;return 'blob:x';};
    h.run("state.results=[];state.reportCreatedAt='2026-01-01T00:00:00.000Z';state.reportUpdatedAt='2026-01-02T00:00:00.000Z';exportReport();");
    const report=JSON.parse(await blob.text());assert.equal(report.created_at,'2026-01-01T00:00:00.000Z');assert.equal(report.updated_at,'2026-01-02T00:00:00.000Z');assert.ok(report.exported_at);
});
test('cancelled retry retains report and clearly communicates cancellation',async()=>{
    const h=harness();h.run("state.results=[{q_num:'1',total_marks:1,assessment_complete:false,point_results:[]}];state.msStructure=[];compareAnswers=async()=>{state.runController.abort();throw new DOMException('cancel','AbortError');};");
    await h.context.retryFailed();assert.equal(h.node('progressTitle').textContent,'重试已取消，保留原报告');assert.equal(h.run('state.results.length'),1);assert.equal(h.run('state.runController'),null);
});
test('stale invalid proxy configuration does not break startup controls',()=>{
    const h=harness();h.context.AppConfig.getProxyUrl=()=>{throw new Error('PDF 代理 URL 无效。');};
    h.run("state.paperConfirmed=true;state.userPages=[{}];updateStartButton();");
    assert.equal(h.node('startGradingBtn').disabled,true);assert.match(h.node('startHint').textContent,/代理 URL 无效/);
});
test('forgetting credentials disables grading before another paid request',()=>{
    const h=harness();h.context.AppConfig.availableVisionLines=()=>[];
    h.run("state.paperConfirmed=true;state.userPages=[{}];state.manualMsBuf={};state.manualQpBuf={};updateStartButton();");
    assert.equal(h.node('startGradingBtn').disabled,true);assert.match(h.node('startHint').textContent,/AI 视觉线路/);
});
test('cancel during a stalled PDF text extraction releases the document promptly',async()=>{
    const h=harness();let destroyed=0;const controller=new AbortController();
    h.context.pdfjsLib.getDocument=()=>({promise:Promise.resolve({numPages:1,getPage:async()=>({getTextContent:()=>new Promise(()=>{}),getOperatorList:async()=>({fnArray:[]})}),destroy(){destroyed++;}})});
    const pending=h.context.pdfToHybrid(new ArrayBuffer(4),1,false,'PDF',controller.signal);
    setTimeout(()=>controller.abort(),5);
    await assert.rejects(pending,e=>e.name==='AbortError');assert.equal(destroyed,1);
});
test('cancel does not depend on a PDF loading-task promise rejecting itself',async()=>{
    const h=harness();let destroyed=0;const controller=new AbortController();
    h.context.pdfjsLib.getDocument=()=>({promise:new Promise(()=>{}),destroy(){destroyed++;}});
    const pending=h.context.loadPdf(new ArrayBuffer(4),controller.signal);controller.abort();
    await assert.rejects(pending,e=>e.name==='AbortError');assert.ok(destroyed>=1);
});
test('corrupt photo diagnostics identify the exact file in a multi-photo upload',async()=>{
    const h=harness();h.context.createImageBitmap=async()=>{throw new Error('The source image could not be decoded');};
    await assert.rejects(h.context.imagesToPages([{name:'student-page-27.png'}]),/student-page-27\.png.*JPG、PNG 或 WebP/);
});

test('proxy target construction handles bare endpoints and preserves shared token parameters',()=>{
    const h=harness(), target='https://bestexamhelp.com/exam/a.pdf?x=1&y=2';
    for (const base of ['https://proxy.example/proxy.php','https://proxy.example/proxy.php?url=old','https://proxy.example/proxy.php?token=shared&url=']) {
        const actual = new URL(h.context.buildProxyRequest(base,target));
        assert.equal(actual.searchParams.get('url'),target);
        if(base.includes('token=')) assert.equal(actual.searchParams.get('token'),'shared');
    }
});
test('a parsing-stage failure aborts sibling requests before waiting for pool settlement',async()=>{
    const h=harness();h.run('state.runController=new AbortController()');let calls=0,aborted=0;
    h.context.AppConfig.chat=async(key,payload,options)=>{
        if(++calls===1){await new Promise(r=>setTimeout(r,5));throw new Error('QP provider failure');}
        return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>{aborted++;reject(new DOMException('cancel','AbortError'));},{once:true}));
    };
    await assert.rejects(h.context.parseQuestionPaper([{type:'text',content:'first',pageNumber:1},{type:'text',content:'second',pageNumber:2},{type:'text',content:'third',pageNumber:3}]));
    assert.equal(calls,2);assert.equal(aborted,1);assert.equal(h.run('state.runFailure.message'),'QP provider failure');
});
test('internal phase cancellation reports its real failure rather than user cancellation',async()=>{
    const h=harness();h.run("resolvePaperBuffer=async()=>new ArrayBuffer(4);pdfToHybrid=async()=>[{type:'text'}];parseMarkScheme=async()=>{state.runFailure=new Error('invalid MS rules');state.runController.abort();throw state.runFailure;};");
    await h.context.runGradingPipeline();
    assert.equal(h.node('progressTitle').textContent,'批改失败；未生成不完整报告');
    assert.ok(h.node('progressLog').children.some(line=>line.textContent.includes('invalid MS rules')));
});
