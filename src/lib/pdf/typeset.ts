/**
 * PDF 译文排版：把译文（含 <xN/> 原子）断行、选字号，装进原段落的方框。
 * 测量文字和原子宽度的函数由调用方注入（canvas measureText），这里只做纯计算，便于单测。
 */

export type Token = { kind: 'text'; text: string } | { kind: 'atom'; index: number } | { kind: 'space' };

const CJK = '\\u2E80-\\u9FFF\\uF900-\\uFAFF\\uFF00-\\uFFEF\\u3000-\\u303F';
/** 原子占位 | 单个中日文字符或全角标点 | 一段连续的非空白、非中文（英文单词、数字、半角标点） | 空白 */
const TOKEN = new RegExp(`<x(\\d+)\\s*\\/>|[${CJK}]|[^\\s<${CJK}]+|<|\\s+`, 'g');

/** 不能放在行首的标点（避头） */
const NO_LINE_START = /^[，。、；：！？）」』》〉】”’…,.;:!?)\]}%]/;
/** 不能放在行尾的标点（避尾） */
const NO_LINE_END = /^[（「『《〈【“‘([{]$/;

const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** 译文 → token：中文逐字、英文按词、原子按编号；只认存在的原子编号，模型编出来的多余编号丢弃 */
export function tokenize(translation: string, atomCount: number): Token[] {
  const tokens: Token[] = [];
  for (const m of unescape(translation.replace(/&lt;(\/?x\d+\s*\/?)&gt;/g, '<$1>')).matchAll(TOKEN)) {
    if (m[1] !== undefined) {
      const index = Number(m[1]);
      if (index < atomCount) tokens.push({ kind: 'atom', index });
    } else if (/^\s+$/.test(m[0])) {
      // 丢掉多余原子后两侧的空白会相邻，合并成一个
      if (tokens.at(-1)?.kind !== 'space') tokens.push({ kind: 'space' });
    } else tokens.push({ kind: 'text', text: m[0] });
  }
  return tokens;
}

export interface Measure {
  /** 文字在给定字号下的宽度 */
  text(text: string, size: number): number;
  /** 原子按比例缩放后的宽度 */
  atom(index: number, scale: number): number;
}

/** 按宽度断行：空白不放行首；避头的标点留在上一行（允许略微超出），避尾的开括号随下一个字移到新行 */
export function breakLines(tokens: Token[], width: number, size: number, scale: number, measure: Measure): Token[][] {
  const lines: Token[][] = [[]];
  let used = 0;
  const widthOf = (t: Token) =>
    t.kind === 'atom' ? measure.atom(t.index, scale) : t.kind === 'space' ? measure.text(' ', size) : measure.text(t.text, size);
  for (const t of tokens) {
    const line = lines.at(-1)!;
    if (t.kind === 'space') {
      if (line.length > 0 && line.at(-1)!.kind !== 'space') {
        line.push(t);
        used += widthOf(t);
      }
      continue;
    }
    const w = widthOf(t);
    const fits = used + w <= width || line.length === 0;
    const mustStay = t.kind === 'text' && NO_LINE_START.test(t.text);
    if (fits || mustStay) {
      line.push(t);
      used += w;
      continue;
    }
    // 换行：去掉行尾空白；行尾的开括号带到新行
    while (line.at(-1)?.kind === 'space') line.pop();
    const carried: Token[] = [];
    const tail = line.at(-1);
    if (tail?.kind === 'text' && NO_LINE_END.test(tail.text) && line.length > 1) carried.push(line.pop()!);
    lines.push([...carried, t]);
    used = carried.reduce((n, c) => n + widthOf(c), 0) + w;
  }
  for (const line of lines) while (line.at(-1)?.kind === 'space') line.pop();
  return lines.filter((l) => l.length > 0);
}

export interface FitOptions {
  width: number;
  height: number;
  /** 原文字号 */
  size: number;
  /** 最小缩到原字号的多少 */
  minScale?: number;
  /** 行高（字号的倍数） */
  lineHeight?: number;
}

/** 从原字号往下试，直到行数 × 行高装进原块高度；装不下就用最小字号（允许溢出） */
export function fitBlock(tokens: Token[], opts: FitOptions, measure: Measure): { size: number; lines: Token[][] } {
  const lineHeight = opts.lineHeight ?? 1.32;
  const min = opts.size * (opts.minScale ?? 0.6);
  let size = opts.size;
  let lines = breakLines(tokens, opts.width, size, 1, measure);
  for (; size >= min; size -= opts.size * 0.025) {
    lines = breakLines(tokens, opts.width, size, size / opts.size, measure);
    // 多留 0.4 行的余量：原块高度按字顶到字底算，末行不需要完整行距
    if (lines.length * size * lineHeight <= opts.height + size * 0.4) return { size, lines };
  }
  size = min;
  return { size, lines: breakLines(tokens, opts.width, size, size / opts.size, measure) };
}
