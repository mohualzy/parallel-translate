import { baseLang } from './languages';

/**
 * YouTube 字幕数据（/api/timedtext，fmt=json3）的解析与调度逻辑。纯函数，便于单测。
 * 设计见 docs/specs/2026-10-22-youtube-subtitles-design.md。
 */

export interface Cue {
  /** 毫秒 */
  start: number;
  end: number;
  text: string;
}

export interface TimedtextInfo {
  videoId: string;
  lang: string;
  /** 自动生成（语音识别）字幕：逐词滚动，需要合句 */
  asr: boolean;
  /** YouTube「自动翻译」的目标语言（tlang），没有则为空字符串 */
  translatedTo: string;
}

export function parseTimedtextUrl(url: string): TimedtextInfo {
  const params = new URL(url, 'https://www.youtube.com').searchParams;
  return {
    videoId: params.get('v') ?? '',
    lang: params.get('lang') ?? '',
    asr: params.get('kind') === 'asr',
    translatedTo: params.get('tlang') ?? '',
  };
}

interface Json3Seg {
  utf8?: string;
  tOffsetMs?: number;
}

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  aAppend?: number;
  segs?: Json3Seg[];
}

/** 去掉 [Music]、(laughs) 这类环境音标注和 >> 换人标记，压缩空白 */
export function cleanCueText(text: string): string {
  return text
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/>>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const SENTENCE_END = /[.?!。？！…]["'”’)]?$/;
/** 自动字幕合句：停顿超过这个时长就断句 */
const ASR_PAUSE_MS = 1200;
/** 自动字幕合句：一句最多这么多词，避免整段不断句的长串 */
const ASR_MAX_WORDS = 18;
/** 自动字幕最后一句没有下一句可参照时显示的时长 */
const ASR_TAIL_MS = 2000;

export function parseJson3(body: string, asr: boolean): Cue[] {
  let events: Json3Event[];
  try {
    events = (JSON.parse(body) as { events?: Json3Event[] }).events ?? [];
  } catch {
    return [];
  }
  return asr ? mergeAsrWords(events) : manualCues(events);
}

function manualCues(events: Json3Event[]): Cue[] {
  const cues: Cue[] = [];
  for (const e of events) {
    if (!e.segs || e.tStartMs === undefined) continue;
    const text = cleanCueText(e.segs.map((s) => s.utf8 ?? '').join(''));
    if (!text) continue;
    cues.push({ start: e.tStartMs, end: e.tStartMs + (e.dDurationMs ?? 0), text });
  }
  return cues;
}

interface Word {
  text: string;
  time: number;
}

function mergeAsrWords(events: Json3Event[]): Cue[] {
  const words: Word[] = [];
  for (const e of events) {
    // aAppend 事件只是换行，不含新词
    if (!e.segs || e.tStartMs === undefined || e.aAppend) continue;
    for (const seg of e.segs) {
      // 保留原始的前导空格：英文词自带空格（" guys"），日文、中文的词之间本来就没有空格
      const raw = (seg.utf8 ?? '').replace(/\n/g, ' ');
      if (cleanCueText(raw)) words.push({ text: raw, time: e.tStartMs + (seg.tOffsetMs ?? 0) });
    }
  }

  const sentences: Word[][] = [];
  let current: Word[] = [];
  words.forEach((word, i) => {
    current.push(word);
    const next = words[i + 1];
    if (
      !next ||
      SENTENCE_END.test(word.text.trim()) ||
      next.time - word.time > ASR_PAUSE_MS ||
      current.length >= ASR_MAX_WORDS
    ) {
      sentences.push(current);
      current = [];
    }
  });

  return sentences.map((sentence, i) => {
    const start = sentence[0]!.time;
    const nextStart = sentences[i + 1]?.[0]?.time;
    const last = sentence[sentence.length - 1]!.time;
    return {
      start,
      end: nextStart !== undefined ? Math.min(nextStart, last + ASR_TAIL_MS * 2) : last + ASR_TAIL_MS,
      text: cleanCueText(sentence.map((w) => w.text).join('')),
    };
  });
}

/**
 * 当前时间点正在显示的条目下标；没有则 -1（条目按开始时间有序）。
 * 人工字幕的条目可能时间重叠（多人同时说话、画面文字注释）：最近开始的那条已经结束时，
 * 更早开始的长条目可能还在显示，要往前找，否则原生字幕还有字、我们的字幕层却是空的。
 */
export function activeCueIndex(cues: Cue[], ms: number): number {
  let lo = 0;
  let hi = cues.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid]!.start <= ms) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  for (let i = found; i >= 0; i--) if (cues[i]!.end > ms) return i;
  return -1;
}

export interface WindowOptions {
  /** 往后看多远（毫秒） */
  aheadMs: number;
  /** 往前补多少（毫秒），拖动进度条往回看时也能立刻有译文 */
  behindMs: number;
  /** 一批最多几条 */
  max: number;
}

/** 按播放进度挑出下一批要翻译的条目：只看当前时间附近，未翻译的，按时间先后 */
export function nextBatch(
  cues: Cue[],
  ms: number,
  needsTranslation: (index: number) => boolean,
  opts: WindowOptions,
): number[] {
  const batch: number[] = [];
  for (let i = 0; i < cues.length && batch.length < opts.max; i++) {
    const cue = cues[i]!;
    if (cue.end < ms - opts.behindMs) continue;
    if (cue.start > ms + opts.aheadMs) break;
    if (needsTranslation(i)) batch.push(i);
  }
  return batch;
}

/** 播放器字幕轨列表里的一条（来自页面世界的 getOption('captions', 'tracklist')） */
export interface CaptionTrackInfo {
  languageCode: string;
  /** 例如 ".en"（人工）、"a.en"（自动生成） */
  vssId: string;
  kind: string;
  name: string;
}

export function isAutoTrack(track: CaptionTrackInfo): boolean {
  return track.kind === 'asr' || track.vssId.startsWith('a.');
}

/**
 * 当前加载的是自动字幕时，挑一条人工字幕替换：与自动字幕同语言的优先，其次英文，再次任意一条。
 * 目标语言的人工字幕不选：那条原生字幕本身就能直接看，不需要双语。
 */
export function pickManualTrack(
  tracks: CaptionTrackInfo[],
  autoLang: string,
  targetLang: string,
): CaptionTrackInfo | undefined {
  const manual = tracks.filter((t) => !isAutoTrack(t) && baseLang(t.languageCode) !== baseLang(targetLang));
  return (
    manual.find((t) => baseLang(t.languageCode) === baseLang(autoLang)) ??
    manual.find((t) => baseLang(t.languageCode) === 'en') ??
    manual[0]
  );
}
