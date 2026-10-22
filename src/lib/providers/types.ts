export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * 翻译服务适配接口。新增协议（如原生 Anthropic / Gemini）时实现它，
 * 并在 index.ts 注册，调用方不感知具体协议。
 */
export interface LLMClient {
  /** 发送对话并返回完整文本；流式时每收到一段增量回调一次 onDelta（划词弹窗逐字显示） */
  complete(messages: ChatMessage[], signal: AbortSignal, onDelta?: (delta: string) => void): Promise<string>;
  listModels(signal?: AbortSignal): Promise<string[]>;
}

/** 带 HTTP 状态码的错误，便于决定是否重试、给出可读提示 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Retry-After 头（毫秒） */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
