import { defineContentScript } from 'wxt/utils/define-content-script';
import type { CaptionTrackInfo } from '@/lib/subtitles';
import {
  CONTENT_SOURCE,
  HOOK_SOURCE,
  isTimedtextUrl,
  YOUTUBE_MATCHES,
  type ReadyMessage,
  type SelectTrackMessage,
  type TimedtextMessage,
} from '@/lib/youtube';

/** YouTube 播放器元素上的（非公开）接口，只用到字幕相关的几个方法 */
interface YouTubePlayer extends HTMLElement {
  getOption?(module: 'captions', option: 'tracklist'): Record<string, unknown>[] | undefined;
  setOption?(module: 'captions', option: 'track', value: Record<string, unknown>): void;
  getPlayerResponse?(): {
    captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: Record<string, unknown>[] } };
  };
}

const player = () => document.getElementById('movie_player') as YouTubePlayer | null;

/**
 * 字幕轨列表。实测（2026-10-22）getOption('captions', 'tracklist') 在只有自动字幕的视频上返回空数组，
 * 所以为空时退回播放器数据里的 captionTracks（字段名是 vssId 而不是 vss_id）。
 */
function rawTracks(): Record<string, unknown>[] {
  try {
    const list = player()?.getOption?.('captions', 'tracklist');
    if (Array.isArray(list) && list.length > 0) return list;
  } catch {
    // 退回下面的 captionTracks
  }
  try {
    const tracks = player()?.getPlayerResponse?.()?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    return Array.isArray(tracks) ? tracks : [];
  } catch {
    return [];
  }
}

const vssIdOf = (t: Record<string, unknown>) => String(t.vss_id ?? t.vssId ?? '');

function readTracks(): CaptionTrackInfo[] {
  return rawTracks().map((t) => ({
    languageCode: String(t.languageCode ?? ''),
    vssId: vssIdOf(t),
    kind: String(t.kind ?? ''),
    name: String(t.languageName ?? t.displayName ?? ''),
  }));
}

/**
 * 运行在页面世界（MAIN world）：旁听 YouTube 播放器自己发出的字幕请求。
 * 字幕请求需要播放器生成的 pot 令牌，扩展自己去拉很可能拿到空结果，所以只能「旁听」。
 * 只读取响应，不修改任何返回值；任何异常都吞掉，绝不影响播放器。
 * 唯一的写操作：内容脚本明确发来 select-track 指令时切换字幕轨（自动字幕 → 人工字幕）。
 * 设计见 docs/specs/2026-10-22-youtube-subtitles-design.md。
 */
export default defineContentScript({
  matches: YOUTUBE_MATCHES,
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    // 内容脚本可能晚于播放器就绪：缓存最近几次结果，收到 ready 后补发
    const recent: TimedtextMessage[] = [];
    const publish = (url: string, body: string) => {
      if (!body) return;
      const message: TimedtextMessage = { source: HOOK_SOURCE, type: 'timedtext', url, body };
      // 自动字幕：附带字幕轨列表，由内容脚本决定是否换成人工字幕
      if (url.includes('kind=asr')) message.tracks = readTracks();
      recent.push(message);
      if (recent.length > 3) recent.shift();
      window.postMessage(message, location.origin);
    };

    window.addEventListener('message', (e: MessageEvent<ReadyMessage | SelectTrackMessage>) => {
      if (e.source !== window || e.data?.source !== CONTENT_SOURCE) return;
      const data = e.data;
      if (data.type === 'ready') {
        for (const message of recent) window.postMessage(message, location.origin);
      } else if (data.type === 'select-track') {
        try {
          // 优先用 tracklist 里的对象；没有时只传 languageCode。实测同语言同时有人工和自动字幕时，
          // 只传 languageCode 播放器会选中人工字幕，正是我们要的
          let list: Record<string, unknown>[] = [];
          try {
            list = player()?.getOption?.('captions', 'tracklist') ?? [];
          } catch {
            // 用 languageCode 兜底
          }
          const track = list.find((t) => vssIdOf(t) === data.vssId) ?? { languageCode: data.languageCode };
          player()?.setOption?.('captions', 'track', track);
        } catch {
          // 切换失败就保持自动字幕
        }
      }
    });

    // XHR：YouTube 播放器目前用它请求字幕
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      try {
        const href = String(url);
        if (isTimedtextUrl(href)) {
          this.addEventListener('load', () => {
            try {
              const body =
                this.responseType === '' || this.responseType === 'text'
                  ? this.responseText
                  : this.responseType === 'json'
                    ? JSON.stringify(this.response)
                    : '';
              publish(new URL(href, location.href).href, body);
            } catch {
              // 读取失败不影响播放器
            }
          });
        }
      } catch {
        // 同上
      }
      return (open as (...args: unknown[]) => void).call(this, method, url, ...rest);
    } as typeof XMLHttpRequest.prototype.open;

    // fetch：以防播放器改用 fetch
    const originalFetch = window.fetch;
    window.fetch = async function (this: typeof globalThis, ...args: Parameters<typeof fetch>) {
      const response = await originalFetch.apply(this, args);
      try {
        const input = args[0];
        const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (isTimedtextUrl(href)) {
          void response
            .clone()
            .text()
            .then((body) => publish(new URL(href, location.href).href, body))
            .catch(() => undefined);
        }
      } catch {
        // 同上
      }
      return response;
    };
  },
});
