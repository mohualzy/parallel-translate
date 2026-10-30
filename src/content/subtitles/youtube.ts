import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { conflictsWithTerms, type GlossaryEntry } from '@/lib/glossary';
import { isProbablyInLanguage } from '@/lib/languages';
import { sendToBackground } from '@/lib/messages';
import { getSettings, onSettingsChanged, type Settings } from '@/lib/settings';
import {
  activeCueIndex,
  batchContext,
  nextBatch,
  parseJson3,
  parseTimedtextUrl,
  isAutoTrack,
  pickSourceTrack,
  sourceTrackUrl,
  type Cue,
} from '@/lib/subtitles';
import { CONTENT_SOURCE, HOOK_SOURCE, type FetchTrackMessage, type ReadyMessage, type TimedtextMessage } from '@/lib/youtube';
import { escapeText, unescapeText } from '../richtext';
import { SubtitleOverlay } from './overlay';

type CueState = 'idle' | 'pending' | 'done' | 'error';

interface Track {
  videoId: string;
  /** 语言 + 是否自动字幕 + 自动翻译语言：同一视频重复请求同一轨时复用已有译文 */
  key: string;
  cues: Cue[];
  /** 自动生成（语音识别）字幕：字幕层显示「自动字幕」标记 */
  auto: boolean;
  states: CueState[];
  translations: (string | undefined)[];
  /** 全片预读的结果：内容摘要和术语，每批翻译都带上 */
  summary: string;
  terms: GlossaryEntry[];
  /** 预读结果到达后 +1：发出时还没有术语的批次，返回后要检查冲突 */
  termsVersion: number;
}

/** 只翻译当前时间往后 2 分钟内的字幕，往回 5 秒（拖回去时立刻有译文） */
const WINDOW = { aheadMs: 120_000, behindMs: 5000, max: 25 };
const MAX_INFLIGHT = 2;
const TICK_MS = 100;
/** 翻译失败的条目过一会儿再重试 */
const RETRY_MS = 15_000;
/** 每批带上的前后台词条数 */
const CONTEXT = { before: 4, after: 3 };
/** 全片预读：字幕太短没必要，太长只读开头（约一小时的台词） */
const BRIEF_MIN_CHARS = 200;
const BRIEF_MAX_CHARS = 40_000;

/**
 * YouTube 双语字幕（设计见 docs/specs/2026-10-22-youtube-subtitles-design.md）：
 * 接收页面世界旁听到的字幕 → 按播放进度分批翻译 → 在播放器里渲染原文 + 译文。
 * 显示与否跟随播放器自己的 CC 按钮。
 */
export class YouTubeSubtitles {
  private settings!: Settings;
  private track?: Track;
  private overlay: SubtitleOverlay;
  private inflight = 0;
  private rendered = '';
  /** 正在请钩子拉取的原文轨；拉取失败时退回播放器加载的那条 */
  private fetching?: { url: string; fallback: TimedtextMessage };
  /** 每个视频播放器上一次加载的字幕轨：之后加载的轨不一样，就是用户在字幕菜单里换了轨 */
  private lastPlayed = new Map<string, string>();
  /** 用户在字幕菜单里换过轨的视频：跟随用户选的轨 */
  private userPicked = new Set<string>();

  constructor(private readonly ctx: ContentScriptContext) {
    this.overlay = new SubtitleOverlay(ctx);
  }

  async start() {
    window.addEventListener('message', (e: MessageEvent<TimedtextMessage>) => {
      if (e.source !== window || e.data?.source !== HOOK_SOURCE || e.data.type !== 'timedtext') return;
      this.load(e.data);
    });
    this.settings = await getSettings();
    onSettingsChanged((next) => (this.settings = next));
    // 告诉页面世界的钩子：可以补发在此之前捕获到的字幕了
    window.postMessage({ source: CONTENT_SOURCE, type: 'ready' } satisfies ReadyMessage, location.origin);
    this.ctx.setInterval(() => this.tick(), TICK_MS);
  }

