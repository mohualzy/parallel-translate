# 翻译风格档案 — 实现计划

设计：[docs/specs/2026-10-23-prompt-profiles-design.md](../specs/2026-10-23-prompt-profiles-design.md)
每一步完成后都要通过 `just check`；涉及内容脚本或 prompt 时再跑 `just e2e`。

- [x] **1. 档案与选择逻辑**：`src/lib/profiles.ts`，包括档案定义（中英两版风格文本）、`resolveProfile(host, siteProfiles, hasCitationMeta)`。
  验证：`pnpm vitest run tests/unit/profiles.test.ts` 通过。
- [x] **2. prompt 与后台**：`buildMessages` 接收档案风格，并叠加自定义要求；`PageContext.profile`；缓存键加入档案 id；设置项 `siteProfiles`。
  验证：`pnpm vitest run tests/unit/prompt.test.ts` 通过。
- [x] **3. 内容脚本**：解析当前页档案并随请求发送；`siteProfiles` 变化时当前页重翻。
  验证：`just check` 通过。
- [x] **4. 弹窗与设置页**：弹窗「翻译风格」下拉框；设置页显示档案说明和已指定的网站。
  验证：弹窗 E2E 用例通过。
- [x] **5. E2E**：带 `citation_*` meta 的测试页，system prompt 里是论文风格；在弹窗里改成文学风格后重翻，system prompt 换成文学风格。
  验证：`just e2e` 全部通过。
- [x] **6. 真实模型**：`just e2e-live` 加一条：同一段英文在 `tech` 与 `social` 档案下的译文都是中文，没有协议标签残留。
  验证：live 用例通过。
- [x] **7. 文档**：README、DECISIONS、PLANS。
  验证：`git status` 干净。
