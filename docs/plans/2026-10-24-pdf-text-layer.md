# PDF 译文页文字层与划词强调 — 实现计划

设计：[specs/2026-10-24-pdf-text-layer-design.md](../specs/2026-10-24-pdf-text-layer-design.md)。决策见 DECISIONS D57。

## 任务

- [x] **1. PageText 纯逻辑**：`src/lib/pdf/page-text.ts`：块 key、保留块的显示文本与位置、按行分组、偏移区间 → 矩形。
  验证：`pnpm vitest run tests/unit/pdf-page-text.test.ts` 通过（项间补空格、行间补空格、平移量、跨 piece 的矩形合并）。
- [x] **2. 强调纯逻辑**：`src/lib/pdf/highlights.ts`：添加（切掉重叠的旧强调）、清除区间、按 quote 重新定位。
  验证：`pnpm vitest run tests/unit/pdf-highlights.test.ts` 通过。
- [x] **3. 绘制产出 PageText 并画强调**：`drawTranslatedPage` 返回每块的显示文本与位置，接收要画的强调（multiply 高亮、下划线）。
  验证：`just check` 通过；E2E 原有 PDF 用例不变。
- [x] **4. 文字层**：`src/pdf/text-layer.ts`：按 PageText 建透明文字层；选区 → 块内偏移。页面结构改为原文 / 译文两个槽位，释放时只删画布、保留文字层。
  验证：E2E 文字层包含译文，选区文字正确。
- [x] **4b. 查找栏**：`src/lib/pdf/find.ts` 在显示文本里找命中（不区分大小写、跨行）；`src/pdf/find-bar.ts` 接管 Ctrl+F，叠命中框、滚动、计数。
  验证：单测 `tests/unit/pdf-find.test.ts`；E2E 按 Ctrl+F 搜「Bilingual Reading」（跨行）得到 1 个命中并显示当前命中框，搜「【译】」得到 4 个。
- [x] **5. 工具条与保存**：选区工具条（颜色、下划线、复制、清除），`pdfHighlights:<指纹>` 读写，改动后重画对应页。
  验证：E2E 选中 → 点黄色 → 存储里有记录、画布该处变黄；刷新后仍在；清除后记录为空。
- [x] **6. 全量检查**：`just check`、`just e2e`。
  结果：单元 196、E2E 49 全部通过。第一次全量 E2E 偶发失败一次：测试里滚回顶部的 scroll 事件晚于工具条显示，把工具条收起了；改为先滚动、等两帧再选中，之后连续 5 轮 PDF 用例、2 轮全量都通过。
  另：原计划用浏览器原生查找，E2E 发现跨行搜不到，改为自建查找栏（任务 4b，设计已更新）。
- [x] **7. 真实论文实测**：用户 Chrome 打开 arXiv 2608.16806，选中、复制、搜索、强调，换字体后强调仍在原文字上。
  结果：选区与画出的译文逐字对齐；黄色高亮在文字下方、黑字不受影响；查找「文本注」命中标题里被折行拆开的那一处，计数 1 / 3。测试加的高亮已删除，扩展错误列表为空。换字体后强调不偏移由 E2E 覆盖。
- [x] **8. 文档**：DECISIONS D57、PLANS、README、TECH_NOTES。
