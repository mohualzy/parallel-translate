# YouTube 字幕：自己挑原文轨，不动播放器 — 实现计划

目标：双语字幕的原文总是视频本来的字幕（语音同语言的人工字幕优先），不受用户全局字幕语言偏好和 YouTube 自动翻译的影响；扩展不再调用 `setOption` 改写播放器设置。设计见 [设计文档](../specs/2026-10-22-youtube-subtitles-design.md) 第 6 点，决策见 DECISIONS D70。

起因：用户的全局字幕语言偏好是韩语，YOASOBI《群青》（只有日语、英语人工字幕）显示成「英语 >> 韩语」，扩展再把韩语翻成中文。

## 任务

- [x] **1. 挑轨纯逻辑**：`src/lib/subtitles.ts` 用 `pickSourceTrack` 取代 `pickManualTrack`（语音语言：自动字幕的语言，否则按标题和简介判断；顺序见设计文档）；新增 `sourceTrackUrl`：字幕轨 `baseUrl` + 播放器请求里多出来的参数（去掉 `tlang`）。
  验证：`pnpm vitest run tests/unit/subtitles.test.ts`。
- [x] **2. 钩子与消息**：钩子每次旁听都附带 `captionTracks`（含 `baseUrl`）和标题、简介；删除 `select-track`，新增 `fetch-track`：用未包装的 `fetch` 拉指定轨，结果以 `fetched` 标记发回（失败时 body 为空）。
  验证：`just check` 通过；`grep -rn "setOption" src` 没有调用。
- [x] **3. 内容脚本**：挑出的轨和播放器加载的不同（或带 `tlang`）时请求钩子拉取，拉取失败退回播放器加载的那条；同一视频同一轨不重复拉。播放器加载的轨在观看中变了（用户在字幕菜单里换轨），跟随用户选的轨。
  验证：同上。
- [x] **4. 仿 YouTube 测试页与 E2E**：测试页的 `captionTracks` 带 `baseUrl`、`videoDetails`；新增「日语歌，偏好韩语」用例；人工 / 自动混合的用例改为断言播放器字幕轨未被改动；`tlang` 用例改为都用原文轨翻译。
  验证：`just e2e` 全部通过。
  结果：单元 227、E2E 61 通过。mock 字幕接口没有 `pot` 令牌时返回 403，用来确认拉取带上了播放器的令牌。
- [x] **5. 真实 YouTube 实测**：用户 Chrome 打开《群青》（偏好仍是韩语），字幕层原文是日语，译文是中文；播放器仍显示「英语 >> 韩语」，`yt-player-caption-sticky-language` 不变。
  结果：1:48 处字幕层原文「渋谷の街に朝が降る」、译文「涩谷的街头迎来清晨」；播放器仍是「英语 >> 韩语」，偏好仍是 `ko`。
- [x] **6. 文档**：DECISIONS D70（取代 D34 的切换做法和 D35）、TECH_NOTES、PLANS。
