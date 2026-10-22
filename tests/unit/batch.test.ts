import { describe, expect, it, vi } from 'vitest';
import { translateBatch, type BatchRequest } from '@/lib/batch';

const opts = { maxRecoveryRequests: 2, describeError: (err: unknown) => (err as Error).message };
const ok = (s: string) => `译:${s}`;

describe('translateBatch', () => {
  it('同一批里相同的文本只发送一次，结果回填到每个位置', async () => {
    const request = vi.fn<BatchRequest>(async (batch) => batch.map(ok));
    const res = await translateBatch(['a', 'b', 'a'], request, opts);
    expect(res).toEqual({ translations: ['译:a', '译:b', '译:a'], error: undefined });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0]).toEqual(['a', 'b']);
  });

  it('漏掉一段时只补翻这一段', async () => {
    const request = vi
      .fn<BatchRequest>()
      .mockImplementationOnce(async (batch) => batch.map((s) => (s === 'c' ? null : ok(s))))
      .mockImplementation(async (batch) => batch.map(ok));
    const res = await translateBatch(['a', 'b', 'c'], request, opts);
    expect(res.translations).toEqual(['译:a', '译:b', '译:c']);
    expect(request.mock.calls.map((c) => c[0])).toEqual([['a', 'b', 'c'], ['c']]);
  });

  it('整批输出都坏掉时二分补翻，额外请求不超过预算', async () => {
    const sources = Array.from({ length: 12 }, (_, i) => `s${i}`);
    const request = vi.fn<BatchRequest>(async (batch) => (batch.length > 6 ? batch.map(() => null) : batch.map(ok)));
    const res = await translateBatch(sources, request, opts);
    expect(res.translations.every((t) => t?.startsWith('译:'))).toBe(true);
    expect(request.mock.calls.map((c) => c[0].length)).toEqual([12, 6, 6]);
  });

  it('预算用完仍有缺失时返回 null 和原因，不再继续请求', async () => {
    const request = vi.fn<BatchRequest>(async (batch) => batch.map(() => null));
    const res = await translateBatch(['a', 'b', 'c', 'd'], request, opts);
    expect(res.translations).toEqual([null, null, null, null]);
    expect(res.error).toBe('模型输出缺少部分段落');
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('首次请求出错时直接返回错误，不补翻', async () => {
    const request = vi.fn<BatchRequest>().mockRejectedValue(new Error('API Key 无效'));
    const res = await translateBatch(['a', 'b'], request, opts);
    expect(res).toEqual({ translations: [null, null], error: 'API Key 无效' });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
