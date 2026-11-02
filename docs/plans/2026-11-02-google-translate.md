# 内置 Google 翻译：实现计划

设计见 [specs/2026-11-02-google-translate-design.md](../specs/2026-11-02-google-translate-design.md)。

- [x] `MachineClient` 接口和 `src/lib/providers/google.ts`。验证：`tests/unit/google.test.ts` 覆盖请求参数、批量解析、实体解码、错误。
- [x] `settings.ts` 内置服务，不落盘、排在最后。验证：`tests/unit/settings.test.ts`。
- [x] `background/translate.ts` 接入：批量、单段、测试连接；术语抽取和视频预读跳过。验证：`just check`。
- [x] 弹窗、侧栏去掉「未配置」分支；设置页隐藏模型字段。验证：`just e2e`。
- [x] 真实接口实测：网页占位标签、划词、侧栏多段、PDF。验证：`pnpm exec playwright test -c playwright.live.config.ts tests/live/google.spec.ts`。
- [x] README、隐私政策、DECISIONS、TECH_NOTES、PLANS。
