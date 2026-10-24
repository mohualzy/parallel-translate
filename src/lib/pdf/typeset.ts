/**
 * PDF 译文排版：把译文（含 <xN/> 原子）断行、选字号；同一栏相邻的段落连成串依次排布，装进原来的区域。
 * 测量文字和原子宽度的函数由调用方注入（canvas measureText），这里只做纯计算，便于单测。
 */

/** mark：所在的 <gN> 行内样式片段编号（粗体 / 斜体），没有则按段落样式 */
export type Token = { kind: 'text'; text: string; mark?: number } | { kind: 'atom'; index: number } | { kind: 'space'; mark?: number };

const CJK = '\\u2E80-\\u9FFF\\uF900-\\uFAFF\\uFF00-\\uFFEF\\u3000-\\u303F';
/**
 * 原子占位 | 样式标签 | 单个中日文字符或全角标点 | 破折号（——，整体不拆）| 一段连续的非空白、非中文（英文单词、数字、半角标点），
 * 遇到斜杠可以断开（A/B/C 这类很长的并列名称不至于整串挪到下一行）| 空白
 */
const TOKEN = new RegExp(`<x(\\d+)\\s*\\/>|<(\\/?)g(\\d+)>|[${CJK}]|—+|[^\\s<${CJK}—/]+\\/?|\\/|<|\\s+`, 'g');
/** 汉字、假名（不含全角标点）：和英文、数字、公式相邻时中间留一点空 */
const IDEOGRAPH = /^[぀-ヿ㐀-䶿一-鿿豈-﫿]$/;
const LATIN_EDGE = /^[A-Za-z0-9]|[A-Za-z0-9]$/;

