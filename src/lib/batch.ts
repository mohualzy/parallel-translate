/** 发一次请求翻译一组文本，返回与输入等长的结果（缺失为 null） */
export type BatchRequest = (sources: string[]) => Promise<(string | null)[]>;

export interface BatchOptions {
  /** 首次请求之外，补翻最多再发几次请求 */
  maxRecoveryRequests: number;
  describeError: (err: unknown) => string;
}

export interface BatchOutcome {
  translations: (string | null)[];
  error?: string;
}

/**
 * 去重 → 整批请求 → 对缺失的段二分补翻。
 * 补翻有请求预算：模型输出整体乱掉时，最多多花 maxRecoveryRequests 次请求，
 * 剩下的段返回 null，由用户点击重试，避免一批坏结果引发十几次单段请求。
 */
export async function translateBatch(sources: string[], request: BatchRequest, opts: BatchOptions): Promise<BatchOutcome> {
  // 同一批里相同的文本只翻一次
  const unique = [...new Set(sources)];
  const results: (string | null)[] = new Array(unique.length).fill(null);
  let error: string | undefined;

  const run = async (indexes: number[]) => {
    try {
      const out = await request(indexes.map((i) => unique[i]!));
      indexes.forEach((i, k) => (results[i] = out[k] ?? null));
    } catch (err) {
      error = opts.describeError(err);
      return false;
    }
    return true;
  };

  // 首次请求失败（网络、鉴权、限流等）重试也大概率失败，直接返回
  if (await run(unique.map((_, i) => i))) {
    let budget = opts.maxRecoveryRequests;
    for (;;) {
      const missing = results.flatMap((r, i) => (r === null ? [i] : []));
      if (missing.length === 0 || budget <= 0) break;
      const half = Math.ceil(missing.length / 2);
      const groups = (missing.length === 1 ? [missing] : [missing.slice(0, half), missing.slice(half)]).slice(0, budget);
      budget -= groups.length;
      const ok = await Promise.all(groups.map(run));
      if (ok.includes(false)) break;
    }
  }

  if (!error && results.includes(null)) error = '模型输出缺少部分段落';
  const byText = new Map(unique.map((text, i) => [text, results[i] ?? null]));
  return { translations: sources.map((s) => byText.get(s) ?? null), error };
}
