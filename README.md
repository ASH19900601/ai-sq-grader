# AI SQ Grader · 结构题 AI 批改器

> 上传 CAIE / IGCSE / A-Level 结构题（Structured Question）答卷，AI 自动逐题、逐得分点比对官方 Mark Scheme，明确告诉你每个点是否得分。**纯前端、零后端、密钥本地存储。**

![status](https://img.shields.io/badge/type-static%20site-blue) ![license](https://img.shields.io/badge/license-MIT-green) ![stack](https://img.shields.io/badge/stack-HTML%2FCSS%2FJS-orange)

## ✨ 功能特性

5 步流水线：**选择试卷 → 上传答卷 → 准备 MS → AI 解析 → AI 比对 → 输出报告**

- 🧠 **三段式 AI 批改**：
  1. **解析 Mark Scheme**：把 MS 拆解成结构化得分点（含 OR 备选答案）；
  2. **识别答卷**：作为 OCR 专家逐页识别学生手写答案，连画图题也用文字描述；
  3. **逐点比对**：对每个得分点给出「明确正确 / 疑似正确 / 错误 / MS之外」四态判定与简短理由。
- 📄 **智能 PDF 处理**：自动区分纯文本页与图像页，自动裁剪封面、空白页、评分规则页。
- ⚡ **并发加速**：MS 解析、答卷识别、逐题比对均并发执行。
- 🛟 **健壮性**：内置多级 JSON 抢救逻辑，能从被截断的模型输出中救回有效结果。
- 🧩 **可选 DeepSeek 线路**：当 MS 为纯文本时，可路由到单独配置的 DeepSeek 线路处理。
- 📊 **得分报告**：逐题展示得分点状态、预计得分与得分率。
- 🔐 **隐私优先**：不内置任何 API Key，密钥仅保存在浏览器 `localStorage`。

## 🚀 快速开始

纯静态网站，无需构建、无需后端。

```bash
python -m http.server 8080
# 或 npx serve .
```

浏览器打开 `http://localhost:8080`。推荐用本地服务器而非直接双击（`file://` 下 `fetch` 受限）。

### 部署到 GitHub Pages

推送到 GitHub，仓库 **Settings → Pages** 选择主分支根目录即可。

## ⚙️ 配置 AI 接口

首次打开会自动弹出「API 配置」窗口（也可点右上角 **配置**）。兼容任何 **OpenAI 风格** 的 `/chat/completions` 接口，可配置三条线路：

| 线路 | 用途 | 要求 |
| --- | --- | --- |
| 线路 1（默认） | 解析 MS、识别手写答卷、比对 | **必填，需支持视觉(vision)的多模态模型**，如 `gpt-4o` |
| 线路 2（备用） | 同上，可在主界面切换 | 可选 |
| DeepSeek | 处理纯文本 MS（勾选开关后生效） | 可选，如 `deepseek-chat` |

每条线路需填写 **Base URL**（不含 `/chat/completions`）、**API Key**、**模型名称**。

> ⚠️ 由于需要识别手写答卷，线路 1/2 必须是支持图片输入的多模态模型。

### 关于「PDF 下载代理」（可选）

浏览器跨域限制无法直接抓取第三方题库 PDF。若想用「自动下载官方 MS」，需自备 CORS 代理并在配置中填写其地址（程序会把目标 URL `encodeURIComponent` 后拼接在末尾）。仓库 `proxy.example.php` 提供可自部署的最小示例。**不配置也能用——直接手动上传 MS 即可。**

## 📁 目录结构

```
ai-sq-grader/
├── index.html          # 页面结构 + 设置弹窗
├── css/style.css       # 全部样式
├── js/core.js          # 纯逻辑（同构，浏览器+Node 共用）
├── js/config.js        # API 配置管理（三线路 + 代理）+ 直连调用
├── js/app.js           # 5 步批改流水线（DOM 绑定，调用 SQCore）
├── tests/core.test.js  # CLI 测试（node --test）
├── proxy.example.php   # 可选的 PDF 下载代理示例
├── package.json
├── README.md
├── LICENSE
└── .gitignore
```

## 🧪 测试与架构（CLI = GUI）

界面无关的纯逻辑抽到了同构模块 **`js/core.js`**（`SQCore`），浏览器与 Node 共用同一份实现。**命令行测试覆盖的就是 GUI 实际运行的逻辑**，无需打开浏览器即可验证。

```bash
node --test        # 或 npm test
```

覆盖：MS 下载 URL 拼装、HTML 转义/徽章、`%PDF` 头校验、**被截断 JSON 的多级抢救**、重复题号合并、答卷按行拼接、仅「明确正确」计分的得分率计算等。

## ⚠️ 免责声明

批改结果由 AI 自动生成，**仅供参考与自测**，"疑似正确"部分建议与老师确认，最终成绩以官方为准。考试资源版权归各考试局所有。

## 📄 License

[MIT](./LICENSE)
