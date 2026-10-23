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

## 页面内 UI 与 Shadow DOM

- WXT 的 `createShadowRootUi` 设置 `isolateEvents` 后，会在宿主上阻止按键事件冒泡。焦点在组件内部时，document 上监听不到 Esc，需要在 shadow root 内另外监听。
- 事件从 shadow 树冒泡到 document 时，`target` 被重定向为宿主；判断事件是否来自扩展 UI 要看 `composedPath()`。
- `<slot>` 默认是 `display: contents`，没有盒子，IntersectionObserver 永远不会报告它可见。容器是 `display: contents` 时，改为观察片段本身。
- 页面级 CSS（manifest 注入）进不了 shadow root，插到 shadow 树里的 `<ptx-t>` 需要用 `adoptedStyleSheets` 补上样式。
- MutationObserver 观察 document 时看不到 shadow 树内部的变化，每个遍历到的 shadow root 都要单独 `observe`。

## iframe

- `chrome.tabs.sendMessage` 不指定 `frameId` 时会发给所有 frame，Promise 取第一个回复。所以 iframe 一律不回复；需要状态时显式指定 `{ frameId: 0 }`。

## 测试相关

- happy-dom 不支持属性选择器的大小写标志（`[name="description" i]`），但 Chrome 支持；需要不区分大小写时手动比较。
- Playwright 的 `dblclick()` / `click()` 默认点在元素中心。块级段落的中心可能已在文字末尾之外，选不中词；精确选词要用 Range。
- 流式 UI 的完成判定不能看「不再是加载中」，要有明确的完成状态（划词弹窗用 `data-state="done"`）。

## YouTube

- 字幕接口 `/api/timedtext` 自 2024 年起需要播放器生成的 `pot` 令牌，不能用 `captionTracks[].baseUrl` 直接请求。
- 自动化浏览器（Playwright 自带的 Chromium，无头和有头模式都一样）打开视频会被拦截，显示「请登录，以便我们确认你不是聊天机器人」，视频不播放（2026-10-22，当前网络环境）。所以字幕功能的自动化测试用仿 YouTube 测试页（e2e 构建模式），真实站点只能手动验证。
- 已确认的真实页面结构：`#movie_player`（`.html5-video-player`）、其中的 `<video>`、带 `aria-pressed` 的 `.ytp-subtitles-button`、`.ytp-caption-window-container`；控制栏隐藏时播放器带 `ytp-autohide` 类。播放器请求字幕的格式按 json3（`fmt=json3`）处理，尚未在真实页面上抓包确认。
- 多个内容脚本共用同一个 `YOUTUBE_MATCHES` 数组对象，在 `build:manifestGenerated` 钩子里不能直接 `push`（会被追加多次），要赋新数组。
- 测试页里，页面脚本给 `<video>` 定义的属性在隔离世界看不到，所以时间源用 `canvas.captureStream()` 的真实视频流。
- 字幕轨列表与切换：页面世界的 `#movie_player` 元素上有非公开接口 `getOption('captions', 'tracklist')`（每条带 `languageCode`、`kind`（自动字幕为 `asr`）、`vss_id`（人工 `.en`、自动 `a.en`））和 `setOption('captions', 'track', track)`。只能在 MAIN world 调用，隔离世界拿不到这些方法。切换后播放器会重新请求一次 timedtext（不带 `kind=asr`）。
- 自动字幕的分词：英文每个词自带前导空格（`" guys"`），日文、中文没有空格，合句时要保留原始分隔。
- 真实 YouTube 实测（2026-10-22，通过 web-access 的 CDP 连到日常 Chrome，不会被机器人检测拦截）：
  - 字幕请求确实是 `fmt=json3`，响应以 `{"wireMagic": "pb3"` 开头；自动字幕带 `kind=asr`。
  - `getOption('captions', 'tracklist')` 在只有自动字幕的视频上返回空数组，`getPlayerResponse().captions.playerCaptionsTracklistRenderer.captionTracks` 才可靠（字段名 `vssId`）。
  - `setOption('captions', 'track', { languageCode: 'en' })` 在同语言同时有人工字幕和自动字幕时会选中人工字幕；想切到自动字幕（`a.en`），用这几种写法都会被改回人工字幕。
  - **字幕语言偏好是全局的**：在任意视频上 `setOption` 切换语言，会改变用户在所有视频上的默认字幕语言。之后打开只有日语自动字幕的视频，播放器会自动翻译成英文（请求带 `tlang=en`）。测试时改过偏好，必须改回去。

## 可见性与排版

- IntersectionObserver：目标被祖先（`overflow: hidden; height: 0` 的折叠容器）裁剪成零面积时，若贴着边，仍会报告 `isIntersecting: true`。判断「真正可见」要看 `intersectionRect` 面积是否大于 0（目标本身面积为 0 的锚点除外）。
- `font-size: 0` 会让容器上所有用 em / ch 表示的尺寸（宽度、max-width、内边距、间距）一起归零，所以仅译文模式不能假设隐藏原文不影响容器尺寸。
- 后台标签页不执行 `requestAnimationFrame`，也不重绘：依赖 rAF 的排版检查要等标签页切到前台才会运行；通过 CDP 截后台标签页，拿到的是旧画面，验证要以 DOM 状态为准。

## 输入框与富文本编辑器

- 富文本编辑器的段落是带外边距的 `<p>`，`innerText` 在段落之间返回空行（`a\n\nb`）。拿它当原文翻译再写回，每段之间会多出一个空段落；要按块级子元素逐个取文本，用单个换行连接。
- Lexical 靠异步的 `selectionchange` 同步内部选区：用 Range 选中后立刻 `execCommand('insertText')` 会返回 true 但什么都没写进去；等约 50ms 再写才生效。它的 insertText 会丢掉换行，合成的 `paste` 事件（`DataTransfer` 放 `text/plain`）则按行建段落，Ctrl+Z 一次撤销。
- ProseMirror 接受 insertText（换行变成新段落），撤销由它自己的历史记录处理：`execCommand('undo')` 无效，要靠 Ctrl+Z 按键。
- 合成的 `paste` 事件浏览器不会执行默认粘贴：普通 contenteditable 收到后什么都不发生，只能当作「编辑器自己处理粘贴」的探测手段。
- 快捷键冲突：沉浸式翻译同样占用 Alt+A / Alt+W / Alt+I。两个扩展都装着时，后装的拿不到默认按键（实测本机所有命令都没有绑定），需要在 `chrome://extensions/shortcuts` 手动设置。

