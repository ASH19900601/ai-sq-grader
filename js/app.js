/**
 * app.js — 结构题(SQ) AI 批改主逻辑
 * 改编自原站 essay-grader.js。改动：
 *  - 去除账号/收藏/问AI 等依赖后端的功能
 *  - AI 调用改为通过 AppConfig 直连用户配置的 OpenAI 兼容接口
 *  - PDF 下载改用用户在配置中填写的代理地址（可选；否则手动上传 MS）
 *
 * 5 步流水线：选择试卷 → 上传答卷 → 准备 MS → AI 解析 → AI 比对 → 报告
 */

// ===================== 科目数据 =====================
const SUBJECTS_DATA = {
    igcse: [
        { code:'0625', name:'Physics',    peh:'physics-0625',    papers:[{n:4,v:1},{n:4,v:2},{n:4,v:3},{n:6,v:1},{n:6,v:2},{n:6,v:3}] },
        { code:'0620', name:'Chemistry',  peh:'chemistry-0620',  papers:[{n:4,v:1},{n:4,v:2},{n:4,v:3},{n:6,v:1},{n:6,v:2},{n:6,v:3}] },
        { code:'0610', name:'Biology',    peh:'biology-0610',    papers:[{n:4,v:1},{n:4,v:2},{n:4,v:3},{n:6,v:1},{n:6,v:2},{n:6,v:3}] },
        { code:'0580', name:'Mathematics',peh:'mathematics-0580',papers:[{n:2,v:1},{n:2,v:2},{n:4,v:1},{n:4,v:2}] },
    ],
    alevel: [
        { code:'9702', name:'Physics',    peh:'physics-9702',    papers:[{n:4,v:1},{n:4,v:2},{n:4,v:3},{n:5,v:1},{n:5,v:2},{n:5,v:3}] },
        { code:'9701', name:'Chemistry',  peh:'chemistry-9701',  papers:[{n:4,v:1},{n:4,v:2},{n:4,v:3},{n:5,v:1},{n:5,v:2},{n:5,v:3}] },
        { code:'9700', name:'Biology',    peh:'biology-9700',    papers:[{n:4,v:1},{n:4,v:2},{n:4,v:3},{n:5,v:1},{n:5,v:2},{n:5,v:3}] },
        { code:'9709', name:'Mathematics',peh:'mathematics-9709',papers:[{n:1,v:1},{n:1,v:2},{n:1,v:3},{n:3,v:1},{n:3,v:2},{n:3,v:3}] },
        { code:'9708', name:'Economics',  peh:'economics-9708',  papers:[{n:2,v:1},{n:2,v:2},{n:4,v:1},{n:4,v:2}] },
    ]
};

// ===================== State =====================
let state = {
    level: 'alevel', subjectCode: '9702', subjectName: 'Physics', peh: 'physics-9702',
    year: '2023', season: 's', paper: '41',
    userPages: [], msPages: [], msStructure: null, userAnswers: null,
    paperConfirmed: false, manualMsBuf: null,
    apiChoice: 'line1', useDeepseek: false
};

const $ = id => document.getElementById(id);

