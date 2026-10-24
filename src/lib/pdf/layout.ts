/**
 * PDF 版面分析（设计见 docs/specs/2026-10-24-pdf-bilingual-design.md）：
 * pdf.js 文本项 → 行（挂靠上下标、合并同基线片段）→ 段落块（同栏、字号相近、行距正常）→ 待翻译片段。
 * 公式与代码片段作为「原子」，翻译时用 <xN/> 占位，写回时画原字形。纯逻辑，坐标由调用方换算好。
 */

/** 一个 pdf.js 文本项，已换算到视口坐标（y 向下，y 是基线） */
export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  /** 宽度（视口坐标） */
  w: number;
  /** 字号（视口坐标） */
  size: number;
  /** 原字体名，如 ABCDEF+CMMI10 */
  font: string;
  /** 是否旋转（竖排水印等） */
  rotated: boolean;
  /** 等宽字体（代码） */
  mono: boolean;
}

export interface PdfLine {
  y: number;
  size: number;
  x0: number;
  x1: number;
  items: LineItem[];
}

export interface LineItem extends PdfTextItem {
  /** 公式字体 */
  math: boolean;
  /** 挂靠到主行的上下标、根号等 */
  attached: boolean;
}

/** 不翻译、原样保留的片段：公式、行内代码 */
export interface PdfAtom {
  items: LineItem[];
  x0: number;
  x1: number;
  /** 所在行的基线，写回时以它为锚点平移缩放 */
  y: number;
}

export interface PdfBlock {
  lines: PdfLine[];
  x0: number;
  x1: number;
  /** 首行字顶 / 末行字底（视口坐标） */
  top: number;
  bottom: number;
  size: number;
  align: 'left' | 'center';
  /** 待翻译片段：已转义，原子为 <xN/> */
  text: string;
  atoms: PdfAtom[];
  /** 保留原文，不翻译（行间公式、纯代码、没有单词） */
  keep: boolean;
}

/** TeX 等的公式字体 */
const MATH_FONT = /CMMI|CMSY|CMEX|CMBSY|MSAM|MSBM|Math|Symbol|rsfs|EUFM|EUSM|esint|wasy|stmary|LMMath|STIX.*(Math|Two)/i;
/** 等宽字体：代码 */
export const MONO_FONT = /Mono|Courier|CMTT|Consol|Menlo|Inconsolata|Code|SFMono/i;

/** 字体族：去掉子集前缀、样式后缀和字号，如 ABCDEF+CMR10 → CMR */
export function fontFamily(name: string): string {
  return name
    .replace(/^[A-Z]{6}\+/, '')
    .replace(/[-,].*$/, '')
    .replace(/\d+$/, '');
}

const chars = (items: { str: string }[]) => items.reduce((n, i) => n + i.str.trim().length, 0);
const center = (l: { x0: number; x1: number }) => (l.x0 + l.x1) / 2;