  private load(message: TimedtextMessage) {
    if (!this.settings?.youtubeSubtitles) return;
    if (message.fetched) {
      const pending = this.fetching;
      if (pending?.url !== message.url) return;
      this.fetching = undefined;
      if (!this.apply(message.url, message.body)) this.apply(pending.fallback.url, pending.fallback.body);
      return;
    }
    // 播放器加载哪条取决于用户的全局字幕语言偏好，可能还经过 YouTube 自动翻译：原文轨由我们挑，
    // 和播放器加载的不是同一条时，请钩子用播放器的令牌参数去拉（设计文档第 6 点）
    const info = parseTimedtextUrl(message.url);
    const tracks = message.tracks ?? [];
    const played = trackKey(info.lang, info.asr, info.translatedTo);
    const last = this.lastPlayed.get(info.videoId);
    this.lastPlayed.set(info.videoId, played);
    if (last !== undefined && last !== played) this.userPicked.add(info.videoId);
    const source = this.userPicked.has(info.videoId)
      ? // 用户自己在字幕菜单里换了轨：用这一轨（去掉自动翻译）
        tracks.find((t) => t.languageCode === info.lang && isAutoTrack(t) === info.asr)
      : pickSourceTrack(tracks, info, this.settings.targetLang, message.videoText ?? '');
    if (source && (source.languageCode !== info.lang || isAutoTrack(source) !== info.asr || info.translatedTo)) {
      if (this.track?.videoId === info.videoId && this.track.key === trackKey(source.languageCode, isAutoTrack(source), '')) return;
      const url = sourceTrackUrl(source, message.url);
      if (this.fetching?.url === url) return;
      this.fetching = { url, fallback: message };
      window.postMessage({ source: CONTENT_SOURCE, type: 'fetch-track', url } satisfies FetchTrackMessage, location.origin);
      return;
    }
    this.apply(message.url, message.body);
  }

  /** 用这条字幕作为原文；解析不出字幕条目时返回 false */
  private apply(url: string, body: string): boolean {
    const info = parseTimedtextUrl(url);
    const key = trackKey(info.lang, info.asr, info.translatedTo);
    if (this.track?.videoId === info.videoId && this.track.key === key) return true;
    const cues = parseJson3(body, info.asr);
    if (cues.length === 0) return false;
    // 字幕本身就是目标语言（视频语音就是目标语言，或只能用 YouTube 自动翻译成目标语言的那条），交给原生字幕
    const sample = cues.slice(0, 30).map((c) => c.text).join(' ');
    if (isProbablyInLanguage(sample, this.settings.targetLang)) {
      this.track = undefined;
      return true;
    }
    this.track = {
      videoId: info.videoId,
      key,
      cues,
      auto: info.asr,
      states: cues.map(() => 'idle'),
      translations: [],
      summary: '',
      terms: [],
      termsVersion: 0,
    };
    this.rendered = '';
    void this.preread(this.track);
    return true;
  }

  /** 全片预读：和翻译并行，不阻塞字幕；术语回来后，已翻好但和术语冲突的条目回到待翻译 */
  private async preread(track: Track) {
    if (!this.settings.extractTerms) return;
    const text = track.cues.map((c) => c.text).join('\n');
    if (text.length < BRIEF_MIN_CHARS) return;
    try {
      const brief = await sendToBackground({ type: 'video-brief', title: videoTitle(), text: text.slice(0, BRIEF_MAX_CHARS) });
      track.summary = brief.summary;
      track.terms = brief.terms;
      track.termsVersion++;
      track.states.forEach((state, i) => {
        if (state === 'done' && this.conflicts(track, i)) track.states[i] = 'idle';
      });
    } catch {
      // 预读失败不影响翻译，只是少了上下文
    }
  }

  private conflicts(track: Track, index: number): boolean {
    const translation = track.translations[index];
    return !!translation && conflictsWithTerms(track.terms, this.settings.glossary, track.cues[index]!.text, translation);
  }

  private player(): HTMLElement | null {
    return document.querySelector<HTMLElement>('#movie_player, .html5-video-player');
  }

  private currentVideoId(): string {
    return new URLSearchParams(location.search).get('v') ?? '';
  }

  private captionsOn(player: Element): boolean {
    return player.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed') === 'true';
  }

