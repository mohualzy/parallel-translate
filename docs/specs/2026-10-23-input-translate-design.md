# 输入框翻译 — 设计

## 目标

在任意网页的输入框里用中文写完，一键换成目标语言（默认英文）再发出去。Alt+I、连按三次空格两种触发，过滤输入法，写回后可撤销。

## 触发

| 方式 | 范围 | 实现 |
|---|---|---|
| `Alt+I`（`chrome.commands`，可在快捷键页改） | 输入框里有选中文字时只翻选区，否则翻整个输入框 | 后台收到命令后发给标签页**所有 frame**；只有 `document.hasFocus()` 且焦点在可编辑元素上的那个 frame 响应 |
| 连按三次空格（设置可关） | 整个输入框（去掉末尾的三个空格） | 内容脚本监听 `input` 事件 |

为什么快捷键走 `chrome.commands` 而不是页面里监听 keydown：和 Alt+A / Alt+W 一致，用户能在 `chrome://extensions/shortcuts` 改键；页面拦截按键也不影响。

### 三次空格的误触发防护

输入法（中文拼音用空格选词）和代码编辑器（空格缩进）最容易误触发，判定同时满足：

1. 三次连续的**可信** `input` 事件，`inputType === 'insertText'` 且 `data === ' '`，不在组合输入中（`isComposing`）；相邻两次间隔 ≤ 800ms。输入法上屏是 `insertCompositionText`，天然不计数；中间夹着任何其他输入就清零。
2. 光标前的文本确实以三个空格（含 `&nbsp;`）结尾，光标后没有非空白内容（只在末尾触发，避免在文中误改）。
3. 光标所在行去掉空格后不为空（行首敲空格是缩进）。
4. 不在代码编辑器里（`.monaco-editor`、`.cm-editor`、`.CodeMirror`、`.ace_editor`）。

## 哪些元素算输入框

`textarea`、`type` 为 text / search 或缺省的 `input`、`contenteditable`；排除 `readonly` / `disabled`。密码框、邮箱、数字等一律不碰。焦点在 open shadow root 里时沿 `activeElement` 往下找。最多 5000 字，超出提示不翻译。

## 翻译请求

- 新消息 `translate-input { text }` → 后台 `translateInput`，单次请求（非流式 UI，不排网页批量队列），结果缓存。
- 独立 prompt（`buildInputMessages`，`INPUT_PROMPT_VERSION`）：把 `<text>` 内的内容译成目标语言，保留换行、@提及、URL、表情、Markdown；只输出译文。输入内容同样视为数据，不拼进 system 指令（硬性规则 5）。
- 不带术语表和网页翻译的风格要求：术语表是「外文 → 母语」方向，用在反方向会出错。
- 目标语言是独立设置 `inputTargetLang`（默认 `en`），和网页翻译的目标语言无关。

## 写回

按顺序尝试，每一步写完都读回校验：

1. 选中要替换的范围，`document.execCommand('insertText')`：会触发 `beforeinput`/`input`，React、ProseMirror 等编辑器能感知，且进入浏览器原生撤销栈（Ctrl+Z 直接还原）。
2. 失败时：`input`/`textarea` 用原生 `value` setter + `input` 事件（绕过 React 的受控值缓存）；`contenteditable` 派发带 `DataTransfer` 的 `paste` 事件（Slack、Lexical、Draft.js 都处理粘贴）。这条路不进原生撤销栈，由扩展记录原文，在该输入框里按 Ctrl+Z 时还原一次。
3. 仍失败：把译文复制到剪贴板并提示手动粘贴。

请求期间用户继续编辑了输入框（内容与发出时不同），放弃写回并提示，避免覆盖新输入。

## 提示

复用页面顶部 toast：「正在翻译成 English…」→「已翻译，Ctrl+Z 撤销」/ 错误原因。模型原样返回（已是目标语言）时提示而不写回。

## 不做

- 实时预览/候选译文浮层。
- 跨 frame 的焦点判断之外的 iframe 协调：每个 frame 各管自己的输入框。
