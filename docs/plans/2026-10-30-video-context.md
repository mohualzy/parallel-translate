# 视频字幕上下文：滑动窗口 + 全片预读 — 实现计划

目标：字幕按进度分批翻译时，批与批之间不再是孤岛：每批能看到相邻台词，并知道全片讲什么、专有名词怎么译。设计见 [YouTube 字幕设计](../specs/2026-10-22-youtube-subtitles-design.md) 第 3 点「上下文」，决策见 DECISIONS D71。

## 任务

- [x] **1. 提取术语冲突判断**：`conflictsWithTerms` 从 `translator.ts` 移到 `src/lib/glossary.ts`，长文和字幕共用。
  验证：`just check` 通过，行为不变。
- [x] **2. 滑动窗口**：`buildMessages` 支持 `around`（`<before>` / `<after>`）；`src/lib/subtitles.ts` 新增 `batchContext`；`PageContext` 增加 `around`、`scope`，`scope` 计入缓存键；字幕用「视频标题 / 视频内容摘要」的说法。
  验证：`pnpm vitest run tests/unit/prompt.test.ts tests/unit/subtitles.test.ts`；网页翻译的缓存键不变。
- [x] **3. 全片预读**：`buildVideoBriefMessages` / `parseVideoBrief`；后台 `video-brief` 消息（走队列，按内容缓存）；字幕到手后并行请求，结果存进这一轨，每批带上；术语回来后重翻冲突条目。
  验证：单测；E2E 用足够长的字幕：预读一次、之后的批次带摘要和术语、冲突条目重翻、关闭 `extractTerms` 不预读、mock 译文不含术语也不会反复重翻。
- [x] **4. 全量检查**：`just check`、`just e2e`、`just e2e-live`（改了 prompt，确认 deepseek-flash 不把 `<before>` / `<after>` 译出来）。
  结果：单元 233、E2E 63、真实模型 12 通过。
- [ ] **5. 真实 YouTube 实测**：《群青》看预读结果和译文。（待做：CDP 代理对请求无响应，未能连到用户 Chrome）
- [x] **6. 文档**：DECISIONS D71、TECH_NOTES、PLANS、README、设置页文案。
