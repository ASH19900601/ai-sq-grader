# AI SQ Grader

[English](#english) · [简体中文](#简体中文)

## English

AI SQ Grader is a browser-based practice tool for CAIE IGCSE / AS & A Level structured questions. It reads the Question Paper (QP), official Mark Scheme (MS), and student answers together to produce a report for each question and marking point.

The application requires no build step or dedicated grading backend. Bring your own API key for a vision-capable model service. Current version: **2.3.0**. See the [changelog](CHANGELOG.md) for changes.

> Results are estimates for practice and review. Models can misread handwriting, questions, and marking rules; official or teacher assessment remains authoritative.

### Features

- **Uses all three documents:** parses QP and MS, transcribes answers, and includes relevant original question and answer images in final grading. Supports scanned PDFs, photos, and hand-drawn diagrams.
- **Structured marking rules:** represents M/A/B/SC/FT marks, dependencies, follow-through, shared group caps, and alternative routes. A deterministic scoring layer applies deduplication, dependencies, mutually exclusive routes, and mark caps.
- **Point-by-point reports:** shows answer transcription, reasons, and five statuses: correct, possibly correct, incorrect, outside the MS, and unassessed. The interface currently uses Chinese labels.
- **Targeted retries and cancellation:** retry unassessed questions using existing parsed material. Failed or cancelled full reruns retain and clearly label the previous valid report. Changing the selected paper clears old material. MS/QP/OCR parsing failures stop report generation; individual grading failures are marked unassessed.
- **Export:** download a JSON report, or print/save the report as PDF through the browser.

### Quick start

Requirements: a modern browser supporting ES Modules, module workers, and `createImageBitmap`; an HTTP server serving `.mjs` as JavaScript and `.wasm` as `application/wasm`; and a compatible model API that allows requests from your page's origin.

No Node.js or npm dependencies are needed to serve the application. With Python 3 installed:

```bash
git clone https://github.com/ASH19900601/ai-sq-grader.git
cd ai-sq-grader
python3 -m http.server 8080
```

Open <http://localhost:8080>. For a downloaded ZIP, extract it and run the server inside the directory containing `index.html`. Use HTTP rather than opening the HTML file directly: `file://` restricts workers and network access. The static files can also be hosted on a service with the required MIME support; the optional PHP proxy needs a PHP-capable server.

1. Open **配置** (Configuration). Enter an API Base URL, API key, and model name for at least one vision route. The Base URL is the service's API root, such as `https://api.example.com/v1` (placeholder); do not append `/chat/completions`.
2. Select the level, subject, year, session, paper/variant, and vision route, then click **确认试卷** (Confirm paper).
3. Upload matching **QP and MS PDFs**, or configure the optional download proxy.
4. Upload one answer PDF, or multiple JPG / PNG / WebP images in page order, then click **开始 AI 批改** (Start grading).
5. Review each transcription and marking reason. Use **重试未评估题目** to retry unassessed questions, **导出 JSON 报告** to export, or **打印 / 保存 PDF** to print.

Potential marks for “possibly correct” points are displayed separately from confirmed marks. If any question is unassessed, the total is a confirmed lower bound marked `+?`, and the percentage is `-`; the report is incomplete.

### Built-in paper catalogue

| Level | Subjects and syllabus codes |
| --- | --- |
| IGCSE | Physics 0625, Chemistry 0620, Biology 0610, Mathematics 0580 |
| AS & A Level | Physics 9702, Chemistry 9701, Biology 9700, Mathematics 9709, Economics 9708 |

The year list extends to the browser's current year. Catalogue entries cover common components and variants, but availability varies by year/session. A listed paper does not imply validated grading accuracy for every question type; this tool is intended for structured questions.

### API compatibility

| Item | Requirement |
| --- | --- |
| Endpoint | `POST /chat/completions` |
| Authentication | `Authorization: Bearer ...` |
| Output | `response_format: {"type":"json_object"}` |
| Images | Multimodal `image_url`, including Base64 Data URLs |
| Parameters | `max_tokens` and `temperature` |
| Browser access | CORS must permit the page origin and the necessary request headers/preflight |

Basic text-chat compatibility alone is insufficient. Remote endpoints must use HTTPS; HTTP is allowed only for local development. Enter a model name supported by your service; the prefilled names do not guarantee availability.

Two vision routes can be configured and selected manually. The optional DeepSeek route handles **text-only MS parsing**. Image-based MS, QP parsing, answer recognition, and final grading use the selected vision route.

### Limits and privacy

| Item | Limit |
| --- | --- |
| Single uploaded file | 25 MiB |
| PDF pages / answer images | 100 pages / images |
| Combined answer image size | 100 MiB |
| Rendered image longest side | 2400 pixels |
| Single API response | 4 MiB |

PDF reading and image preprocessing happen in the browser. Relevant text and images are sent to the model service you configure, along with the API key for authentication. The project has no dedicated grading backend. If you use the optional download proxy, it receives QP/MS download URLs and transfers those PDFs.

- Keys and proxy URLs that may contain credentials are stored in `sessionStorage` by default, for the current tab session.
- Credentials enter `localStorage` only if you explicitly enable cross-session remembering. Use **忘记密钥与代理凭据** in Configuration to clear saved credentials.
- Same-origin scripts and browser extensions with page access may read browser storage. Restrict key permissions and spending limits as appropriate.
- JSON exports exclude API configuration, credentials, and original answer images, but include transcribed answers and marking details. Review personal information before sharing reports.
- Local preprocessing does not make grading offline. API charges and data-retention policies depend on your chosen service.

### Optional PDF download proxy

Manual QP/MS upload needs no proxy. For automatic downloads, deploy `proxy.example.php` on a server with **PHP 8.1+ and cURL**, and set:

```text
SQ_PROXY_ALLOWED_ORIGIN=https://your-grader.example.com
SQ_PROXY_TOKEN=replace-with-a-long-random-value
SQ_PROXY_RATE_LIMIT=30
SQ_PROXY_MAX_BYTES=26214400
```

Configure the frontend proxy URL, replacing the placeholders:

```text
https://your-proxy.example.com/proxy.php?token=YOUR_TOKEN&url=
```

A bare endpoint without `url` is also supported; the application adds the parameter and preserves an existing token. Set the allowed origin to the page's actual scheme, host, and non-default port, if any.

The proxy permits allowlisted HTTPS/443 destinations, validates DNS and each redirect, rejects non-public IPs, pins verified addresses, and limits redirects, size, duration, and requests per IP per minute. The domain allowlist is `ALLOWED_DOMAINS` in the PHP file. Public deployments also need server-level traffic/concurrency/time limits and credential-safe logging; multiple instances need shared rate limiting.

### Troubleshooting

| Symptom | What to check |
| --- | --- |
| Page stays on the loading notice | Use HTTP, check `.mjs`/`.wasm` MIME types, and ensure all static assets are present. |
| Cannot connect to the model API | Check Base URL, HTTPS, service availability, and CORS. A working CLI request does not prove browser access. |
| Start button is disabled | Follow the hint to complete API configuration, paper confirmation, answer upload, and QP/MS upload or proxy configuration. |
| Automatic download fails | Check paper availability, proxy settings, and the allowlist, or upload matching QP/MS files manually. |
| Report contains unassessed questions | Resolve the API error and retry those questions; the lower-bound score is not final. |
| Transcription or marking is wrong | Compare the original answer and official MS manually. Format validation and mark caps cannot guarantee semantic accuracy. |

### Development and tests

Development requires **Node.js 22.13+**. Unit tests and syntax checks need no npm dependency installation:

```bash
npm test
npm run check
```

Browser tests use Playwright with simulated API responses and do not incur model charges:

```bash
npm ci
npx playwright install chromium
npm run test:all
```

`test:all` runs unit tests, syntax checks, and four browser suites: `test:browser`, `test:regression`, `test:ui`, and `test:round3`. Browser selection uses `CHROMIUM_PATH`, then `/usr/bin/chromium`, then Playwright's installed Chromium. On Linux, `npx playwright install-deps chromium` can install missing system dependencies.

| Optional command | Purpose and requirements |
| --- | --- |
| `npm run test:proxy` | PHP protection and local TLS download checks; requires PHP CLI, cURL, and OpenSSL. `PHP_BIN` selects PHP. |
| `npm run test:api` | Live vision API probe; requires Chromium and API credentials, and incurs API charges. |
| `npm run test:live` | Live-model pipeline with a synthetic question; requires Chromium and API credentials, and incurs API charges. |

Live tests read `SQ_API_KEY`, `SQ_API_BASE`, and `SQ_API_MODEL` from the process environment. Specify the intended service/model explicitly, and keep real credentials out of source, logs, and commits. On Node 24 with an environment proxy, use `node --use-env-proxy tools/probe-api.cjs` or `node --use-env-proxy tools/live-pipeline.cjs`. Test forwarding is not a production backend or proof of browser-to-provider CORS support.

Existing test outputs and synthetic-data screenshots are in `artifacts/`; `round3-baseline-failures.txt` records expected failures before fixes, not the current test result. Historical test scope is documented in the [2.1 audit](AUDIT_REPORT.zh-CN.md), [2.2 fixes](FIX_LEDGER_R2.zh-CN.md), and [2.3 fixes](FIX_LEDGER_R3.zh-CN.md) (Chinese). Single-question model checks do not establish accuracy across real papers, handwriting, or subjects. Complex independent OR combinations and cross-question dependencies still require manual review.

### Project structure

| Path | Purpose |
| --- | --- |
| `index.html`, `css/style.css` | Interface and styling |
| `js/bootstrap.js` | Module startup and recovery |
| `js/app.js` | Catalogue, uploads, grading workflow, and reports |
| `js/config.js` | API configuration, credential storage, and requests |
| `js/core.js` | Validation, question matching, and scoring |
| `tests/`, `tools/` | Unit, integration, browser, and optional API checks |
| `vendor/` | Bundled PDF.js, Font Awesome, resources, and licenses |
| `proxy.example.php` | Optional PDF download proxy |
| `artifacts/` | Test evidence and synthetic-data screenshots |

### Contributing and license

Report reproducible problems through [Issues](https://github.com/ASH19900601/ai-sq-grader/issues), or propose changes through a pull request. Include steps, browser details, and expected/actual behavior. Use synthetic or authorized, de-identified example material. For scoring or asynchronous-flow changes, run relevant tests and provide a reproduction case.

Project code uses the [MIT License](LICENSE). Bundled third-party components retain their own licenses in `vendor/licenses/` and the PDF.js resource directories.

---

## 简体中文

AI SQ Grader 是面向 CAIE IGCSE / AS & A Level 结构题的浏览器练习批改工具。同时读取试题（Question Paper，QP）、官方评分方案（Mark Scheme，MS）和学生答卷，生成逐题、逐得分点的批改报告。

应用无需构建，也没有自有批改后端；使用者自行配置支持图像输入的模型服务与 API Key。当前版本为 **2.3.0**，更新内容见 [CHANGELOG](CHANGELOG.md)。

> 结果仅供练习与复核。模型可能误读手写内容、题干或评分规则，正式成绩应以考试局或教师评分为准。

### 主要功能

- **结合三份资料评分**：解析 QP 与 MS、转录答卷；最终判分同时查看相关题干和答卷原图，支持扫描 PDF、照片及手绘图。
- **结构化评分规则**：表示 M/A/B/SC/FT、依赖分、follow-through、共享组上限和替代路线；程序执行去重、依赖检查、互斥路线选择与分值封顶。
- **逐点报告**：显示答案转录、判定理由，以及“明确正确”“疑似正确”“错误”“MS之外”“未评估”五种状态；当前应用界面使用中文。
- **定向重试与取消**：只重试未评估题目，复用已解析资料；整卷重跑失败或取消时保留并明确标记先前有效报告。切换试卷会清除旧资料。MS / QP / OCR 解析失败会停止生成报告；单题判分失败则标记为未评估。
- **导出与打印**：下载 JSON 报告，或通过浏览器打印、保存为 PDF。

### 快速开始

需要支持 ES Modules、module worker 和 `createImageBitmap` 的现代浏览器；能将 `.mjs` 作为 JavaScript、`.wasm` 作为 `application/wasm` 提供的 HTTP 服务；以及允许页面来源跨域访问的兼容模型 API。

部署页面不需要 Node.js 或 npm 依赖。安装 Python 3 后运行：

```bash
git clone https://github.com/ASH19900601/ai-sq-grader.git
cd ai-sq-grader
python3 -m http.server 8080
```

打开 <http://localhost:8080>。如果下载 ZIP，解压后进入包含 `index.html` 的目录，再启动服务。请通过 HTTP 访问；直接双击 HTML 文件的 `file://` 环境会限制 worker 与网络请求。也可使用支持所需 MIME 类型的静态托管服务；可选 PHP 代理需要支持 PHP 的服务器。

1. 点击右上角“配置”，为至少一条视觉线路填写 API Base URL、API Key 和模型名称。Base URL 使用服务商提供的 API 根地址，如 `https://api.example.com/v1`（占位示例），无需追加 `/chat/completions`。
2. 选择学习阶段、科目、年份、考季、试卷变体和视觉线路，点击“确认试卷”。
3. 上传与所选试卷完全对应的 **QP PDF 和 MS PDF**，或配置可选下载代理。
4. 上传一份答卷 PDF，或按页序上传多张 JPG / PNG / WebP 图片，点击“开始 AI 批改”。
5. 展开各题核对转录与评分理由；使用“重试未评估题目”定向重试，或点击“导出 JSON 报告”“打印 / 保存 PDF”留档。

“疑似正确”的潜在增分单独显示，不计入已确认得分。存在未评估题目时，总分显示为已确认下限 `+?`，得分率显示 `-`；此时报告尚未完成。

### 内置试卷目录

| 学习阶段 | 科目与代码 |
| --- | --- |
| IGCSE | Physics 0625、Chemistry 0620、Biology 0610、Mathematics 0580 |
| AS & A Level | Physics 9702、Chemistry 9701、Biology 9700、Mathematics 9709、Economics 9708 |

年份列表随浏览器当前年份更新。目录覆盖常用组件与变体，但并非每个年份和考季都有对应试卷；列出某份试卷也不代表其所有题型均经过批改准确率验证。本工具主要用于结构题。

### API 配置与兼容性

| 项目 | 要求 |
| --- | --- |
| 端点 | `POST /chat/completions` |
| 认证 | `Authorization: Bearer ...` |
| 输出 | `response_format: {"type":"json_object"}` |
| 图像 | 多模态 `image_url`，包括 Base64 Data URL 图片 |
| 参数 | `max_tokens` 和 `temperature` |
| 浏览器访问 | CORS 允许页面来源及所需请求头、预检请求 |

仅支持基础文本对话的接口未必满足这些要求。远程接口必须使用 HTTPS；HTTP 仅允许本机调试地址。模型名称按服务商实际提供的值填写，界面预填名称不保证该服务商可用。

可配置两条视觉线路并手动选择。可选的 DeepSeek 线路用于**纯文本 MS 解析**；含图像的 MS、QP 解析、答卷识别与最终判分仍使用所选视觉线路。

### 文件限制与隐私

| 项目 | 限制 |
| --- | --- |
| 单个上传文件 | 25 MiB |
| PDF 页数 / 答卷图片数 | 最多 100 页 / 张 |
| 答卷图片合计大小 | 100 MiB |
| 渲染图像长边 | 最多 2400 像素 |
| 单次 API 响应 | 4 MiB |

PDF 读取与图片预处理在浏览器中进行；批改所需的文本、图像会发送给配置的模型服务商，API Key 用于该服务的认证。本项目没有自有批改后端。使用可选下载代理时，代理会接收 QP / MS 下载地址并转发相应 PDF。

- API Key 和可能含凭据的代理 URL 默认保存在当前标签页的 `sessionStorage` 中。
- 只有主动勾选跨会话记住选项时，凭据才写入 `localStorage`；设置中的“忘记密钥与代理凭据”可清除保存内容。
- 同源脚本和具备页面权限的浏览器扩展可能访问浏览器存储。请按需限制密钥权限与额度。
- JSON 报告不包含 API 配置、密钥或原始答卷图片，但包含答案转录与评分明细；分享前请检查个人信息。
- 本地预处理不等于离线批改。API 费用与数据保留政策取决于所选服务商。

### 可选：部署 PDF 下载代理

手动上传 QP / MS 不需要代理。自动下载使用 `proxy.example.php`，需要 **PHP 8.1+ 与 cURL 扩展**。部署后配置以下环境变量：

```text
SQ_PROXY_ALLOWED_ORIGIN=https://your-grader.example.com
SQ_PROXY_TOKEN=replace-with-a-long-random-value
SQ_PROXY_RATE_LIMIT=30
SQ_PROXY_MAX_BYTES=26214400
```

在前端配置中填写代理地址，并替换占位内容：

```text
https://your-proxy.example.com/proxy.php?token=YOUR_TOKEN&url=
```

也支持不带 `url` 参数的端点，程序会添加该参数并保留已有 token。允许来源应与页面的实际协议、主机和非默认端口一致。

代理仅允许白名单域名的 HTTPS / 443 请求；校验 DNS 与每次重定向、拒绝非公网地址、固定已验证 IP，并限制重定向次数、大小、时长和每 IP 每分钟请求频率。域名白名单位于 PHP 文件的 `ALLOWED_DOMAINS`。公网部署还需配置服务器级流量、并发和请求时限，避免日志记录凭据；多实例部署需要共享限流机制。

### 常见问题

| 现象 | 检查方法 |
| --- | --- |
| 一直停留在加载提示 | 通过 HTTP 访问，检查 `.mjs` / `.wasm` MIME 类型与静态资源是否齐全。 |
| 无法连接模型接口 | 检查 Base URL、HTTPS、服务商状态与 CORS；CLI 可用不能证明浏览器可直连。 |
| 开始按钮不可用 | 按提示补齐接口配置、试卷确认、答卷，以及 QP / MS 或有效代理。 |
| 自动下载失败 | 检查试卷是否存在、代理设置与白名单，也可手动上传匹配的 QP / MS。 |
| 报告有未评估题目 | 处理接口错误后定向重试，不要将下限分数当成最终成绩。 |
| 转录或评分有误 | 对照原答卷与官方 MS 人工复核；格式校验与分值封顶不能保证语义判断正确。 |

### 开发与测试

开发环境需要 **Node.js 22.13+**。基础测试与语法检查无需安装 npm 依赖：

```bash
npm test
npm run check
```

浏览器测试使用 Playwright 和模拟 API 响应，不消耗模型额度：

```bash
npm ci
npx playwright install chromium
npm run test:all
```

`test:all` 包含基础测试、语法检查及 `test:browser`、`test:regression`、`test:ui`、`test:round3` 四套浏览器流程。浏览器选择顺序为 `CHROMIUM_PATH`、`/usr/bin/chromium`、Playwright 安装的 Chromium。Linux 缺少系统依赖时，可运行 `npx playwright install-deps chromium`。

| 可选命令 | 用途与要求 |
| --- | --- |
| `npm run test:proxy` | PHP 防护与本地 TLS 下载检查；需要 PHP CLI、cURL 和 OpenSSL，`PHP_BIN` 可指定 PHP。 |
| `npm run test:api` | 真实视觉接口探针；需要 Chromium 和 API 凭据，会产生调用费用。 |
| `npm run test:live` | 自制单题的真实模型完整流程；需要 Chromium 和 API 凭据，会产生调用费用。 |

真实接口检查通过进程环境读取 `SQ_API_KEY`、`SQ_API_BASE` 与 `SQ_API_MODEL`。应明确指定目标服务与模型，不要将真实凭据写入源码、日志或提交记录。Node 24 的环境代理场景可使用 `node --use-env-proxy tools/probe-api.cjs` 或 `node --use-env-proxy tools/live-pipeline.cjs`。测试转发不等于生产后端，也不能证明浏览器直连的 CORS 可用。

`artifacts/` 保存既有测试输出和合成数据截图；`round3-baseline-failures.txt` 是修复前的预期失败记录，并非当前测试结果。历史测试范围见 [2.1 审查报告](AUDIT_REPORT.zh-CN.md)、[2.2 修复清单](FIX_LEDGER_R2.zh-CN.md) 和 [2.3 修复清单](FIX_LEDGER_R3.zh-CN.md)。单题模型检查不能证明真卷、各类手写体或不同学科的准确率；复杂独立 OR 组合与跨小题依赖仍需人工复核。

### 项目结构

| 路径 | 内容 |
| --- | --- |
| `index.html`、`css/style.css` | 页面与样式 |
| `js/bootstrap.js` | 模块启动与恢复 |
| `js/app.js` | 试卷目录、上传、批改流程与报告 |
| `js/config.js` | 接口配置、凭据存储与请求 |
| `js/core.js` | 校验、题号匹配与计分 |
| `tests/`、`tools/` | 单元、集成、浏览器及可选接口检查 |
| `vendor/` | PDF.js、Font Awesome、资源及许可证 |
| `proxy.example.php` | 可选 PDF 下载代理 |
| `artifacts/` | 测试证据与合成数据截图 |

### 参与贡献与许可证

欢迎通过 [Issues](https://github.com/ASH19900601/ai-sq-grader/issues) 提交可复现问题，或通过 Pull Request 提交改进。请附操作步骤、浏览器信息、预期与实际结果。示例资料应使用合成内容，或获准分享的脱敏资料。涉及评分或异步流程的修改，请运行相关测试并提供复现用例。

项目代码采用 [MIT License](LICENSE)。随附第三方组件保留各自许可证，见 `vendor/licenses/` 及 PDF.js 各资源目录中的许可证文件。
