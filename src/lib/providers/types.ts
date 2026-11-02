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

export interface MachineOptions {
  targetLang: string;
  /** 文本已转义、带占位标签（网页、PDF、字幕的片段）；否则是可能多段的纯文本 */
  markup: boolean;
}

/**
 * 机器翻译服务：不理解 prompt，直接翻译原文。
 * 风格、术语、上下文对它不生效，术语抽取、视频预读这些要模型才能做的事跳过。
 */
export interface MachineClient {
  /** 返回和 texts 等长的数组，缺失的项为 null */
  translate(texts: string[], opts: MachineOptions, signal: AbortSignal): Promise<(string | null)[]>;
}

export type TranslationClient = LLMClient | MachineClient;

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
