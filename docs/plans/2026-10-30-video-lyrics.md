# 音乐视频用同步歌词当原文 — 实现计划

目标：只有自动字幕的音乐视频，用 LRCLIB 的同步歌词代替语音识别当原文，所有歌自动生效，查不到或对不上时退回现状。设计见 [YouTube 字幕设计](../specs/2026-10-22-youtube-subtitles-design.md) 第 7 点，决策见 DECISIONS D73。

## 任务

- [x] **1. 纯逻辑**：`src/lib/lyrics.ts`：`songQuery`（解析歌手、歌名）、`parseLrc`、`pickLyrics`、`alignLyrics`、`lyricsToCues`。
  验证：`pnpm vitest run tests/unit/lyrics.test.ts`。
- [x] **2. 后台查询**：`src/background/lyrics.ts` 请求 LRCLIB，只缓存查到的结果；`lookup-lyrics` 消息。
  验证：`just check` 通过。
- [x] **3. 字幕流程**：钩子附带视频信息；查询和对齐完成前不翻译；替换条目、显示「歌词」标记；之后再全片预读；设置项 `videoLyrics`。
  验证：E2E：查到时显示歌词且不翻译自动字幕、对不上时保留自动字幕、关闭设置不查询。
- [x] **4. 全量检查**：`just check`、`just e2e`。
  结果：单元 247、E2E 65 通过。
- [x] **5. 真实歌曲实测**：几首不同语言、不同类型的只有自动字幕的音乐视频，记录能否查到、偏移、抽样对照。
  结果：13 组搜索的候选里，只有自动字幕的音乐视频 3 个，都查到了歌词（日语 MV、日语短版、英语歌词视频）；韩语没有找到这类视频，没有实测。《群青》MV 上，自动字幕较准的 3、10、80、90、95 秒都落在同一句歌词上。
- [x] **6. 文档**：DECISIONS D73、TECH_NOTES、PLANS、README。