function log(msg, type = 'info') {
    const logEl = $('progressLog');
    const line = document.createElement('div');
    line.className = `log-line ${type}`;
    line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
}
function setProgress(pct, title) {
    $('progressBarFill').style.width = pct + '%';
    if (title) $('progressTitle').textContent = title;
}
function setPipelineStep(n) {
    document.querySelectorAll('.pipeline-step').forEach((el, i) => {
        el.classList.remove('active', 'done');
        if (i + 1 < n) el.classList.add('done');
        if (i + 1 === n) el.classList.add('active');
    });
}
function unlockSection(id) {
    const el = $(id);
    if (el) { el.classList.remove('locked'); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
}

// ===================== AI 调用封装 =====================
async function callAI(messages, jsonMode = true) {
    const payload = { messages, temperature: 0.1, max_tokens: 4096 };
    if (jsonMode) payload.response_format = { type: 'json_object' };
    const data = await AppConfig.chat(state.apiChoice || 'line1', payload);
    const content = data.choices?.[0]?.message?.content || '';
    return jsonMode ? safeParseJSON(content, data, 'AI') : content;
}
async function callDeepSeek(messages, jsonMode = true) {
    const payload = { messages, temperature: 0.1, max_tokens: 8192 };
    if (jsonMode) payload.response_format = { type: 'json_object' };
    const data = await AppConfig.chat('deepseek', payload);
    const content = data.choices?.[0]?.message?.content || '';
    return jsonMode ? safeParseJSON(content, data, 'DeepSeek') : content;
}
function imageMsg(base64, detail = 'high') {
    return { type: 'image_url', image_url: { url: base64, detail } };
}

// ===================== PDF.js 渲染 =====================
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

async function pdfToHybrid(arrayBuffer, scale = 1.5, isMs = false) {
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        let text = '', hasImages = false;
        try {
            const textContent = await page.getTextContent();
            text = textContent.items.map(item => item.str).join(' ');
            const opList = await page.getOperatorList();
            hasImages = opList.fnArray.includes(pdfjsLib.OPS.paintImageXObject) ||
                        opList.fnArray.includes(pdfjsLib.OPS.paintJpegXObject) ||
                        opList.fnArray.includes(pdfjsLib.OPS.paintInlineImageXObject);

            const isMsCover = text.includes('Maximum Mark') && text.includes('MARK SCHEME');
            const isQpCover = (text.includes('CANDIDATE') && text.includes('NUMBER')) || (text.includes('INSTRUCTIONS') && text.includes('INFORMATION'));
            const isRules = text.includes('Generic Marking Principles') || text.includes('GENERIC MARKING PRINCIPLE') || text.includes('Calculation specific guidance') || text.includes('generic marking principles');
            const isBlank = (text.includes('BLANK PAGE') && text.length < 500) || text.trim().length < 20;

            if (isMs && (isMsCover || isRules || isBlank)) { log(`  ✂️ 裁剪 MS 第 ${i} 页 (封面/规则/空白)`, 'info'); continue; }
            if (!isMs && (isQpCover || isBlank)) { log(`  ✂️ 裁剪答卷 第 ${i} 页 (封面/空白页)`, 'info'); continue; }
        } catch (e) { hasImages = true; }

        if (!hasImages && text.trim().length > 50) {
            log(`  📄 第 ${i} 页检测为纯文本，使用极速文本模式`, 'info');
            pages.push({ type: 'text', content: text });
        } else {
            log(`  🖼️ 第 ${i} 页包含图像/复杂版式，使用视觉图片模式`, 'info');
            const viewport = page.getViewport({ scale });
            const canvas = document.createElement('canvas');
            canvas.width = viewport.width; canvas.height = viewport.height;
            await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
            pages.push({ type: 'image', content: canvas.toDataURL('image/jpeg', 0.85) });
        }
    }
    return pages;
}

async function pdfToImages(arrayBuffer, scale = 1.5, isMs = false, label = '答卷') {
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        try {
            const textContent = await page.getTextContent();
            const text = textContent.items.map(item => item.str).join(' ');
            const isQpCover = (text.includes('CANDIDATE') && text.includes('NUMBER')) || (text.includes('INSTRUCTIONS') && text.includes('INFORMATION'));
            const isBlank = (text.includes('BLANK PAGE') && text.length < 500) || text.trim().length < 20;
            if (!isMs && (isQpCover || isBlank)) { log(`  ✂️ 裁剪${label} 第 ${i} 页 (封面/空白页)`, 'info'); continue; }
        } catch (e) {}
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width; canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        pages.push(canvas.toDataURL('image/jpeg', 0.85));
    }
    return pages;
}

async function imagesToBase64List(files) {
    const results = [];
    for (const file of files) {
        const b64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = e => resolve(e.target.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
        results.push(b64);
    }
    return results;
}

// ===================== 通过代理下载 PDF =====================
async function fetchWithTimeout(url, timeoutMs = 30000) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    try { const resp = await fetch(url, { signal: ctrl.signal }); clearTimeout(tid); return resp; }
    catch (e) { clearTimeout(tid); throw e; }
}

