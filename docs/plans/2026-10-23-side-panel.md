# 原生侧栏 — 实现计划

设计：[docs/specs/2026-10-23-side-panel-design.md](../specs/2026-10-23-side-panel-design.md)
每一步完成后都要通过 `just check`；涉及 prompt 或后台时再跑 `just e2e`，改了 prompt 再跑 `just e2e-live`。

- [x] **1. prompt 与方向判定**：`buildTextMessages`（风格 + 术语表 + 保留格式）、`TEXT_PROMPT_VERSION`；`resolveTextTarget(text, target, settings)`，处理「自动」方向。
  验证：`pnpm vitest run tests/unit/prompt.test.ts tests/unit/text-translate.test.ts` 通过。
- [x] **2. 后台**：`ptx-text` 长连接与 `translateText`（缓存、可指定服务）；命令 `open-side-panel`（Alt+S）；右键菜单「在侧栏中翻译选中文字」；侧栏打开工具函数（sidePanel → sidebarAction → 新标签页）。
  验证：`just check` 通过，manifest 含 `side_panel`、`sidePanel` 权限和新命令。
- [x] **3. 侧栏页面**：`src/entrypoints/sidepanel/`，包括输入、服务 / 风格 / 目标语言选择、流式结果、复制、Ctrl+Enter、读取 `storage.session` 里待翻译的文字。
  验证：`just check` 通过。
- [x] **4. 弹窗入口**：「在侧栏翻译文本」按钮。
  验证：弹窗 E2E 通过。
- [x] **5. E2E**：在标签页里打开侧栏页面：
  - 输入英文得到流式译文；
  - 输入中文时「自动」改译成英文；
  - `storage.session` 交接的文字自动翻译；
  - 切换服务 / 风格后请求随之变化。
  验证：`just e2e` 全部通过。
- [x] **6. 真实模型与真实浏览器**：live 用例（多段文本保留段落）；在日常 Chrome 里用快捷键 / 右键菜单打开侧栏，人工确认。
  验证：`just e2e-live` 通过（多段文本保留段落与列表，中文自动译成英文）。侧栏能否在真实 Chrome 里打开需要用户手势，CDP 触发不了，交给用户手动验证。
- [x] **7. 文档**：README、DECISIONS、PLANS。
  验证：`git status` 干净。
