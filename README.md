# 双语对照翻译 (Parallel Translate)

自用的网页双语对照翻译扩展，翻译服务用你自己的大模型 API。

- **双语对照**：译文插在每段原文下方，保留链接、加粗、行内代码；也可切换「仅译文」
- **自带模型**：任何 OpenAI 兼容接口——DeepSeek、通义千问、Kimi、智谱、硅基流动、OpenRouter、Gemini、OpenAI、本地 Ollama
- **省钱**：只翻译滚动到的部分；多段合并成一次请求；译文缓存 30 天，重复访问不再计费
- **悬停翻译**：鼠标停在段落上单按一下 Ctrl，只翻译这一段
- **动态页面**：无限滚动、SPA 新出现的内容自动翻译
- **网站规则**：总是翻译 / 永不翻译 / 自定义不翻译区域

## 安装

```bash
pnpm install
```
Reason: 安装依赖（会自动执行 `wxt prepare` 生成类型）

```bash
just build
```
Reason: 构建 Chrome/Edge 版到 `.output/chrome-mv3`

然后在浏览器中加载：

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
2. 打开右上角「开发者模式」
3. 点「加载已解压的扩展程序」，选择 `.output/chrome-mv3` 目录
4. **刷新已经打开的网页**（安装前打开的页面里没有扩展脚本）

更新代码后重新 `just build`，在扩展管理页点扩展卡片上的刷新按钮即可。

## 配置翻译服务

首次安装会自动打开设置页：

1. 在「翻译服务」右侧选择预设（如 DeepSeek），点「添加」
2. 填入 API Key
3. 点「获取模型列表」，在模型输入框里选择模型（也可以直接手填）
4. 点「测试连接」，看到「连接成功」和译文示例后点「保存」

可以添加多个服务，在弹窗里随时切换。「高级选项」里可以调温度、并发数、超时，写自定义翻译要求（例如「技术文档风格，API 名称保留英文」），以及填写额外请求参数（JSON，合并进请求体）。

## 使用

| 操作 | 方式 |
|---|---|
| 翻译 / 还原整页 | `Alt+A`，或点工具栏图标 →「翻译此页面」，或右键菜单 |
| 切换双语 / 仅译文 | `Alt+W`，或在弹窗里切换 |
| 只翻译某一段 | 鼠标停在段落上，单按一下 `Ctrl`（再按一次收起）；按键可在设置里改 |
| 翻译失败重试 | 点击段落下方红色的「翻译失败，点击重试」（鼠标悬停可看原因） |
| 修改快捷键 | 弹窗底部「修改快捷键」，或 `chrome://extensions/shortcuts` |

## 常见问题

- **快捷键没反应**：如果同时装着沉浸式翻译，`Alt+A` 会冲突，在 `chrome://extensions/shortcuts` 里改掉其中一个。
- **某些页面无法翻译**：浏览器内置页面（`chrome://`）、扩展商店不允许扩展运行。
- **按钮、导航没有被翻译**：默认跳过短的界面文字，避免撑乱布局。需要时可以悬停按 Ctrl 单独翻译，或在设置里关闭「跳过按钮、标签页、导航链接等短界面文字」。
- **Ollama 返回 403**：Ollama 默认拒绝来自扩展的请求，启动前设置环境变量 `OLLAMA_ORIGINS=chrome-extension://*`。
- **DeepSeek**：当前模型是 `deepseek-flash` / `deepseek-v4-pro`，默认会推理。预设已自动填好 `{"thinking": {"type": "disabled"}}`，实测输出 token 减少约 75%；手动添加时记得加上。
- **推理模型太慢、太贵**：在「高级选项 → 额外请求参数」里关闭思考，参数名因服务而异，例如通义 `{"enable_thinking": false}`、Ollama `{"think": false}`、OpenAI `{"reasoning_effort": "minimal"}`，以服务商文档为准。
- **偶尔有段落漏翻**：弱模型可能漏掉批量中的个别段落，扩展会自动逐段补翻；仍失败时点击重试，或在设置里调小「每次请求最多段落数」。
- **费用**：只有滚动到的段落才会请求；已翻译内容缓存在本机，重复访问不计费。

## 隐私

- API Key 只保存在本机浏览器（`chrome.storage.local`），不会同步，导出设置时默认不包含。
- 页面文本只会发送到你配置的翻译服务地址。

## 开发

开发约定、目录结构和命令见 [AGENTS.md](AGENTS.md)；路线图见 [docs/PLANS.md](docs/PLANS.md)；技术决策见 [docs/DECISIONS.md](docs/DECISIONS.md)。

```bash
just check
```
Reason: 类型检查 + 单元测试 + 构建

```bash
just e2e
```
Reason: 加载真实扩展、用本地 mock 模型服务跑端到端测试

```bash
just e2e-live
```
Reason: 用真实 DeepSeek API 验证模型遵守分段/占位协议（需要环境变量 `DEEPSEEK_API_KEY`，会产生几分钱费用；未设置时自动跳过）