async function fetchPdfViaProxy(targetUrl, label = '', timeoutMs = 30000) {
    const proxyBase = AppConfig.getProxyUrl();
    if (!proxyBase) throw new Error('未配置 PDF 下载代理');
    const proxyUrl = proxyBase + encodeURIComponent(targetUrl);
    log(`  📡 通过代理下载 ${label}...`, 'info');
    const resp = await fetchWithTimeout(proxyUrl, timeoutMs);
    if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`代理返回 HTTP ${resp.status}: ${errText.slice(0, 120)}`);
    }
    const buf = await resp.arrayBuffer();
    if (buf.byteLength <= 5000) throw new Error('返回内容过小，可能不是有效 PDF');
    if (!SQCore.isPdfHeader(buf.slice(0, 4))) throw new Error('代理返回了非 PDF 内容');
    log(`  ✅ ${label} 下载成功 (${Math.round(buf.byteLength / 1024)}KB)`, 'success');
    return buf;
}

function buildBehUrl(type) {
    return SQCore.buildBehUrl(state, type);
}

// ===================== JSON 解析（含截断抢救）=====================
function safeParseJSON(content, data, errorPrefix = 'AI') {
    return SQCore.safeParseJSON(content, data, errorPrefix);
}

// ===================== Step 1: 解析 MS =====================
async function parseMarkScheme(msPages) {
    log('📄 正在并发分析 Mark Scheme...', 'info');
    const textOnly = msPages.every(p => p.type === 'text');
    const shouldUseDeepSeek = state.useDeepseek && textOnly && AppConfig.hasDeepSeek();
    if (shouldUseDeepSeek) log('🤖 检测到纯文本 MS，采用 DeepSeek 解析...', 'info');

    const BATCH = shouldUseDeepSeek ? 1 : 4;
    const promises = [];

    for (let i = 0; i < msPages.length; i += BATCH) {
        const batch = msPages.slice(i, i + BATCH);
        const content = [
            { type: 'text', text: `你是一位 CAIE 考试资深审核员。请仔细阅读以下 Mark Scheme 页面，提取出所有题目的评分结构。

输出格式（严格JSON）：
{
  "questions": [
    { "q_num": "1(a)(i)", "total_marks": 2,
      "mark_points": [ { "point_id": "1(a)(i)-1", "description": "得分点的完整描述（按 MS 原文）", "is_alternative": false, "alternatives": [] } ] }
  ]
}

注意：
- q_num 要完整，如 "1(a)(i)", "2(b)", "3" 等
- 每个 mark_point 是独立的一个得分点
- alternatives 是同一个点的备选答案（MS 上写的 OR ...）
- "allow"/"accept" 开头的宽松得分也要包含
- 忽略表格格式，只关注得分点内容
- 如果这几页没有得分点信息，返回 {"questions": []}` },
            ...batch.map(p => p.type === 'text' ? { type: 'text', text: p.content } : (p.type === 'image' ? imageMsg(p.content) : imageMsg(p)))
        ];

        const caller = shouldUseDeepSeek ? callDeepSeek : callAI;
        const pr = (async () => {
            let result;
            try { result = await caller([{ role: 'user', content }]); }
            catch (e) { log(`  ⚠️ MS 第 ${i + 1} 批解析出错，正在重试...`, 'info'); result = await caller([{ role: 'user', content }]); }
            log(`  ✅ MS 第 ${i + 1}-${Math.min(i + BATCH, msPages.length)} 页解析完成`, 'info');
            return result.questions || [];
        })().catch(e => { log(`  ⚠️ MS 第 ${i + 1} 批解析失败: ${e.message}`, 'error'); return []; });
        promises.push(pr);
    }

    const allQuestions = (await Promise.all(promises)).flat();
    return SQCore.mergeQuestions(allQuestions);
}

