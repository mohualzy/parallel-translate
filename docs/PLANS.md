# PLANS — 路线图

目标：完整的网页翻译体验，翻译质量取决于用户自选模型。
原则：先把「读网页」这条主路径做到好用，再扩展到字幕、PDF 等场景。
实测模型：暂时只用 DeepSeek `deepseek-flash`（`just e2e-live`），不切换其他模型。

## 已完成

### Phase 1 — MVP（v0.1，2026-10-22）

- [x] 工程骨架：WXT + TS + Vitest + Playwright，`just check` / `just e2e`
- [x] 翻译服务：OpenAI 兼容协议，多服务配置、测试连接、拉取模型列表
- [x] 后台：流式请求、超时、429/5xx 重试、按服务并发限制、Service Worker 保活
- [x] 批量翻译（`<s id>` 分段协议）+ IndexedDB 缓存
- [x] 段落识别（块级 + 行内片段），排除代码/编辑器/读屏隐藏文字；默认跳过短界面文字
- [x] 懒翻译、动态内容、框架重渲染后补回译文
- [x] 富文本保留（链接、加粗、行内代码）
- [x] 双语 / 仅译文；6 种译文样式；悬停 + 按键翻译单段
- [x] Alt+A、Alt+W、右键菜单；总是/永不翻译；外文页面自动翻译；弹窗 + 设置页 + 导入导出

### Phase 1.1 — 体验细节打磨（DECISIONS D13–D17）

- [x] 改写中的段落稳定后再翻；漏段二分补翻（预算 2 次）；批内去重
- [x] prompt 强调完整翻译单元；中文目标用中文 prompt
- [x] 上下标、时间、图标字体原样保留；每个服务可配额外请求参数

### Phase 1.2 — 真实模型实测（DECISIONS D18–D20）

- [x] `<br><br>` 分段 + 纯文本片段的懒翻译锚点
- [x] `<article>` 内短内容算正文；DeepSeek 预设关闭推理；`just e2e-live`

## 功能对照（按使用场景）

| 场景 | 现状 | 决定 |
|---|---|---|
| 网页双语 / 仅译文 | ✅ 含 iframe、Shadow DOM、解除截断、标签页标题 | — |
| 鼠标悬停翻译 | ✅ 修饰键触发 | 可选：无修饰键的悬停自动模式（P3） |
| 划词翻译 | ✅ 按钮 / 直接两种触发；单词词典式、句子译文；流式 | — |
| 悬浮球 / 侧栏入口 | ✅ 悬浮球 | 侧栏放到 P2 |
| 输入框翻译 | ✅ Alt+I / 连按三次空格；选区翻译；多策略写回 + 撤销 | — |
| 术语表 / 文章术语 | ✅ 用户术语表 | AI 抽取术语（P2） |
| 文档上下文：标题 / 摘要 | ✅ 标题 + meta description | — |
| 学习模式 / 遮罩 | ✅ 一键切换遮罩（当前页） | — |
| AI 助手 = prompt 档案 | 🟡 每个服务一个自定义要求 | 多档案 + 按站点选择（P2） |
| 文本 / 侧栏多模型对比 | ❌ | P3（当前只用一个模型，收益低） |
| 编辑译文 | ❌ | P3 |
| 视频字幕 | ✅ YouTube 双语字幕（旁听播放器字幕、按进度翻译、优先人工字幕） | 嵌入式播放器、Shorts、直播字幕待做 |
| PDF / EPUB / HTML 文件 | PDF ✅ / EPUB、HTML ❌ | PDF 用自带的本地 pdf.js 阅读器，文件不交给远程 Web App；EPUB、HTML 文件为 P3 |
| 图片 / 漫画 OCR | ❌ | P3；deepseek-flash 支持图片输入，优先评估视觉模型 |
| 截图区域 OCR | ❌ | P3，与图片翻译共用视觉模型通道 |
| AI 写作 | ❌ | **不做**：不是翻译需求 |
| 敏感信息脱敏 | ❌ | **不做**（暂不）：自带 Key 直连服务商 |
| 原生 App 桥接、搜索增强 | ❌ | **不做**：与自用浏览器扩展无关 |
| 多服务快捷键 | ❌ | 不做：服务切换放在弹窗即可 |

## 路线图

### P1 — 网页阅读体验补齐（2026-10-22 完成，DECISIONS D21–D30）

- [x] 页面内 UI 基础设施：统一的 Shadow DOM 挂载（WXT `createShadowRootUi`），供悬浮球、划词弹窗共用
- [x] 划词翻译：选区旁小按钮 → 单例弹窗；单词给释义，句子给译文；带选区上下文；流式显示
- [x] 悬浮球：页面侧边开关翻译，可拖拽吸附，可按站点隐藏
- [x] 用户术语表：设置页维护「原文 → 译法」，命中的条目注入当批 prompt（暂不做 AI 抽取）
- [x] 文档上下文：标题之外注入 `meta description` 作为摘要
- [x] 快捷键对齐：Alt+W 改为「立即翻译整页（不懒加载）」，新增「切换仅译文」「切换学习遮罩」
- [x] 同语言提示：页面翻译字数很少时提示「可能已是目标语言」
- [x] 译文容器被 line-clamp / 省略号截断时解除截断
- [x] 翻译标签页标题
- [x] iframe 与 Shadow DOM 内容：内容脚本 `allFrames`，段落遍历进入 open shadow root（如新版 Reddit 的 Web Components）

### P2 — 新场景

