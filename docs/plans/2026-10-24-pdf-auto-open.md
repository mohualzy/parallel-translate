# 自动用双语阅读器打开 PDF — 实现计划

目标：打开开关后，在网页上点开 PDF（包括 arXiv `/pdf/…` 这类没有 `.pdf` 后缀的地址）直接进双语阅读器，不经过 Chrome 自带的 PDF 查看器，没有闪烁、不多一条历史记录，后退回到原来的页面。决策见 DECISIONS D61。

## 方案

- `declarativeNetRequest` 动态规则：主框架请求的响应头 `content-type` 是 `application/pdf`、且不是 `content-disposition: attachment`（下载）时，重定向到 `pdf.html#<原地址>`（`regexSubstitution` 不能编码，原地址原样放在 hash 里；请求地址本来就不带 `#`）。
- `pdf.html` 列入 `web_accessible_resources` 并设 `use_dynamic_url: true`：DNR 重定向照常可用，网页却不能用 iframe 嵌入或自己跳转到阅读器（否则任何网站都能让阅读器翻译任意 PDF，消耗用户的 API 额度）。
- 设置 `pdfAutoOpen`（默认关），后台在启动和设置变化时增删规则。
- 阅读器「原文件」按钮：后台给这个标签页、这个地址加一条会话级放行规则（优先级更高），再跳到原地址，用 Chrome 自带查看器打开。
- 不覆盖 `file://`（DNR 不作用于本地文件），本地 PDF 仍可拖进阅读器。

## 任务

- [x] **0. 实验**：最小扩展 + Playwright 验证「按响应头重定向」与 `use_dynamic_url`。
  验证：重定向后阅读器拿到完整地址（含查询串），历史 3 条、后退回摘要页；附件下载不受影响；动态地址下网页 iframe / 跳转被拦。
  结果：Chromium 148 上全部符合预期（见 D61）。
- [x] **1. 规则纯逻辑**：`src/lib/pdf/auto-open.ts`：自动打开规则、放行规则（转义地址）。
  验证：`pnpm vitest run tests/unit/pdf-auto-open.test.ts`。
- [x] **2. 后台与 manifest**：`declarativeNetRequest` 权限、`web_accessible_resources`；设置变化时同步规则；`open-original-pdf` 消息。
  验证：`just check` 通过；manifest 里有新权限与 `use_dynamic_url`。
- [x] **3. 阅读器与设置页**：阅读器读取 hash 里的地址、「原文件」按钮；设置页开关。
  验证：E2E 打开开关后访问不带 `.pdf` 后缀的 PDF 地址进入阅读器并完成翻译；点「原文件」回到原地址不被重定向；关掉开关后规则被删除。
- [x] **4. 全量检查与实测**：`just check`、`just e2e`；用户 Chrome 打开 arXiv 链接。
  结果：单元 208、E2E 51 通过。用户 Chrome 在 arXiv 摘要页点 PDF 链接直接进阅读器，历史 2 条，后退回摘要页。
- [x] **5. 文档**：DECISIONS D61、PLANS、README、TECH_NOTES。
