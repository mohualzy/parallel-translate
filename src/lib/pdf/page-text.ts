/**
 * 译文页上的文字几何（设计见 docs/specs/2026-10-24-pdf-text-layer-design.md）：
 * 每个块一份「显示文本」和其中每段文字在画布上的位置，文字层（选中、复制、搜索）和强调绘制都从这里派生。
 * 显示文本和断行无关：换字体、缩放后偏移量不变，强调不会错位。纯逻辑，坐标是画布像素。
 */
import type { PdfBlock } from './layout';

/** 显示文本里 [start, end) 这段文字在画布上的位置；line 是所在的行号 */
export interface TextPiece {
  start: number;
  end: number;
  x: number;
  w: number;
  baseline: number;
  size: number;
  line: number;
}

export interface PageTextBlock {
  key: string;
  text: string;
  pieces: TextPiece[];
  /** 画的是译文（否则是保留的原文字形） */
  translated: boolean;
}

/** 文字层的一行：显示文本里 [start, end) 这段（含行末被断行丢掉的空格），以及它在画布上的范围 */
export interface TextLine {
  start: number;
  end: number;
  x0: number;
  x1: number;
  baseline: number;
  size: number;
}

export interface TextRect {
  x: number;
  y: number;
  w: number;
  h: number;
  baseline: number;
  size: number;
}

const CJK = /[⺀-鿿豈-﫿＀-￯　-〿]/;

/** 块在本页的标识：原文 + 同一页里第几次出现（重复的页眉、表格里相同的格子也能区分） */
export function blockKeys(blocks: { text: string }[]): string[] {
  const seen = new Map<string, number>();
  return blocks.map((b) => {
    const n = seen.get(b.text) ?? 0;
    seen.set(b.text, n + 1);
    return `${b.text}#${n}`;
  });
}

/**
 * 保留原文的块（人名、公式、未翻译的段落）：各行文本项按位置拼接。
 * 同一行里隔开的项之间、换行处补一个空格；行末连字符、中文两侧不补。dy 是公式区域整体平移的距离。
 */
export function keptBlockText(block: PdfBlock, key: string, dy = 0): PageTextBlock {
  let text = '';
  const pieces: TextPiece[] = [];
  block.lines.forEach((line, li) => {
    let prev: { x1: number; size: number } | undefined;
    for (const it of [...line.items].sort((a, b) => a.x - b.x)) {
      if (it.rotated || it.str === '') continue;
      const joined = text === '' || /\s$/.test(text) || /^\s/.test(it.str);
      const sameLine = prev !== undefined;
      const gap = sameLine ? it.x - prev!.x1 > Math.min(prev!.size, it.size) * 0.15 : true;
      const cjkEdge = CJK.test(text.at(-1) ?? '') || CJK.test(it.str[0]!);
      if (!joined && gap && !cjkEdge && !(!sameLine && text.endsWith('-'))) text += ' ';
      pieces.push({ start: text.length, end: text.length + it.str.length, x: it.x, w: it.w, baseline: it.y + dy, size: it.size, line: li });
      text += it.str;
      prev = { x1: it.x + it.w, size: it.size };
    }
  });
  return { key, text, pieces, translated: false };
}

/** 按行分组：每行取最大的字号和它的基线（上下标不改变行的位置） */
export function textLines(block: PageTextBlock): TextLine[] {
  const byLine = new Map<number, TextPiece[]>();
  for (const p of block.pieces) {
    let list = byLine.get(p.line);
    if (!list) byLine.set(p.line, (list = []));
    list.push(p);
  }
  const groups = [...byLine.entries()].sort((a, b) => a[0] - b[0]).map(([, ps]) => ps);
  return groups.map((ps, i) => {
    const main = ps.reduce((a, b) => (b.size > a.size ? b : a));
    return {
      start: i === 0 ? 0 : Math.min(...ps.map((p) => p.start)),
      end: i + 1 < groups.length ? Math.min(...groups[i + 1]!.map((p) => p.start)) : block.text.length,
      x0: Math.min(...ps.map((p) => p.x)),
      x1: Math.max(...ps.map((p) => p.x + p.w)),
      baseline: main.baseline,
      size: main.size,
    };
  });
}

/**
 * 显示文本 [start, end) 在画布上覆盖的矩形，每行合并成一个。
 * 一段文字内部按字数线性插值（中文逐字一段，英文一词一段，误差只在词内）。
 */
export function rangeRects(block: PageTextBlock, start: number, end: number): TextRect[] {
  const lines = new Map<number, { x0: number; x1: number; baseline: number; size: number }>();
  for (const p of block.pieces) {
    const a = Math.max(start, p.start);
    const b = Math.min(end, p.end);
    if (a >= b) continue;
    const len = p.end - p.start;
    const x0 = p.x + (p.w * (a - p.start)) / len;
    const x1 = p.x + (p.w * (b - p.start)) / len;
    const cur = lines.get(p.line);
    if (!cur) lines.set(p.line, { x0, x1, baseline: p.baseline, size: p.size });
    else {
      cur.x0 = Math.min(cur.x0, x0);
      cur.x1 = Math.max(cur.x1, x1);
      if (p.size > cur.size) Object.assign(cur, { baseline: p.baseline, size: p.size });
    }
  }
  return [...lines.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, l]) => ({ x: l.x0, y: l.baseline - l.size * 0.92, w: l.x1 - l.x0, h: l.size * 1.18, baseline: l.baseline, size: l.size }));
}