- [x] 视频双语字幕（YouTube）— 已实现，E2E 与真实站点实测通过：[设计](specs/2026-10-22-youtube-subtitles-design.md) · [计划](plans/2026-10-22-youtube-subtitles.md)
- [x] 输入框翻译：Alt+I / 连按三次空格；过滤输入法组合输入；可撤销写回 — 已实现，E2E、真实模型与 ProseMirror / Lexical 实测通过：[设计](specs/2026-10-23-input-translate-design.md) · [计划](plans/2026-10-23-input-translate.md)
- [x] AI 助手 / prompt 档案：技术、论文、新闻、GitHub 等预设风格，可按站点自动选择— 已实现：六种风格、按网站 / 论文元数据自动选择、弹窗按网站指定；E2E 与真实模型通过：[设计](specs/2026-10-23-prompt-profiles-design.md) · [计划](plans/2026-10-23-prompt-profiles.md)
- [x] AI 抽取文章术语，保证长文前后译法一致（最多 12 条候选）— 已实现：并行抽取不阻塞首屏、冲突段落带术语重翻、弹窗查看；E2E 与真实模型通过：[设计](specs/2026-10-23-article-terms-design.md) · [计划](plans/2026-10-23-article-terms.md)
- [x] 原生侧栏（`chrome.sidePanel`）：文本翻译 — 已实现：快捷键 / 弹窗 / 右键菜单打开，自动双向、流式、可切换服务与风格；E2E 与真实模型通过：[设计](specs/2026-10-23-side-panel-design.md) · [计划](plans/2026-10-23-side-panel.md)
- [x] 安装/更新后对已打开的标签页注入内容脚本（免刷新）— 已实现：安装/更新时主动注入 + 发消息失败时按需注入，新旧实例交接并保留翻译状态；E2E 与日常 Chrome 重载实测通过：[设计](specs/2026-10-23-inject-open-tabs-design.md) · [计划](plans/2026-10-23-inject-open-tabs.md)
- [x] 常见站点适配规则（X、Reddit、GitHub、Hacker News 等）— 均已实测：HN、GitHub、X 用规则；Reddit 修通用识别后不需要规则：[设计](specs/2026-10-23-site-rules-design.md) · [计划](plans/2026-10-23-site-rules.md)
- [x] 段落翻译失败的批量重试入口 — 已实现：点任一失败提示全部重试、弹窗按钮、带原因的失败提示：[设计](specs/2026-10-23-retry-failed-design.md) · [计划](plans/2026-10-23-retry-failed.md)

### P3 — 远期 / 视需求

- [x] PDF 双语（本地 pdf.js 阅读器，文件不出本机）— 已实现：原文 / 译文并排，译文去字形后按原位置、原颜色和字体写回，公式与代码原样保留；E2E 与真实论文实测通过：[设计](specs/2026-10-24-pdf-bilingual-design.md) · [计划](plans/2026-10-24-pdf-bilingual.md)
- [x] PDF 译文中文字体切换（阅读器工具栏：自动 / 预设 / 本机字体 / 手动输入，切换只重画不重翻）— 已实现，E2E 通过：[计划](plans/2026-10-24-pdf-cjk-font.md)
- [x] PDF 译文页选中复制、查找（Ctrl+F，跨行）、划词强调（四色高亮 / 下划线，按文档保存）— 已实现，E2E 通过：[设计](specs/2026-10-24-pdf-text-layer-design.md) · [计划](plans/2026-10-24-pdf-text-layer.md)
- [x] PDF 强调面板（列出、跳转、删除、导出 Markdown 附原文）— 已实现，E2E 通过：[设计](specs/2026-10-24-pdf-text-layer-design.md) · [计划](plans/2026-10-24-pdf-text-layer.md)
- [x] PDF 原文页选中复制、查找原文（强调只在译文页）— 已实现，E2E 通过：[设计](specs/2026-10-24-pdf-text-layer-design.md) · [计划](plans/2026-10-24-pdf-text-layer.md)
- [x] 自动用双语阅读器打开网页上的 PDF（按响应头识别，「原文件」放行）— 已实现，E2E 与 arXiv 实测通过：[计划](plans/2026-10-24-pdf-auto-open.md)
- [x] PDF 记住阅读位置（按文档指纹，缩放时保持位置）— 已实现，E2E 通过：[计划](plans/2026-10-24-pdf-reading-position.md)
- [x] 导出译文 PDF / 双语并排 PDF（图片版，强调一并导出，后台标签页可导出）— 已实现，E2E 与真实论文实测通过：[计划](plans/2026-10-24-pdf-export.md)
- [x] 仅译文模式补全：只占容器一部分的段落、MathML 行内公式、行内容器的挤窄误判、CSS 层里的 !important、两端对齐首行空白（arXiv HTML 实测）— 已修复，E2E 与真实页面验证（D64）
- [x] 仅译文模式多站点回归（14 个网站改动前后对比）：部分隐藏只藏安全元素、链接副本点击转发（D65）
- [x] 网页划词强调（一次性：高亮四色、下划线、清除，原文和译文都行）— 已实现，E2E 与 Wikipedia 实测通过：[计划](plans/2026-10-24-page-marks.md)
- [ ] 图片 / 截图区域 OCR 翻译（视觉模型）
- [ ] EPUB 双语
- [ ] 编辑译文、多模型对比、无修饰键的悬停自动翻译
- [ ] 原生 Anthropic / Gemini 协议适配；Firefox 实测

### 待验证

- [ ] 设置导入/导出、右键菜单、快捷键注册本身（E2E 直接发消息，没有覆盖按键）的手动验证
