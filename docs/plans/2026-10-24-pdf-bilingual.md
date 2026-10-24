# PDF 双语阅读器 — 实现计划

设计：[docs/specs/2026-10-24-pdf-bilingual-design.md](../specs/2026-10-24-pdf-bilingual-design.md)
每一步完成后都要通过 `just check`；涉及翻译请求的步骤再跑 `just e2e`。

- [x] **1. 版面分析（纯逻辑）**：`src/lib/pdf/layout.ts`，覆盖以下几块：
  - 行：挂靠上下标、合并同基线片段；
  - 块：分栏、切段、居中；
  - 片段：原子占位、连字符合并、转义；
  - 保留判定。

  验证：`pnpm vitest run tests/unit/pdf-layout.test.ts` 通过，用例包括：
  - 两栏不串；
  - 首行缩进切段、居中标题不切；
  - 宽下标不断行；
  - 根号挂靠；
  - 行内公式成为原子；
  - 行间公式保留；
  - 旋转文字保留；
  - 行末连字符合并。
- [x] **2. 译文排版（纯逻辑）**：`src/lib/pdf/typeset.ts`，包括 token 化（中文逐字、英文按词、原子）、断行（避头尾）、字号搜索，测量函数注入，便于单测。
  验证：`pnpm vitest run tests/unit/pdf-typeset.test.ts` 通过。
- [x] **3. 打包与入口**：
  - 依赖 `pdfjs-dist@6.4.299`；
  - worker 用 `?url` 引入，cMaps 和标准字体经 `build:publicAssets` 复制；
  - CSP 加 `'wasm-unsafe-eval'`；
  - 阅读器页面骨架能打开一个 PDF 并渲染原文页。

  验证：`just check` 通过，构建产物含 `pdf.html`、`cmaps/`、`standard_fonts/`。
- [x] **4. 渲染与翻译**：`src/pdf/`，包括字形捕获、底图、版面分析接线、按页懒翻译（复用 `translate` 消息与文章术语）、译文页绘制（清底、保留块、原子缩放绘制、原样返回的块保留）、双语 / 仅译文、风格选择、Type3 检测。
  验证：`just check` 通过。
- [x] **5. 打开方式**：弹窗按钮（当前页是 PDF 时）、右键 PDF 链接、阅读器内打开本地文件 / 拖放。
  验证：`just check` 通过，manifest 含新右键菜单。
- [x] **6. E2E**：mock 服务按需生成一份测试 PDF，内容包括标题、两段正文、一行等宽代码、旋转水印，然后验证：
  - 阅读器渲染两页 canvas；
  - 发给模型的片段正确：代码与水印不翻；
  - 译文页绘制完成；
  - 弹窗按钮能打开阅读器。

  验证：`just e2e` 全部通过。
- [x] **7. 真实论文实测**：用 DeepSeek 打开 arXiv 论文的几页，截图检查观感（两栏、公式页、标题页），记录问题到 TECH_NOTES；live 用例覆盖生成的测试 PDF。
  验证：`just e2e-live` 通过；截图交给用户确认观感。
  结果：实测修了 6 个版面问题（见 TECH_NOTES「PDF」），加了 PDF 简洁提示（D50）。公式原子在真实模型下的保留只在 arXiv 实测截图里确认过，没有自动化用例（测试 PDF 不含公式字体）。
- [x] **8. 文档**：README、DECISIONS、TECH_NOTES、PLANS。
  验证：`git status` 干净。
