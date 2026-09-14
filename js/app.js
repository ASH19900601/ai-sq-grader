/** Main five-stage grading pipeline. */

const makePapers = numbers => numbers.flatMap(n => [1, 2, 3].map(v => ({ n, v })));
const SUBJECTS_DATA = {
    igcse: [
        { code: '0625', name: 'Physics', peh: 'physics-0625', papers: makePapers([1, 2, 3, 4, 5, 6]) },
        { code: '0620', name: 'Chemistry', peh: 'chemistry-0620', papers: makePapers([1, 2, 3, 4, 5, 6]) },
        { code: '0610', name: 'Biology', peh: 'biology-0610', papers: makePapers([1, 2, 3, 4, 5, 6]) },
        { code: '0580', name: 'Mathematics', peh: 'mathematics-0580', papers: makePapers([1, 2, 3, 4]) }
    ],
    alevel: [
        { code: '9702', name: 'Physics', peh: 'physics-9702', papers: makePapers([1, 2, 3, 4, 5]) },
        { code: '9701', name: 'Chemistry', peh: 'chemistry-9701', papers: makePapers([1, 2, 3, 4, 5]) },
        { code: '9700', name: 'Biology', peh: 'biology-9700', papers: makePapers([1, 2, 3, 4, 5]) },
        { code: '9709', name: 'Mathematics', peh: 'mathematics-9709', papers: makePapers([1, 2, 3, 4, 5, 6]) },
        { code: '9708', name: 'Economics', peh: 'economics-9708', papers: makePapers([1, 2, 3, 4]) }
    ]
};

let state = {
    level: 'alevel', subjectCode: '9702', subjectName: 'Physics', peh: 'physics-9702',
    year: String(new Date().getFullYear()), season: 's', paper: '21',
    userPages: [], msPages: [], qpPages: [], msStructure: null, qpStructure: null, userAnswers: null,
    paperConfirmed: false, confirmedPaperId: '', manualMsBuf: null, manualQpBuf: null,
    apiChoice: 'line1', useDeepseek: false, runController: null
};

const $ = id => document.getElementById(id);
const signal = () => state.runController?.signal;

function log(message, type = 'info') {
    const logEl = $('progressLog');
    if (!logEl) return;
    const line = document.createElement('div');
    line.className = `log-line ${type}`;
    line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
}

function setProgress(percent, title) {
    if ($('progressBarFill')) $('progressBarFill').style.width = `${Math.max(0, Math.min(100, percent))}%`;
    if (title && $('progressTitle')) $('progressTitle').textContent = title;
}

function setPipelineStep(number) {
    document.querySelectorAll('.pipeline-step').forEach((element, index) => {
        element.classList.remove('active', 'done');
        if (index + 1 < number) element.classList.add('done');
        if (index + 1 === number) element.classList.add('active');
    });
}

function unlockSection(id) {
    const element = $(id);
    if (element) element.classList.remove('locked');
}

function requireArrayResult(result, key, stage) {
    if (!result || !Array.isArray(result[key])) throw new Error(`${stage} 返回缺少 ${key} 数组`);
    return result[key];
}

async function callModel(lineKey, messages, maxTokens = 4096) {
    const payload = { messages, temperature: 0.1, max_tokens: maxTokens, response_format: { type: 'json_object' } };
    const data = await AppConfig.chat(lineKey, payload, { signal: signal(), retries: 3, timeoutMs: 60000 });
    const content = data.choices?.[0]?.message?.content || '';
    return SQCore.safeParseJSON(content, data, lineKey === 'deepseek' ? 'DeepSeek' : 'AI');
}

function callAI(messages) { return callModel(state.apiChoice || 'line1', messages, 4096); }
function callDeepSeek(messages) { return callModel('deepseek', messages, 8192); }
function imageMsg(base64, detail = 'high') { return { type: 'image_url', image_url: { url: base64, detail } }; }

pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';

