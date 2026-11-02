import type { ProviderConfig } from '../settings';
import { HttpError, type MachineClient } from './types';

/** format=html 会把引号转成实体；&lt; &gt; &amp; 保留，由占位协议统一反转义 */
const decodeQuotes = (s: string) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"');

export function createGoogleClient(config: ProviderConfig): MachineClient {
  return {
    async translate(texts, { targetLang, markup }, signal) {
      const query = new URLSearchParams({ client: 'gtx', sl: 'auto', tl: targetLang, format: markup ? 'html' : 'text' });
      let res: Response;
      try {
        res = await fetch(`${config.baseURL}/translate_a/t?${query}`, {
          method: 'POST',
          body: new URLSearchParams(texts.map((q) => ['q', q])),
          signal,
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'TimeoutError') {
          throw new Error('连接 Google 翻译超时：国内网络需要代理，也可以在设置页添加自己的模型', { cause: err });
        }
        throw err;
      }
      if (!res.ok) {
        const hint = res.status === 429 ? '请求过于频繁，稍后再试' : '接口暂时不可用，可以在设置页添加自己的模型';
        throw new HttpError(res.status, `Google 翻译：${hint}（HTTP ${res.status}）`);
      }
      const json = (await res.json()) as [string, string][];
      return texts.map((_, i) => {
        const text = json[i]?.[0];
        return text ? decodeQuotes(text) : null;
      });
    },
  };
}
