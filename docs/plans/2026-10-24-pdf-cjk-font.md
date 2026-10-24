# PDF 译文中文字体 — 实现计划

目标：PDF 阅读器里可以随时切换译文的中文字体（自动 / 宋体 / 黑体 / 楷体 / 仿宋 / 本机已安装的任意中文字体 / 手动输入），切换后已打开的页面用现有译文重画，不重新请求模型。只影响中文；英文、数字仍优先用 PDF 原字体，公式、代码不变。决策见 DECISIONS D56。

## 方案要点

- 设置键 `pdfCjkFont`（`Settings`，可同步给阅读器）：`''` 自动；`@song` / `@hei` / `@kai` / `@fang` 内置预设；其他值是字体族名。
- 字体栈的选择放在 `src/lib/pdf/fonts.ts`（纯函数，可单测）：给定设置与块样式（衬线 / 无衬线、斜体）返回中文字体栈。自定义字体后面接自动栈兜底缺字。
  - 斜体用楷体；主字体本身是楷体类（预设楷体或名字含 Kai / 楷 / WenKai）时，斜体改用仿宋，避免强调看不出来。
  - 自动栈补上 Windows 上常见的 `Noto Serif SC` / `Noto Sans SC`（原来写的是 `Noto Serif CJK SC`，Windows 版 Noto 的族名对不上，落到了 SimSun）。
- 切换入口放在阅读器工具栏（看着 PDF 切换最直接），值写进设置；其他已打开的阅读器监听设置变化同步。
- 本机字体列表：`queryLocalFonts()`。已授权时打开阅读器就读取；未授权时下拉框里有「读取本机字体…」，点了才弹授权（需要用户手势）。只列出能显示中文的字体（同一段中文分别以 serif / sans-serif 兜底各画一次，像素相同说明字体自己有中文字形）。
- 手动输入：下拉框里的「手动输入…」用 `prompt()` 输入字体族名。

## 任务

- [x] **1. 字体栈**：新增 `src/lib/pdf/fonts.ts`，`draw.ts` 改用它；`drawTranslatedPage` 增加中文字体参数。
  验证：`pnpm vitest run tests/unit/pdf-fonts.test.ts` 全部通过（预设、自定义名加兜底、斜体楷体 / 仿宋、引号转义）。
- [x] **2. 设置项**：`Settings.pdfCjkFont`，默认 `''`。
  验证：`just check` 的类型检查通过；`tests/unit/settings.test.ts` 不受影响。
- [x] **3. 阅读器切换与重画**：`PdfViewer.setCjkFont` 只重画已渲染的页面，不清译文、不重新渲染 PDF；监听 `onSettingsChanged`。
  验证：E2E 切换字体后 `server.batches` 数量不变、译文页像素变化。
- [x] **4. 工具栏下拉框**：预设、本机字体分组、「读取本机字体…」「手动输入…」；当前值不在列表里时也显示出来。
  验证：E2E 用 `prompt` 输入字体名后设置里保存了该值，刷新后下拉框仍选中它。
- [x] **5. 本机字体读取实测**：在扩展页面里调用 `queryLocalFonts()`，确认授权与列表（无头 E2E 用 `grantPermissions(['local-fonts'])` 试；不行就在用户 Chrome 里手动确认）。
  验证：下拉框出现本机的中文字体（如 Microsoft YaHei、SimSun、Noto Serif SC），没有纯西文字体。
  结果：无头 Chromium 授权后列出 35 款中文字体（含 MS Gothic 等带汉字的日文字体），不含 Arial；已写进 E2E。未授权时 `queryLocalFonts()` 返回空数组而不报错，改为提示授权。用户 Chrome 里通过下拉框弹出授权框这一步需要手动确认（无头环境不弹授权框）。
- [x] **6. 全量检查**：`just check`、`just e2e` 通过。
  结果：单元 181、E2E 48 全部通过。
- [x] **7. 文档**：DECISIONS D56、PLANS.md、README（PDF 一节）、TECH_NOTES（`queryLocalFonts`、Noto 族名）。
