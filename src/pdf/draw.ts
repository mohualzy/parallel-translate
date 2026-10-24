import type { PdfBlock, PdfTextItem } from '@/lib/pdf/layout';
import { fitBlock, tokenize, type Measure } from '@/lib/pdf/typeset';
import type { Glyph } from './page-render';

/** 译文的行高（字号的倍数） */
const LINE_HEIGHT = 1.32;
const CJK_SERIF = '"Songti SC","Noto Serif CJK SC","Source Han Serif SC","SimSun",serif';
const CJK_SANS = '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC","Source Han Sans SC",sans-serif';

/** 文本项对应的字形：同一基线、落在该项的水平范围内（按区域取会把旁边的正文带进来） */
function glyphsOf(item: PdfTextItem, glyphs: Glyph[]): Glyph[] {
  return glyphs.filter((g) => Math.abs(g.y - item.y) < item.size * 0.25 && g.x >= item.x - 0.5 && g.x <= item.x + item.w + 0.5);
}

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

/** 块的样式：原文的颜色、字重、字体（拉丁字母先用 PDF 自己的字体，中文回退到系统字体） */
function blockStyle(glyphs: Glyph[]) {
  const font = mode(glyphs.map((g) => g.font)) ?? '';
  const family = font.replace(/^.*?\d+(\.\d+)?px\s+/, '');
  const generic = /sans-serif\s*$/.test(family) ? 'sans' : 'serif';
  const own = family.replace(/,\s*(serif|sans-serif|monospace)\s*$/, '').trim();
  return {
    fill: mode(glyphs.map((g) => g.fill)) ?? '#000',
    bold: glyphs.filter((g) => /\b(bold|[6-9]00)\b/.test(g.font)).length > glyphs.length / 2,
    family: [own, generic === 'sans' ? CJK_SANS : CJK_SERIF].filter(Boolean).join(','),
  };
}

/** 块区域四周颜色均匀（纯色底）时，用该颜色清空区域，带走分数线、根号上横线等跟着公式移走的矢量线；压在图片上则不清 */
function clearBlock(ctx: CanvasRenderingContext2D, x0: number, top: number, x1: number, bottom: number) {
  const pad = 2;
  const left = Math.max(0, Math.floor(x0 - pad));
  const right = Math.min(ctx.canvas.width - 1, Math.ceil(x1 + pad));
  const upper = Math.max(0, Math.floor(top - pad));
  const lower = Math.min(ctx.canvas.height - 1, Math.ceil(bottom + pad));
  if (right <= left || lower <= upper) return;
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
  if (!uniform) return;
  ctx.fillStyle = `rgb(${mean.map(Math.round).join(',')})`;
  ctx.fillRect(left, upper, right - left, lower - upper);
}

const normalize = (s: string) =>
  s
    .replace(/<x\d+\s*\/>/g, '')
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

/**
 * 画译文页：底图 → 清空要写译文的块 → 画回其余所有字形（保留块、未翻译块、旋转文字）→ 写译文。
 * translations 里没有的块（还没翻译、不翻译、翻译失败）都按原样显示。
 */
export function drawTranslatedPage(
  target: HTMLCanvasElement,
  background: HTMLCanvasElement,
  glyphs: Glyph[],
  blocks: PdfBlock[],
  translations: Map<PdfBlock, string>,
): void {
  const ctx = target.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(background, 0, 0);

  const plain = glyphs.filter((g) => !isRotated(g));
  const jobs = blocks
    .filter((b) => {
      const t = translations.get(b);
      return t !== undefined && !b.keep && !isUnchanged(b, t);
    })
    .map((block) => {
      const items = block.lines.flatMap((l) => l.items);
      const own = new Set(items.flatMap((i) => glyphsOf(i, plain)));
      // 空白字形不算进原子：带前导空格的文本项会把原子的左边界拉远，写回时多出一段空
      const atomGlyphs = block.atoms.map((a) => [...new Set(a.items.flatMap((i) => glyphsOf(i, plain)))].filter((g) => g.text.trim() !== ''));
      const atomSet = new Set(atomGlyphs.flat());
      return { block, translation: translations.get(block)!, own, atomGlyphs, style: blockStyle([...own].filter((g) => !atomSet.has(g))) };
    });

  for (const job of jobs) clearBlock(ctx, job.block.x0, job.block.top, job.block.x1, job.block.bottom);
  const claimed = new Set(jobs.flatMap((j) => [...j.own]));
  for (const g of glyphs) if (!claimed.has(g)) drawGlyph(ctx, g);

  for (const job of jobs) drawBlock(ctx, job);
}

function drawBlock(
  ctx: CanvasRenderingContext2D,
  job: { block: PdfBlock; translation: string; atomGlyphs: Glyph[][]; style: ReturnType<typeof blockStyle> },
) {
  const { block, style } = job;
  const fontAt = (size: number) => `${style.bold ? 700 : 400} ${size}px ${style.family}`;
  // 原子的范围按字形算：起点是最左字形，宽度到最右字形的末端
  const atomBox = job.atomGlyphs.map((gs, i) => {
    const atom = block.atoms[i]!;
    if (gs.length === 0) return { x0: atom.x0, width: atom.x1 - atom.x0 };
    const x0 = Math.min(...gs.map((g) => g.x));
    return { x0, width: Math.max(...gs.map((g) => g.x + g.w)) - x0 };
  });
  const measure: Measure = {
    text: (text, size) => {
      ctx.font = fontAt(size);
      return ctx.measureText(text).width;
    },
    atom: (index, scale) => (atomBox[index]?.width ?? 0) * scale,
  };
  const tokens = tokenize(job.translation, block.atoms.length);
  const width = block.x1 - block.x0;
  const { size, lines } = fitBlock(tokens, { width, height: block.bottom - block.top, size: block.size, lineHeight: LINE_HEIGHT }, measure);
  const scale = size / block.size;

  lines.forEach((line, i) => {
    const baseline = block.top + size * (1 + i * LINE_HEIGHT);
    const lineWidth = line.reduce((w, t) => w + (t.kind === 'atom' ? measure.atom(t.index, scale) : measure.text(t.kind === 'space' ? ' ' : t.text, size)), 0);
    let x = block.align === 'center' ? block.x0 + (width - lineWidth) / 2 : block.x0;
    for (const t of line) {
      if (t.kind === 'atom') {
        const box = atomBox[t.index]!;
        const atom = block.atoms[t.index]!;
        // 原子字形以「原子左端、所在行基线」为锚点，平移到当前位置并按字号比例缩放
        for (const g of job.atomGlyphs[t.index] ?? []) drawGlyph(ctx, g, [scale, 0, 0, scale, x - box.x0 * scale, baseline - atom.y * scale]);
        x += box.width * scale;
        continue;
      }
      const text = t.kind === 'space' ? ' ' : t.text;
      ctx.font = fontAt(size);
      ctx.fillStyle = style.fill;
      ctx.fillText(text, x, baseline);
      x += ctx.measureText(text).width;
    }
  });
}
