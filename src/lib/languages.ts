export interface Language {
  code: string;
  /** 界面显示名（该语言自己的写法） */
  name: string;
  /** 写进 prompt 的英文名，模型对英文语言名理解最稳定 */
  englishName: string;
}

export const LANGUAGES: Language[] = [
  { code: 'zh-CN', name: '简体中文', englishName: 'Simplified Chinese' },
  { code: 'zh-TW', name: '繁體中文', englishName: 'Traditional Chinese' },
  { code: 'en', name: 'English', englishName: 'English' },
  { code: 'ja', name: '日本語', englishName: 'Japanese' },
  { code: 'ko', name: '한국어', englishName: 'Korean' },
  { code: 'fr', name: 'Français', englishName: 'French' },
  { code: 'de', name: 'Deutsch', englishName: 'German' },
  { code: 'es', name: 'Español', englishName: 'Spanish' },
  { code: 'pt', name: 'Português', englishName: 'Portuguese' },
  { code: 'it', name: 'Italiano', englishName: 'Italian' },
  { code: 'ru', name: 'Русский', englishName: 'Russian' },
  { code: 'vi', name: 'Tiếng Việt', englishName: 'Vietnamese' },
];

export function getLanguage(code: string): Language {
  return LANGUAGES.find((l) => l.code === code) ?? { code, name: code, englishName: code };
}

/** 'zh-CN' → 'zh'，用于比较「是不是同一种语言」 */
export function baseLang(code: string): string {
  return code.toLowerCase().split(/[-_]/)[0] ?? '';
}

const RE_HAN = /\p{Script=Han}/gu;
const RE_KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const RE_HANGUL = /\p{Script=Hangul}/gu;
const RE_LATIN_WORD = /\p{Script=Latin}+/gu;
const RE_CYRILLIC_WORD = /\p{Script=Cyrillic}+/gu;

function count(text: string, re: RegExp): number {
  return text.match(re)?.length ?? 0;
}

/**
 * 粗判一段文本是否已经是目标语言，命中则跳过翻译以省钱。
 * 只对能靠文字系统区分的语言生效（中/日/韩/俄）；拉丁语系之间无法区分，返回 false 交给模型处理。
 * 计数单位：CJK 每个字算一个单位，拉丁/西里尔按词算，避免「中文夹英文术语」被误判为外文。
 */
export function isProbablyInLanguage(text: string, lang: string): boolean {
  const han = count(text, RE_HAN);
  const kana = count(text, RE_KANA);
  const hangul = count(text, RE_HANGUL);
  const latin = count(text, RE_LATIN_WORD);
  const cyrillic = count(text, RE_CYRILLIC_WORD);
  const units = han + kana + hangul + latin + cyrillic;
  if (units === 0) return false;

  switch (baseLang(lang)) {
    case 'zh':
      return han / units >= 0.4 && kana / units < 0.1;
    case 'ja':
      return kana / units >= 0.1;
    case 'ko':
      return hangul / units >= 0.4;
    case 'ru':
      return cyrillic / units >= 0.5;
    default:
      return false;
  }
}
