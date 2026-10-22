import { HttpError } from './providers/types';

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 计数信号量：限制同一服务的并发请求数，避免触发 429 */
export class Semaphore {
  private active = 0;
  private waiters: (() => void)[] = [];

  constructor(private limit: number) {}

  setLimit(limit: number) {
    this.limit = Math.max(1, limit);
    while (this.active < this.limit && this.waiters.length > 0) {
      this.active++;
      this.waiters.shift()?.();
    }
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    // 名额由 release 直接移交，active 不变，避免唤醒间隙被新请求插队
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release() {
    const next = this.active <= this.limit ? this.waiters.shift() : undefined;
    if (next) next();
    else this.active--;
  }
}

/** 429、5xx、网络错误值得重试；4xx（Key 错、模型名错）重试也没用 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return err.status === 429 || err.status >= 500;
  if (err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError')) return false;
  return err instanceof TypeError; // fetch 网络失败抛 TypeError
}

export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  signal?: AbortSignal;
}

export async function withRetry<T>(task: () => Promise<T>, opts: RetryOptions): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await task();
    } catch (err) {
      if (attempt >= opts.retries || !isRetryable(err) || opts.signal?.aborted) throw err;
      const hinted = err instanceof HttpError ? err.retryAfterMs : undefined;
      await sleep(Math.min(hinted ?? opts.baseDelayMs * 3 ** attempt, 15_000));
    }
  }
}
