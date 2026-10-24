import type { ProviderConfig, ProviderType } from '../settings';
import { createOpenAIClient } from './openai';
import type { LLMClient } from './types';

const factories: Record<ProviderType, (config: ProviderConfig) => LLMClient> = {
  openai: createOpenAIClient,
};

export function createClient(config: ProviderConfig): LLMClient {
  return factories[config.type](config);
}

export { buildMessages, parseSegments, PROMPT_VERSION } from './prompt';
export { HttpError } from './types';
export type { ChatMessage, LLMClient } from './types';
