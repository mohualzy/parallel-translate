// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenAIClient, endpoint, parseExtraBody, parseSSELine } from '@/lib/providers/openai';
import { HttpError } from '@/lib/providers/types';
import { createProvider } from '@/lib/settings';

const provider = { ...createProvider(), baseURL: 'https://api.example.com/v1/', apiKey: 'test-key', model: 'm' };

function sse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('endpoint', () => {
  it('兼容各种 Base URL 写法', () => {
    expect(endpoint('https://a.com/v1', 'chat/completions')).toBe('https://a.com/v1/chat/completions');
    expect(endpoint('https://a.com/v1/', 'models')).toBe('https://a.com/v1/models');
    expect(endpoint('https://a.com/v1/chat/completions', 'chat/completions')).toBe('https://a.com/v1/chat/completions');
    expect(endpoint('https://a.com/v1/chat/completions', 'models')).toBe('https://a.com/v1/models');
  });
});

describe('parseSSELine', () => {
  it('提取 delta 内容，忽略 [DONE]、注释与推理字段', () => {
    expect(parseSSELine('data: {"choices":[{"delta":{"content":"你"}}]}')).toBe('你');
    expect(parseSSELine('data: {"choices":[{"delta":{"reasoning_content":"思考"}}]}')).toBe('');
    expect(parseSSELine('data: [DONE]')).toBe('');
    expect(parseSSELine(': keep-alive')).toBe('');
  });

  it('流中的 error 对象抛出', () => {
    expect(() => parseSSELine('data: {"error":{"message":"quota"}}')).toThrow('quota');
  });
});

describe('createOpenAIClient', () => {
  it('流式响应：跨 chunk 的行被正确拼接', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sse([
        'data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"choi',
        'ces":[{"delta":{"content":"好"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);
    const text = await createOpenAIClient(provider).complete([{ role: 'user', content: 'hi' }], new AbortController().signal);
    expect(text).toBe('你好');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer test-key');
    expect(JSON.parse(init.body)).toMatchObject({ model: 'm', stream: true });
  });

  it('额外请求参数合并进请求体，可覆盖 temperature，不能覆盖 model/stream', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ choices: [{ message: { content: 'ok' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    const extraBody = '{"enable_thinking": false, "temperature": 0.1, "model": "hijack", "stream": false}';
    await createOpenAIClient({ ...provider, extraBody }).complete([], new AbortController().signal);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toMatchObject({
      enable_thinking: false,
      temperature: 0.1,
      model: 'm',
      stream: true,
    });
  });

  it('额外请求参数不是 JSON 对象时给出可读错误', () => {
    expect(parseExtraBody('')).toEqual({});
    expect(() => parseExtraBody('{bad')).toThrow('不是合法的 JSON');
    expect(() => parseExtraBody('[1]')).toThrow('必须是 JSON 对象');
  });

  it('请求流式但服务返回 JSON 时也能解析', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ choices: [{ message: { content: '你好' } }] })),
    );
    const text = await createOpenAIClient(provider).complete([], new AbortController().signal);
    expect(text).toBe('你好');
  });

  it('HTTP 错误转换为带提示的 HttpError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ error: { message: 'Invalid key' } }, { status: 401 })),
    );
    const err = await createOpenAIClient(provider).complete([], new AbortController().signal).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(401);
    expect(err.message).toContain('API Key 无效');
    expect(err.message).toContain('Invalid key');
  });

  it('listModels 返回排序后的模型 ID', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data: [{ id: 'b' }, { id: 'a' }] })));
    await expect(createOpenAIClient(provider).listModels()).resolves.toEqual(['a', 'b']);
  });
});
