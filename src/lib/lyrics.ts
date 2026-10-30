import { baseLang, isProbablyInLanguage } from './languages';
import type { Cue } from './subtitles';

/**
 * 音乐视频的同步歌词（LRCLIB）：解析歌名、挑选歌词、和自动字幕对齐。纯函数，便于单测。
 * 设计见 docs/specs/2026-10-22-youtube-subtitles-design.md 第 7 点。
 */

export interface LyricLine {
  /** 毫秒 */
  start: number;
  /** 空字符串是 LRC 里的结束标记，只用来确定上一行什么时候结束 */
  text: string;
}

export interface Lyrics {
  lines: LyricLine[];
  /** 歌曲时长（秒），LRCLIB 没有记录时为空 */
  seconds: number | null;
}

export interface SongQuery {
  artist: string;
  track: string;
}

/** 标题里和歌名无关的部分：括号内容、Official Video 之类的说明 */
const TITLE_NOISE =
  /[\[(【（][^\])】）]*[\])】）]|\bofficial\b|\b(?:music|lyrics?)\s+video\b|\bvideo\b|\baudio\b|\bm\/?v\b|\blyrics\b|\b(?:hd|4k)\b/gi;

function cleanArtist(author: string): string {
  return author
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/\s*official(?:\s+(?:youtube\s+)?channel)?$/i, '')
    .replace(/VEVO$/i, '')
    .trim();
}

/** 从视频标题和频道名解析歌手、歌名：`Artist「Title」…`、`Artist - Title`，否则整个标题当歌名 */
export function songQuery(title: string, author: string): SongQuery {
  const artist = cleanArtist(author);
  const quoted = /[「『](.+?)[」』]/.exec(title)?.[1]?.trim();
  if (quoted) return { artist, track: quoted };

  const clean = title.replace(TITLE_NOISE, ' ').replace(/\s+/g, ' ').trim();
  const dash = /^(.+?)\s+[-–—|/]\s+(.+)$/.exec(clean);
  if (dash) {
    const [left, right] = [dash[1]!.trim(), dash[2]!.trim()];
    // 频道名和右边一致时是 `Title - Artist`，其余按 `Artist - Title`
    if (artist && right.toLowerCase().includes(artist.toLowerCase())) return { artist, track: left };
    return { artist: left, track: right };
  }
  const track = artist ? clean.replace(new RegExp(artist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '').trim() : clean;
  return { artist, track: track || clean };
}

export function parseLrc(lrc: string): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const raw of lrc.split('\n')) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (stamps.length === 0) continue;
    const text = raw.slice(stamps.at(-1)!.index + stamps.at(-1)![0].length).trim();
    for (const m of stamps) lines.push({ start: Math.round((Number(m[1]) * 60 + Number(m[2])) * 1000), text });
  }
  return lines.sort((a, b) => a.start - b.start);
}

export interface LyricsRecord {
  duration?: number | null;
  syncedLyrics?: string | null;
}

/** 选带时间轴、文字系统和字幕语言一致（排除罗马音、译文版）的歌词，时长最接近的优先 */
export function pickLyrics(records: LyricsRecord[], seconds: number, lang: string): Lyrics | undefined {
  const scripted = ['ja', 'ko', 'ru', 'zh'].includes(baseLang(lang));
  const gap = (r: LyricsRecord) => Math.abs((r.duration ?? Infinity) - seconds);
  const [best] = records
    .filter((r) => r.syncedLyrics && (!scripted || isProbablyInLanguage(r.syncedLyrics.replace(/\[[^\]]*\]/g, ''), lang)))
    .sort((a, b) => gap(a) - gap(b));
  return best?.syncedLyrics ? { lines: parseLrc(best.syncedLyrics), seconds: best.duration ?? null } : undefined;
}

const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function trigrams(s: string): string[] {
  const grams = [];
  for (let i = 0; i + 3 <= s.length; i++) grams.push(s.slice(i, i + 3));
  return grams;
}

const covered = (grams: string[], text: string) => grams.filter((g) => text.includes(g)).length / grams.length;

/** 两句相似：较短的一句有 40% 的片段出现在另一句里（自动字幕可能比歌词长，也可能只听出半句） */
function similar(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const grams = trigrams(short);
  return grams.length >= 2 && covered(grams, long) >= 0.4;
}

/** 投票窗口：时间差落在 3 秒内算同一个偏移 */
const VOTE_WINDOW_MS = 3000;
const MIN_VOTES = 3;
/** 投票不够时，歌词和视频时长相差不超过这么多才按偏移 0 使用 */
const SAME_LENGTH_SECONDS = 5;

/**
 * 歌词相对视频的时间偏移（毫秒），对不上时返回 null。
 * 每对相似的句子投一票；重复的副歌会投给错误的偏移，但分散在不同位置，得票最多的窗口才是真实偏移。
 */
export function alignLyrics(cues: Cue[], lyrics: Lyrics, videoSeconds: number): number | null {
  const lyric = lyrics.lines.filter((l) => l.text).map((l) => ({ start: l.start, text: normalize(l.text) }));
  if (lyric.length === 0) return null;
  const votes: number[] = [];
  for (const cue of cues) {
    const text = normalize(cue.text);
    for (const line of lyric) if (similar(text, line.text)) votes.push(cue.start - line.start);
  }
  votes.sort((a, b) => a - b);
  let best: number[] = [];
  for (let i = 0, j = 0; j < votes.length; j++) {
    while (votes[j]! - votes[i]! > VOTE_WINDOW_MS) i++;
    if (j - i + 1 > best.length) best = votes.slice(i, j + 1);
  }
  if (best.length >= MIN_VOTES) return best[best.length >> 1]!;
  return lyrics.seconds !== null && Math.abs(lyrics.seconds - videoSeconds) <= SAME_LENGTH_SECONDS ? 0 : null;
}

/** 歌词一行最长显示这么久：长间奏时不让上一句一直挂着 */
const MAX_LINE_MS = 8000;

export function lyricsToCues(lines: LyricLine[], offset: number): Cue[] {
  return lines.flatMap((line, i) => {
    if (!line.text) return [];
    const next = lines[i + 1]?.start ?? Infinity;
    return [{ start: line.start + offset, end: Math.min(next, line.start + MAX_LINE_MS) + offset, text: line.text }];
  });
}
