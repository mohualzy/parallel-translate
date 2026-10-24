import { sameFont } from '@/lib/pdf/color';
import { cjkStack } from '@/lib/pdf/fonts';
import type { HighlightStyle } from '@/lib/pdf/highlights';
import { BOLD_FONT, ITALIC_FONT, SANS_FONT, type PdfBlock, type PdfTextItem } from '@/lib/pdf/layout';
import { blockKeys, keptBlockText, rangeRects, type PageTextBlock, type TextPiece } from '@/lib/pdf/page-text';
import { flowLayout, tokenize, tokenWidth, type FlowBox, type Measure, type Move, type Placement, type Token } from '@/lib/pdf/typeset';
import type { Glyph } from './page-render';

/** 译文的行高（字号的倍数） */
const LINE_HEIGHT = 1.32;
/** PDF 子集字体缺字时，译文里的英文改用的系统字体 */
const LATIN_SERIF = '"Times New Roman",Times,"Nimbus Roman","Liberation Serif"';
const LATIN_SANS = 'Arial,Helvetica,"Liberation Sans"';
const CJK_CHAR = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/;

/** 各 PDF 字体（pdf.js 注册的字体名）实际画过的字符：PDF 内嵌的多是子集字体，只含原文用到的字 */
export type FontCoverage = Map<string, Set<string>>;

/**
 * 文本项对应的字形：同一字体、同一基线、起点落在该项的水平范围内。
 * 按区域取会把旁边的正文带进来；终点不含，否则会带上紧挨着的下一项的首字。
 */
function glyphsOf(item: PdfTextItem, glyphs: Glyph[]): Glyph[] {
  return glyphs.filter((g) => sameFont(item, g) && Math.abs(g.y - item.y) < item.size * 0.25 && g.x >= item.x - 0.5 && g.x < item.x + item.w - 0.5);
}

/** 字体串里的字体族：去掉样式、字重、字号 */
const familyOf = (font: string) => font.replace(/^.*?\d+(\.\d+)?px\s+/, '');
/** pdf.js 注册的原文字体名（去掉末尾的通用字体族） */
const ownFamily = (font: string) => familyOf(font).replace(/,\s*(serif|sans-serif|monospace)\s*$/, '').trim();

const isRotated = (g: Glyph) => g.m[1] !== 0 || g.m[2] !== 0;

