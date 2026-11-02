import type { ProviderConfig, ProviderType } from '../settings';
import { createGoogleClient } from './google';
import { createOpenAIClient } from './openai';
import type { TranslationClient } from './types';

const factories: Record<ProviderType, (config: ProviderConfig) => TranslationClient> = {
  openai: createOpenAIClient,
  google: createGoogleClient,
};

export function createClient(config: ProviderConfig): TranslationClient {
  return factories[config.type](config);
}

export { buildMessages, parseSegments, PROMPT_VERSION } from './prompt';
export { HttpError } from './types';
export type { ChatMessage, LLMClient, MachineClient, TranslationClient } from './types';
