/**
 * PDF 译文排版：把译文（含 <xN/> 原子）断行、选字号；同一栏相邻的段落连成串依次排布，装进原来的区域。
 * 测量文字和原子宽度的函数由调用方注入（canvas measureText），这里只做纯计算，便于单测。
 */

export type Token = { kind: 'text'; text: string } | { kind: 'atom'; index: number } | { kind: 'space' };

const CJK = '\\u2E80-\\u9FFF\\uF900-\\uFAFF\\uFF00-\\uFFEF\\u3000-\\u303F';
/**
 * 原子占位 | 单个中日文字符或全角标点 | 破折号（——，整体不拆）| 一段连续的非空白、非中文（英文单词、数字、半角标点），
 * 遇到斜杠可以断开（A/B/C 这类很长的并列名称不至于整串挪到下一行）| 空白
 */
const TOKEN = new RegExp(`<x(\\d+)\\s*\\/>|[${CJK}]|—+|[^\\s<${CJK}—/]+\\/?|\\/|<|\\s+`, 'g');

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

/** 行首缩进（像素）：首行（段首缩进）与其余行（悬挂缩进） */
export interface Indent {
  first: number;
  rest: number;
}

/** 按宽度断行：空白不放行首；避头的标点留在上一行（允许略微超出），避尾的开括号随下一个字移到新行 */
export function breakLines(
  tokens: Token[],
  width: number,
  size: number,
  scale: number,
  measure: Measure,
  indent: Indent = { first: 0, rest: 0 },
): Token[][] {
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
    const fits = used + w <= width - (lines.length === 1 ? indent.first : indent.rest) || line.length === 0;
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

/** 版面上的一个矩形块（视口坐标；top 为首行字顶，bottom 为末行字底） */
export interface FlowBox {
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  /** 原文字号 */
  size: number;
  /** 不和上下的块连成串（表格单元格） */
  fixed?: boolean;
}

/** 要写译文的块 */
export interface FlowBlock extends FlowBox {
  tokens: Token[];
  measure: Measure;
  /** 首行 / 其余行的缩进，以译文字号为单位（2 = 两个汉字） */
  indentEm: Indent;
}

/** 译文块的排版结果 */
export interface Placement {
  /** 新的字顶位置 */
  top: number;
  size: number;
  lines: Token[][];
  indent: Indent;
}

export interface FlowOptions {
  /** 行高（字号的倍数） */
  lineHeight?: number;
  /** 最小缩到原字号的多少 */
  minScale?: number;
  /** 同一页正文统一字号时，最多缩到多少（再小的只缩它自己那一串） */
  pageMinScale?: number;
}

/**
 * 把译文块连成「串」：同一栏里上下相邻、中间没有别的东西（公式、图片、保留原文的块）的块。
 * 串内译文依次往下排，段距保持原文的段距，省下来的空间留在串的末尾，而不是散落在各段之间。
 * obstacles 是保持原样的块，只用来截断串。
 */
export function chainBlocks(blocks: FlowBox[], obstacles: FlowBox[]): number[][] {
  const boxes = [...blocks.map((box, i) => ({ box, i })), ...obstacles.map((box) => ({ box, i: -1 }))];
  const pred = blocks.map((b) => {
    if (b.fixed) return -1;
    const s = b.size;
    const above = boxes.filter(
      ({ box: c }) => c !== b && Math.min(c.x1, b.x1) - Math.max(c.x0, b.x0) > s * 0.2 && c.top < b.top && c.bottom <= b.top + s * 0.5,
    );
    const p = above.sort((u, v) => v.box.bottom - u.box.bottom)[0];
    if (!p || p.i < 0 || p.box.fixed) return -1;
    // 上方并排着别的块（两栏之上的通栏块）：不知道该接哪一栏，不连
    if (above.some((c) => c !== p && c.box.bottom > p.box.top + s * 0.2)) return -1;
    // 中间隔着大段空白，多半是图片
    if (b.top - p.box.bottom > Math.max(s, p.box.size) * 3) return -1;
    return p.i;
  });
  // 一个块只接一个后继：通栏块下面的两栏各自独立
  const successors = new Map<number, number>();
  for (const p of pred) if (p >= 0) successors.set(p, (successors.get(p) ?? 0) + 1);
  const next = new Map<number, number>();
  pred.forEach((p, i) => {
    if (p >= 0 && successors.get(p) === 1) next.set(p, i);
  });
  const linked = new Set(next.values());
  const runs: number[][] = [];
  blocks.forEach((_, i) => {
    if (linked.has(i)) return;
    const run = [i];
    for (let j = next.get(i); j !== undefined; j = next.get(j)) run.push(j);
    runs.push(run);
  });
  return runs;
}

/** 字顶到末行字底的高度，与 PdfBlock 的 top / bottom 口径一致 */
const heightOf = (lines: number, size: number, lineHeight: number) => (lines === 0 ? 0 : size * (1 + (lines - 1) * lineHeight + 0.3));

/**
 * 整页译文排版：按串排布，每串选一个统一的缩放，从原字号往下试，直到整串装进原来的高度；
 * 同一页多行正文的串再取同一个缩放，避免各段字号忽大忽小。
 */
export function flowLayout(blocks: FlowBlock[], obstacles: FlowBox[], opts: FlowOptions = {}): Placement[] {
  const lineHeight = opts.lineHeight ?? 1.32;
  const minScale = opts.minScale ?? 0.6;
  const pageMinScale = opts.pageMinScale ?? 0.8;

  const place = (run: number[], scale: number) => {
    const placed: Placement[] = [];
    let cursor = 0;
    run.forEach((i, k) => {
      const b = blocks[i]!;
      const size = b.size * scale;
      const indent = { first: b.indentEm.first * size, rest: b.indentEm.rest * size };
      const lines = breakLines(b.tokens, b.x1 - b.x0, size, scale, b.measure, indent);
      let top = b.top;
      if (k > 0) {
        // 段距：原文两段之间超出正常行距（约 1.2 倍字号）的部分，按同样比例缩放
        const prev = blocks[run[k - 1]!]!;
        const extra = Math.max(0, b.top - prev.bottom + 0.1 * b.size) * scale;
        top = cursor + (lineHeight - 1.3) * size + extra;
      }
      placed.push({ top, size, lines, indent });
      cursor = top + heightOf(lines.length, size, lineHeight);
    });
    return { placed, end: cursor };
  };

  const steps = Math.round((1 - minScale) / 0.025);
  const fitted = chainBlocks(blocks, obstacles).map((run) => {
    const last = blocks[run.at(-1)!]!;
    const limit = last.bottom + last.size * 0.3;
    for (let k = 0; k <= steps; k++) {
      const scale = 1 - k * 0.025;
      const result = place(run, scale);
      if (result.end <= limit || k === steps) return { run, scale, ...result };
    }
    throw new Error('unreachable');
  });

  // 多行正文的串取同一个缩放；单行的标题、图注标签不参与，免得一个挤的标签拖小整页
  const body = fitted.filter((f) => f.placed.reduce((n, p) => n + p.lines.length, 0) >= 3);
  const pageScale = Math.max(pageMinScale, Math.min(1, ...body.map((f) => f.scale)));
  const out: Placement[] = new Array(blocks.length);
  for (const f of fitted) {
    const placed = f.scale > pageScale ? place(f.run, pageScale).placed : f.placed;
    f.run.forEach((i, k) => (out[i] = placed[k]!));
  }
  return out;
}
