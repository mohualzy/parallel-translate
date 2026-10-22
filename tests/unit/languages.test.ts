import { describe, expect, it } from 'vitest';
import { baseLang, isProbablyInLanguage } from '@/lib/languages';

describe('isProbablyInLanguage', () => {
  it('中文段落（夹杂英文术语）判为中文', () => {
    expect(isProbablyInLanguage('使用 React 构建用户界面', 'zh-CN')).toBe(true);
    expect(isProbablyInLanguage('這是繁體中文', 'zh-CN')).toBe(true);
  });

  it('英文段落（夹杂个别汉字）不判为中文', () => {
    expect(isProbablyInLanguage('The word 中 means middle in Chinese.', 'zh-CN')).toBe(false);
  });

  it('日文有假名，不判为中文；判为日文', () => {
    const ja = 'これは日本語の文章です';
    expect(isProbablyInLanguage(ja, 'zh-CN')).toBe(false);
    expect(isProbablyInLanguage(ja, 'ja')).toBe(true);
  });

  it('韩文与俄文', () => {
    expect(isProbablyInLanguage('안녕하세요 세계', 'ko')).toBe(true);
    expect(isProbablyInLanguage('Привет, мир', 'ru')).toBe(true);
    expect(isProbablyInLanguage('Hello world', 'ru')).toBe(false);
  });

  it('拉丁语系无法区分，交给模型', () => {
    expect(isProbablyInLanguage('Bonjour le monde', 'en')).toBe(false);
  });
});

describe('baseLang', () => {
  it('取主语言代码', () => {
    expect(baseLang('zh-CN')).toBe('zh');
    expect(baseLang('en_US')).toBe('en');
  });
});
