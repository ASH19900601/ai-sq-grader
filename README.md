# AI SQ Grader · 结构题 AI 批改器

纯前端的 CAIE / IGCSE / A-Level 结构题辅助批改工具。它同时读取 Question Paper（QP）、Mark Scheme（MS）和学生答卷，以题干、原始页面图像及结构化评分规则生成逐点报告。

> AI 结果仅供练习与复核，不能代替考试局或教师的正式评分。

## 主要能力

- 扫描 PDF、拍照 PDF、低文字量页面和手绘图页会保留为图像；不再因缺少文本层被当作空白页。
- QP 会被解析并进入最终评分；图表题同时向最终视觉模型提供 QP 与答卷原图，OCR 文字只作索引。
- MS 结构支持 M/A/B/SC/FT、依赖分、follow-through、`any N from`/共享组上限、替代路线、`not from wrong working` 和 `ignore subsequent working`。
- 得分点按 `point_id` 去重，并在得分点组上限和题目满分两层封顶，预计得分不会超过满分。
- MS、QP、OCR 和逐题评分均有固定并发上限。API 支持超时、429 `Retry-After`、指数退避和取消。
- MS/QP/OCR 的局部解析失败会终止流程，不生成貌似完整的报告；逐题模型失败显示“未评估”，不记为学生答错，也不计算得分率。
- 更改学习阶段、科目、年份、考季或试卷后，会取消当前任务并清除旧 QP、MS、答卷和报告。
- 年份列表自动包含当前年份；目录补充了 AS 科学 Paper 2 与 9709 Paper 1–6 等常用组件。
- PDF.js 和 Font Awesome 已随项目打包，页面不再执行第三方 CDN 脚本，并设置了基础 CSP。

## 运行

无需构建，也没有运行时 npm 依赖：

```bash
python3 -m http.server 8080
```

打开 `http://localhost:8080`。不要直接双击 `index.html`，因为 `file://` 环境会限制 worker 和网络请求。

操作顺序：

1. 配置视觉模型 API。
2. 选择并确认试卷。
3. 手动上传匹配的 QP 与 MS，或配置代理自动下载。
4. 上传答卷 PDF/图片并开始批改。
5. 若报告出现“未评估”，重试对应流程，不要把当前下限分数当作最终成绩。

## API 兼容范围

“OpenAI 兼容”在本项目中明确指同时支持：

- `/chat/completions`；
- `response_format: {"type":"json_object"}`；
- 多模态 `image_url`；
- Base64 Data URL 图片；
- `max_tokens`。

只兼容基础文本 Chat Completions 的服务无法完成视觉批改。DeepSeek 线路仅可用于纯文本 MS 的第一阶段解析；最终判分始终使用选中的视觉线路。

## API Key 与隐私

- Key 必然会作为 `Authorization` 发送到你配置的 AI 服务商；不会发送给本项目作者，因为本项目没有自有批改后端。
- 默认 Key 只写入 `sessionStorage`，通常在关闭标签页后清除。
- 只有主动勾选“跨会话记住 API Key”时才写入 `localStorage`。
- 旧版 `localStorage` 配置会自动迁移到当前会话并从旧存储项中清除。
- 纯前端无法让密钥对同源脚本或具备页面权限的浏览器扩展绝对保密；敏感或高额度 Key 应设置额度、来源和权限限制。

## 可选 PDF 代理

`proxy.example.php` 是加固后的部署示例，需要 PHP 8.1+ 与 cURL 扩展。它包含：

- 仅 HTTPS/443 与域名白名单；
- 初始 URL 和每次重定向重新校验；
- DNS 解析后拒绝私网/保留地址，并把 cURL 固定到已校验 IP；
- 最多 3 次手动重定向；
- 下载大小、连接时间和总时间上限；
- 每 IP 每分钟限流；
- 可选共享 token；
- 精确 CORS Origin，不再默认 `*`。

推荐环境变量：

```text
SQ_PROXY_ALLOWED_ORIGIN=https://your-grader.example.com
SQ_PROXY_TOKEN=replace-with-a-long-random-value
SQ_PROXY_RATE_LIMIT=30
SQ_PROXY_MAX_BYTES=26214400
```

若启用 token，前端代理 URL 可填写为：

```text
https://your-proxy.example.com/proxy.php?token=YOUR_TOKEN&url=
```

这是防护示例，不等于完整的生产网关；公网部署还应在反向代理层增加日志脱敏、总流量/并发限制和监控。

## 测试与验收

```bash
npm test
node --check js/core.js
node --check js/config.js
node --check js/app.js
```

测试覆盖纯逻辑、真实 `app.js` PDF 页面判定路径、API 密钥迁移、429 重试、并发限制、复杂分值封顶、截断 answers JSON、静态资源引用和代理防护断言。CLI 测试覆盖关键共享逻辑与模拟集成路径，但不宣称可以证明任意第三方 AI 接口或所有浏览器环境的端到端行为。

## 目录

```text
ai-sq-grader/
├── index.html
├── css/style.css
├── js/app.js
├── js/config.js
├── js/core.js
├── tests/
├── vendor/
├── proxy.example.php
├── CHANGELOG.md
├── package.json
└── LICENSE
```

## License

项目代码采用 MIT License。随附的 PDF.js 与 Font Awesome 许可证位于 `vendor/licenses/`。