// ===================== Step 2: 识别用户答卷 =====================
async function extractUserAnswers(userPages, msStructure) {
    log('✍️ 正在并发识别用户答卷...', 'info');
    const questionList = msStructure.map(q => q.q_num).join(', ');
    const promises = [];

    for (let i = 0; i < userPages.length; i++) {
        const page = userPages[i];
        const content = [
            { type: 'text', text: `你是一位顶级 OCR 专家，专门负责识别 CAIE 学生的手写答卷。
请极其仔细地识别以下图片中学生的所有手写答案。

本次试卷包含的题目编号为：${questionList}

输出格式（严格JSON）：
{ "answers": [ { "q_num": "1(a)(i)", "answer_text": "学生写的所有内容（包括对图形的描述）", "confidence": "high/medium/low" } ] }

非常关键的警告：
1. q_num 必须与页面上印刷的题目编号完全一致。
2. 学生字迹可能潦草、轻微或写在边角，请逐行扫描。
3. 只要在答题区域内看到任何手写笔迹，绝对不能判断为空白，尽力提取每一个字。
4. 【画图题特判】遇到画图题（示意图、化学结构式、坐标图等）请结合图片用文字详细描述学生画的内容，不能因只有图没文字就判未作答。
5. 只有 100% 确认完全没有任何笔迹且没有画图时，才把 answer_text 写为"（未作答）"。
6. 忽略印刷的题目本身，只识别学生手写和手画的内容。` },
            (page.type === 'text' ? { type: 'text', text: page.content } : (page.type === 'image' ? imageMsg(page.content) : imageMsg(page)))
        ];

        const pr = (async () => {
            let result;
            try { result = await callAI([{ role: 'user', content }]); }
            catch (e) { log(`  ⚠️ 答卷第 ${i + 1} 页初次识别出错，正在重试...`, 'info'); result = await callAI([{ role: 'user', content }]); }
            log(`  ✅ 答卷第 ${i + 1} 页识别完成`, 'info');
            return result.answers || [];
        })().catch(e => { log(`  ⚠️ 答卷第 ${i + 1} 页识别失败: ${e.message}`, 'error'); return []; });
        promises.push(pr);
    }

    const allAnswers = (await Promise.all(promises)).flat();
    return SQCore.mergeAnswers(allAnswers);
}

// ===================== Step 3: 逐得分点比对 =====================
async function compareAnswers(msStructure, userAnswers) {
    const textOnly = state.msPages && state.msPages.length > 0 && state.msPages.every(p => p.type === 'text');
    const shouldUseDeepSeek = state.useDeepseek && textOnly && AppConfig.hasDeepSeek();
    const caller = shouldUseDeepSeek ? callDeepSeek : callAI;
    log(shouldUseDeepSeek ? '🤖 AI 正在使用 DeepSeek 并发比对...' : '🤖 AI 正在并发比对所有题目...', 'info');

    let completed = 0;
    const totalQ = msStructure.length;

    const promises = msStructure.map(async (question) => {
        const userAns = userAnswers[question.q_num];
        const studentText = userAns ? userAns.answer_text : '（未作答）';
        const qResult = { q_num: question.q_num, total_marks: question.total_marks, student_answer: studentText, point_results: [] };
        if (question.mark_points.length === 0) return qResult;

        const pointsPrompt = question.mark_points.map(p =>
            `[ID: ${p.point_id}]\n描述: ${p.description}\n${p.alternatives && p.alternatives.length > 0 ? '备选: ' + p.alternatives.join(' | ') : ''}`
        ).join('\n\n');

        const content = `你是一位严格的 CAIE 考试评卷官，精通 ${state.subjectName}。

【学生在该题 (${question.q_num}) 写的全部内容】
${studentText}

【官方 Mark Scheme 得分点列表】
请逐一判断以下得分点的获得情况，只能从4个状态选一个：明确正确、疑似正确、错误、MS之外。并给出简短中文理由（15字以内）。

${pointsPrompt}

返回严格JSON：
{ "results": [ { "point_id": "得分点ID", "status": "明确正确|疑似正确|错误|MS之外", "reason": "简短理由" } ] }`;

        try {
            let res;
            try { res = await caller([{ role: 'user', content: [{ type: 'text', text: content }] }]); }
            catch (e) { log(`  ⚠️ 题目 ${question.q_num} 初次比对出错，正在重试...`, 'info'); res = await caller([{ role: 'user', content: [{ type: 'text', text: content }] }]); }
            const resultMap = {};
            if (res.results) for (const r of res.results) resultMap[r.point_id] = r;
            for (const p of question.mark_points) {
                const r = resultMap[p.point_id];
                qResult.point_results.push({ point_id: p.point_id, description: p.description, status: r ? r.status : '错误', reason: r ? r.reason : '未评估' });
            }
        } catch (e) {
            log(`  ⚠️ 题目 ${question.q_num} 比对失败: ${e.message}`, 'error');
            for (const p of question.mark_points) qResult.point_results.push({ point_id: p.point_id, description: p.description, status: '错误', reason: 'AI比对异常' });
        }
        completed++;
        setProgress(60 + (completed / totalQ) * 35, `AI 并发比对中 (${completed}/${totalQ})...`);
        return qResult;
    });

    const results = await Promise.all(promises);
    results.sort((a, b) => msStructure.findIndex(q => q.q_num === a.q_num) - msStructure.findIndex(q => q.q_num === b.q_num));
    return results;
}

