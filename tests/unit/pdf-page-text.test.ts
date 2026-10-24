import { describe, expect, it } from 'vitest';
import type { LineItem, PdfBlock } from '@/lib/pdf/layout';
import { blockKeys, keptBlockText, rangeRects, textLines, type PageTextBlock } from '@/lib/pdf/page-text';

const item = (str: string, x: number, w: number, y = 100, size = 10): LineItem => ({
  str,
  x,
  y,
  w,
  size,
  font: 'Times',
  rotated: false,
  mono: false,
  math: false,
  attached: false,
});

const block = (lines: LineItem[][]): PdfBlock =>
  ({ lines: lines.map((items) => ({ y: items[0]!.y, size: items[0]!.size, x0: 0, x1: 0, items })) }) as unknown as PdfBlock;

describe('blockKeys', () => {
  it('同一页重复的原文按出现次序编号', () => {
    expect(blockKeys([{ text: 'A' }, { text: 'B' }, { text: 'A' }])).toEqual(['A#0', 'B#0', 'A#1']);
  });
});

describe('keptBlockText', () => {
  it('同一行隔开的项之间、换行处补空格；紧挨着的项、行末连字符不补；旋转的项跳过', () => {
    const b = keptBlockText(
      block([
        [item('Jia', 0, 15), item('wei', 15, 15), item('Liu', 40, 15)],
        [item('exam-', 0, 25, 112), item('ple', 0, 15, 124)],
      ]),
      'k',
    );
    expect(b.text).toBe('Jiawei Liu exam-ple');
    expect(b.pieces.map((p) => [p.start, p.end, p.line])).toEqual([
      [0, 3, 0],
      [3, 6, 0],
      [7, 10, 0],
      [11, 16, 1],
      [16, 19, 1],
    ]);
  });

  it('平移过的区域：基线加上平移量', () => {
    const b = keptBlockText(block([[item('x', 0, 5, 100)]]), 'k', -30);
    expect(b.pieces[0]!.baseline).toBe(70);
  });
});

const translated: PageTextBlock = {
  key: 'k',
  text: '注意力 is all',
  translated: true,
  pieces: [
    { start: 0, end: 1, x: 0, w: 10, baseline: 20, size: 10, line: 0 },
    { start: 1, end: 2, x: 10, w: 10, baseline: 20, size: 10, line: 0 },
    { start: 2, end: 3, x: 20, w: 10, baseline: 20, size: 10, line: 0 },
    { start: 3, end: 4, x: 30, w: 3, baseline: 20, size: 10, line: 0 },
    { start: 4, end: 6, x: 33, w: 10, baseline: 20, size: 10, line: 0 },
    // 行末空格被断行丢掉，没有位置
    { start: 7, end: 10, x: 0, w: 15, baseline: 33, size: 10, line: 1 },
  ],
};

describe('textLines', () => {
  it('每行的文本区间包含行末被丢掉的空格，首行从 0 开始、末行到结尾', () => {
    expect(textLines(translated).map((l) => [l.start, l.end, l.x0, l.x1, l.baseline])).toEqual([
      [0, 7, 0, 43],
      [7, 10, 0, 15],
    ].map(([s, e, a, b], i) => [s, e, a, b, i === 0 ? 20 : 33]));
  });
});

describe('rangeRects', () => {
  it('跨多个片段的区间每行合并成一个矩形；词内按字数插值', () => {
    const rects = rangeRects(translated, 1, 9);
    expect(rects).toHaveLength(2);
    expect(rects[0]!.x).toBe(10);
    expect(rects[0]!.w).toBeCloseTo(33);
    expect(rects[1]!.x).toBe(0);
    expect(rects[1]!.w).toBeCloseTo(10);
    expect(rects[1]!.baseline).toBe(33);
  });

  it('区间外的片段不出矩形', () => {
    expect(rangeRects(translated, 6, 7)).toEqual([]);
  });
});
