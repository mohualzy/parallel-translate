# 隐私政策 / Privacy Policy

生效日期 / Effective date: 2026-11-01

双语对照翻译（Parallel Translate）没有自己的服务器，开发者收不到你的任何数据。扩展不含统计、分析或广告代码。

## 保存在本机的数据

以下数据只保存在你的浏览器里，不同步：

- 翻译服务配置，包括 API Key
- 扩展设置、术语表、网站规则
- 译文缓存（30 天后清除，可在设置页清空）
- PDF 的高亮、下划线和阅读位置

## 发送给你配置的翻译服务的数据

扩展把内容发给你在设置页填写的翻译服务（比如 DeepSeek、OpenAI，或本地的 Ollama、llama.cpp），由它返回译文。发送时附带你的 API Key。

只有你开启翻译或主动发起翻译时才会发送：

- 待翻译的网页文字、选中的文字、输入框或侧栏里的文字
- 视频字幕
- PDF 的文字片段；PDF 文件本身只在本机解析，不上传
- 帮助模型理解语境的页面标题、页面摘要和前后文

这些数据由你选择的服务商处理，适用该服务商的隐私政策。使用本地模型时，这些内容不离开你的电脑。

## 发送给 LRCLIB 的数据

只有自动字幕的音乐视频，扩展会把歌手和歌名发给 [lrclib.net](https://lrclib.net) 查询同步歌词，不发送视频 ID、页面地址或其他数据。可在设置页关闭。

## 不做的事

不出售、不转让你的数据，也不把数据用于广告、信用评估或与翻译无关的用途。

## 联系方式

问题请在 [GitHub Issues](https://github.com/mohualzy/parallel-translate/issues) 提出。

---

## English

Parallel Translate has no server of its own, and the developer receives none of your data. The extension contains no analytics, tracking or advertising code.

**Stored locally, never synced:** translation service settings including your API key, extension settings, glossary and site rules, the translation cache (cleared after 30 days, or from the settings page), and PDF highlights and reading positions.

**Sent to the translation service you configure,** only when you start or enable translation, together with your API key: page text, selected text, text from input boxes or the side panel, video subtitles, text fragments from PDFs, and context that helps the model such as the page title, page summary and surrounding text. PDF files themselves are parsed locally and never uploaded. Your chosen provider's privacy policy applies. With a local model, this content stays on your computer.

**Sent to LRCLIB:** for music videos that only have auto-generated captions, the artist and track name are sent to [lrclib.net](https://lrclib.net) to look up synced lyrics. No video ID, page address or other data is sent. This can be turned off in settings.

**We do not** sell or transfer your data, or use it for advertising, creditworthiness or anything unrelated to translation.

**Contact:** [GitHub Issues](https://github.com/mohualzy/parallel-translate/issues).
