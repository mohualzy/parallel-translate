import { describe, expect, it } from 'vitest';
import { findMatches } from '@/lib/pdf/find';

const pages: [number, { key: string; text: string }[]][] = [
  [1, [{ key: 'a', text: '注意力机制 Attention is all you need' }, { key: 'b', text: '多头注意力' }]],
  [3, [{ key: 'c', text: 'attention, ATTENTION' }]],
];

describe('findMatches', () => {
  it('按页、块、位置的顺序列出全部命中，不区分大小写', () => {
    expect(findMatches(pages, 'attention')).toEqual([
      { page: 1, key: 'a', start: 6, end: 15 },
      { page: 3, key: 'c', start: 0, end: 9 },
      { page: 3, key: 'c', start: 11, end: 20 },
    ]);
  });

  it('中文、含空格的短语在块内照常匹配（显示文本和断行无关）', () => {
    expect(findMatches(pages, '注意力').map((m) => m.key)).toEqual(['a', 'b']);
    expect(findMatches(pages, 'is all you')).toEqual([{ page: 1, key: 'a', start: 16, end: 26 }]);
  });

  it('空查询没有结果；首尾空白忽略', () => {
    expect(findMatches(pages, '  ')).toEqual([]);
    expect(findMatches(pages, ' 多头 ')).toHaveLength(1);
  });
});
