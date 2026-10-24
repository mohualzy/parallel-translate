# 长文术语一致性 — 实现计划

设计：[docs/specs/2026-10-23-article-terms-design.md](../specs/2026-10-23-article-terms-design.md)
每一步完成后都要通过 `just check`；涉及内容脚本或 prompt 时再跑 `just e2e`，改了 prompt 再跑 `just e2e-live`。

- [x] **1. 抽取 prompt 与合并**：`buildTermsMessages`（含已有术语、防注入）、`TERMS_PROMPT_VERSION`；`mergeGlossary(user, article)`，用户术语表优先。
  验证：`pnpm vitest run tests/unit/prompt.test.ts tests/unit/glossary.test.ts` 通过。
- [x] **2. 后台**：消息 `extract-terms`（结果缓存）；`translateSegments` 把 `PageContext.terms` 与用户术语表合并后再匹配、计入缓存键。
  验证：`just check` 通过。
- [x] **3. 内容脚本**：长文判定、并行抽取、请求附带术语、术语返回后修正冲突段落（含进行中的批次）；`TabState.terms`；设置项 `extractTerms`。
  验证：`just check` 通过。
- [x] **4. 弹窗与设置页**：「本文术语 N 条」可展开；设置页开关。
  验证：弹窗 E2E 通过。
- [x] **5. E2E**：mock 支持抽取请求，并模拟「首屏不用术语」的译法：
  - 长文测试页只发一次抽取请求；
  - 之后的批次 prompt 里带有命中的术语；
  - 首屏冲突段落被重翻；
  - 短页面、关闭开关时不抽取。
  验证：`just e2e` 全部通过。
- [x] **6. 真实模型**：长文测试页抽取出可解析的术语，agent 在全文统一译为「智能体」。第一版 prompt 抽出了 12 条，含 paragraph、Section 等普通词；加了「宁缺毋滥」和反例后降到 9 条，task、tool 这类有固定译法的词仍会出现，影响很小，暂且接受。
  验证：`just e2e-live` 通过。
- [x] **7. 文档**：README、DECISIONS、PLANS。
  验证：`git status` 干净。