// ===================== 渲染结果 =====================
function escHtml(s) { return SQCore.escHtml(s); }
function badgeHtml(status) { return SQCore.badgeHtml(status); }

function renderResults(results) {
    const container = $('resultsContainer');
    container.innerHTML = '';

    for (const q of results) {
        const gotPoints = q.point_results.filter(p => p.status === '明确正确').length;
        const possiblePoints = q.point_results.filter(p => p.status === '疑似正确').length;

        const card = document.createElement('div');
        card.className = 'question-card';
        card.innerHTML = `
            <div class="question-header" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none'">
                <span class="question-title">题目 ${escHtml(q.q_num)}</span>
                <span class="question-score">预计 ${gotPoints}${possiblePoints > 0 ? '+' + possiblePoints + '?' : ''} / ${q.total_marks} 分</span>
            </div>
            <div class="question-body">
                <div class="student-answer-box"><strong>你的答案：</strong>${escHtml(q.student_answer)}</div>
                <div style="margin-top:0.8rem;">
                    ${q.point_results.map(pr => `
                    <div class="mark-point-row">
                        <div class="mp-description"><strong>得分点</strong>${escHtml(pr.description)}</div>
                        <div class="mp-status">${badgeHtml(pr.status)}</div>
                        <div class="mp-reason">${escHtml(pr.reason)}</div>
                    </div>`).join('')}
                </div>
            </div>`;
        container.appendChild(card);
    }

    const report = SQCore.computeReport(results);
    $('totalScore').textContent = report.totalGot;
    $('maxScore').textContent = report.totalMax;
    $('scoreRate').textContent = report.rate;
}

