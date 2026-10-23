import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { isProbablyInLanguage } from '@/lib/languages';
import { sendToBackground } from '@/lib/messages';
import { getSettings, onSettingsChanged, type Settings } from '@/lib/settings';
import {
  activeCueIndex,
  nextBatch,
  parseJson3,
  parseTimedtextUrl,
  pickManualTrack,
  type CaptionTrackInfo,
  type Cue,
} from '@/lib/subtitles';
import { CONTENT_SOURCE, HOOK_SOURCE, type ReadyMessage, type SelectTrackMessage, type TimedtextMessage } from '@/lib/youtube';
import { escapeText, unescapeText } from '../richtext';
import { SubtitleOverlay } from './overlay';

type CueState = 'idle' | 'pending' | 'done' | 'error';

interface Track {
  videoId: string;
  /** 语言 + 是否自动字幕：同一视频重复请求同一轨时复用已有译文 */
  key: string;
  cues: Cue[];
  /** 自动生成（语音识别）字幕：字幕层显示「自动字幕」标记 */
  auto: boolean;
  states: CueState[];
  translations: (string | undefined)[];
}

/** 只翻译当前时间往后 2 分钟内的字幕，往回 5 秒（拖回去时立刻有译文） */
const WINDOW = { aheadMs: 120_000, behindMs: 5000, max: 25 };
const MAX_INFLIGHT = 2;
const TICK_MS = 100;
/** 翻译失败的条目过一会儿再重试 */
const RETRY_MS = 15_000;

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
  /** 已经替用户切换过人工字幕的视频：每个视频只切一次，之后用户手动切回自动字幕不再干预 */
  private switched = new Set<string>();

  constructor(private readonly ctx: ContentScriptContext) {
    this.overlay = new SubtitleOverlay(ctx);
  }

  async start() {
    window.addEventListener('message', (e: MessageEvent<TimedtextMessage>) => {
      if (e.source !== window || e.data?.source !== HOOK_SOURCE || e.data.type !== 'timedtext') return;
      this.load(e.data.url, e.data.body, e.data.tracks);
    });
    this.settings = await getSettings();
    onSettingsChanged((next) => (this.settings = next));
    // 告诉页面世界的钩子：可以补发在此之前捕获到的字幕了
    window.postMessage({ source: CONTENT_SOURCE, type: 'ready' } satisfies ReadyMessage, location.origin);
    this.ctx.setInterval(() => this.tick(), TICK_MS);
  }

  private load(url: string, body: string, tracks?: CaptionTrackInfo[]) {
    if (!this.settings?.youtubeSubtitles) return;
    const info = parseTimedtextUrl(url);
    // 自动字幕常常不可靠（音乐视频尤其明显）：视频另有人工字幕就切过去，新字幕到来后会替换当前这一轨
    if (info.asr && tracks?.length && !this.switched.has(info.videoId)) {
      const manual = pickManualTrack(tracks, info.lang, this.settings.targetLang);
      if (manual) {
        this.switched.add(info.videoId);
        const message: SelectTrackMessage = {
          source: CONTENT_SOURCE,
          type: 'select-track',
          vssId: manual.vssId,
          languageCode: manual.languageCode,
        };
        window.postMessage(message, location.origin);
      }
    }
    // YouTube「自动翻译」成目标语言时，下面的「已是目标语言」检测会让位给原生字幕；
    // 翻成其他语言（如英文）时，把这一轨当原文再翻译。切换自动翻译语言视为换了一轨
    const key = `${info.lang}:${info.asr}:${info.translatedTo}`;
    if (this.track?.videoId === info.videoId && this.track.key === key) return;
    const cues = parseJson3(body, info.asr);
    if (cues.length === 0) return;
    // 字幕本身就是目标语言，不需要翻译
    const sample = cues.slice(0, 30).map((c) => c.text).join(' ');
    if (isProbablyInLanguage(sample, this.settings.targetLang)) {
      this.track = undefined;
      return;
    }
    this.track = {
      videoId: info.videoId,
      key,
      cues,
      auto: info.asr,
      states: cues.map(() => 'idle'),
      translations: [],
    };
    this.rendered = '';
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
    if (!this.overlay.ready) return;
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
    try {
      const res = await sendToBackground({
        type: 'translate',
        segments: batch.map((i) => escapeText(track.cues[i]!.text)),
        page: { title: videoTitle(), summary: '', subtitles: true },
      });
      batch.forEach((cueIndex, j) => {
        const text = res.translations[j];
        if (text) {
          track.states[cueIndex] = 'done';
          track.translations[cueIndex] = unescapeText(text.replace(/<\/?[gx]\d+\s*\/?>/g, '')).trim();
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

/** 视频标题作为翻译上下文（页面标题可能已被整页翻译替换，优先取页面上的标题元素） */
function videoTitle(): string {
  const heading = document.querySelector('h1.ytd-watch-metadata, #title h1')?.textContent?.trim();
  return heading || document.title.replace(/\s*-\s*YouTube\s*$/, '');
}
