# TECH_NOTES — 踩坑与平台限制

## 扩展平台

### Service Worker 生命周期（MV3）

- Chrome 会在以下情况终止 background service worker：空闲 30 秒（收到事件或调用扩展 API 会重置计时）、单个事件处理超过 5 分钟、**`fetch()` 响应超过 30 秒还没到达**。
- 对策（`src/background/translate.ts`）：
  1. 模型请求默认 `stream: true`，响应头几乎立即返回；
  2. 有请求进行时每 20 秒调用一次 `browser.runtime.getPlatformInfo()` 重置空闲计时（`keepAlive`）。

### 内容脚本不能直接请求模型 API

- Chrome 85 起，内容脚本的跨域 `fetch` 按网页来源处理，会被 CORS 拦截；而且内容脚本不应持有 API Key。所有请求经 `runtime.sendMessage` 交给 background。
- `onMessage` 用 `sendResponse` + `return true` 的写法；「监听器直接返回 Promise」不是所有 Chromium 版本都支持。

### 已打开的标签页没有内容脚本

- 安装/更新扩展前打开的页面不会自动注入内容脚本，`tabs.sendMessage` 会失败。目前在弹窗里提示「刷新页面」；后续可以用 `scripting.executeScript` 按需注入。

### 自动化测试只能用 Chromium

- Chrome 137 起，正式版 Chrome 不再支持 `--load-extension` 命令行参数。Playwright E2E 使用其自带的 Chromium（`channel: 'chromium'`，新版 headless 支持扩展）。
- `@playwright/test` 锁定 1.60.0，对应本机已缓存的 chromium-1223。升级时需要执行 `pnpm exec playwright install chromium`。

## DOM 与段落识别

### getComputedStyle 的 display

- flex/grid 容器的子元素会被「块化」：`<span>` 作为 flex 子项时 computed display 是 `block`。所以段落识别以 computed style 为准，而不只看标签名。
- 脱离文档的元素在 Chrome 里返回空字符串；happy-dom 对行内元素也返回空字符串。按 CSS 规范，display 初始值是 `inline`，空串一律按 `inline` 处理。
- 为了扫描速度，`div/p/li` 等明确的块级标签跳过 `getComputedStyle`。

### 只给读屏器的隐藏文字

- `.sr-only` 一类元素用「绝对定位 + `clip`/`clip-path` 裁剪」隐藏，不是 `display:none`，IntersectionObserver 也照常触发。不处理的话会出现 `Fork16.8k (16.8k)` 这样的重复译文。判断见 `DomClassifier.compute`。

### 区分自己和页面的 DOM 变化

- MutationObserver 会收到我们自己插入/删除 `<ptx-t>` 产生的记录。处理方式：新增节点是 `<ptx-t>` 的记录直接忽略；自己删除的节点放进 `WeakSet`（`ownRemovals`），删除记录据此过滤。
- 页面框架删掉译文节点（重渲染）时会重新扫描并补回，每段最多补 5 次，防止和页面脚本无限拉锯。

### 发现「段落被改写」不能只靠节点身份

- 页面用 `el.textContent = …` 更新文字时，旧文本节点被整体替换，新段落和旧段落没有共享节点。所以除了「原节点文本变了」，还要在动态扫描时比较同一容器上一次登记的整段内容（`lastByContainer`）。首次整页扫描不做这个比较，否则同一容器里的多个片段会互相误判。

### 富文本占位编号

- 编号按先序分配（外层元素先编号），模型看到 `<g0>the <g1>docs</g1></g0>` 比 `<g1>the <g0>docs</g0></g1>` 更自然，也更不容易调换标签。

## 工具链

- TypeScript 7（原生实现）与 WXT 0.21 生成的 tsconfig 兼容，`tsc --noEmit` 可用。
- WXT 0.21 中 `vite` 是 peer dependency，需要显式安装。
- justfile 在 Windows 上用 `powershell.exe` 执行（`set windows-shell`）。

## 真实模型

### DeepSeek（2026-10-22 实测）

- `/v1/models` 返回 `deepseek-flash`、`deepseek-v4-pro`，旧的 `deepseek-chat` 不在列表里；两者都带 `effort` 字段，默认 `high`，即默认推理。
- 关闭推理用 `{"thinking": {"type": "disabled"}}`；`reasoning_effort: "low"` 并不会减少推理 token。
- 关闭推理后，分段协议（`<s id>`）与占位标签（`<gN>`、`<xN>`）遵守良好，测试页和 Wikipedia、HN、GitHub、paulgraham.com 上均无漏段、无标签残留。

### 实测脚本的坑

- GitHub 仓库改名后旧地址会重定向（`facebook/react` → `react/react`）。按导航前的 URL 找标签页会找不到，必须用 `page.url()` 取跳转后的地址。