async function inspectPdfPage(page) {
    let text = '';
    let hasImages = false;
    try {
        const textContent = await page.getTextContent();
        text = textContent.items.map(item => item.str).join(' ');
    } catch (_) {}
    try {
        const opList = await page.getOperatorList();
        const imageOps = [pdfjsLib.OPS.paintImageXObject, pdfjsLib.OPS.paintJpegXObject, pdfjsLib.OPS.paintInlineImageXObject].filter(Number.isFinite);
        hasImages = opList.fnArray.some(op => imageOps.includes(op));
    } catch (_) {
        hasImages = true;
    }
    return { text, hasImages };
}

async function renderPdfPage(page, scale) {
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    return canvas.toDataURL('image/jpeg', 0.88);
}

async function pdfToHybrid(arrayBuffer, scale = 1.5, isMs = false, label = 'PDF') {
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const pages = [];
    for (let number = 1; number <= pdf.numPages; number++) {
        if (signal()?.aborted) throw new DOMException('批改已取消', 'AbortError');
        const page = await pdf.getPage(number);
        const inspection = await inspectPdfPage(page);
        const decision = SQCore.classifyPdfPage({ ...inspection, isMs });
        if (decision.skip) {
            log(`  ✂️ 跳过 ${label} 第 ${number} 页（${decision.reason}）`, 'info');
            continue;
        }
        if (decision.mode === 'text') {
            log(`  📄 ${label} 第 ${number} 页使用文本模式`, 'info');
            pages.push({ type: 'text', content: inspection.text, pageNumber: number });
        } else {
            log(`  🖼️ ${label} 第 ${number} 页保留为图像（扫描/图表/复杂版式）`, 'info');
            pages.push({ type: 'image', content: await renderPdfPage(page, scale), pageNumber: number });
        }
    }
    return pages;
}

async function pdfToAnswerImages(arrayBuffer, scale = 1.5) {
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const pages = [];
    for (let number = 1; number <= pdf.numPages; number++) {
        if (signal()?.aborted) throw new DOMException('批改已取消', 'AbortError');
        const page = await pdf.getPage(number);
        const inspection = await inspectPdfPage(page);
        const decision = SQCore.classifyPdfPage({ ...inspection, isMs: false });
        if (decision.skip) {
            log(`  ✂️ 跳过答卷第 ${number} 页（${decision.reason}）`, 'info');
            continue;
        }
        pages.push({ type: 'image', content: await renderPdfPage(page, scale), pageNumber: number });
    }
    return pages;
}