// ===================== 主流水线 =====================
async function runGradingPipeline() {
    $('sectionProgress').style.display = 'block';
    $('sectionProgress').scrollIntoView({ behavior: 'smooth' });
    $('progressIcon').className = 'fas fa-spinner fa-spin';

    try {
        setPipelineStep(3);
        setProgress(5, '正在准备 Mark Scheme...');

        let msBuf = state.manualMsBuf || null;
        if (!msBuf) {
            if (!AppConfig.getProxyUrl()) {
                throw new Error('未配置下载代理，且未手动上传 MS。请在「配置」中填写代理，或使用「手动上传 MS」。');
            }
            try {
                msBuf = await fetchPdfViaProxy(buildBehUrl('ms'), 'MS');
            } catch (e) {
                throw new Error(`MS 自动下载失败 (${e.message})。请使用「手动上传 MS」按钮上传后重试。`);
            }
        } else {
            log('  ✅ 使用手动上传的 MS', 'success');
        }

        setProgress(10, '正在智能解析 MS 结构...');
        log('🖼️ 正在混合提取 MS PDF（文本+图片智能感知）...', 'info');
        state.msPages = await pdfToHybrid(msBuf, 1.5, true);
        log(`  MS 裁剪后共保留 ${state.msPages.length} 页`, 'info');

        setPipelineStep(4);
        setProgress(15, 'AI 正在解析 MS 得分点...');
        const msStructure = await parseMarkScheme(state.msPages);
        log(`  ✅ MS 解析完成，共识别 ${msStructure.length} 道题`, 'success');
        if (msStructure.length === 0) throw new Error('MS 解析结果为空，请检查所选试卷是否含结构题 MS，或更换上传文件。');
        state.msStructure = msStructure;

        setProgress(35, 'AI 正在识别用户答卷...');
        const userAnswers = await extractUserAnswers(state.userPages, msStructure);
        log(`  ✅ 答卷识别完成，共识别 ${Object.keys(userAnswers).length} 道题`, 'success');
        state.userAnswers = userAnswers;

        setProgress(60, 'AI 逐点比对...');
        const compResults = await compareAnswers(msStructure, userAnswers);
        setProgress(95, '生成报告...');

        setPipelineStep(5);
        setProgress(100, '完成！');
        $('progressIcon').className = 'fas fa-check-circle';
        $('sectionResults').style.display = 'block';
        $('sectionResults').scrollIntoView({ behavior: 'smooth' });
        renderResults(compResults);
    } catch (e) {
        log(`❌ 错误: ${e.message}`, 'error');
        $('progressIcon').className = 'fas fa-times-circle';
        $('progressTitle').textContent = '批改失败，请检查上方错误信息';
    }
}

