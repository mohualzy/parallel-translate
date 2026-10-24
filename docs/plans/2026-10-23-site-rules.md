# 常见网站适配规则 — 实现计划

设计：[docs/specs/2026-10-23-site-rules-design.md](../specs/2026-10-23-site-rules-design.md)
每一步完成后都要通过 `just check`；涉及内容脚本时再跑 `just e2e`。

> 这一项先做了真实站点实测（要知道问题在哪才能定规则格式），设计文档是实测后补写的。

- [x] **1. 实测**：用 e2e 构建 + mock 模型 + Playwright 访问 HN 首页 / 评论页、GitHub 仓库 / 文件 / PR / issue；X、Reddit 用日常 Chrome 尝试。
  验证：每个页面列出被翻译的段落；X、Reddit 无法访问的原因记录到 TECH_NOTES。
- [x] **2. 通用修正**：哈希类名的读屏专用文字；`visibility:hidden` 的内容在懒翻译与立即翻译整页中都跳过。
  验证：`just e2e` 中立即翻译整页用例断言收起的菜单与读屏标题不发送。
- [x] **3. 规则机制**：`src/lib/site-rules.ts`（`include` / `exclude`）；`DomClassifier` 合并排除、判断白名单；设置项 `siteRules` 与设置页开关。
  验证：`pnpm vitest run tests/unit/site-rules.test.ts`（含「选择器合法、不含哈希类名」检查）；e2e 构建的 localhost 测试规则用例通过；正式构建的内容脚本不含 `localhost`。
- [x] **4. 规则内容**：Hacker News（白名单）、GitHub（排除）。
  验证：重新实测，段数变化记录在设计文档。
- [x] **5. 文档**：README、DECISIONS、TECH_NOTES、PLANS。
  验证：`git status` 干净。
- [x] **6. X、Reddit**：已登录的日常 Chrome 里只读实测。Reddit 修了两个通用的 Shadow DOM 识别问题，不需要规则；X 加排除规则（仅译文模式下的用户名、趋势、浏览量）。
  验证：Reddit 列表页、帖子页段落正常且无重复标题；X 个人主页、推文页在仅译文模式下不再翻译名字和趋势。
