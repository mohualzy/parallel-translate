# 批量重试 — 实现计划

设计：[docs/specs/2026-10-23-retry-failed-design.md](../specs/2026-10-23-retry-failed-design.md)
每一步完成后都要通过 `just check` 和 `just e2e`。

- [x] **1. 翻译器**：`retryFailed()`，点击失败提示改为全部重试；批次失败回调 `onBatchError`。
  验证：`just check` 通过。
- [x] **2. 接线**：消息 `retry-failed`；内容脚本接 toast（顶层页面，同一原因 10 秒内只提示一次）；弹窗「重试失败的 N 段」按钮。
  验证：`just check` 通过。
- [x] **3. E2E**：mock 失败 → 多段失败 → 出现带原因的 toast → 恢复后点一个失败提示，全部段落都翻好；弹窗按钮同样可用。
  验证：`just e2e` 全部通过。
- [x] **4. 文档**：README、DECISIONS、PLANS。
  验证：`git status` 干净。