/** 不能放在行首的标点（避头） */
const NO_LINE_START = /^[，。、；：！？）」』》〉】”’…,.;:!?)\]}%]/;
/** 不能放在行尾的标点（避尾） */
const NO_LINE_END = /^[（「『《〈【“‘([{]$/;

const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** 汉字与英文 / 数字 / 公式紧挨着时补一个空格（中文排版的「中西文间距」），全角标点旁不补 */
function autospace(tokens: Token[]): Token[] {
  const out: Token[] = [];
  const cjk = (t: Token | undefined) => t?.kind === 'text' && IDEOGRAPH.test(t.text);
  const western = (t: Token | undefined, edge: 'start' | 'end') =>
    t?.kind === 'atom' || (t?.kind === 'text' && !IDEOGRAPH.test(t.text) && LATIN_EDGE.test(edge === 'start' ? t.text[0]! : t.text.at(-1)!));
  for (const t of tokens) {
    const prev = out.at(-1);
    if ((cjk(prev) && western(t, 'start')) || (western(prev, 'end') && cjk(t))) {
      out.push({ kind: 'space', mark: t.kind === 'atom' ? undefined : t.mark });
    }
    out.push(t);
  }
  return out;
}

/**
 * 译文 → token：中文逐字、英文按词、原子按编号，<gN> 内的 token 标上样式编号。
 * 只认存在的原子、样式编号，模型编出来的多余编号丢弃。
 */
export function tokenize(translation: string, atomCount: number, markCount = 0): Token[] {
  const tokens: Token[] = [];
  let mark: number | undefined;
  for (const m of unescape(translation.replace(/&lt;(\/?[xg]\d+\s*\/?)&gt;/g, '<$1>')).matchAll(TOKEN)) {
    if (m[1] !== undefined) {
      const index = Number(m[1]);
      if (index < atomCount) tokens.push({ kind: 'atom', index });
    } else if (m[3] !== undefined) {
      const index = Number(m[3]);
      if (m[2] === '/') mark = undefined;
      else if (index < markCount) mark = index;
    } else if (/^\s+$/.test(m[0])) {
      // 丢掉多余原子后两侧的空白会相邻，合并成一个
      if (tokens.at(-1)?.kind !== 'space') tokens.push({ kind: 'space', mark });
    } else tokens.push({ kind: 'text', text: m[0], mark });
  }
  return autospace(tokens);
}

export interface Measure {
  /** 文字在给定字号下的宽度；mark 为行内样式片段编号 */
  text(text: string, size: number, mark?: number): number;
  /** 原子按比例缩放后的宽度 */
  atom(index: number, scale: number): number;
}

/** token 的宽度：断行和绘制共用，两边算出来的位置才一致 */
export function tokenWidth(t: Token, size: number, scale: number, measure: Measure): number {
  if (t.kind === 'atom') return measure.atom(t.index, scale);
  return measure.text(t.kind === 'space' ? ' ' : t.text, size, t.mark);
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
  const widthOf = (t: Token) => tokenWidth(t, size, scale, measure);
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

/** 一串译文块；slots[k] 是第 k−1 块和第 k 块之间整体平移的区域（行间公式等），没有则为 undefined */
export interface Run {
  blocks: number[];
  slots: (FlowBox | undefined)[];
  /** 串尾下方紧跟着的公式区域（栏底的行间公式）：跟着最后一块平移 */
  tail?: FlowBox;
}

/** 判断页面区域的回调（看不含文字的底图），由绘制方提供；纯计算部分不碰像素 */
export interface Regions {
  /** 区域四周是纯色底，可以整体平移 */
  slotOk?: (slot: FlowBox) => boolean;
  /** 区域内全是纯色底，什么都没有 */
  blank?: (gap: FlowBox) => boolean;
}

/** 整体平移的区域：原位置和移动量 */
export interface Move extends FlowBox {
  dy: number;
}

/**
 * 把译文块连成「串」：同一栏里上下相邻的块。串内译文依次往下排，段距保持原文的段距，省下来的空间留在串的末尾，
 * 而不是散落在各段之间。
 * 两块之间只隔着保持原样的块（行间公式、公式编号、栏内的图）时，这段区域作为一个整体跟着上一块平移（D54），
 * 文字和公式的间距保持原样；slotOk 检查区域四周是纯色底（没有图片跨过边界），不满足就不连。
 * 直接相连的两块之间若空隙较大，blank 检查空隙里什么都没有（没有分隔线、图片）。
 * 中间什么都没有、却隔着大段空白的（脚注上方）不连，脚注留在页底。
 */
export function chainBlocks(
  blocks: FlowBox[],
  obstacles: FlowBox[],
  slotOk: (slot: FlowBox) => boolean = () => true,
  blank: (gap: FlowBox) => boolean = () => true,
): Run[] {
  const pred = blocks.map((b): { p: number; slot?: FlowBox } | undefined => {
    if (b.fixed) return undefined;
    const s = b.size;
    const overlapsX = (c: FlowBox, x0 = b.x0, x1 = b.x1) => Math.min(c.x1, x1) - Math.max(c.x0, x0) > s * 0.2;
    const above = blocks
      .map((box, i) => ({ box, i }))
      .filter(({ box: c }) => c !== b && overlapsX(c) && c.top < b.top && c.bottom <= b.top + s * 0.5);
    const p = above.sort((u, v) => v.box.bottom - u.box.bottom)[0];
    if (!p || p.box.fixed) return undefined;
    // 上方并排着别的块（两栏之上的通栏块）：不知道该接哪一栏，不连。
    // 并排要看上下重叠得多不多：相邻两段的框本来就会重叠零点几个字号（上一段的字底低于下一段的字顶）
    const sideBySide = (c: FlowBox) => Math.min(c.bottom, p.box.bottom) - Math.max(c.top, p.box.top) > s * 0.5;
    if (above.some((c) => c !== p && sideBySide(c.box))) return undefined;
    const x0 = Math.min(p.box.x0, b.x0);
    const x1 = Math.max(p.box.x1, b.x1);
    const between = obstacles.filter((o) => overlapsX(o, x0, x1) && o.top < b.top && o.bottom > p.box.bottom);
    if (between.length === 0) {
      // 中间隔着大段空白，或空隙里有线条、图片（脚注上方的分隔线）：脚注留在页底，不跟着上移
      const gap = b.top - p.box.bottom;
      if (gap > Math.max(s, p.box.size) * 3) return undefined;
      if (gap > s * 0.5 && !blank({ x0, x1, top: p.box.bottom, bottom: b.top, size: s })) return undefined;
      return { p: p.i };
    }
    // 中间的东西要完整落在两块之间、不伸进别的栏
    const contained = between.every((o) => o.top >= p.box.bottom - s * 0.5 && o.bottom <= b.top + s * 0.5 && o.x0 >= x0 - s * 2 && o.x1 <= x1 + s * 2);
    if (!contained) return undefined;
    const slot = {
      x0: Math.min(x0, ...between.map((o) => o.x0)),
      x1: Math.max(x1, ...between.map((o) => o.x1)),
      top: p.box.bottom,
      bottom: b.top,
      size: s,
    };
    return slotOk(slot) ? { p: p.i, slot } : undefined;
  });
  // 一个块只接一个后继：通栏块下面的两栏各自独立
  const successors = new Map<number, number>();
  for (const link of pred) if (link) successors.set(link.p, (successors.get(link.p) ?? 0) + 1);
  const next = new Map<number, number>();
  pred.forEach((link, i) => {
    if (link && successors.get(link.p) === 1) next.set(link.p, i);
  });
  const linked = new Set(next.values());
  const runs: Run[] = [];
  blocks.forEach((_, i) => {
    if (linked.has(i)) return;
    const run: Run = { blocks: [i], slots: [undefined] };
    for (let j = next.get(i); j !== undefined; j = next.get(j)) {
      run.blocks.push(j);
      run.slots.push(pred[j]!.slot);
    }
    run.tail = tailSlot(blocks, obstacles, run.blocks.at(-1)!, slotOk);
    runs.push(run);
  });
  return runs;
}

/**
 * 串尾的公式区域：最后一块下方紧接着（3 个字号内，逐个相接）的保留块，直到碰到下一个译文块为止。
 * 栏底的行间公式没有下一段可以接，不带上它就会停在原位，和上移的译文之间空出一大截。
 */
function tailSlot(blocks: FlowBox[], obstacles: FlowBox[], last: number, slotOk: (slot: FlowBox) => boolean): FlowBox | undefined {
  const l = blocks[last]!;
  if (l.fixed) return undefined;
  const s = l.size;
  const overlapsX = (c: FlowBox) => Math.min(c.x1, l.x1) - Math.max(c.x0, l.x0) > s * 0.2;
  const nextText = Math.min(...blocks.filter((c) => c !== l && overlapsX(c) && c.top >= l.bottom - s * 0.5).map((c) => c.top));
  let end = l.bottom;
  const cluster: FlowBox[] = [];
  for (const o of obstacles.filter((o) => overlapsX(o) && o.top >= l.bottom - s * 0.5).sort((a, b) => a.top - b.top)) {
    if (o.top > end + s * 3 || o.bottom > nextText) break;
    cluster.push(o);
    end = Math.max(end, o.bottom);
  }
  if (cluster.length === 0 || !cluster.every((o) => o.x0 >= l.x0 - s * 2 && o.x1 <= l.x1 + s * 2)) return undefined;
  const slot = { x0: Math.min(l.x0, ...cluster.map((o) => o.x0)), x1: Math.max(l.x1, ...cluster.map((o) => o.x1)), top: l.bottom, bottom: end + s * 0.2, size: s };
  return slotOk(slot) ? slot : undefined;
}

/** 字顶到末行字底的高度，与 PdfBlock 的 top / bottom 口径一致 */
const heightOf = (lines: number, size: number, lineHeight: number) => (lines === 0 ? 0 : size * (1 + (lines - 1) * lineHeight + 0.3));

/**
 * 整页译文排版：按串排布，每串选一个统一的缩放，从原字号往下试，直到整串装进原来的高度；
 * 同一页多行正文的串再取同一个缩放，避免各段字号忽大忽小。
 */
export function flowLayout(
  blocks: FlowBlock[],
  obstacles: FlowBox[],
  opts: FlowOptions = {},
  regions: Regions = {},
): { placements: Placement[]; moves: Move[] } {
  const lineHeight = opts.lineHeight ?? 1.32;
  const minScale = opts.minScale ?? 0.6;
  const pageMinScale = opts.pageMinScale ?? 0.8;

  const place = (run: Run, scale: number) => {
    const placed: Placement[] = [];
    const moves: Move[] = [];
    let cursor = 0;
    run.blocks.forEach((i, k) => {
      const b = blocks[i]!;
      const size = b.size * scale;
      const indent = { first: b.indentEm.first * size, rest: b.indentEm.rest * size };
      const lines = breakLines(b.tokens, b.x1 - b.x0, size, scale, b.measure, indent);
      let top = b.top;
      const slot = run.slots[k];
      if (slot) {
        // 中间的公式区域整体接在上一块后面，和上下两块的间距保持原样
        moves.push({ ...slot, dy: cursor - slot.top });
        top = cursor + (b.top - slot.top);
      } else if (k > 0) {
        // 段距：原文两段之间超出正常行距（约 1.2 倍字号）的部分，按同样比例缩放
        const prev = blocks[run.blocks[k - 1]!]!;
        const extra = Math.max(0, b.top - prev.bottom + 0.1 * b.size) * scale;
        top = cursor + (lineHeight - 1.3) * size + extra;
      }
      placed.push({ top, size, lines, indent });
      cursor = top + heightOf(lines.length, size, lineHeight);
    });
    if (run.tail) {
      moves.push({ ...run.tail, dy: cursor - run.tail.top });
      cursor += run.tail.bottom - run.tail.top;
    }
    return { placed, moves, end: cursor };
  };

  const steps = Math.round((1 - minScale) / 0.025);
  const fitted = chainBlocks(blocks, obstacles, regions.slotOk, regions.blank).map((run) => {
    const last = blocks[run.blocks.at(-1)!]!;
    const limit = run.tail ? run.tail.bottom : last.bottom + last.size * 0.3;
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
  const placements: Placement[] = new Array(blocks.length);
  const moves: Move[] = [];
  for (const f of fitted) {
    const final = f.scale > pageScale ? place(f.run, pageScale) : f;
    f.run.blocks.forEach((i, k) => (placements[i] = final.placed[k]!));
    moves.push(...final.moves.filter((m) => Math.abs(m.dy) > 0.5));
  }
  return { placements, moves };
}
