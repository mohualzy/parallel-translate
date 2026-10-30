import { defineContentScript } from 'wxt/utils/define-content-script';
import type { CaptionTrackInfo } from '@/lib/subtitles';
import {
  CONTENT_SOURCE,
  HOOK_SOURCE,
  isTimedtextUrl,
  YOUTUBE_MATCHES,
  type FetchTrackMessage,
  type ReadyMessage,
  type TimedtextMessage,
} from '@/lib/youtube';

/** YouTube 播放器元素上的（非公开）接口，只读取播放器数据 */
interface YouTubePlayer extends HTMLElement {
  getPlayerResponse?(): {
    captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: Record<string, unknown>[] } };
    videoDetails?: { title?: string; shortDescription?: string };
  };
}

const playerResponse = () => {
  try {
    return (document.getElementById('movie_player') as YouTubePlayer | null)?.getPlayerResponse?.();
  } catch {
    return undefined;
  }
};

/**
 * 字幕轨列表，取播放器数据里的 captionTracks：它带 baseUrl，且包含自动字幕
 * （实测 getOption('captions', 'tracklist') 在只有自动字幕的视频上返回空数组）。
 */
function readTracks(): CaptionTrackInfo[] {
  const tracks = playerResponse()?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  return (Array.isArray(tracks) ? tracks : []).map((t) => ({
    languageCode: String(t.languageCode ?? ''),
    vssId: String(t.vssId ?? ''),
    kind: String(t.kind ?? ''),
    name: String(t.languageName ?? t.displayName ?? ''),
    baseUrl: String(t.baseUrl ?? ''),
  }));
}

function readVideoText(): string {
  const details = playerResponse()?.videoDetails;
  return `${details?.title ?? ''}\n${(details?.shortDescription ?? '').slice(0, 1000)}`;
}

/**
 * 运行在页面世界（MAIN world）：旁听 YouTube 播放器自己发出的字幕请求。
 * 字幕请求需要播放器生成的 pot 令牌，所以令牌只能靠旁听；内容脚本挑好原文轨后，
 * 钩子用旁听到的令牌参数去拉那一条（fetch-track）。只读取响应和播放器数据，不改动播放器；任何异常都吞掉。
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
      const message: TimedtextMessage = {
        source: HOOK_SOURCE,
        type: 'timedtext',
        url,
        body,
        tracks: readTracks(),
        videoText: readVideoText(),
      };
      recent.push(message);
      if (recent.length > 3) recent.shift();
      window.postMessage(message, location.origin);
    };
    // 拉取用原始的 fetch，不经过下面的包装（否则会被当成播放器的请求再旁听一遍）
    const originalFetch = window.fetch;

    window.addEventListener('message', (e: MessageEvent<ReadyMessage | FetchTrackMessage>) => {
      if (e.source !== window || e.data?.source !== CONTENT_SOURCE) return;
      const data = e.data;
      if (data.type === 'ready') {
        for (const message of recent) window.postMessage(message, location.origin);
      } else if (data.type === 'fetch-track' && isTimedtextUrl(data.url)) {
        const reply = (body: string) =>
          window.postMessage(
            { source: HOOK_SOURCE, type: 'timedtext', url: data.url, body, fetched: true } satisfies TimedtextMessage,
            location.origin,
          );
        originalFetch(data.url, { credentials: 'include' })
          .then((res) => (res.ok ? res.text() : ''))
          .then(reply, () => reply(''));
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
