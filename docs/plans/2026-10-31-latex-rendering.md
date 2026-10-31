# LaTeX 源码渲染实现计划

设计：[2026-10-31-latex-rendering-design.md](../specs/2026-10-31-latex-rendering-design.md)

- [x] **1. 识别**：`src/lib/tex.ts`（`splitTex`、`texElement`、`appendTexText`）。
  验证：`pnpm vitest run tests/unit/tex.test.ts` 通过，覆盖四种分隔符和 `$5 and $10`、`$HOME/$USER`、`$foo$bar` 等不误判。
- [x] **2. 渲染**：`src/background/tex.ts` 用 KaTeX 输出 MathML，新增 `render-tex` 消息；`src/lib/tex-render.ts` 批量渲染 `<ptx-math>`；`wxt.config.ts` 打包 KaTeX 许可。
  验证：单测覆盖公式、语法错误返回 `null`、`\href` 不产生链接。
- [x] **3. 页面翻译**：`serialize` 用 `<xN>` 占位，`deserialize` 处理文字里的公式，`translator` 渲染并保留只有公式的段落。
  验证：`just e2e` 新用例：行内和行间公式渲染成 `<math>`，发给模型的是占位，价格和环境变量不变，渲染不触发重翻。
- [x] **4. 划词与侧栏**：完成后渲染，复制按钮复制译文原文。
  验证：`just e2e` 新用例：弹窗和侧栏出现 `<math>`，复制内容是源码。
- [x] **5. 真实模型**：`just e2e-live` 新用例：页面、划词、侧栏的公式都保留并渲染。
  验证：新用例通过；不保留时在划词和文本 prompt 里加要求并升版本。
- [x] **6. 回归与文档**：`just check`、`just e2e`、`just e2e-live`；序列化改动影响所有网站，跑 `just sweep e23b1f9`；更新 README、DECISIONS、PLANS。
  验证：全部通过，sweep 报告没有新退化。
