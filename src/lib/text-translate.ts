import { isProbablyInLanguage } from './languages';

/** 侧栏文本翻译用的长连接：逐段推送译文，断开即中止请求（事件类型同划词的 SelectionEvent） */
export const TEXT_PORT = 'ptx-text';

export interface TextRequest {
  text: string;
  /** 目标语言（「自动」已在侧栏解析好） */
  targetLang: string;
  /** 翻译风格档案 id（lib/profiles.ts） */
  profile: string;
  /** 指定服务；缺省用当前服务 */
  providerId?: string;
}

/**
 * 侧栏「自动」目标语言：输入不是目标语言时译成目标语言（看外文）；
 * 已经是目标语言时改译成输入框翻译的目标语言（写外文）。一个侧栏覆盖两个方向。
 */
export function resolveTextTarget(text: string, choice: string, targetLang: string, writeLang: string): string {
  if (choice !== 'auto') return choice;
  return text.trim() !== '' && isProbablyInLanguage(text, targetLang) ? writeLang : targetLang;
}
