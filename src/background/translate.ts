import { browser } from 'wxt/browser';
import { Semaphore, withRetry } from '@/lib/async';
import { translateBatch } from '@/lib/batch';
import type { TranslateResult } from '@/lib/messages';
import { buildMessages, createClient, HttpError, parseSegments, PROMPT_VERSION, type ChatMessage } from '@/lib/providers';
import { getActiveProvider, getSettings, type ProviderConfig, type Settings } from '@/lib/settings';
import * as cache from './cache';

/** 一批里有段缺失时，补翻最多额外请求的次数（见 docs/DECISIONS.md D14） */
const MAX_RECOVERY_REQUESTS = 2;

const semaphores = new Map<string, Semaphore>();

function semaphoreFor(provider: ProviderConfig): Semaphore {
  let sem = semaphores.get(provider.id);
  if (!sem) semaphores.set(provider.id, (sem = new Semaphore(provider.maxConcurrent)));
  else sem.setLimit(provider.maxConcurrent);
  return sem;
}

let inflight = 0;
let keepAliveTimer: ReturnType<typeof setInterval> | undefined;

/**
 * MV3 Service Worker 空闲 30 秒会被回收；请求进行中每 20 秒调用一次扩展 API 重置计时。
 * 见 docs/TECH_NOTES.md「Service Worker 生命周期」。
 */
async function keepAlive<T>(task: () => Promise<T>): Promise<T> {
  if (inflight++ === 0) keepAliveTimer = setInterval(() => void browser.runtime.getPlatformInfo(), 20_000);
  try {
    return await task();
  } finally {
    if (--inflight === 0) clearInterval(keepAliveTimer);
  }
}

export function describeError(err: unknown, provider?: ProviderConfig): string {
  if (err instanceof HttpError) return err.message;
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return `请求超时（${Math.round((provider?.timeoutMs ?? 0) / 1000)} 秒），可在设置中调大超时或减小批量大小`;
  }
  if (err instanceof TypeError) {
    return `网络错误：无法连接 ${provider?.baseURL ?? '服务'}（检查地址、网络或代理）`;
  }
  return err instanceof Error ? err.message : String(err);
}

async function complete(provider: ProviderConfig, messages: ChatMessage[]): Promise<string> {
  const client = createClient(provider);
  return keepAlive(() =>
    semaphoreFor(provider).run(() =>
      withRetry(() => client.complete(messages, AbortSignal.timeout(provider.timeoutMs)), {
        retries: 2,
        baseDelayMs: 1000,
      }),
    ),
  );
}

function cacheKey(provider: ProviderConfig, settings: Settings, segment: string): Promise<string> {
  return cache.sha256(
    JSON.stringify([provider.baseURL, provider.model, settings.targetLang, PROMPT_VERSION, provider.prompt, segment]),
  );
}

async function requireProvider(): Promise<ProviderConfig> {
  const provider = await getActiveProvider();
  if (!provider) throw new Error('还没有配置翻译服务：请在扩展设置页添加一个模型 API');
  if (!provider.model) throw new Error(`翻译服务「${provider.name}」还没填写模型名`);
  return provider;
}

/**
 * 翻译一批段落：先查缓存，未命中的合并成一次请求；
 * 模型漏掉的段在预算内二分补翻；仍失败的段返回 null 并附带原因。
 */
export async function translateSegments(segments: string[], title: string): Promise<TranslateResult> {
  const [settings, provider] = await Promise.all([getSettings(), requireProvider()]);
  const keys = await Promise.all(segments.map((s) => cacheKey(provider, settings, s)));
  const cached = await cache.getMany(keys);
  const translations = keys.map((k) => cached.get(k) ?? null);
  const missing = translations.flatMap((t, i) => (t === null ? [i] : []));
  if (missing.length === 0) return { translations };

  const prompt = { targetLang: settings.targetLang, stylePrompt: provider.prompt, title };
  const outcome = await translateBatch(
    missing.map((i) => segments[i]!),
    async (batch) => parseSegments(await complete(provider, buildMessages(batch, prompt)), batch.length),
    { maxRecoveryRequests: MAX_RECOVERY_REQUESTS, describeError: (err) => describeError(err, provider) },
  );
  missing.forEach((i, j) => (translations[i] = outcome.translations[j] ?? null));

  const fresh = missing.flatMap((i) => {
    const t = translations[i];
    return t === null || t === undefined ? [] : [[keys[i]!, t] as [string, string]];
  });
  await cache.setMany(fresh).catch(() => undefined); // 缓存写失败不影响本次翻译
  return { translations, error: outcome.error };
}

export async function testProvider(provider: ProviderConfig): Promise<{ text: string; ms: number }> {
  const settings = await getSettings();
  const start = performance.now();
  try {
    const messages = buildMessages(['Hello! This is a connection test from the translation extension.'], {
      targetLang: settings.targetLang,
      stylePrompt: provider.prompt,
    });
    const text = parseSegments(await complete(provider, messages), 1)[0];
    if (!text) throw new Error('模型返回了空内容');
    return { text, ms: Math.round(performance.now() - start) };
  } catch (err) {
    throw new Error(describeError(err, provider));
  }
}

export async function listModels(provider: ProviderConfig): Promise<string[]> {
  try {
    return await createClient(provider).listModels(AbortSignal.timeout(15_000));
  } catch (err) {
    throw new Error(describeError(err, provider));
  }
}
