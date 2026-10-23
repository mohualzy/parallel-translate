# YouTube 双语字幕 — 实现计划

设计：[docs/specs/2026-10-22-youtube-subtitles-design.md](../specs/2026-10-22-youtube-subtitles-design.md)
每一步完成后都要通过 `just check`；涉及内容脚本时再跑 `just e2e`，通过后单独提交。

- [x] **1. 字幕数据解析**：`src/lib/subtitles.ts`，内容包括 json3 → 条目、自动字幕合句、环境音过滤、按进度挑选待翻译条目。
  验证：`pnpm vitest run tests/unit/subtitles.test.ts` 全部通过。
- [x] **2. E2E 构建模式与仿 YouTube 测试页**：`wxt build --mode e2e` 时 YouTube 脚本额外匹配 `127.0.0.1`；`just e2e` / `just e2e-live` 改用该模式；mock 服务提供 `/watch` 与 `/api/timedtext`。
  验证：`pnpm build` 产物的 manifest 不含 `127.0.0.1`；`pnpm build:e2e` 的产物含有。
- [x] **3. 页面世界旁听**：`src/entrypoints/youtube-hook.content.ts`（MAIN world、`document_start`），包装 XHR / fetch，只读取响应，带缓存与就绪握手。
  验证：E2E 中点击 CC 后，内容脚本收到字幕文本（由第 4 步的用例覆盖）。
- [x] **4. 双语字幕层与按进度翻译**：`src/content/subtitles/`，内容包括字幕层渲染、播放同步、CC 跟随、隐藏原生字幕、视频切换、设置项。
  验证：`just e2e` 中的 YouTube 用例全部通过，覆盖双语显示、跟随进度切换条目、远处条目不提前请求、关闭 CC 后隐藏。
- [x] **5. 真实 YouTube 实测**（Playwright 被机器人检测拦截；改用 web-access 连日常 Chrome 实测通过，并据此修了字幕轨列表兜底与自动翻译字幕两个问题，见 TECH_NOTES）：用 deepseek-flash 打开一个有英文字幕的视频，打开 CC，截图检查效果。
  验证：截图里有原文 + 译文两行，且与画面时间对得上；如被 YouTube 拦截，如实记录到 TECH_NOTES。
- [x] **6. 文档**：README 使用说明、DECISIONS、TECH_NOTES、PLANS 状态更新。
  验证：`git status` 干净，PLANS 中该功能行链接到本计划并标记完成。

## 追加：优先人工字幕 + 标注自动字幕（实测反馈）

- [x] **7. 挑选人工字幕**：`pickManualTrack` 纯函数（同语言 → 英文 → 任意；排除目标语言）。
  验证：`pnpm vitest run tests/unit/subtitles.test.ts` 通过。
- [x] **8. 钩子读取字幕轨并按指令切换**：旁听到自动字幕时附带字幕轨列表；收到 `select-track` 指令时调用 `setOption('captions', 'track', …)`。
  验证：由第 9 步的 E2E 覆盖。
- [x] **9. 内容脚本切换与标注**：每个视频最多切换一次；只有自动字幕时字幕层显示「自动字幕」。
  验证：`just e2e` 中「有人工字幕时切到人工字幕」「只有自动字幕时显示标记」两个用例通过。
