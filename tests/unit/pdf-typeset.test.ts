import { describe, expect, it } from 'vitest';
import { breakLines, chainBlocks, flowLayout, tokenize, type FlowBlock, type Measure, type Token } from '@/lib/pdf/typeset';

/** 测量：中文字符宽 1 个字号，其他字符宽 0.5 个字号；原子固定宽 20 × 缩放 */
const measure: Measure = {
  text: (text, size) => [...text].reduce((w, ch) => w + (/[⺀-鿿＀-￯　-〿]/.test(ch) ? size : size * 0.5), 0),
  atom: (_index, scale) => 20 * scale,
};
const show = (lines: Token[][]) =>
  lines.map((l) => l.map((t) => (t.kind === 'atom' ? `<${t.index}>` : t.kind === 'space' ? ' ' : t.text)).join(''));

describe('tokenize', () => {
  it('中文逐字、英文按词、原子按编号；反转义；丢弃不存在的原子编号', () => {
    const tokens = tokenize('使用softmax函数计算<x0/>和 <x5/> &lt;b&gt;', 1);
    expect(show([tokens])).toEqual(['使用softmax函数计算<0>和 <b>']);
    expect(tokens.filter((t) => t.kind === 'atom')).toHaveLength(1);
  });

  it('模型把占位符转义了（&lt;x0/&gt;）也能认出来', () => {
    expect(tokenize('维度为&lt;x0/&gt;的键', 1).some((t) => t.kind === 'atom')).toBe(true);
  });
});

describe('breakLines', () => {
  it('按宽度断行，中文逐字可断，英文单词与原子不可断', () => {
    const lines = breakLines(tokenize('我们使用Transformer模型<x0/>完成任务', 1), 60, 10, 1, measure);
    // Transformer 宽 55，后面跟不下「模」；「模型」+ 原子 +「完成」正好 60
    expect(show(lines)).toEqual(['我们使用', 'Transformer', '模型<0>完成', '任务']);
  });

  it('避头：句读不放行首；避尾：开括号不留行尾', () => {
    expect(show(breakLines(tokenize('一二三四五，六七', 0), 50, 10, 1, measure))).toEqual(['一二三四五，', '六七']);
    expect(show(breakLines(tokenize('一二三四（五六）', 0), 50, 10, 1, measure))).toEqual(['一二三四', '（五六）']);
  });

  it('行首行尾不留空白', () => {
    expect(show(breakLines(tokenize('aaaa bbbb cccc', 0), 45, 10, 1, measure))).toEqual(['aaaa bbbb', 'cccc']);
  });
});

describe('breakLines 缩进', () => {
  it('首行缩进只占首行的宽度；悬挂缩进作用于其余各行', () => {
    const text = tokenize('一二三四五六七八九十一二三四五', 0);
    expect(show(breakLines(text, 100, 10, 1, measure, { first: 20, rest: 0 }))).toEqual(['一二三四五六七八', '九十一二三四五']);
    expect(show(breakLines(text, 100, 10, 1, measure, { first: 0, rest: 30 }))).toEqual(['一二三四五六七八九十', '一二三四五']);
  });
});

describe('tokenize 断词', () => {
  it('斜杠后可以断开；破折号整体成一个 token', () => {
    expect(show([tokenize('环境——ProgPrompt/VirtualHome、AI2-THOR', 0)])).toEqual(['环境——ProgPrompt/VirtualHome、AI2-THOR']);
    const texts = tokenize('——A/B/C', 0).map((t) => (t.kind === 'text' ? t.text : ''));
    expect(texts).toEqual(['——', 'A/', 'B/', 'C']);
  });
});

/** 一个译文块：中文字数 n 个字，宽 100（每行 10 个字） */
function flowBlock(box: Partial<FlowBlock> & { top: number; bottom: number }, chars: number): FlowBlock {
  return { x0: 0, x1: 100, size: 10, tokens: tokenize('字'.repeat(chars), 0), measure, indentEm: { first: 0, rest: 0 }, ...box };
}

