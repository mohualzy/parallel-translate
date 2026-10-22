import { describe, expect, it, vi } from 'vitest';
import { Semaphore, sleep, withRetry } from '@/lib/async';
import { HttpError } from '@/lib/providers/types';

describe('Semaphore', () => {
  it('同时运行的任务数不超过上限', async () => {
    const sem = new Semaphore(2);
    let running = 0;
    let peak = 0;
    const task = async () => {
      running++;
      peak = Math.max(peak, running);
      await sleep(5);
      running--;
    };
    await Promise.all(Array.from({ length: 8 }, () => sem.run(task)));
    expect(peak).toBe(2);
  });

  it('调大上限后立即放行等待者', async () => {
    const sem = new Semaphore(1);
    let running = 0;
    let peak = 0;
    const all = Promise.all(
      Array.from({ length: 4 }, () =>
        sem.run(async () => {
          running++;
          peak = Math.max(peak, running);
          await sleep(10);
          running--;
        }),
      ),
    );
    sem.setLimit(4);
    await all;
    expect(peak).toBe(4);
  });
});

describe('withRetry', () => {
  it('429 会重试，成功后返回结果', async () => {
    const task = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new HttpError(429, 'too many', 1))
      .mockResolvedValue('ok');
    await expect(withRetry(task, { retries: 2, baseDelayMs: 1 })).resolves.toBe('ok');
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('401 不重试', async () => {
    const task = vi.fn<() => Promise<string>>().mockRejectedValue(new HttpError(401, 'bad key'));
    await expect(withRetry(task, { retries: 2, baseDelayMs: 1 })).rejects.toThrow('bad key');
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('网络错误重试到上限后抛出', async () => {
    const task = vi.fn<() => Promise<string>>().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(withRetry(task, { retries: 2, baseDelayMs: 1 })).rejects.toThrow('Failed to fetch');
    expect(task).toHaveBeenCalledTimes(3);
  });
});
