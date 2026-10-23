import { browser } from 'wxt/browser';
import { Semaphore, withRetry } from '@/lib/async';
import { translateBatch } from '@/lib/batch';
import { matchGlossary, parseGlossary, type GlossaryEntry } from '@/lib/glossary';
import type { PageContext, SelectionRequest, TranslateResult } from '@/lib/messages';
import { buildMessages, createClient, HttpError, parseSegments, PROMPT_VERSION, type ChatMessage } from '@/lib/providers';
import { buildSelectionMessages, SELECTION_PROMPT_VERSION, stripReasoning } from '@/lib/providers/prompt';
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

/** 缓存键包含该段命中的术语：改了术语表的译法，旧缓存自然失效 */
function cacheKey(provider: ProviderConfig, settings: Settings, segment: string, glossary: GlossaryEntry[]): Promise<string> {
  const terms = matchGlossary(glossary, [segment]).map((e) => [e.source, e.target]);
  return cache.sha256(
    JSON.stringify([provider.baseURL, provider.model, settings.targetLang, PROMPT_VERSION, provider.prompt, terms, segment]),
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
export async function translateSegments(segments: string[], page: PageContext): Promise<TranslateResult> {
  const [settings, provider] = await Promise.all([getSettings(), requireProvider()]);
  const glossary = parseGlossary(settings.glossary);
  const keys = await Promise.all(segments.map((s) => cacheKey(provider, settings, s, glossary)));
  const cached = await cache.getMany(keys);
  const translations = keys.map((k) => cached.get(k) ?? null);
  const missing = translations.flatMap((t, i) => (t === null ? [i] : []));
  if (missing.length === 0) return { translations };

  const prompt = { targetLang: settings.targetLang, stylePrompt: provider.prompt, title: page.title, summary: page.summary, subtitles: page.subtitles };
  const outcome = await translateBatch(
    missing.map((i) => segments[i]!),
    // 术语按实际发送的这一批匹配（补翻拆分后的小批次也只带自己用到的术语）
    async (batch) =>
      parseSegments(
        await complete(provider, buildMessages(batch, { ...prompt, glossary: matchGlossary(glossary, batch) })),
        batch.length,
      ),
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

/**
 * 划词翻译：单次流式请求，边收边推给页面。
 * 用户主动触发、需要立刻看到结果，所以不排在网页批量翻译的并发队列后面，也不重试（流到一半重试会重复输出）。
 */
export async function translateSelection(
  req: SelectionRequest,
  onDelta: (delta: string) => void,
  signal: AbortSignal,
): Promise<string> {
  const [settings, provider] = await Promise.all([getSettings(), requireProvider()]);
  const glossary = matchGlossary(parseGlossary(settings.glossary), [req.text]);
  const key = await cache.sha256(
    JSON.stringify([
      'selection',
      provider.baseURL,
      provider.model,
      settings.targetLang,
      SELECTION_PROMPT_VERSION,
      glossary.map((e) => [e.source, e.target]),
      req.word,
      req.context,
      req.text,
    ]),
  );
  const hit = (await cache.getMany([key])).get(key);
  if (hit !== undefined) {
    onDelta(hit);
    return hit;
  }
  const messages = buildSelectionMessages(req.text, {
    targetLang: settings.targetLang,
    context: req.context,
    word: req.word,
    glossary,
  });
  try {
    const raw = await keepAlive(() =>
      createClient(provider).complete(messages, AbortSignal.any([signal, AbortSignal.timeout(provider.timeoutMs)]), onDelta),
    );
    const text = stripReasoning(raw).trim();
    if (!text) throw new Error('模型返回了空内容');
    await cache.setMany([[key, text]]).catch(() => undefined);
    return text;
  } catch (err) {
    throw new Error(describeError(err, provider));
  }
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