async function imagesToPages(files) {
    const pages = [];
    for (const [index, file] of files.entries()) {
        const content = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = event => resolve(event.target.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
        pages.push({ type: 'image', content, pageNumber: index + 1 });
    }
    return pages;
}

async function fetchWithTimeout(url, timeoutMs = 30000) {
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    signal()?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try { return await fetch(url, { signal: controller.signal }); }
    catch (error) {
        if (timedOut && !signal()?.aborted) throw new Error(`代理请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
        throw error;
    }
    finally {
        clearTimeout(timeout);
        signal()?.removeEventListener('abort', onAbort);
    }
}

async function fetchPdfViaProxy(targetUrl, label, timeoutMs = 30000) {
    const proxyBase = AppConfig.getProxyUrl();
    if (!proxyBase) throw new Error('未配置 PDF 下载代理');
    log(`  📡 通过代理下载 ${label}...`, 'info');
    const response = await fetchWithTimeout(proxyBase + encodeURIComponent(targetUrl), timeoutMs);
    if (!response.ok) throw new Error(`代理返回 HTTP ${response.status}: ${(await response.text().catch(() => '')).slice(0, 120)}`);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength <= 5000 || !SQCore.isPdfHeader(buffer.slice(0, 4))) throw new Error('代理返回的内容不是有效 PDF');
    log(`  ✅ ${label} 下载成功 (${Math.round(buffer.byteLength / 1024)}KB)`, 'success');
    return buffer;
}

function buildBehUrl(type) { return SQCore.buildBehUrl(state, type); }

async function parseMarkScheme(msPages) {
    log('📄 正在限流解析 Mark Scheme...', 'info');
    const textOnly = msPages.every(page => page.type === 'text');
    const useDeepSeek = state.useDeepseek && textOnly && AppConfig.hasDeepSeek();
    const caller = useDeepSeek ? callDeepSeek : callAI;
    const batchSize = useDeepSeek ? 1 : 3;
    const batches = [];
    for (let i = 0; i < msPages.length; i += batchSize) batches.push({ start: i, pages: msPages.slice(i, i + batchSize) });
    const parsed = await SQCore.mapWithConcurrency(batches, 2, async batch => {
        const content = [{ type: 'text', text: `你是 CAIE 资深审核员。完整提取这些 Mark Scheme 页面的题目与评分规则。不要把每一行机械地当作独立一分。

严格返回 JSON：
{"questions":[{"q_num":"1(a)(i)","total_marks":2,"general_rules":[],"mark_points":[{"point_id":"1(a)(i)-M1","description":"MS原意","mark_type":"M|A|B|SC|FT","marks":1,"alternatives":[],"depends_on":[],"group_id":"","group_max":null,"route_id":"","follow_through":false,"not_from_wrong_working":false,"ignore_subsequent_working":false,"rule_notes":""}]}]}

规则：
- 准确保留 M、A、B、SC、FT、dep、follow-through、not from wrong working、ignore subsequent working。
- A 分依赖 M 分时，把 M 的 point_id 写入 depends_on。
- “any N from”及多路线共享上限：同组写相同 group_id 和 group_max；OR 路线写 route_id。
- alternatives 只用于同一得分点的等价答案；marks 是该点分值。
- 没有得分内容时返回 {"questions":[]}。` },
        ...batch.pages.map(page => page.type === 'text' ? { type: 'text', text: `\n[MS page ${page.pageNumber}]\n${page.content}` } : imageMsg(page.content))];
        const result = await caller([{ role: 'user', content }]);
        const questions = requireArrayResult(result, 'questions', `MS 第 ${batch.start + 1} 批`);
        log(`  ✅ MS 保留页 ${batch.start + 1}-${batch.start + batch.pages.length} 解析完成`, 'success');
        return questions;
    }, signal());
    return SQCore.mergeQuestions(parsed.flat());
}

async function parseQuestionPaper(qpPages) {
    log('📘 正在限流解析 Question Paper 题干...', 'info');
    const parsed = await SQCore.mapWithConcurrency(qpPages, 2, async (page, index) => {
        const content = [{ type: 'text', text: `提取这张 CAIE Question Paper 页面中的每个小题。保留 command word、给定数据、公式、图表/示意图的关键信息。严格返回 JSON：{"questions":[{"q_num":"1(a)(i)","question_text":"完整题意"}]}。没有题目则返回空数组。` },
            page.type === 'text' ? { type: 'text', text: page.content } : imageMsg(page.content)];
        const result = await callAI([{ role: 'user', content }]);
        const questions = requireArrayResult(result, 'questions', `QP 第 ${page.pageNumber} 页`);
        for (const question of questions) question.source_pages = [index];
        log(`  ✅ QP 第 ${page.pageNumber} 页解析完成`, 'success');
        return questions;
    }, signal());
    return SQCore.mergeQuestionContexts(parsed.flat());
}

async function extractUserAnswers(userPages, msStructure) {
    log('✍️ 正在限流识别答卷...', 'info');
    const questionList = msStructure.map(q => q.q_num).join(', ');
    const parsed = await SQCore.mapWithConcurrency(userPages, 3, async (page, index) => {
        const content = [{ type: 'text', text: `你是 CAIE 手写答卷 OCR 专家。识别本页学生的全部手写/手画内容，并对应到这些题号：${questionList}。
严格返回 JSON：{"answers":[{"q_num":"1(a)(i)","answer_text":"所有书写内容及图形简述","confidence":"high|medium|low"}]}。
不要遗漏轻微字迹、边角计算、结构式、曲线、箭头或标注。只有确认完全无作答时才写“（未作答）”。文字转录用于索引；最终判分还会直接查看原图。` }, imageMsg(page.content)];
        const result = await callAI([{ role: 'user', content }]);
        const answers = requireArrayResult(result, 'answers', `答卷第 ${page.pageNumber} 页`);
        for (const answer of answers) answer.source_page = index;
        log(`  ✅ 答卷第 ${page.pageNumber} 页识别完成`, 'success');
        return answers;
    }, signal());
    return SQCore.mergeAnswers(parsed.flat());
}

function contextForQuestion(qNum, contexts) {
    if (contexts[qNum]) return contexts[qNum];
    const key = Object.keys(contexts).find(candidate => candidate.startsWith(qNum) || qNum.startsWith(candidate));
    return key ? contexts[key] : { question_text: '（未能提取对应题干）', source_pages: [] };
}

function appendSourceImages(content, pages, indexes, label) {
    const unique = [...new Set(indexes || [])].filter(index => pages[index]?.type === 'image');
    for (const index of unique) {
        content.push({ type: 'text', text: `[${label}，原 PDF 第 ${pages[index].pageNumber} 页]` });
        content.push(imageMsg(pages[index].content));
    }
}

async function compareAnswers(msStructure, userAnswers, qpStructure) {
    // Raw QP/answer images are always attached, so the final pass must use a vision line.
    const caller = callAI;
    log('🤖 AI 正在限流逐题判分，并直接查看题干与答卷原图...', 'info');
    let completed = 0;
    return SQCore.mapWithConcurrency(msStructure, 3, async question => {
        const userAnswer = userAnswers[question.q_num];
        const studentText = userAnswer?.answer_text || '（未作答）';
        const qpContext = contextForQuestion(question.q_num, qpStructure);
        const qResult = { q_num: question.q_num, total_marks: question.total_marks, student_answer: studentText, point_results: [], assessment_complete: true };
        if (!question.mark_points.length) return qResult;
        const ruleJson = JSON.stringify({ general_rules: question.general_rules, mark_points: question.mark_points }, null, 2);
        const prompt = `你是严格的 CAIE ${state.subjectName} 评卷官。请依据题干、原始答卷图像和结构化 MS 逐点评估证据。

【题号】${question.q_num}
【QP 题干】${qpContext.question_text || '（未提取到文字，请查看随附QP原图）'}
【OCR 转录（只作索引，原图优先）】${studentText}
【MS 规则】${ruleJson}

逐个 point_id 返回：明确正确、疑似正确、错误、MS之外。只判断该点的证据是否满足；依赖分与组上限由程序确定执行。FT、SC、not from wrong working、ignore subsequent working 等仍须按 rule_notes 判断。理由不超过25字。
严格返回 JSON：{"results":[{"point_id":"...","status":"明确正确|疑似正确|错误|MS之外","reason":"..."}]}`;
        const messageContent = [{ type: 'text', text: prompt }];
        const qpIndexes = qpContext.source_pages?.length ? qpContext.source_pages : state.qpPages.map((_, index) => index);
        const answerIndexes = userAnswer?.source_pages?.length ? userAnswer.source_pages : state.userPages.map((_, index) => index);
        appendSourceImages(messageContent, state.qpPages, qpIndexes, 'QP原图');
        appendSourceImages(messageContent, state.userPages, answerIndexes, '学生答卷原图');
        try {
            const response = await caller([{ role: 'user', content: messageContent }]);
            const rows = requireArrayResult(response, 'results', `题目 ${question.q_num}`);
            const resultMap = new Map(rows.map(row => [String(row.point_id), row]));
            for (const point of question.mark_points) {
                const row = resultMap.get(point.point_id);
                const status = row ? SQCore.normalizeStatus(row.status) : '未评估';
                if (status === '未评估') qResult.assessment_complete = false;
                qResult.point_results.push({ ...point, status, reason: row ? String(row.reason || '') : '模型未返回该得分点' });
            }
        } catch (error) {
            qResult.assessment_complete = false;
            log(`  ⚠️ 题目 ${question.q_num} 未能完成评估：${error.message}`, 'error');
            qResult.point_results = question.mark_points.map(point => ({ ...point, status: '未评估', reason: 'API或解析异常' }));
        }
        completed++;
        setProgress(62 + (completed / msStructure.length) * 32, `AI 判分中 (${completed}/${msStructure.length})...`);
        return qResult;
    }, signal());
}

function renderResults(results) {
    const container = $('resultsContainer');
    container.innerHTML = '';
    for (const question of results) {
        const score = SQCore.scoreQuestion(question);
        const card = document.createElement('div');
        card.className = `question-card${score.incomplete ? ' incomplete' : ''}`;
        const rules = question.point_results.map(point => {
            const award = score.awards[point.point_id] || 0;
            const rule = [point.mark_type, point.depends_on?.length ? `依赖 ${point.depends_on.join(', ')}` : '', point.group_id ? `组上限 ${point.group_max}` : ''].filter(Boolean).join(' · ');
            return `<div class="mark-point-row"><div class="mp-description"><strong>${SQCore.escHtml(point.point_id)} · ${SQCore.escHtml(rule)}</strong>${SQCore.escHtml(point.description)}</div><div class="mp-status">${SQCore.badgeHtml(point.status)}<small>计 ${award} 分</small></div><div class="mp-reason">${SQCore.escHtml(point.reason)}</div></div>`;
        }).join('');
        card.innerHTML = `<button type="button" class="question-header"><span class="question-title">题目 ${SQCore.escHtml(question.q_num)}</span><span class="question-score">${score.incomplete ? '评估未完成 · ' : ''}预计 ${score.got}${score.possible ? `+${score.possible}?` : ''} / ${score.max} 分</span></button><div class="question-body"><div class="student-answer-box"><strong>答案转录：</strong>${SQCore.escHtml(question.student_answer)}</div><div class="mark-points">${rules}</div></div>`;
        card.querySelector('.question-header').addEventListener('click', () => {
            const body = card.querySelector('.question-body');
            body.hidden = !body.hidden;
        });
        container.appendChild(card);
    }
    const report = SQCore.computeReport(results);
    $('totalScore').textContent = report.incomplete ? `${report.totalGot}+?` : report.totalGot;
    $('maxScore').textContent = report.totalMax;
    $('scoreRate').textContent = report.rate;
    $('incompleteWarning').style.display = report.incomplete ? 'block' : 'none';
    if (report.incomplete) $('incompleteWarning').textContent = `有 ${report.incompleteQuestions} 道题未完成评估；已确认得分仅是下限，不计算得分率。请重试。`;
}

async function resolvePaperBuffer(type) {
    const manual = type === 'ms' ? state.manualMsBuf : state.manualQpBuf;
    const label = type.toUpperCase();
    if (manual) { log(`  ✅ 使用手动上传的 ${label}`, 'success'); return manual; }
    if (!AppConfig.getProxyUrl()) throw new Error(`未配置下载代理且未手动上传 ${label}。请上传 ${label} 后重试。`);
    try { return await fetchPdfViaProxy(buildBehUrl(type), label); }
    catch (error) { throw new Error(`${label} 自动下载失败（${error.message}）。请手动上传后重试。`); }
}

async function runGradingPipeline() {
    state.runController = new AbortController();
    $('progressLog').innerHTML = '';
    $('sectionProgress').style.display = 'block';
    $('sectionResults').style.display = 'none';
    $('progressIcon').className = 'fas fa-spinner fa-spin';
    $('startGradingBtn').disabled = true;
    $('cancelGradingBtn').style.display = 'inline-flex';
    try {
        setPipelineStep(3);
        setProgress(4, '正在准备 QP 与 MS...');
        const msBuffer = await resolvePaperBuffer('ms');
        const qpBuffer = await resolvePaperBuffer('qp');
        state.msPages = await pdfToHybrid(msBuffer, 1.5, true, 'MS');
        state.qpPages = await pdfToHybrid(qpBuffer, 1.5, false, 'QP');
        if (!state.msPages.length || !state.qpPages.length) throw new Error('QP 或 MS 未保留任何有效页面。');

        setPipelineStep(4);
        setProgress(15, 'AI 正在解析 MS 规则...');
        state.msStructure = await parseMarkScheme(state.msPages);
        if (!state.msStructure.length) throw new Error('MS 解析结果为空。');
        const invalidMsQuestion = state.msStructure.find(question => question.total_marks <= 0 || !question.mark_points.length);
        if (invalidMsQuestion) throw new Error(`MS 题目 ${invalidMsQuestion.q_num} 的分值或得分点不完整；为避免错误计分，本次停止。`);
        setProgress(32, 'AI 正在解析 QP 题干...');
        state.qpStructure = await parseQuestionPaper(state.qpPages);
        if (!Object.keys(state.qpStructure).length) throw new Error('QP 解析结果为空。');
        setProgress(47, 'AI 正在识别答卷...');
        state.userAnswers = await extractUserAnswers(state.userPages, state.msStructure);
        if (!Object.keys(state.userAnswers).length) throw new Error('答卷识别结果为空；为避免把处理失败当作未作答，本次不生成报告。');

        setProgress(62, 'AI 正在逐题判分...');
        const results = await compareAnswers(state.msStructure, state.userAnswers, state.qpStructure);
        setProgress(96, '正在生成报告...');
        renderResults(results);
        setPipelineStep(5);
        setProgress(100, '完成');
        $('progressIcon').className = 'fas fa-check-circle';
        $('sectionResults').style.display = 'block';
        $('sectionResults').scrollIntoView({ behavior: 'smooth' });
    } catch (error) {
        if (error.name === 'AbortError' || signal()?.aborted) {
            log('⏹️ 批改已取消，没有生成不完整报告。', 'info');
            $('progressTitle').textContent = '已取消';
        } else {
            state.runController?.abort();
            log(`❌ ${error.message}`, 'error');
            $('progressTitle').textContent = '批改失败；未生成不完整报告';
        }
        $('progressIcon').className = 'fas fa-times-circle';
    } finally {
        state.runController = null;
        $('cancelGradingBtn').style.display = 'none';
        updateStartButton();
    }
}

function paperIdentityFromForm() {
    return [$('eg-level').value, $('eg-subject').value, $('eg-year').value, $('eg-season').value, $('eg-paper').value].join(':');
}

function resetArtifactUI() {
    for (const id of ['manualMsInput', 'manualQpInput', 'pdfInput', 'imgInput']) if ($(id)) $(id).value = '';
    $('manualMsStatus').textContent = '点击或拖入 MS PDF 文件';
    $('manualQpStatus').textContent = '点击或拖入 QP PDF 文件';
    document.querySelectorAll('.paper-upload-label').forEach(label => { label.classList.remove('has-file'); label.querySelector('i').className = 'fas fa-cloud-upload-alt'; });
    $('pdfPreviewInfo').style.display = 'none';
    $('imgPreviewArea').innerHTML = '';
    $('sectionResults').style.display = 'none';
    $('sectionProgress').style.display = 'none';
    $('incompleteWarning').style.display = 'none';
}

function clearPaperArtifacts() {
    state.runController?.abort();
    Object.assign(state, { userPages: [], msPages: [], qpPages: [], msStructure: null, qpStructure: null, userAnswers: null, manualMsBuf: null, manualQpBuf: null, paperConfirmed: false, confirmedPaperId: '' });
    resetArtifactUI();
    $('sectionUpload')?.classList.add('locked');
    setPipelineStep(1);
    updateStartButton();
}

function markSelectionDirty() {
    if (state.paperConfirmed || state.userPages.length || state.manualMsBuf || state.manualQpBuf) clearPaperArtifacts();
    else state.paperConfirmed = false;
}

function updateStartButton() {
    const button = $('startGradingBtn');
    if (button) button.disabled = Boolean(state.runController) || !state.paperConfirmed || state.userPages.length === 0;
}

function validatePdfBuffer(buffer, label) {
    if (!SQCore.isPdfHeader(buffer.slice(0, 4))) throw new Error(`${label} 不是有效 PDF 文件`);
}

function bindPaperUpload(inputId, type) {
    $(inputId).addEventListener('change', async event => {
        const file = event.target.files[0];
        if (!file) return;
        const isMs = type === 'ms';
        const status = $(isMs ? 'manualMsStatus' : 'manualQpStatus');
        const label = event.target.closest('.paper-upload-row')?.querySelector('.paper-upload-label');
        status.textContent = '正在加载...';
        try {
            const buffer = await file.arrayBuffer();
            validatePdfBuffer(buffer, type.toUpperCase());
            if (isMs) state.manualMsBuf = buffer; else state.manualQpBuf = buffer;
            status.textContent = `✅ ${file.name} (${Math.round(buffer.byteLength / 1024)}KB) — 已就绪`;
            label?.classList.add('has-file');
            if (label?.querySelector('i')) label.querySelector('i').className = 'fas fa-check-circle';
        } catch (error) {
            status.textContent = `❌ ${error.message}`;
        }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    AppConfig.initUI(refreshConfigState);
    const apiSelect = $('eg-api');
    function refreshConfigState() {
        const lines = AppConfig.availableVisionLines();
        apiSelect.innerHTML = '';
        if (!lines.length) apiSelect.add(new Option('（请先配置 API）', ''));
        else lines.forEach(line => apiSelect.add(new Option(line.label, line.key)));
        $('configBanner').style.display = AppConfig.isConfigured() ? 'none' : 'flex';
    }
    refreshConfigState();
    if (!AppConfig.isConfigured()) AppConfig.openModal();

    function populatePapers() {
        const selected = $('eg-subject').selectedOptions[0];
        $('eg-paper').innerHTML = '';
        let papers = [];
        try { papers = JSON.parse(selected?.dataset.papers || '[]'); } catch (_) {}
        papers.forEach(paper => $('eg-paper').add(new Option(`Paper ${paper.n}, Variant ${paper.v}`, `${paper.n}${paper.v}`)));
    }
    function populateSubjects() {
        $('eg-subject').innerHTML = '';
        (SUBJECTS_DATA[$('eg-level').value] || []).forEach(subject => {
            const option = new Option(`${subject.name} (${subject.code})`, subject.code);
            option.dataset.peh = subject.peh;
            option.dataset.name = subject.name;
            option.dataset.papers = JSON.stringify(subject.papers);
            $('eg-subject').add(option);
        });
        populatePapers();
    }
    function populateYears() {
        const current = new Date().getFullYear();
        $('eg-year').innerHTML = '';
        for (let year = current; year >= 2015; year--) $('eg-year').add(new Option(String(year), String(year)));
    }
    $('eg-level').addEventListener('change', () => { markSelectionDirty(); populateSubjects(); });
    $('eg-subject').addEventListener('change', () => { markSelectionDirty(); populatePapers(); });
    for (const id of ['eg-year', 'eg-season', 'eg-paper']) $(id).addEventListener('change', markSelectionDirty);
    populateSubjects();
    populateYears();

    $('paperSelectForm').addEventListener('submit', event => {
        event.preventDefault();
        if (!AppConfig.isConfigured()) { alert('请先配置 AI 接口。'); AppConfig.openModal(); return; }
        const selected = $('eg-subject').selectedOptions[0];
        if (!selected || !$('eg-paper').value) { alert('请选择有效试卷。'); return; }
        const newIdentity = paperIdentityFromForm();
        if (state.confirmedPaperId && state.confirmedPaperId !== newIdentity) clearPaperArtifacts();
        Object.assign(state, {
            level: $('eg-level').value, subjectCode: $('eg-subject').value, subjectName: selected.dataset.name,
            peh: selected.dataset.peh, year: $('eg-year').value, season: $('eg-season').value,
            paper: $('eg-paper').value, apiChoice: apiSelect.value || 'line1',
            useDeepseek: $('eg-use-deepseek').checked, paperConfirmed: true, confirmedPaperId: newIdentity
        });
        setPipelineStep(2);
        unlockSection('sectionUpload');
        updateStartButton();
    });

    $('tabPdf').addEventListener('click', () => switchTab('pdf'));
    $('tabImages').addEventListener('click', () => switchTab('images'));
    $('choosePdfBtn').addEventListener('click', () => $('pdfInput').click());
    $('chooseImagesBtn').addEventListener('click', () => $('imgInput').click());
    function switchTab(tab) {
        $('tabContentPdf').style.display = tab === 'pdf' ? '' : 'none';
        $('tabContentImages').style.display = tab === 'images' ? '' : 'none';
        $('tabPdf').classList.toggle('active', tab === 'pdf');
        $('tabImages').classList.toggle('active', tab === 'images');
    }

    $('pdfInput').addEventListener('change', async event => {
        const file = event.target.files[0];
        if (!file) return;
        $('pdfPreviewInfo').style.display = 'block';
        $('pdfPreviewInfo').textContent = `正在渲染 ${file.name}...`;
        try {
            const buffer = await file.arrayBuffer();
            validatePdfBuffer(buffer, '答卷');
            state.userPages = await pdfToAnswerImages(buffer);
            if (!state.userPages.length) throw new Error('答卷未保留任何有效页面');
            $('pdfPreviewInfo').textContent = `✅ 已加载 ${file.name}，保留 ${state.userPages.length} 页`;
        } catch (error) {
            state.userPages = [];
            $('pdfPreviewInfo').textContent = `❌ ${error.message}`;
        }
        updateStartButton();
    });

    $('imgInput').addEventListener('change', async event => {
        const files = Array.from(event.target.files).filter(file => file.type.startsWith('image/'));
        state.userPages = await imagesToPages(files);
        $('imgPreviewArea').innerHTML = '';
        state.userPages.forEach(page => {
            const image = document.createElement('img'); image.src = page.content; image.alt = `Page ${page.pageNumber}`; $('imgPreviewArea').appendChild(image);
        });
        updateStartButton();
    });

    for (const id of ['pdfDropzone', 'imgDropzone']) {
        const element = $(id);
        element.addEventListener('dragover', event => { event.preventDefault(); element.classList.add('dragging'); });
        element.addEventListener('dragleave', () => element.classList.remove('dragging'));
        element.addEventListener('drop', event => {
            event.preventDefault(); element.classList.remove('dragging');
            const files = event.dataTransfer.files;
            if (id === 'pdfDropzone' && files[0]?.type === 'application/pdf') { $('pdfInput').files = files; $('pdfInput').dispatchEvent(new Event('change')); }
            if (id === 'imgDropzone') { $('imgInput').files = files; $('imgInput').dispatchEvent(new Event('change')); }
        });
    }

    bindPaperUpload('manualMsInput', 'ms');
    bindPaperUpload('manualQpInput', 'qp');
    $('startGradingBtn').addEventListener('click', () => {
        if (!state.paperConfirmed) return alert('请先确认试卷。');
        if (!state.userPages.length) return alert('请先上传答卷。');
        runGradingPipeline();
    });
    $('cancelGradingBtn').addEventListener('click', () => state.runController?.abort());
    updateStartButton();
});
