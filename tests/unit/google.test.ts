// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGoogleClient } from '@/lib/providers/google';
import { HttpError } from '@/lib/providers/types';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { getProviders, GOOGLE_PROVIDER_ID } from '@/lib/settings';

const signal = new AbortController().signal;

async function client() {
  await fakeBrowser.reset();
  return createGoogleClient((await getProviders()).find((p) => p.id === GOOGLE_PROVIDER_ID)!);
}

afterEach(() => vi.unstubAllGlobals());

describe('createGoogleClient', () => {
  it('批量请求：多个 q 放在表单里，标记文本用 html 格式', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => Response.json([['你好<g0>世界</g0>', 'en'], ['第二段', 'en']]));
    vi.stubGlobal('fetch', fetchMock);
    const out = await (await client()).translate(['Hello <g0>world</g0>', 'Second & third'], { targetLang: 'zh-CN', markup: true }, signal);
    expect(out).toEqual(['你好<g0>世界</g0>', '第二段']);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://translate.googleapis.com/translate_a/t?client=gtx&sl=auto&tl=zh-CN&format=html');
    expect(init.method).toBe('POST');
    expect((init.body as URLSearchParams).getAll('q')).toEqual(['Hello <g0>world</g0>', 'Second & third']);
  });

  it('纯文本用 text 格式，保留换行', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => Response.json([['一\n\n二', 'en']]));
    vi.stubGlobal('fetch', fetchMock);
    expect(await (await client()).translate(['one\n\ntwo'], { targetLang: 'zh-CN', markup: false }, signal)).toEqual(['一\n\n二']);
    expect(fetchMock.mock.calls[0]![0]).toContain('format=text');
  });

  it('还原引号实体，其余实体留给占位协议', async () => {
    vi.stubGlobal('fetch', async () => Response.json([['C&#39;est &quot;x&quot; &lt; y &amp; z', 'en']]));
    expect(await (await client()).translate(['x'], { targetLang: 'fr', markup: true }, signal)).toEqual(['C\'est "x" &lt; y &amp; z']);
  });

  it('缺失的项返回 null', async () => {
    vi.stubGlobal('fetch', async () => Response.json([['一', 'en']]));
    expect(await (await client()).translate(['a', 'b'], { targetLang: 'zh-CN', markup: true }, signal)).toEqual(['一', null]);
  });

  it('429 抛 HttpError，由上层重试', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 429 }));
    const err = await (await client()).translate(['a'], { targetLang: 'zh-CN', markup: true }, signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(429);
  });

  it('连接超时时提示网络和代理', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new DOMException('timed out', 'TimeoutError');
    });
    await expect((await client()).translate(['a'], { targetLang: 'zh-CN', markup: true }, signal)).rejects.toThrow('需要代理');
  });
});
