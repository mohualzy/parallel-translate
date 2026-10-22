import type { ProviderConfig } from '../settings';
import { HttpError, type ChatMessage, type LLMClient } from './types';

/** 兼容用户填写 `.../v1`、`.../v1/`、`.../v1/chat/completions` 等写法 */
export function endpoint(baseURL: string, path: 'chat/completions' | 'models'): string {
  const base = baseURL
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/(chat\/completions|models)$/, '');
  return `${base}/${path}`;
}

const STATUS_HINTS: Record<number, string> = {
  400: '请求参数有误（多半是模型名不对）',
  401: 'API Key 无效或缺失',
  402: '账户余额不足',
  403: '无权访问（检查 Key 权限或地区限制）',
  404: '地址或模型不存在（检查 Base URL 与模型名）',
  429: '请求过于频繁或额度用尽',
};

async function toHttpError(res: Response): Promise<HttpError> {
  let detail = '';
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      detail = json?.error?.message ?? json?.message ?? text;
    } catch {
      detail = text;
    }
  } catch {
    // 读不到响应体就只报状态码
  }
  const hint = STATUS_HINTS[res.status] ?? (res.status >= 500 ? '服务端错误' : '请求失败');
  const retryAfter = Number(res.headers.get('retry-after'));
  return new HttpError(
    res.status,
    `${hint}（HTTP ${res.status}）${detail ? `：${String(detail).slice(0, 300)}` : ''}`,
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
  );
}

/** 解析一行 SSE，返回增量文本；流中出现 error 对象时抛出 */
export function parseSSELine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return '';
  const data = trimmed.slice(5).trim();
  if (data === '' || data === '[DONE]') return '';
  let json: any;
  try {
    json = JSON.parse(data);
  } catch {
    return '';
  }
  if (json?.error) throw new Error(`模型服务返回错误：${json.error.message ?? JSON.stringify(json.error)}`);
  const content = json?.choices?.[0]?.delta?.content;
  return typeof content === 'string' ? content : '';
}

async function readEventStream(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let output = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) output += parseSSELine(line);
  }
  buffer += decoder.decode();
  if (buffer) output += parseSSELine(buffer);
  return output;
}

/**
 * 解析用户填写的额外请求参数。必须是 JSON 对象；空字符串视为没有。
 * 用途：关闭推理模型的思考（enable_thinking / think / reasoning_effort）、Ollama 的 keep_alive 等。
 */
export function parseExtraBody(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('额外请求参数不是合法的 JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('额外请求参数必须是 JSON 对象，例如 {"enable_thinking": false}');
  }
  return value as Record<string, unknown>;
}

export function createOpenAIClient(config: ProviderConfig): LLMClient {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // Ollama 等本地服务可以不填 Key
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  return {
    async complete(messages: ChatMessage[], signal: AbortSignal): Promise<string> {
      const res = await fetch(endpoint(config.baseURL, 'chat/completions'), {
        method: 'POST',
        headers,
        signal,
        // 额外参数可以覆盖 temperature，但不能覆盖协议必需的 model / messages / stream
        body: JSON.stringify({
          temperature: config.temperature,
          ...parseExtraBody(config.extraBody),
          model: config.model,
          messages,
          stream: config.stream,
        }),
      });
      if (!res.ok) throw await toHttpError(res);

      // 请求了流式但服务直接回 JSON 的情况也兼容
      const contentType = res.headers.get('content-type') ?? '';
      if (config.stream && res.body && !contentType.includes('application/json')) {
        return readEventStream(res.body);
      }
      const json = await res.json();
      const content = json?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('响应格式不符合 OpenAI 兼容协议（缺少 choices[0].message.content）');
      return content;
    },

    async listModels(signal?: AbortSignal): Promise<string[]> {
      const res = await fetch(endpoint(config.baseURL, 'models'), { headers, signal });
      if (!res.ok) throw await toHttpError(res);
      const json = await res.json();
      const list: unknown[] = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
      return list
        .map((m) => (typeof m === 'string' ? m : (m as { id?: string; name?: string })?.id ?? (m as { name?: string })?.name))
        .filter((id): id is string => typeof id === 'string')
        .sort();
    },
  };
}
