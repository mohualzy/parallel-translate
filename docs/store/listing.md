# 商店上架材料

Chrome Web Store 和 Microsoft Edge Add-ons 共用。图片在同目录。

- 隐私政策：https://github.com/mohualzy/parallel-translate/blob/main/PRIVACY.md
- 主页与支持：https://github.com/mohualzy/parallel-translate
- 类别：Chrome 选「工具 / Tools」，Edge 选「Productivity」
- 语言：简体中文

## 简短说明

网页、PDF、YouTube 字幕双语对照翻译，使用你自己的大模型 API，公式和排版原样保留。

## 详细说明

把网页、PDF 和 YouTube 字幕翻成双语对照。模型由你自己选：DeepSeek、通义千问、Kimi、智谱、OpenAI、Gemini 等任何 OpenAI 兼容接口，也可以用本机的 Ollama、llama.cpp。请求直接发给你配置的服务，不经过任何中间服务器。

使用前需要准备一个模型服务的 API Key，或在本机运行模型。

主要功能：

- 网页双语对照：译文插在原文下方，保留链接、粗体和行内代码，也可切换仅译文
- PDF 双语阅读：译文写回原版面，公式和代码原样保留，文件只在本机解析
- YouTube 双语字幕：先通读全片再逐批翻译，只翻译当前播放位置附近
- LaTeX 公式：网页、划词和侧栏里的源码，在译文里显示成渲染好的公式
- 术语一致：长文自动统一术语译法，也可以自建术语表
- 划词翻译、悬停翻译、输入框翻译、侧栏文本翻译
- 翻译风格：技术文档、学术论文、新闻等六种风格，按网站自动选择
- 省钱：只翻译滚动到的内容，多段合并请求，译文缓存 30 天

开源：https://github.com/mohualzy/parallel-translate

## 单一用途

把用户正在浏览的内容（网页、PDF、视频字幕）翻译成用户选择的语言，并以双语对照方式显示。

Translate the content the user is viewing (web pages, PDFs and video subtitles) into the user's chosen language and display it side by side with the original.

## 权限理由

| 权限 | 理由 |
|---|---|
| `storage` | Saves the user's translation service settings, preferences, glossary and PDF highlights locally. |
| `contextMenus` | Adds right-click menu items to translate the page, translate selected text in the side panel, and open a PDF link in the bilingual reader. |
| `scripting` | Injects the extension's own bundled content script into tabs that were already open when the extension was installed or updated, so they work without a reload. No remote code is executed. |
| `declarativeNetRequest` | When the user turns on the optional setting, redirects PDF responses into the extension's local bilingual PDF reader. Off by default. |
| `sidePanel` | Provides the text translation side panel. |
| 主机权限 `<all_urls>` | The user chooses to translate any website, so the content script must run on all pages. Requests must reach whatever API base URL the user configures, including local addresses such as localhost, and PDFs must be fetched from the site hosting them. |

## 远程代码

不使用。所有代码都在扩展包内，包括 pdf.js 和 KaTeX。

No. All code, including pdf.js and KaTeX, is included in the package.

## 数据使用声明

勾选：

- 网站内容（Website content）：待翻译的文字发给用户自己配置的翻译服务
- 身份验证信息（Authentication information）：用户的 API Key 只保存在本机，只发给用户自己配置的翻译服务

三项承诺都勾选：不出售给第三方；不用于与单一用途无关的目的；不用于信用评估或贷款。

## 审核备注

This extension uses the reviewer's own model service, so it needs an API key or a local model to translate. No account with the developer exists.

To test: 1) Open the settings page, which opens automatically after install. 2) Next to "翻译服务" choose a preset, click "添加", enter a Base URL, model and API key for any OpenAI-compatible service, or use a local Ollama server, then click "保存". 3) Open any English web page and press Alt+A, or click the toolbar icon and choose "翻译此页面". Translations appear under each paragraph.
