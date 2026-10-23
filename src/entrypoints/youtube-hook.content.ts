import { defineContentScript } from 'wxt/utils/define-content-script';
import { CONTENT_SOURCE, HOOK_SOURCE, isTimedtextUrl, YOUTUBE_MATCHES, type ReadyMessage, type TimedtextMessage } from '@/lib/youtube';

/**
 * 运行在页面世界（MAIN world）：旁听 YouTube 播放器自己发出的字幕请求。
 * 字幕请求需要播放器生成的 pot 令牌，扩展自己去拉很可能拿到空结果，所以只能「旁听」。
 * 只读取响应，不修改任何返回值；任何异常都吞掉，绝不影响播放器。
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
      recent.push(message);
      if (recent.length > 3) recent.shift();
      window.postMessage(message, location.origin);
    };

    window.addEventListener('message', (e: MessageEvent<ReadyMessage>) => {
      if (e.source !== window || e.data?.source !== CONTENT_SOURCE || e.data.type !== 'ready') return;
      for (const message of recent) window.postMessage(message, location.origin);
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
