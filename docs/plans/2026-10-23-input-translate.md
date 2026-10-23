# 输入框翻译 — 实现计划

设计：[docs/specs/2026-10-23-input-translate-design.md](../specs/2026-10-23-input-translate-design.md)
每一步完成后都要通过 `just check`；涉及内容脚本时再跑 `just e2e`。

- [x] **1. 纯逻辑**：`src/lib/input-trigger.ts`（三次空格计数器、光标前文本判定）；`buildInputMessages` + `INPUT_PROMPT_VERSION`；设置项 `inputTargetLang`、`inputSpaceTrigger`。
  验证：`pnpm vitest run tests/unit/input-trigger.test.ts tests/unit/prompt.test.ts` 通过。
- [x] **2. 后台**：消息 `translate-input`、`translateInput`（缓存）；命令 `translate-input`（Alt+I）发给所有 frame。
  验证：`just check` 通过，manifest 里有 `translate-input` 命令。
- [x] **3. 内容脚本**：`src/content/input.ts`，包括找焦点输入框、读文本/选区、三级写回与校验、扩展自己的撤销、三次空格监听、toast。
  验证：`pnpm vitest run tests/unit/input.test.ts` 通过（happy-dom 覆盖读取与回退写入）。
- [x] **4. 设置页**：「翻译偏好」里加「输入框翻译成」和三次空格开关。
  验证：设置页 E2E 用例仍通过。
- [x] **5. E2E**：测试页 `input.html` 覆盖以下场景：
  - textarea、input 和 contenteditable 都能写回，Ctrl+Z 还原；
  - 只翻选区；
  - 行首缩进、代码编辑器、关闭开关时不触发（输入法组合输入由单元测试覆盖，Playwright 模拟不了真实输入法）；
  - 多行 contenteditable：普通的走 insertText，自己处理粘贴的编辑器先走粘贴；
  - 密码框不翻；
  - 请求期间改了内容就不写回。
  验证：`just e2e` 全部通过。
- [x] **6. 真实模型与真实站点**（live 用例通过；ProseMirror / Lexical 实测发现段落空行与 Lexical 选区同步两个问题，已修，见 TECH_NOTES）：`just e2e-live` 加一条输入框用例；用 web-access 在一个真实富文本编辑器上试写回。
  验证：live 用例通过；实测结果记入 TECH_NOTES。
- [x] **7. 文档**：README、DECISIONS、PLANS。
  验证：`git status` 干净，PLANS 中该功能行链接到本计划并标记完成。