describe('chainBlocks', () => {
  it('同一栏上下相邻的块连成串；两栏各自成串', () => {
    const blocks = [
      { x0: 0, x1: 100, top: 0, bottom: 50, size: 10 },
      { x0: 200, x1: 300, top: 0, bottom: 50, size: 10 },
      { x0: 0, x1: 100, top: 52, bottom: 90, size: 10 },
      { x0: 200, x1: 300, top: 52, bottom: 90, size: 10 },
    ];
    expect(chainBlocks(blocks, [])).toEqual([
      [0, 2],
      [1, 3],
    ]);
  });

  it('中间隔着保留原文的块（公式）、大段空白（图片）或是表格单元格时不连', () => {
    const a = { x0: 0, x1: 100, top: 0, bottom: 50, size: 10 };
    expect(chainBlocks([a, { x0: 0, x1: 100, top: 80, bottom: 120, size: 10 }], [{ x0: 20, x1: 80, top: 55, bottom: 75, size: 10 }])).toEqual([[0], [1]]);
    expect(chainBlocks([a, { x0: 0, x1: 100, top: 100, bottom: 140, size: 10 }], [])).toEqual([[0], [1]]);
    expect(chainBlocks([a, { x0: 0, x1: 100, top: 52, bottom: 90, size: 10, fixed: true }], [])).toEqual([[0], [1]]);
  });

  it('通栏块下面的两栏不接在通栏块后面；两栏下面的通栏块也不接', () => {
    const blocks = [
      { x0: 0, x1: 300, top: 0, bottom: 20, size: 10 },
      { x0: 0, x1: 100, top: 25, bottom: 60, size: 10 },
      { x0: 200, x1: 300, top: 25, bottom: 60, size: 10 },
      { x0: 0, x1: 300, top: 65, bottom: 80, size: 10 },
    ];
    expect(chainBlocks(blocks, [])).toEqual([[0], [1], [2], [3]]);
  });
});

describe('flowLayout', () => {
  it('串内译文依次排布：后一段紧接前一段，段距不因译文变短而变大', () => {
    // 原文两段各 5 行；译文各 15 字（2 行），第二段上移
    const blocks = [flowBlock({ top: 0, bottom: 56 }, 15), flowBlock({ top: 55, bottom: 111 }, 15)];
    const [a, b] = flowLayout(blocks, []);
    expect(a!.top).toBe(0);
    expect(a!.size).toBe(10);
    // 第一段占 10 × (1 + 1.32 + 0.3) = 26.2，原文两段之间没有额外段距
    expect(b!.top).toBeCloseTo(26.2 + 0.2);
    expect(b!.lines).toHaveLength(2);
  });

  it('原文的额外段距（标题前后）按比例保留', () => {
    const blocks = [flowBlock({ top: 0, bottom: 56 }, 15), flowBlock({ top: 75, bottom: 131 }, 15)];
    const [, b] = flowLayout(blocks, []);
    expect(b!.top).toBeCloseTo(26.2 + 0.2 + 20);
  });

  it('整串装不下时整串一起缩小，字号一致', () => {
    // 两段原文各 1 行，译文各 15 字：原字号要 2 行，装不下
    const blocks = [flowBlock({ top: 0, bottom: 13 }, 15), flowBlock({ top: 13, bottom: 26 }, 15)];
    const [a, b] = flowLayout(blocks, []);
    expect(a!.size).toBeLessThan(10);
    expect(a!.size).toBe(b!.size);
  });

  it('同一页多行正文取同一个缩放；单行标签挤得再小也不拖累整页', () => {
    const blocks = [
      // 左栏：装得下（原 5 行，译文 2 行）
      flowBlock({ x0: 0, x1: 100, top: 0, bottom: 70 }, 15),
      // 右栏：原 3 行，译文 40 字要缩到约 0.85 才装得下
      flowBlock({ x0: 200, x1: 300, top: 0, bottom: 40 }, 40),
      // 单行标签：很挤
      flowBlock({ x0: 400, x1: 420, top: 0, bottom: 13 }, 10),
    ];
    const [left, right, label] = flowLayout(blocks, []);
    expect(right!.size).toBeLessThan(10);
    expect(left!.size).toBe(right!.size);
    expect(label!.size).toBeLessThan(right!.size);
  });

  it('首行缩进按译文字号的两个字计算', () => {
    const [p] = flowLayout([flowBlock({ top: 0, bottom: 56, indentEm: { first: 2, rest: 0 } }, 15)], []);
    expect(p!.indent.first).toBe(20);
    expect(show(p!.lines)[0]).toHaveLength(8);
  });
});
