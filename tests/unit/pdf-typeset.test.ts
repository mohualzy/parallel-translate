import { describe, expect, it } from 'vitest';
import { breakLines, fitBlock, tokenize, type Measure, type Token } from '@/lib/pdf/typeset';

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

describe('fitBlock', () => {
  it('装得下时用原字号；装不下时缩小字号，原子按同样比例缩放', () => {
    const roomy = fitBlock(tokenize('短句', 0), { width: 100, height: 20, size: 10 }, measure);
    expect(roomy.size).toBe(10);
    const tight = fitBlock(tokenize('这是一句很长的译文需要缩小字号才能放进去', 0), { width: 100, height: 20, size: 10 }, measure);
    expect(tight.size).toBeLessThan(10);
    expect(tight.size).toBeGreaterThanOrEqual(6);
    expect(tight.lines.length * tight.size * 1.32).toBeLessThanOrEqual(20 + tight.size * 0.4);
  });

  it('最小字号也装不下时用最小字号（允许溢出），不会无限缩小', () => {
    const r = fitBlock(tokenize('很长'.repeat(50), 0), { width: 40, height: 10, size: 10 }, measure);
    expect(r.size).toBeCloseTo(6);
  });
});
