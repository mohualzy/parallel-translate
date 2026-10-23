# 免刷新注入 — 实现计划

设计：[docs/specs/2026-10-23-inject-open-tabs-design.md](../specs/2026-10-23-inject-open-tabs-design.md)
每一步完成后都要通过 `just check`；涉及内容脚本时再跑 `just e2e`。

- [x] **1. 新旧实例交接**：`src/content/lifecycle.ts`（派发 / 监听 `ptx-content-started`、读 `data-ptx-on`）；翻译器维护 `data-ptx-on`；悬停、划词、输入框、翻译器的页面监听挂 `ctx.signal`；`ctx` 失效时关闭翻译、解绑设置与消息监听。
  验证：`just check` 通过；第 3 步的「再次注入」用例覆盖。
- [x] **2. 注入与重试**：`src/lib/inject.ts`，包括 manifest 取文件、`injectContentScript`、带 10 秒去重的 `sendWithInject`、`injectIntoOpenTabs`；`sendToTab` 与后台发给页面的消息改走它；`onInstalled` 时注入已打开的标签页；新增 `scripting` 权限；弹窗失败文案更新。
  验证：`just check` 通过，manifest 的 permissions 含 `scripting`。
- [x] **3. E2E**：
  - 对已在翻译的页面再注入一次：旧实例退场，悬浮球只剩一个，译文从缓存恢复，开关照常可用。原计划是测「重载扩展」，但 Playwright 里 `runtime.reload()` 会把扩展卸掉，见 TECH_NOTES；
  - e2e 构建让内容脚本不匹配 `preinstalled.html`，模拟安装前就打开的页面：弹窗打开时自动注入，点「翻译此页面」能翻译。
  验证：`just e2e` 全部通过，正式构建的 manifest 不含 `exclude_matches`。
- [x] **4. 真实 Chrome**：在日常 Chrome 里重载扩展，看自己开的测试页上悬浮球是否只剩一个、能否点开翻译。
  验证：用 CDP 读 DOM，`ptx-ui-float-ball` 的数量为 1，点击后出现 `ptx-t`。
  结果：重载后约 1 秒内，旧译文被移除，新实例从缓存恢复了全部 6 段，悬浮球只有一个，开关由新实例响应。后台标签页里点不动悬浮球，改用扩展消息开关。
- [x] **5. 文档**：README、DECISIONS、TECH_NOTES、PLANS。
  验证：`git status` 干净，PLANS 中该功能行链接到本计划并标记完成。