function mode<T>(values: T[]): T | undefined {
  const count = new Map<T, number>();
  for (const v of values) count.set(v, (count.get(v) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** 2D 仿射矩阵相乘：先 m 后 p */
function multiply(p: number[], m: number[]): [number, number, number, number, number, number] {
  return [
    p[0]! * m[0]! + p[2]! * m[1]!,
    p[1]! * m[0]! + p[3]! * m[1]!,
    p[0]! * m[2]! + p[2]! * m[3]!,
    p[1]! * m[2]! + p[3]! * m[3]!,
    p[0]! * m[4]! + p[2]! * m[5]! + p[4]!,
    p[1]! * m[4]! + p[3]! * m[5]! + p[5]!,
  ];
}

/** 按原样画回一个字形；pre 用于把公式原子平移缩放到新位置 */
function drawGlyph(ctx: CanvasRenderingContext2D, g: Glyph, pre = [1, 0, 0, 1, 0, 0]) {
  ctx.save();
  ctx.setTransform(...multiply(pre, g.m));
  ctx.fillStyle = g.fill;
  ctx.font = g.font;
  ctx.fillText(g.text, g.rawX, g.rawY);
  ctx.restore();
}

/**
 * 块的样式：原文的颜色、字重、斜体、字体（拉丁字母先用 PDF 自己的字体，中文回退到系统字体）。
 * 衬线 / 无衬线、粗体按原字体名判断：pdf.js 按字体标志给的值不可靠，TeX 生成的 PDF 常把 Times 标成无衬线、
 * 认不出 NimbusRomNo9L-Medi 是粗体。
 */
function blockStyle(glyphs: Glyph[], fontName: string) {
  const font = mode(glyphs.map((g) => g.font)) ?? '';
  return {
    fill: mode(glyphs.map((g) => g.fill)) ?? '#000',
    bold: glyphs.filter((g) => /\b(bold|[6-9]00)\b/.test(g.font)).length > glyphs.length / 2 || BOLD_FONT.test(fontName),
    italic: /\bitalic\b/.test(font) || ITALIC_FONT.test(fontName),
    sans: SANS_FONT.test(fontName),
    own: ownFamily(font),
  };
}

/** 矩形四周（向外扩 pad）的颜色：均匀（纯色底）时返回该颜色，压在图片、线条上则返回 undefined */
function borderColor(ctx: CanvasRenderingContext2D, x0: number, top: number, x1: number, bottom: number, pad = 2) {
  const left = Math.max(0, Math.floor(x0 - pad));
  const right = Math.min(ctx.canvas.width - 1, Math.ceil(x1 + pad));
  const upper = Math.max(0, Math.floor(top - pad));
  const lower = Math.min(ctx.canvas.height - 1, Math.ceil(bottom + pad));
  if (right <= left || lower <= upper) return undefined;
  const strips = [
    ctx.getImageData(left, upper, right - left, 1),
    ctx.getImageData(left, lower, right - left, 1),
    ctx.getImageData(left, upper, 1, lower - upper),
    ctx.getImageData(right, upper, 1, lower - upper),
  ];
  const samples: number[][] = [];
  for (const s of strips) for (let i = 0; i < s.data.length; i += 4) samples.push([s.data[i]!, s.data[i + 1]!, s.data[i + 2]!]);
  const mean = [0, 1, 2].map((c) => samples.reduce((n, p) => n + p[c]!, 0) / samples.length);
  const uniform = samples.every((p) => p.every((v, c) => Math.abs(v - mean[c]!) < 14));
  return uniform ? { color: `rgb(${mean.map(Math.round).join(',')})`, left, upper, right, lower } : undefined;
}

/** 区域内是否全是同一种颜色（纯色底，没有线条、图片） */
function isBlank(ctx: CanvasRenderingContext2D, x0: number, top: number, x1: number, bottom: number): boolean {
  const left = Math.max(0, Math.floor(x0));
  const upper = Math.max(0, Math.floor(top));
  const w = Math.min(ctx.canvas.width, Math.ceil(x1)) - left;
  const h = Math.min(ctx.canvas.height, Math.ceil(bottom)) - upper;
  if (w <= 0 || h <= 0) return true;
  const d = ctx.getImageData(left, upper, w, h).data;
  for (let i = 4; i < d.length; i += 4) {
    if (Math.abs(d[i]! - d[0]!) > 14 || Math.abs(d[i + 1]! - d[1]!) > 14 || Math.abs(d[i + 2]! - d[2]!) > 14) return false;
  }
  return true;
}

/**
 * 块区域四周颜色均匀时，用该颜色清空区域，带走分数线、根号上横线等跟着公式移走的矢量线；压在图片上则不清。
 * 像素一律从底图 bg 读（内存画布）：译文画布在 GPU 上，反复读回很慢。
 */
function clearBlock(ctx: CanvasRenderingContext2D, bg: CanvasRenderingContext2D, x0: number, top: number, x1: number, bottom: number) {
  const border = borderColor(bg, x0, top, x1, bottom);
  if (!border) return;
  ctx.fillStyle = border.color;
  ctx.fillRect(border.left, border.upper, border.right - border.left, border.lower - border.upper);
}

const normalize = (s: string) =>
  s
    .replace(/<x\d+\s*\/>|<\/?g\d+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/** 译文与原文相同（人名、机构名、模型原样返回）：保留原字形，不重画 */
export function isUnchanged(block: PdfBlock, translation: string): boolean {
  return normalize(translation) === normalize(block.text);
}

/** 一个要写译文的块：原文字形、原子字形、样式、token 与测量函数 */
interface Job {
  block: PdfBlock;
  /** 显示文本（token 依次拼接，原子用原文字符）与每个 token 在其中的区间 */
  text: string;
  offsets: Map<Token, [number, number]>;
  own: Set<Glyph>;
  atomGlyphs: Glyph[][];
  atomBox: { x0: number; width: number }[];
  tokens: Token[];
  measure: Measure;
  /** mark：行内样式片段（<gN>）编号 */
  fontFor(text: string, size: number, mark?: number): string;
  fill: string;
}

function makeJob(block: PdfBlock, translation: string, plain: Glyph[], coverage: FontCoverage, cjkFont: string): Job {
  const items = block.lines.flatMap((l) => l.items);
  const own = new Set(items.flatMap((i) => glyphsOf(i, plain)));
  // 空白字形不算进原子：带前导空格的文本项会把原子的左边界拉远，写回时多出一段空
  const atomGlyphs = block.atoms.map((a) => [...new Set(a.items.flatMap((i) => glyphsOf(i, plain)))].filter((g) => g.text.trim() !== ''));
  const atomSet = new Set(atomGlyphs.flat());
  // 正文的原字体名：按字数取众数，不含原子
  const atomItems = new Set(block.atoms.flatMap((a) => a.items));
  const fontChars = new Map<string, number>();
  for (const i of items) if (!atomItems.has(i)) fontChars.set(i.font, (fontChars.get(i.font) ?? 0) + i.str.trim().length);
  const fontName = [...fontChars].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  const style = blockStyle([...own].filter((g) => !atomSet.has(g)), fontName);
  // 行内样式片段的原字体（canvas 里注册的字体名）：片段里的英文优先用它
  const familyById = new Map([...own].map((g) => [g.fontId, ownFamily(g.font)]));
  const fontFor = (text: string, size: number, mark?: number) => {
    const m = mark === undefined ? undefined : block.marks[mark];
    const bold = m ? m.bold || style.bold : style.bold;
    const italic = m ? m.italic : style.italic;
    const weight = bold ? 700 : 400;
    // 中文没有真正的斜体，按中文排版习惯用楷体表示（浏览器合成的斜体中文很难看）
    const cjk = cjkStack(cjkFont, { sans: style.sans, italic });
    if (CJK_CHAR.test(text)) return `${weight} ${size}px ${cjk}`;
    // PDF 的字体多是子集，只有原文用过的字母；缺字时整词换成相近的系统字体，避免一个词里混两种字形
    const family = (m?.fontId !== undefined ? familyById.get(m.fontId) : undefined) ?? style.own;
    const cover = coverage.get(family);
    const ownOk = family !== '' && cover !== undefined && [...text].every((c) => cover.has(c));
    return `${italic ? 'italic ' : ''}${weight} ${size}px ${ownOk ? `${family},` : ''}${style.sans ? LATIN_SANS : LATIN_SERIF},${cjk}`;
  };
  // 宽度按字号线性缩放：每段文字只在参考字号下量一次
  const widths = new Map<string, number>();
  const measureCtx = document.createElement('canvas').getContext('2d')!;
  // 原子的范围按字形算：起点是最左字形，宽度到最右字形的末端
  const atomBox = atomGlyphs.map((gs, i) => {
    const atom = block.atoms[i]!;
    if (gs.length === 0) return { x0: atom.x0, width: atom.x1 - atom.x0 };
    const x0 = Math.min(...gs.map((g) => g.x));
    return { x0, width: Math.max(...gs.map((g) => g.x + g.w)) - x0 };
  });
  const measure: Measure = {
    text: (text, size, mark) => {
      const key = `${mark ?? ''}|${text}`;
      let w = widths.get(key);
      if (w === undefined) {
        measureCtx.font = fontFor(text, 100, mark);
        w = measureCtx.measureText(text).width;
        widths.set(key, w);
      }
      return (w * size) / 100;
    },
    atom: (index, scale) => (atomBox[index]?.width ?? 0) * scale,
  };
  const tokens = tokenize(translation, block.atoms.length, block.marks.length);
  // 显示文本和断行无关：断行丢掉的行末空格也在里面，换字体后偏移不变（强调靠它定位）
  let text = '';
  const offsets = new Map<Token, [number, number]>();
  for (const t of tokens) {
    const s = t.kind === 'space' ? ' ' : t.kind === 'atom' ? block.atoms[t.index]!.items.map((i) => i.str).join('') : t.text;
    offsets.set(t, [text.length, text.length + s.length]);
    text += s;
  }
  return { block, text, offsets, own, atomGlyphs, atomBox, tokens, measure, fontFor, fill: style.fill };
}

/** 记录各字体实际画过的字符（跨页累积），用来判断译文里的英文能不能用 PDF 自己的字体 */
export function recordCoverage(coverage: FontCoverage, glyphs: Glyph[]): void {
  for (const g of glyphs) {
    const own = ownFamily(g.font);
    let set = coverage.get(own);
    if (!set) coverage.set(own, (set = new Set()));
    for (const c of g.text) set.add(c);
  }
}

/** 整体平移的区域左右多带几个像素：公式常比正文栏略宽 */
const SLOT_PAD = 3;

/** 要画的强调：块标识 → 显示文本里的区间 */
export type HighlightMarks = Map<string, { start: number; end: number; style: HighlightStyle }[]>;

const HIGHLIGHT_COLORS: Record<Exclude<HighlightStyle, 'underline'>, string> = {
  yellow: '#ffe45c',
  green: '#a8eb9a',
  blue: '#a5d4ff',
  pink: '#ffb3d1',
};
const UNDERLINE_COLOR = '#e5484d';

/**
 * 画强调：高亮用 multiply 叠在已画好的页面上（白底变色、黑字不变，不用管先后顺序），下划线画在基线下方。
 * 在 drawTranslatedPage 之后调用：要先有它返回的显示文本，才能定位强调。
 */
export function drawHighlights(ctx: CanvasRenderingContext2D, blocks: PageTextBlock[], marks: HighlightMarks) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (const b of blocks) {
    for (const m of marks.get(b.key) ?? []) {
      for (const r of rangeRects(b, m.start, m.end)) {
        if (m.style === 'underline') {
          ctx.globalCompositeOperation = 'source-over';
          ctx.fillStyle = UNDERLINE_COLOR;
          ctx.fillRect(r.x, r.baseline + r.size * 0.14, r.w, Math.max(1, r.size * 0.08));
        } else {
          ctx.globalCompositeOperation = 'multiply';
          ctx.fillStyle = HIGHLIGHT_COLORS[m.style];
          ctx.fillRect(r.x, r.y, r.w, r.h);
        }
      }
    }
  }
  ctx.restore();
}

/**
 * 画译文页：底图 → 清空要写译文的块 → 画回其余所有字形（保留块、未翻译块、旋转文字）
 * → 把夹在译文之间的公式区域整体平移 → 写译文。
 * translations 里没有的块（还没翻译、不翻译、翻译失败）都按原样显示。
 * 同一栏相邻的译文块连成串依次排布（flowLayout），段距一致，省下的空间留在串末。
 * cjkFont 是设置里的译文中文字体（lib/pdf/fonts.ts），空字符串为自动。
 * 返回每块的显示文本与位置（文字层、强调定位用），顺序同 blocks。
 */
export function drawTranslatedPage(
  target: HTMLCanvasElement,
  background: HTMLCanvasElement,
  glyphs: Glyph[],
  blocks: PdfBlock[],
  translations: Map<PdfBlock, string>,
  coverage: FontCoverage,
  cjkFont: string,
): PageTextBlock[] {
  const ctx = target.getContext('2d')!;
  const bg = background.getContext('2d', { willReadFrequently: true })!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(background, 0, 0);

  const plain = glyphs.filter((g) => !isRotated(g));
  const jobs = blocks
    .filter((b) => {
      const t = translations.get(b);
      return t !== undefined && !b.keep && !isUnchanged(b, t);
    })
    .map((block) => makeJob(block, translations.get(block)!, plain, coverage, cjkFont));
  const translated = new Set(jobs.map((j) => j.block));
  // 公式区域能整体平移的条件：四周是纯色底（看不含文字的底图），没有图片、线条跨过边界；
  // 两段直接相连时，中间的空隙要什么都没有（脚注分隔线、图片会截断）
  const slotOk = (s: FlowBox) => borderColor(bg, s.x0 - SLOT_PAD, s.top, s.x1 + SLOT_PAD, s.bottom, 0) !== undefined;
  const blank = (s: FlowBox) => isBlank(bg, s.x0, s.top, s.x1, s.bottom);
  const { placements, moves } = flowLayout(
    jobs.map(({ block, tokens, measure }) => ({
      x0: block.x0,
      x1: block.x1,
      top: block.top,
      bottom: block.bottom,
      size: block.size,
      fixed: block.cell,
      tokens,
      measure,
      // 原文段首缩进的，译文按中文习惯缩进两字；悬挂缩进保持原来的宽度
      indentEm:
        block.align === 'center'
          ? { first: 0, rest: 0 }
          : { first: block.firstIndent > block.size * 0.5 ? 2 : 0, rest: block.restIndent > block.size * 0.5 ? block.restIndent / block.size : 0 },
    })),
    // 页码等页面装饰不参与连排，也不会被当成串尾的公式带走
    blocks.filter((b) => !translated.has(b) && !b.furniture),
    { lineHeight: LINE_HEIGHT },
    { slotOk, blank },
  );

  for (const job of jobs) clearBlock(ctx, bg, job.block.x0, job.block.top, job.block.x1, job.block.bottom);
  const claimed = new Set(jobs.flatMap((j) => [...j.own]));
  for (const g of glyphs) if (!claimed.has(g)) drawGlyph(ctx, g);
  moveSlots(ctx, bg, moves);

  const pieces = new Map(jobs.map((job, k) => [job.block, drawBlock(ctx, job, placements[k]!)]));
  const textOf = new Map(jobs.map((job) => [job.block, job.text]));

  const keys = blockKeys(blocks);
  const pageText = blocks.map((b, i): PageTextBlock => {
    const own = pieces.get(b);
    if (own) return { key: keys[i]!, text: textOf.get(b)!, pieces: own, translated: true };
    // 保留原文的块落在整体平移的公式区域里时，跟着平移
    const m = moves.find((mv) => b.x0 >= mv.x0 - SLOT_PAD && b.x1 <= mv.x1 + SLOT_PAD && b.top >= mv.top - 1 && b.bottom <= mv.bottom + 1);
    return keptBlockText(b, keys[i]!, m?.dy ?? 0);
  });
  return pageText.filter((b) => b.pieces.length > 0);
}

/** 公式区域整体平移：先把所有原位置清成底色（按底图取色），再从快照里把各区域画到新位置（区域之间可能重叠） */
function moveSlots(ctx: CanvasRenderingContext2D, bg: CanvasRenderingContext2D, moves: Move[]) {
  if (moves.length === 0) return;
  const snapshot = document.createElement('canvas');
  snapshot.width = ctx.canvas.width;
  snapshot.height = ctx.canvas.height;
  snapshot.getContext('2d')!.drawImage(ctx.canvas, 0, 0);
  const rects = moves.map((m) => {
    const x = Math.max(0, Math.floor(m.x0 - SLOT_PAD));
    const y = Math.max(0, Math.floor(m.top));
    return { x, y, w: Math.ceil(m.x1 + SLOT_PAD) - x, h: Math.ceil(m.bottom) - y, dy: Math.round(m.dy) };
  });
  for (const r of rects) {
    const border = borderColor(bg, r.x, r.y, r.x + r.w, r.y + r.h, 0);
    ctx.fillStyle = border?.color ?? '#fff';
    ctx.fillRect(r.x, r.y, r.w, r.h);
  }
  for (const r of rects) ctx.drawImage(snapshot, r.x, r.y, r.w, r.h, r.x, r.y + r.dy, r.w, r.h);
}

/** 写一块译文，返回每个 token 的位置 */
function drawBlock(ctx: CanvasRenderingContext2D, job: Job, p: Placement): TextPiece[] {
  const { block, measure } = job;
  const pieces: TextPiece[] = [];
  const scale = p.size / block.size;
  const width = block.x1 - block.x0;
  const widthOf = (t: Token) => tokenWidth(t, p.size, scale, measure);

  p.lines.forEach((line, i) => {
    const baseline = p.top + p.size * (1 + i * LINE_HEIGHT);
    const lineWidth = line.reduce((w, t) => w + widthOf(t), 0);
    let x = block.align === 'center' ? block.x0 + (width - lineWidth) / 2 : block.x0 + (i === 0 ? p.indent.first : p.indent.rest);
    for (const t of line) {
      if (t.kind === 'atom') {
        const box = job.atomBox[t.index]!;
        const atom = block.atoms[t.index]!;
        // 原子字形以「原子左端、所在行基线」为锚点，平移到当前位置并按字号比例缩放；颜色用字形自己的（引用、链接）
        for (const g of job.atomGlyphs[t.index] ?? []) drawGlyph(ctx, g, [scale, 0, 0, scale, x - box.x0 * scale, baseline - atom.y * scale]);
      } else {
        const text = t.kind === 'space' ? ' ' : t.text;
        ctx.font = job.fontFor(text, p.size, t.mark);
        ctx.fillStyle = job.fill;
        ctx.fillText(text, x, baseline);
      }
      const [start, end] = job.offsets.get(t)!;
      if (end > start) pieces.push({ start, end, x, w: widthOf(t), baseline, size: p.size, line: i });
      x += widthOf(t);
    }
  });
  return pieces;
}
