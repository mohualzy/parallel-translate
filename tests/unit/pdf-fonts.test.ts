import { describe, expect, it } from 'vitest';
import { cjkFontLabel, cjkStack, quoteFamily } from '@/lib/pdf/fonts';

const serif = { sans: false, italic: false };
const sans = { sans: true, italic: false };
const italic = { sans: false, italic: true };

describe('cjkStack', () => {
  it('自动：按原文的衬线 / 无衬线选宋体或黑体，Windows 版 Noto 的族名也在栈里', () => {
    expect(cjkStack('', serif)).toMatch(/^"Songti SC","Noto Serif SC",.*"SimSun",serif$/);
    expect(cjkStack('', sans)).toContain('"Noto Sans SC"');
    expect(cjkStack('', sans)).toMatch(/sans-serif$/);
  });

  it('预设不看原文的衬线 / 无衬线', () => {
    expect(cjkStack('@hei', serif)).toBe(cjkStack('', sans));
    expect(cjkStack('@song', sans)).toBe(cjkStack('', serif));
    expect(cjkStack('@fang', serif)).toContain('FangSong');
  });

  it('自定义字体排第一，后面接自动栈兜底缺字', () => {
    expect(cjkStack('LXGW WenKai Screen', sans)).toBe(`"LXGW WenKai Screen",${cjkStack('', sans)}`);
    expect(cjkStack('  Noto Serif SC ', serif)).toBe(`"Noto Serif SC",${cjkStack('', serif)}`);
  });

  it('斜体用楷体；主字体是楷体类时斜体改用仿宋', () => {
    expect(cjkStack('', italic)).toContain('KaiTi');
    expect(cjkStack('Noto Serif SC', italic)).toContain('KaiTi');
    expect(cjkStack('@kai', italic)).toContain('FangSong');
    expect(cjkStack('LXGW WenKai', italic)).toContain('FangSong');
    expect(cjkStack('华文楷体', italic)).toContain('FangSong');
  });
});

describe('quoteFamily / cjkFontLabel', () => {
  it('去掉名字里的引号与反斜杠，防止拼坏 ctx.font', () => {
    expect(quoteFamily('My "Font"\\')).toBe('"My Font"');
  });

  it('界面名称', () => {
    expect(cjkFontLabel('')).toBe('自动');
    expect(cjkFontLabel('@kai')).toBe('楷体');
    expect(cjkFontLabel('Noto Serif SC')).toBe('Noto Serif SC');
  });
});
