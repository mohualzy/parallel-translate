import { describe, expect, it } from 'vitest';
import { addHighlight, highlightsMarkdown, locate, removeRange, type PdfHighlight } from '@/lib/pdf/highlights';

const TEXT = '注意力机制是 Transformer 的核心。';
const textOf = (page: number, key: string) => (page === 1 && key === 'k' ? TEXT : undefined);
const h = (start: number, end: number, style: PdfHighlight['style'] = 'yellow'): PdfHighlight => ({
  id: `${start}-${end}`,
  page: 1,
  key: 'k',
  start,
  end,
  quote: TEXT.slice(start, end),
  style,
});
const spans = (list: PdfHighlight[]) => list.map((x) => [x.start, x.end, x.style, x.quote]).sort((a, b) => Number(a[0]) - Number(b[0]));

describe('locate', () => {
  it('原位置文字没变就用原位置', () => {
    expect(locate(h(0, 3), TEXT)).toEqual({ start: 0, end: 3 });
  });

  it('译文变了：quote 只出现一次时重新定位，多次或找不到时放弃', () => {
    expect(locate(h(0, 3), `新的${TEXT}`)).toEqual({ start: 2, end: 5 });
    expect(locate(h(0, 3), '和注意力与注意力')).toBeUndefined();
    expect(locate(h(0, 3), '别的译文')).toBeUndefined();
  });
});

describe('addHighlight', () => {
  it('新强调切开重叠的旧强调，保留两侧', () => {
    const list = addHighlight([h(0, 6)], { page: 1, key: 'k', start: 2, end: 4 }, 'green', textOf);
    expect(spans(list)).toEqual([
      [0, 2, 'yellow', '注意'],
      [2, 4, 'green', '力机'],
      [4, 6, 'yellow', '制是'],
    ]);
  });

  it('首尾空白不算进强调；全是空白时不添加', () => {
    const at = TEXT.indexOf(' Transformer ');
    const list = addHighlight([], { page: 1, key: 'k', start: at, end: at + 13 }, 'blue', textOf);
    expect(spans(list)).toEqual([[at + 1, at + 12, 'blue', 'Transformer']]);
    expect(addHighlight([], { page: 1, key: 'k', start: at, end: at + 1 }, 'blue', textOf)).toEqual([]);
  });

  it('别的块、别的页的强调不受影响', () => {
    const other = { ...h(0, 3), key: 'other' };
    expect(addHighlight([other], { page: 1, key: 'k', start: 0, end: 3 }, 'pink', textOf)).toContainEqual(other);
  });
});

describe('removeRange', () => {
  it('清除区间覆盖的部分；完全覆盖的整条删掉', () => {
    expect(spans(removeRange([h(0, 6), h(8, 10)], { page: 1, key: 'k', start: 3, end: 12 }, textOf))).toEqual([[0, 3, 'yellow', '注意力']]);
  });
});

describe('highlightsMarkdown', () => {
  it('按页分节，同一段的强调列在一起并附原文；非黄色注明颜色，下划线用 <u>', () => {
    const md = highlightsMarkdown('Attention Is All You Need', 'https://arxiv.org/pdf/1706.03762', [
      { page: 2, key: 'a', style: 'yellow', quote: '注意力机制', source: 'Attention   mechanisms\nhave become' },
      { page: 2, key: 'a', style: 'green', quote: '序列建模' },
      { page: 2, key: 'b', style: 'underline', quote: '多头注意力', source: 'Multi-head attention' },
      { page: 5, key: 'c', style: 'pink', quote: '位置编码' },
    ]);
    expect(md).toBe(
      [
        '# Attention Is All You Need：强调',
        '',
        '来源：https://arxiv.org/pdf/1706.03762',
        '',
        '## 第 2 页',
        '',
        '- ==注意力机制==',
        '- ==序列建模==（绿）',
        '',
        '  > 原文：Attention mechanisms have become',
        '',
        '- <u>多头注意力</u>',
        '',
        '  > 原文：Multi-head attention',
        '',
        '## 第 5 页',
        '',
        '- ==位置编码==（粉）',
        '',
      ].join('\n'),
    );
  });
});