// ===================== UI 初始化 =====================
document.addEventListener('DOMContentLoaded', () => {
    AppConfig.initUI(refreshConfigState);

    const configBanner = $('configBanner');
    const apiSelect = $('eg-api');

    function refreshConfigState() {
        const lines = AppConfig.availableVisionLines();
        apiSelect.innerHTML = '';
        if (lines.length === 0) {
            const opt = document.createElement('option');
            opt.value = ''; opt.textContent = '（请先配置 API）';
            apiSelect.appendChild(opt);
        } else {
            lines.forEach(l => {
                const opt = document.createElement('option');
                opt.value = l.key; opt.textContent = l.label;
                apiSelect.appendChild(opt);
            });
        }
        configBanner.style.display = AppConfig.isConfigured() ? 'none' : 'flex';
    }
    refreshConfigState();
    if (!AppConfig.isConfigured()) AppConfig.openModal();

    // 科目/试卷/年份
    function populateSubjects() {
        const lvl = $('eg-level').value;
        const subj = $('eg-subject');
        const subjects = SUBJECTS_DATA[lvl] || [];
        subj.innerHTML = '';
        subjects.forEach(s => {
            const o = document.createElement('option');
            o.value = s.code; o.dataset.peh = s.peh; o.dataset.name = s.name;
            o.dataset.papers = JSON.stringify(s.papers);
            o.textContent = `${s.name} (${s.code})`;
            subj.appendChild(o);
        });
        populatePapers();
    }
    function populatePapers() {
        const sel = $('eg-subject').options[$('eg-subject').selectedIndex];
        const pp = $('eg-paper');
        pp.innerHTML = '';
        if (!sel) { return; }
        let papers = [];
        try { papers = JSON.parse(sel.dataset.papers || '[]'); } catch (e) {}
        papers.forEach(p => {
            const o = document.createElement('option');
            o.value = `${p.n}${p.v}`; o.textContent = `Paper ${p.n}, Variant ${p.v}`;
            pp.appendChild(o);
        });
    }
    function populateYears() {
        const yr = $('eg-year');
        yr.innerHTML = '';
        for (let y = 2025; y >= 2015; y--) {
            const o = document.createElement('option');
            o.value = y; o.textContent = y; yr.appendChild(o);
        }
    }
    $('eg-level').addEventListener('change', populateSubjects);
    $('eg-subject').addEventListener('change', populatePapers);
    populateSubjects();
    populateYears();

    // 确认试卷
    $('paperSelectForm').addEventListener('submit', e => {
        e.preventDefault();
        if (!AppConfig.isConfigured()) { alert('请先配置 AI 接口信息。'); AppConfig.openModal(); return; }
        const sel = $('eg-subject').options[$('eg-subject').selectedIndex];
        if (!sel || !$('eg-paper').value) { alert('请先选择有效的科目和试卷。'); return; }
        state.level = $('eg-level').value;
        state.subjectCode = $('eg-subject').value;
        state.subjectName = sel.dataset.name;
        state.peh = sel.dataset.peh;
        state.year = $('eg-year').value;
        state.season = $('eg-season').value;
        state.paper = $('eg-paper').value;
        state.apiChoice = apiSelect.value || 'line1';
        state.useDeepseek = $('eg-use-deepseek') ? $('eg-use-deepseek').checked : false;
        state.paperConfirmed = true;
        setPipelineStep(2);
        unlockSection('sectionUpload');
    });

    // Tab 切换
    window.switchTab = (tab) => {
        $('tabContentPdf').style.display = tab === 'pdf' ? '' : 'none';
        $('tabContentImages').style.display = tab === 'images' ? '' : 'none';
        $('tabPdf').classList.toggle('active', tab === 'pdf');
        $('tabImages').classList.toggle('active', tab === 'images');
    };

    // PDF 上传
    $('pdfInput').addEventListener('change', async e => {
        const file = e.target.files[0];
        if (!file) return;
        $('pdfPreviewInfo').style.display = 'block';
        $('pdfPreviewInfo').textContent = `已选择: ${file.name}，正在渲染...`;
        const buf = await file.arrayBuffer();
        state.userPages = await pdfToImages(buf, 1.5, false, '答卷');
        $('pdfPreviewInfo').textContent = `✅ 已加载 ${file.name}，裁剪后保留 ${state.userPages.length} 页`;
        $('startGradingBtn').disabled = false;
    });

    // 图片上传
    $('imgInput').addEventListener('change', async e => {
        const files = Array.from(e.target.files);
        state.userPages = await imagesToBase64List(files);
        const grid = $('imgPreviewArea');
        grid.innerHTML = '';
        files.forEach((f, i) => {
            const img = document.createElement('img');
            img.src = state.userPages[i]; img.alt = `Page ${i + 1}`;
            grid.appendChild(img);
        });
        $('startGradingBtn').disabled = false;
    });

    // 拖拽
    ['pdfDropzone', 'imgDropzone'].forEach(id => {
        const el = $(id);
        if (!el) return;
        el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('dragging'); });
        el.addEventListener('dragleave', () => el.classList.remove('dragging'));
        el.addEventListener('drop', e => {
            e.preventDefault(); el.classList.remove('dragging');
            const files = e.dataTransfer.files;
            if (id === 'pdfDropzone' && files[0]?.type === 'application/pdf') {
                $('pdfInput').files = files; $('pdfInput').dispatchEvent(new Event('change'));
            } else if (id === 'imgDropzone') {
                $('imgInput').files = files; $('imgInput').dispatchEvent(new Event('change'));
            }
        });
    });

    // 手动上传 MS
    $('manualMsInput').addEventListener('change', async e => {
        const file = e.target.files[0];
        if (!file) return;
        const statusEl = $('manualMsStatus');
        const labelEl = document.querySelector('.ms-upload-label');
        statusEl.textContent = '正在加载...';
        try {
            state.manualMsBuf = await file.arrayBuffer();
            statusEl.textContent = `✅ ${file.name} (${Math.round(state.manualMsBuf.byteLength / 1024)}KB) — 已就绪`;
            if (labelEl) { labelEl.classList.add('has-file'); labelEl.querySelector('i').className = 'fas fa-check-circle'; }
        } catch (err) {
            statusEl.textContent = '❌ 读取失败，请重试';
        }
    });

    // 开始批改
    $('startGradingBtn').addEventListener('click', () => {
        if (!state.paperConfirmed) { alert('请先确认试卷！'); return; }
        if (state.userPages.length === 0) { alert('请先上传答卷！'); return; }
        setPipelineStep(3);
        runGradingPipeline();
    });
});