/** 文本项 → 行：先按字号从大到小建主行，再把上下标、根号等挂靠到主行，最后合并同一基线上被宽下标断开的片段 */
export function buildLines(raw: PdfTextItem[]): PdfLine[] {
  const items: LineItem[] = raw
    .filter((i) => i.str.trim() && !i.rotated)
    .map((i) => ({ ...i, math: MATH_FONT.test(i.font), attached: false }));
  const lines: PdfLine[] = [];
  for (const it of [...items].sort((a, b) => b.size - a.size || a.y - b.y || a.x - b.x)) {
    const line = lines.find(
      (l) =>
        Math.abs(l.y - it.y) < l.size * 0.3 &&
        Math.abs(l.size - it.size) < l.size * 0.2 &&
        it.x < l.x1 + l.size * 1.2 &&
        it.x + it.w > l.x0 - l.size * 1.2,
    );
    if (line) {
      line.items.push(it);
      line.x0 = Math.min(line.x0, it.x);
      line.x1 = Math.max(line.x1, it.x + it.w);
    } else lines.push({ y: it.y, size: it.size, x0: it.x, x1: it.x + it.w, items: [it] });
  }

  // 挂靠：全是公式字体的片段（根号、求和号、上下标）不论大小；非公式的只挂靠明显更小的零星字符，避免吞掉正常的小字行
  for (const l of [...lines].sort((a, b) => a.size - b.size)) {
    const allMath = l.items.every((i) => i.math);
    if (!allMath && chars(l.items) > 12) continue;
    // 上下标、根号、分子分母只会出现在主行正文的空隙或行尾；和某行正文水平重叠，就不是那一行的
    // （否则夹在两行之间的根号会挂到上一行，和本行的公式连成一个横跨半行的原子）
    const overlapsText = (h: PdfLine) =>
      h.items.some((i) => !i.math && !i.attached && Math.min(i.x + i.w, l.x1) - Math.max(i.x, l.x0) > (l.x1 - l.x0) * 0.3);
    const host = lines
      .filter(
        (h) =>
          h !== l &&
          // 公式碎片（根号、分子）常夹在两行之间，放宽到 0.85 个字号；其余按 0.75
          Math.abs(h.y - l.y) < h.size * (allMath ? 0.85 : 0.75) &&
          l.x0 >= h.x0 - h.size &&
          // 行末的分式：分子在主行最后一个词之后，此时主行还没挂上后面的公式，右边界偏左
          l.x0 <= h.x1 + h.size * 1.5 &&
          // 主行字号明显更大；同字号的公式符号（根号）则要求主行更长，避免两个公式片段互相挂靠
          (h.size > l.size * 1.15 || (allMath && chars(h.items) > chars(l.items))) &&
          !overlapsText(h),
      )
      .sort((a, b) => Math.abs(a.y - l.y) - Math.abs(b.y - l.y))[0];
    if (!host) continue;
    host.items.push(...l.items.map((i) => ({ ...i, attached: true })));
    host.x0 = Math.min(host.x0, l.x0);
    host.x1 = Math.max(host.x1, l.x1);
    lines.splice(lines.indexOf(l), 1);
  }

  // 同一基线上的片段再合并一次：宽下标（如 d_model 的 model）挂靠后补上了中间的空隙
  lines.sort((a, b) => a.y - b.y || a.x0 - b.x0);
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i]!;
      const b = lines[j]!;
      if (Math.abs(a.y - b.y) > a.size * 0.3) break;
      // 两个方向都要看：基线差零点几像素时，右边的片段可能排在前面
      const gap = Math.max(b.x0 - a.x1, a.x0 - b.x1);
      if (Math.abs(a.size - b.size) < a.size * 0.2 && gap < a.size * 1.2 && gap > -a.size) {
        a.items.push(...b.items);
        a.x0 = Math.min(a.x0, b.x0);
        a.x1 = Math.max(a.x1, b.x1);
        lines.splice(j, 1);
        j = i;
      }
    }
  }
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);
  return lines;
}

