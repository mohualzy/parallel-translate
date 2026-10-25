import { describe, expect, it } from 'vitest';
import { intersects, PageMarks, subtract, type MarkStyle } from '@/content/marks';

/** 一个文字节点上 [start, end) 的区间 */
function setup(text = 'The quick brown fox jumps over the lazy dog') {
  document.body.innerHTML = `<p id="p">${text}</p>`;
  const node = document.getElementById('p')!.firstChild!;
  const range = (start: number, end: number) => {
    const r = document.createRange();
    r.setStart(node, start);
    r.setEnd(node, end);
    return r;
  };
  return { range };
}

const span = (r: Range) => [r.startOffset, r.endOffset];

describe('intersects / subtract', () => {
  it('相交：重叠才算，首尾相接不算', () => {
    const { range } = setup();
    expect(intersects(range(0, 10), range(5, 15))).toBe(true);
    expect(intersects(range(0, 10), range(10, 15))).toBe(false);
    expect(intersects(range(4, 9), range(0, 20))).toBe(true);
  });

  it('相减：两侧各留一段；被完全覆盖时为空；不相交时原样', () => {
    const { range } = setup();
    expect(subtract(range(0, 20), range(5, 10)).map(span)).toEqual([
      [0, 5],
      [10, 20],
    ]);
    expect(subtract(range(5, 10), range(0, 20))).toEqual([]);
    expect(subtract(range(0, 5), range(10, 20)).map(span)).toEqual([[0, 5]]);
    expect(subtract(range(0, 10), range(5, 20)).map(span)).toEqual([[0, 5]]);
  });
});

describe('PageMarks', () => {
  const recorder = () => {
    const drawn = new Map<MarkStyle, number[][]>();
    const marks = new PageMarks((style, ranges) => drawn.set(style, ranges.map(span)));
    return { marks, drawn };
  };

  it('新的高亮颜色切掉旧颜色的重叠部分；下划线和高亮可以叠加', () => {
    const { range } = setup();
    const { marks, drawn } = recorder();
    marks.add(range(0, 20), 'yellow');
    marks.add(range(4, 9), 'green');
    marks.add(range(0, 20), 'underline');
    expect(drawn.get('yellow')).toEqual([
      [0, 4],
      [9, 20],
    ]);
    expect(drawn.get('green')).toEqual([[4, 9]]);
    expect(drawn.get('underline')).toEqual([[0, 20]]);
  });

  it('同色重复加不会叠出重复区间', () => {
    const { range } = setup();
    const { marks, drawn } = recorder();
    marks.add(range(0, 10), 'pink');
    marks.add(range(5, 15), 'pink');
    expect(drawn.get('pink')).toEqual([
      [0, 5],
      [5, 15],
    ]);
  });

  it('清除只去掉选中的区间，两侧保留；overlaps 判断选区是否碰到强调', () => {
    const { range } = setup();
    const { marks, drawn } = recorder();
    marks.add(range(0, 20), 'blue');
    marks.add(range(0, 20), 'underline');
    expect(marks.overlaps(range(25, 30))).toBe(false);
    expect(marks.overlaps(range(10, 30))).toBe(true);
    marks.clear(range(10, 15));
    expect(drawn.get('blue')).toEqual([
      [0, 10],
      [15, 20],
    ]);
    expect(drawn.get('underline')).toEqual([
      [0, 10],
      [15, 20],
    ]);
  });
});
