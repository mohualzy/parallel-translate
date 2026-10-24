import { describe, expect, it } from 'vitest';
import { sameFont, splitByColor, type ColorGlyph } from '@/lib/pdf/color';
import type { PdfTextItem } from '@/lib/pdf/layout';

const BLACK = '#000000';
const RED = '#ff0000';

/** 一个文本项和它的字形：每个字符宽 5，空白没有字形；colorOf 决定第 i 个字符的颜色 */
function itemWithGlyphs(str: string, colorOf: (ch: string, i: number) => string): { item: PdfTextItem; glyphs: ColorGlyph[] } {
  const item: PdfTextItem = { str, x: 0, y: 100, w: str.length * 5, size: 10, font: 'Times', rotated: false, mono: false };
  const glyphs = [...str].flatMap((ch, i) => (ch.trim() ? [{ text: ch, x: i * 5, y: 100, w: 5, fill: colorOf(ch, i) }] : []));
  return { item, glyphs };
}

describe('splitByColor', () => {
  it('同一文本项里的彩色引用拆出来，括号和逗号归到引用里', () => {
    const { item, glyphs } = itemWithGlyphs('manipulation [1,20]. Next', (ch) => (/\d/.test(ch) ? RED : BLACK));
    const parts = splitByColor([item], glyphs);
    expect(parts.map((p) => [p.str, p.color])).toEqual([
      ['manipulation ', BLACK],
      ['[1,20]', RED],
      ['. Next', BLACK],
    ]);
    // 拆出的项首尾相接：起点是第一个字形
    expect(parts[1]!.x).toBe(13 * 5);
    expect(parts[0]!.x + parts[0]!.w).toBe(parts[1]!.x);
    expect(parts[2]!.x + parts[2]!.w).toBe(item.x + item.w);
  });

  it('其他字体的字形（没有文字层的公式大括号）不算进正文项', () => {
    const { item, glyphs } = itemWithGlyphs('record j, [1]', (ch) => (/\d/.test(ch) ? RED : BLACK));
    const withFont = { ...item, fontId: 'g_d0_f1' };
    const brace = { text: '\u0010', x: 20, y: 100, w: 5, fill: BLACK, fontId: 'g_d0_f9' };
    const parts = splitByColor([withFont], [...glyphs.map((g) => ({ ...g, fontId: 'g_d0_f1' })), brace]);
    expect(parts.map((p) => p.str)).toEqual(['record j, ', '[1]']);
    expect(sameFont(withFont, brace)).toBe(false);
  });

  it('单色的项只标颜色；文字与字形数对不上（连字）时不拆，标上主色', () => {
    const plain = itemWithGlyphs('plain text', () => BLACK);
    expect(splitByColor([plain.item], plain.glyphs).map((p) => [p.str, p.color])).toEqual([['plain text', BLACK]]);
    const ligature = itemWithGlyphs('efficient 1', (ch) => (ch === '1' ? RED : BLACK));
    const merged = ligature.glyphs.filter((g) => g.text !== 'f').concat({ text: 'ﬀ', x: 5, y: 100, w: 5, fill: BLACK });
    expect(splitByColor([ligature.item], merged).map((p) => [p.str, p.color])).toEqual([['efficient 1', BLACK]]);
  });
});