/** 行 → 段落块：同栏（水平重叠）、字号相近、行距正常的行连成一块；首行缩进或上一行是短末行时另起一段，居中排版不切 */
export function buildBlocks(lines: PdfLine[]): PdfLine[][] {
  const blocks: { lines: PdfLine[]; x0: number; x1: number; size: number }[] = [];
  for (const l of [...lines].sort((a, b) => a.y - b.y || a.x0 - b.x0)) {
    const b = blocks
      .slice(-8)
      .reverse()
      .find((b) => {
        const last = b.lines.at(-1)!;
        const overlap = Math.min(b.x1, l.x1) - Math.max(b.x0, l.x0);
        const gap = l.y - last.y;
        return (
          overlap > Math.min(b.x1 - b.x0, l.x1 - l.x0) * 0.5 &&
          Math.abs(b.size - l.size) < b.size * 0.15 &&
          gap > 0 &&
          gap < b.size * 1.7
        );
      });
    const prev = b?.lines.at(-1);
    // 没挂靠上的公式碎片（零星几个公式字符）不能触发分段，否则会从中间把段落切开
    const fragment = l.items.every((i) => i.math) && chars(l.items) <= 3;
    if (b && fragment) {
      b.lines.push(l);
      continue;
    }
    const centered = prev !== undefined && Math.abs(center(prev) - center(l)) < l.size * 0.5 && Math.abs(prev.x0 - l.x0) > l.size * 0.5;
    const indented = prev !== undefined && l.x0 > prev.x0 + l.size * 0.7 && l.x0 > b!.x0 + l.size * 0.7;
    const prevShort = prev !== undefined && prev.x1 < b!.x1 - l.size * 2.5;
    if (b && !centered && (indented || prevShort)) {
      blocks.push({ lines: [l], x0: l.x0, x1: l.x1, size: l.size });
    } else if (b) {
      b.lines.push(l);
      b.x0 = Math.min(b.x0, l.x0);
      b.x1 = Math.max(b.x1, l.x1);
    } else blocks.push({ lines: [l], x0: l.x0, x1: l.x1, size: l.size });
  }
  return blocks.map((b) => b.lines);
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 块 → 待翻译片段：公式字体、等宽字体、挂靠的上下标连成原子，用 <xN/> 占位；行末连字符断词合并 */
export function buildSegment(lines: PdfLine[], bodyFamily: string): { text: string; atoms: PdfAtom[]; atomChars: number; allChars: number } {
  const atoms: PdfAtom[] = [];
  let text = '';
  let atomChars = 0;
  let allChars = 0;
  lines.forEach((line, li) => {
    let cur: PdfAtom | undefined;
    const flush = () => {
      if (!cur) return;
      atoms.push(cur);
      text += `<x${atoms.length - 1}/>`;
      cur = undefined;
    };
    line.items.forEach((it, k) => {
      const prev = line.items[k - 1];
      const spaced = prev !== undefined && it.x - (prev.x + prev.w) > it.size * 0.15;
      const atomish =
        it.math || it.mono || it.attached || (cur !== undefined && fontFamily(it.font) !== bodyFamily && it.x - cur.x1 < it.size * 0.4);
      const n = it.str.trim().length;
      allChars += n;
      if (atomish) {
        atomChars += n;
        if (cur) {
          cur.items.push(it);
          cur.x0 = Math.min(cur.x0, it.x);
          cur.x1 = Math.max(cur.x1, it.x + it.w);
        } else {
          if (spaced && !/\s$/.test(text)) text += ' ';
          cur = { items: [it], x0: it.x, x1: it.x + it.w, y: line.y };
        }
        return;
      }
      flush();
      if (spaced && !/\s$/.test(text) && !/^\s/.test(it.str)) text += ' ';
      text += escape(it.str);
    });
    flush();
    if (li < lines.length - 1) {
      // 行末连字符断词：repre- + sentation → representation
      const next = lines[li + 1]!.items[0]?.str ?? '';
      if (/[A-Za-z]-$/.test(text) && /^[a-z]/.test(next)) text = text.slice(0, -1);
      else if (!/\s$/.test(text)) text += ' ';
    }
  });
  return { text: text.replace(/\s+/g, ' ').trim(), atoms, atomChars, allChars };
}

/** 整页：行 → 块 → 片段，并判断哪些块保留原文。pageWidth 用于判断单行居中（标题） */
export function analyzePage(items: PdfTextItem[], pageWidth: number): PdfBlock[] {
  const lines = buildLines(items);
  // 正文字体族：字数最多的那个（公式里的罗马体 CMR 与正文 Times 区分开）
  const count = new Map<string, number>();
  for (const l of lines) for (const i of l.items) count.set(fontFamily(i.font), (count.get(fontFamily(i.font)) ?? 0) + i.str.length);
  const bodyFamily = [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';

  return buildBlocks(lines).map((blockLines) => {
    const seg = buildSegment(blockLines, bodyFamily);
    const first = blockLines[0]!;
    const last = blockLines.at(-1)!;
    const size = Math.max(...blockLines.map((l) => l.size));
    const x0 = Math.min(...blockLines.map((l) => l.x0));
    const x1 = Math.max(...blockLines.map((l) => l.x1));
    const plain = seg.text.replace(/<x\d+\/>/g, '');
    const words = plain.match(/\p{L}{3,}/gu) ?? [];
    const keep =
      words.length === 0 ||
      (seg.allChars > 0 && seg.atomChars / seg.allChars > 0.5) ||
      // 行间公式：带公式且真正的单词不到 3 个，如 Attention(Q, K, V) = softmax(…)
      (seg.atoms.length > 0 && words.length < 3) ||
      blockLines.every((l) => l.items.every((i) => i.mono));
    const multiCentered =
      blockLines.length > 1 &&
      blockLines.every((l) => Math.abs(center(l) - center(first)) < size * 0.5) &&
      blockLines.some((l) => Math.abs(l.x0 - first.x0) > size * 0.5);
    // 单行：位于页面中线附近、两侧留白明显（标题、居中的章节名）
    const singleCentered = blockLines.length === 1 && Math.abs(center(first) - pageWidth / 2) < pageWidth * 0.02 && x0 > pageWidth * 0.15;
    return {
      lines: blockLines,
      x0,
      x1,
      top: first.y - first.size,
      bottom: last.y + last.size * 0.3,
      size,
      align: multiCentered || singleCentered ? 'center' : 'left',
      text: seg.text,
      atoms: seg.atoms,
      keep,
    };
  });
}
