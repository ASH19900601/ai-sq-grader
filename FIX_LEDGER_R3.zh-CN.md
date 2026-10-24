# 2.3.0 修复与验收记录

基线版本为 2.2.0。以下记录 2.3.0 的 13 项修复及历史验收范围，按根因合并相近问题。日期：2026-10-24（Asia/Shanghai）。

## 确认问题与修复

| # | 原行为与影响 | 现在的行为 | 验证证据 |
|---|---|---|---|
| 01 | OCR 返回意外 `source_pages` 时，优先级高于程序写入的真实 `source_page`，可让第一页转录指向第二页，最终模型漏看正确原图 | 每次 OCR 的来源页完全由当前请求索引覆盖，不接受模型指定 | round3.test.js；双页浏览器故意返回颠倒页码 |
| 02 | 只按完整题号找答案；已有 `1(a)(i)` 时，记在父题 `1(a)` 的前半段作答和原图被遗漏 | 按括号边界合并本题、祖先和子题证据，保留页序并排除兄弟题/`10(a)` | round3.test.js；真实双页 PDF.js，最终请求含 2 张 QP 和 2 张答卷图 |
| 03 | MS 得分点 ID 会 trim，但判分结果 ID 不会；` B1 ` 被当成漏点，`B1` 与 ` B1 ` 的矛盾结果也未识别为冲突 | 查找和重复检测使用同样 trim 后的 ID，矛盾重复行标未评估 | round3.test.js 两个独立断言 |
| 04 | 对相同资料再次整卷批改，一开始就丢弃旧报告；任何后续失败或取消都无法恢复付费生成的旧结果 | 保存报告及匹配的 MS/QP/OCR 快照；失败/取消恢复，并以可见警示和 JSON 的 `retained_after_failure` 标明；首次失败无旧报告时绝不伪造报告 | 单元快照恢复；两种重跑失败与取消的真实浏览器断言、JSON 下载 |
| 05 | 勾选纯文本 MS 用 DeepSeek 但未配置时，静默切回视觉线路；可选备用线路填一半也可被保存为“似乎配置好了” | 纯文本 DeepSeek 缺配置时在请求前停止，图像 MS 明确提示必须用视觉；有填写的可选线路必须完整且 URL 有效 | round3.test.js、config-ui.test.js；浏览器确认失败前请求数没有增加 |
| 06 | 上传 PDF→照片→同一 PDF 时，旧原生 input 的值仍保留，浏览器可能不触发 change；当前 tab 也无法说明实际将批改哪份旧答卷 | 清空另一来源的原生 input，独立状态区明确显示实际答卷文件名/页数 | 双页浏览器交替上传，断言 inactive input 为空且来源信息正确 |
| 07 | 向单 PDF 区拖入多份 PDF 时，代码只取第一份，其他答卷被悄悄忽略 | 明确拒绝并说明先合并 PDF 或改用图片，不留下貌似成功的状态 | 浏览器 DataTransfer 注入两个 PDF，验证错误和禁止开始 |
| 08 | API 使用无界 `response.text()`；超大成功/错误响应可能占满内存，错误协议的合法 JSON 还只产生后续晦涩解析错误 | 头部和分块读取均限制 4 MiB，取消超限响应、不重试超限；流式 UTF-8 解码保留中英文/emoji；错误 API 产品给出 Chat Completions 提示 | config-round3.test.js：header、chunked、字节跨界与错误协议 |
| 09 | 配置弹窗只有 Tab 陷阱和 aria-modal，后台控件仍可被程序聚焦或辅助技术导航 | 弹窗打开时背景 sibling 设为 inert，关闭后恢复原先 inert 状态和焦点 | config-ui.test.js；浏览器尝试聚焦后台年份控件仍停留在弹窗 |
| 10 | 关闭设置会清除隐藏密码 input，但含 token 的代理 URL 仍留在隐藏文本 input 内 | 同时清除代理 input 的 DOM 值，重新打开才从会话设置填回；不改变正常保存策略 | config-ui.test.js 关闭清空与重新打开恢复断言 |
| 11 | 减少动态效果的 CSS 已有，但 JS 仍显式 `scrollIntoView({behavior:'smooth'})`，该显式参数不受 CSS 修复约束 | JS 查询用户偏好，减少动态效果时使用 auto | 浏览器 reducedMotion=reduce，捕获真实报告滚动调用参数为 auto |
| 12 | `page.render()` 同步抛错发生在 try/finally 之前，已分配画布不能释放 | 分配后的渲染调用也被清理块覆盖，同步/异步失败均释放画布 | round3.test.js 模拟同步 render 故障，宽高均归零 |
| 13 | DNS 响应只有 CNAME、没有直接 A/AAAA 时，被当成无地址，CDN 站点无法下载 | 有界跟随 CNAME，原下载 URL/TLS 主机保持不变，最终 IP 仍严格验证；循环、过深和私网目标拒绝 | proxy-smoke：别名解析成功、私网拒绝、环拒绝；原有可信本地 TLS 回退/超时验收继续通过 |

## 覆盖方式与结果

- **先复现再改动**：`artifacts/round3-baseline-failures.txt` 是修改前截取的 7 个预期失败用例，不能当成当前失败。其他项由原代码路径、模拟响应和浏览器交互确认，修复后补充断言。
- `npm test`：**114/114 通过**，没有失败、跳过或零测试。
- `npm run check`：通过。
- 四套 Chromium 测试通过：`test:browser`、`test:regression`、`test:ui`、新增 `test:round3`。后者使用真正双页 PDF，实际 PDF.js worker，故意让页请求以相反顺序完成、OCR 返回错误页码，并验证最终请求内容与报告。模型响应为明确的测试夹具，不冒充真实模型响应。
- 取消流程的浏览器断言覆盖先前报告保留、明确标记、分数和标签。
- PHP 8.4.24 运行检查通过，新增 CNAME 成功、循环和私网拒绝。原有证书链/主机名验证开启的本地 TLS、备用 IP 和慢响应超时仍通过。
- **真实 API 验收**：`gpt-6.1-sol` 单题完整流程 4 次请求通过，结果 **1/1，100%**。真实接口证据为 `artifacts/live-validation.json`、`artifacts/live-report.png`；双页测试证据为 `artifacts/round3-browser.json`、`artifacts/round3-report.png`。

## 运行

静态部署仍无需构建。解压进入 `ai-sq-grader` 后执行 `python3 -m http.server 8080`。开发验证使用 Node 22.13+，`npm ci` 后安装 Chromium，执行 `npm run test:all`。PHP 和消耗额度的真实模型检查仍为单独的可选命令。

## 验证边界

- 真实模型验收为自制清晰单题；多页错序/错误页码用确定性模型夹具验证，不能冒充已经验证多学科真卷的模型准确率。
- 真实浏览器 API POST 经 Node 环境代理转发，不证明服务商直接 CORS 对任意网站可用。
- CNAME 逻辑用可控 DNS 记录验证；没有因模拟测试通过就宣称当前环境的公网原生 DNS 或考试资源站实际下载成功。
- 有限测试不能证明零缺陷；其他验证范围限制见 2.2 修复清单。