  private tick() {
    const { track } = this;
    const player = this.player();
    const video = player?.querySelector('video');
    const active =
      this.settings?.youtubeSubtitles === true &&
      track !== undefined &&
      track.videoId === this.currentVideoId() &&
      player !== null &&
      video != null &&
      this.captionsOn(player);

    if (!active || !player || !video || !track) {
      document.documentElement.removeAttribute('data-ptx-subtitles');
      this.overlay.hide();
      this.rendered = '';
      return;
    }

    void this.overlay.attach(player);
    // 字幕层还没挂上（首次挂载或被移除后重挂）：先让原生字幕顶上，挂载失败也不会一直看不到字幕
    if (!this.overlay.ready) {
      document.documentElement.removeAttribute('data-ptx-subtitles');
      this.rendered = '';
      return;
    }
    // 由我们的字幕层接管显示，原生字幕设为不可见（见 youtube/style.css）
    document.documentElement.setAttribute('data-ptx-subtitles', '');

    const ms = video.currentTime * 1000;
    this.schedule(ms);

    const index = activeCueIndex(track.cues, ms);
    const controls = !player.classList.contains('ytp-autohide');
    const showOriginal = this.settings.displayMode === 'bilingual';
    const translation = index === -1 ? undefined : track.translations[index];
    const key = `${index}|${translation ?? ''}|${controls}|${showOriginal}|${track.auto}`;
    if (key === this.rendered) return;
    this.rendered = key;
    if (index === -1) this.overlay.hide();
    else this.overlay.show(track.cues[index]!.text, translation, showOriginal, controls, track.auto);
  }

  /** 按播放进度补翻：窗口内还有未翻译的条目且并发未满时发起下一批 */
  private schedule(ms: number) {
    const track = this.track;
    if (!track || this.inflight >= MAX_INFLIGHT) return;
    const batch = nextBatch(track.cues, ms, (i) => track.states[i] === 'idle', WINDOW);
    if (batch.length === 0) return;
    for (const i of batch) track.states[i] = 'pending';
    this.inflight++;
    void this.translate(track, batch).finally(() => this.inflight--);
  }

  private async translate(track: Track, batch: number[]) {
    const version = track.termsVersion;
    const { before, after } = batchContext(track.cues, batch, track.translations, CONTEXT);
    try {
      const res = await sendToBackground({
        type: 'translate',
        segments: batch.map((i) => escapeText(track.cues[i]!.text)),
        page: {
          title: videoTitle(),
          summary: track.summary,
          subtitles: true,
          terms: track.terms,
          scope: track.videoId,
          around: {
            before: before.map((l) => ({ text: escapeText(l.text), translation: l.translation && escapeText(l.translation) })),
            after: after.map(escapeText),
          },
        },
      });
      batch.forEach((cueIndex, j) => {
        const text = res.translations[j];
        if (text) {
          track.states[cueIndex] = 'done';
          track.translations[cueIndex] = unescapeText(text.replace(/<\/?[gx]\d+\s*\/?>/g, '')).trim();
          // 发出时还没有术语：返回后和已翻好的条目一样检查（只查一次，模型不用术语也不会反复重翻）
          if (version < track.termsVersion && this.conflicts(track, cueIndex)) track.states[cueIndex] = 'idle';
        } else {
          this.markFailed(track, cueIndex);
        }
      });
    } catch {
      for (const i of batch) this.markFailed(track, i);
    }
    this.rendered = '';
  }

  private markFailed(track: Track, index: number) {
    track.states[index] = 'error';
    setTimeout(() => {
      if (track.states[index] === 'error') track.states[index] = 'idle';
    }, RETRY_MS);
  }
}

const trackKey = (lang: string, asr: boolean, translatedTo: string) => `${lang}:${asr}:${translatedTo}`;

/** 视频标题作为翻译上下文（页面标题可能已被整页翻译替换，优先取页面上的标题元素） */
function videoTitle(): string {
  const heading = document.querySelector('h1.ytd-watch-metadata, #title h1')?.textContent?.trim();
  return heading || document.title.replace(/\s*-\s*YouTube\s*$/, '');
}
