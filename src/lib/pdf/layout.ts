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
  /** pdf.js 载入的字体 id（与渲染时 ctx.font 里的字体名相同），用来把字形对应到文本项 */
  fontId?: string;
  /** 是否旋转（竖排水印等） */
  rotated: boolean;
  /** 等宽字体（代码） */
  mono: boolean;
  /** 文字颜色（渲染时记录的字形颜色）；链接、引用常和正文颜色不同 */
  color?: string;
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

/** 行内样式片段（和所在段落正文不同的粗体 / 斜体） */
export interface PdfMark {
  bold: boolean;
  italic: boolean;
  /** 该片段原文用的字体（pdf.js 字体 id），译文里的英文优先用它 */
  fontId?: string;
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
  /** 首行相对块左边的缩进（段首缩进） */
  firstIndent: number;
  /** 其余行相对块左边的缩进（列表、参考文献的悬挂缩进） */
  restIndent: number;
  /** 表格单元格：译文留在原位，不和上下的块连排，免得错开所在的行 */
  cell: boolean;
  /** 页面装饰（页码）：不参与连排 */
  furniture: boolean;
  /** 待翻译片段：已转义，原子为 <xN/>，行内粗体 / 斜体为 <gN>…</gN> */
  text: string;
  atoms: PdfAtom[];
  /** <gN> 对应的样式 */
  marks: PdfMark[];
  /** 保留原文，不翻译（行间公式、纯代码、没有单词） */
  keep: boolean;
}

/** TeX 等的公式字体 */
const MATH_FONT = /CMMI|CMSY|CMEX|CMBSY|MSAM|MSBM|Math|Symbol|rsfs|EUFM|EUSM|esint|wasy|stmary|LMMath|STIX.*(Math|Two)/i;
/** 大号定界符、大型运算符的字体：字形从基线往下挂（cases 的大括号、行间的求和号） */
const HANGING_FONT = /CMEX|esint|MathExtension/i;
/** 等宽字体：代码 */
export const MONO_FONT = /Mono|Courier|CMTT|Consol|Menlo|Inconsolata|Code|SFMono/i;
/** 无衬线字体：译文的中文、缺字的英文据此选黑体还是宋体（pdf.js 按字体标志判断，TeX 生成的 PDF 常常判错） */
export const SANS_FONT = /Sans|Helvetica|Arial|Calibri|Verdana|Tahoma|Segoe|Roboto|Lato|Gothic|Grotesk|Inter\b|CMSS|NimbusSan|Lucida(?!.*Bright)/i;
/** 斜体 */
export const ITALIC_FONT = /Ital|Oblique|Slant|-It\b|CMTI|CMSL/i;

/** 字体族：去掉子集前缀、样式后缀和字号，如 ABCDEF+CMR10 → CMR */
export function fontFamily(name: string): string {
  return name
    .replace(/^[A-Z]{6}\+/, '')
    .replace(/[-,].*$/, '')
    .replace(/\d+$/, '');
}

const chars = (items: { str: string }[]) => items.reduce((n, i) => n + i.str.trim().length, 0);
const center = (l: { x0: number; x1: number }) => (l.x0 + l.x1) / 2;
type Span = { x0: number; x1: number };
/**
 * 两行互相居中：中线对齐，且左右两端都不齐。只看中线和左端会把段首行误判成居中
 * （首行缩进一个字，中线只偏半个字，右端却和下一行齐平）
 */
const centeredPair = (a: Span, b: Span, size: number) =>
  Math.abs(center(a) - center(b)) < size * 0.5 && Math.abs(a.x0 - b.x0) > size * 0.5 && Math.abs(a.x1 - b.x1) > size * 0.5;
/** 行的文字：文本项之间有间隙的补一个空格（「2.2」和标题文字常是两个文本项） */
const lineText = (l: PdfLine) =>
  l.items.map((i, k) => (k > 0 && i.x - (l.items[k - 1]!.x + l.items[k - 1]!.w) > i.size * 0.15 ? ' ' : '') + i.str).join('');
/** 没挂靠上的公式碎片：零星几个公式字符（大括号这类往下挂的除外，它们属于下方的公式，不能并进上面的段落） */
const isFragment = (l: PdfLine) => l.items.every((i) => i.math) && chars(l.items) <= 3 && !l.items.every((i) => HANGING_FONT.test(i.font));
/** 列表项、参考文献条目、章节标题的开头：1. / 2) / • / (a) / [12] / 2.2 / 3（只在判断悬挂缩进时用，正文行首的数字不会触发） */
const LIST_MARKER = /^\s*(\d{1,2}[.)]?|\d{1,2}(\.\d{1,2})+\.?|[•●▪◦‣∙·–—-]|\([a-z0-9]{1,3}\)|\[\d{1,3}\])\s/i;
/** 行间公式的编号 */
const EQUATION_NUMBER = /^\(\d{1,3}[a-z]?\)$/;
/** 粗体 */
export const BOLD_FONT = /Bold|Medi(?!um)|Semibold|Demi|Black|Heavy|CMBX|CMB\d|-Bd\b/i;
/** 人名里的一个词：首字母大写（可带缩写点、连字符），或姓氏前的小写介词 */
const NAME_WORD = /^(\p{Lu}[\p{L}'’]*\.?(-\p{Lu}?[\p{L}'’]*\.?)*|van|von|der|den|de|di|da|du|del|la|le|bin)$/u;
/** 机构名里的词：有这些词的是单位，要翻译 */
const ORG_WORD = /^(Universit\p{L}*|Institut\p{L}*|College|School|Laborator\p{L}*|Lab|Labs|Department|Dept\.?|Cent(er|re)|Academy|Hospital|Foundation|Research|Faculty)$/u;

/** 作者姓名行：一个或多个「名 姓」，可带上标编号、星号，用逗号或 and 分隔 */
function isNameLine(text: string): boolean {
  const plain = text.replace(/<x\d+\/>/g, ' ').replace(/[\d*†‡§¶∗]/g, ' ');
  const chunks = plain
    .split(/,|\band\b|&amp;/)
    .map((c) => c.trim().split(/\s+/).filter(Boolean))
    .filter((c) => c.length > 0);
  return chunks.length > 0 && chunks.every((c) => c.length >= 2 && c.length <= 4 && c.every((w) => NAME_WORD.test(w) && !ORG_WORD.test(w)));
}

/** 行的主字体（按字数，不含挂靠的上下标）：作者栏里姓名与单位常常只差在正体 / 斜体 */
function lineFont(l: PdfLine): string {
  const count = new Map<string, number>();
  for (const i of l.items) {
    if (i.attached) continue;
    const font = i.font.replace(/^[A-Z]{6}\+/, '');
    count.set(font, (count.get(font) ?? 0) + i.str.trim().length);
  }
  return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

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

  // 零星片段按间隙拆开再挂靠：求和号的下限和后面 q_i、k_i 的下标高度相近，第一遍会并成一行，
  // 整体跨过下一段正文的起点，哪一行都挂不上。拆开后挂不上的片段，最后一步会按同基线重新合并
  for (const l of [...lines]) {
    if (!l.items.every((i) => i.math) && chars(l.items) > 12) continue;
    const groups: LineItem[][] = [];
    for (const it of [...l.items].sort((a, b) => a.x - b.x)) {
      const last = groups.at(-1)?.at(-1);
      if (last && it.x - (last.x + last.w) <= l.size * 0.5) groups.at(-1)!.push(it);
      else groups.push([it]);
    }
    if (groups.length < 2) continue;
    lines.splice(
      lines.indexOf(l),
      1,
      ...groups.map((g) => ({ y: g[0]!.y, size: l.size, x0: Math.min(...g.map((i) => i.x)), x1: Math.max(...g.map((i) => i.x + i.w)), items: g })),
    );
  }

  // 挂靠：全是公式字体的片段（根号、求和号、上下标）不论大小；非公式的只挂靠明显更小的零星字符，避免吞掉正常的小字行。
  // 大号符号先挂：求和号挂上主行后，主行的右边界才到得了它下面的上下限
  const isHanging = (l: PdfLine) => l.items.every((i) => HANGING_FONT.test(i.font));
  for (const l of [...lines].sort((a, b) => Number(isHanging(b)) - Number(isHanging(a)) || a.size - b.size)) {
    const allMath = l.items.every((i) => i.math);
    if (!allMath && chars(l.items) > 12) continue;
    // 求和号的上下限（i=1）常混着罗马体的 = 和数字，几个字符里有公式字体就算公式碎片
    const mathy = allMath || (chars(l.items) <= 4 && l.items.some((i) => i.math));
    // 大括号等挂在基线下方，只能属于基线同高或更低的行（否则会挂到上一段正文的末行，跟着译文挪走）
    const hanging = isHanging(l);
    // 左右距离只算一半：脚注标记 ‡ 在下一行行首左上方，离上一行的基线反而更近
    const distance = (h: PdfLine) => Math.abs(h.y - l.y) + Math.max(0, h.x0 - l.x0, l.x0 - h.x1) * 0.5;
    const near = (h: PdfLine) =>
      hanging
        ? h.y >= l.y - l.size * 0.2 && h.y - l.y < h.size * 2.5
        : // 公式碎片（根号、分子）常夹在两行之间，放宽到 0.85 个字号，比主行小的上下限再放宽到 1 个；其余按 0.75
          Math.abs(h.y - l.y) < h.size * (mathy ? (l.size < h.size * 0.85 ? 1 : 0.85) : 0.75);
    // 上下标、根号、分子分母只会出现在主行正文的空隙或行尾；和某行正文水平重叠，就不是那一行的
    // （否则夹在两行之间的根号会挂到上一行，和本行的公式连成一个横跨半行的原子）
    const overlapsText = (h: PdfLine) =>
      h.items.some((i) => !i.math && !i.attached && Math.min(i.x + i.w, l.x1) - Math.max(i.x, l.x0) > (l.x1 - l.x0) * 0.3);
    const host = lines
      .filter(
        (h) =>
          h !== l &&
          near(h) &&
          l.x0 >= h.x0 - h.size &&
          // 行末的分式：分子在主行最后一个词之后，此时主行还没挂上后面的公式，右边界偏左
          l.x0 <= h.x1 + h.size * 1.5 &&
          // 主行字号明显更大；同字号的公式符号（根号）则要求主行更长，避免两个公式片段互相挂靠
          (h.size > l.size * 1.15 || (mathy && chars(h.items) > chars(l.items))) &&
          // 往下挂的大号符号已限定只挂基线同高或更低的行；宽波浪线（\widetilde）正压在它装饰的字母上，不能因重叠排除
          (hanging || !overlapsText(h)),
      )
      // 取最近的：上下距离加左右距离（同一基线上并排两段时，下标归它正下方或紧挨着的那段）
      .sort((a, b) => distance(a) - distance(b))[0];
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
      const left = a.x0 < b.x0 ? a : b;
      const right = left === a ? b : a;
      // 两端对齐的标题词距很大，pdf.js 会拆成几个文本项；同字体、且空隙的上方和下方几行内都有别的行跨过
      // （说明不是两栏之间的栏缝；只看一侧的话，两栏上方的通栏图注也会「跨过」栏缝）就并回一行
      const spans = (o: PdfLine) => o !== a && o !== b && o.x0 < left.x1 && o.x1 > right.x0;
      const justified =
        gap < a.size * 4 &&
        lineFont(a) === lineFont(b) &&
        lines.some((o) => spans(o) && o.y < a.y && a.y - o.y < a.size * 3) &&
        lines.some((o) => spans(o) && o.y > a.y && o.y - a.y < a.size * 3);
      if (Math.abs(a.size - b.size) < a.size * 0.2 && (gap < a.size * 1.2 || justified) && gap > -a.size) {
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

/**
 * 表格单元格所在的行：本身不长，同一基线上还有至少两段互不相连的短文字（数字、短标签）。
 * 只看短文字，是为了不把两栏正文、行间公式旁的编号当成表格。
 */
export function tableCells(lines: PdfLine[]): Set<PdfLine> {
  const cells = new Set<PdfLine>();
  for (const l of lines) {
    if (l.x1 - l.x0 >= l.size * 20) continue;
    const row = lines.filter((o) => o !== l && Math.abs(o.y - l.y) < l.size * 0.3 && (o.x0 > l.x1 || o.x1 < l.x0) && o.x1 - o.x0 < o.size * 8);
    if (row.length >= 2) cells.add(l);
  }
  return cells;
}

/** 行 → 段落块：同栏（水平重叠）、字号相近、行距正常的行连成一块；首行缩进或上一行是短末行时另起一段，居中排版不切 */
export function buildBlocks(lines: PdfLine[], cells: Set<PdfLine> = tableCells(lines)): PdfLine[][] {
  const blocks: { lines: PdfLine[]; x0: number; x1: number; size: number }[] = [];
  for (const l of [...lines].sort((a, b) => a.y - b.y || a.x0 - b.x0)) {
    // 只在最近的块里找（按 y 排序后两栏交错，另一栏的公式碎片多时，同栏上一段可能隔着几十个块）
    const b = blocks
      .slice(-40)
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
    if (b && isFragment(l)) {
      b.lines.push(l);
      continue;
    }
    const centered = prev !== undefined && centeredPair(prev, l, l.size);
    // 列表项、参考文献的悬挂缩进：首行以编号开头，后续行缩进对齐正文，不是新段落
    const hanging = b !== undefined && b.lines.length === 1 && LIST_MARKER.test(lineText(prev!)) && l.x0 < prev!.x0 + l.size * 4;
    const indented = prev !== undefined && !hanging && l.x0 > prev.x0 + l.size * 0.7 && l.x0 > b!.x0 + l.size * 0.7;
    const prevShort = prev !== undefined && prev.x1 < b!.x1 - l.size * 2.5;
    // 悬挂缩进的下一项：编号行比上一行往左突出；或是以脚注标记（* † ‡ 或上标数字）开头的下一条脚注
    const nextItem =
      prev !== undefined &&
      ((LIST_MARKER.test(lineText(l)) && l.x0 < prev.x0 - l.size * 0.5) ||
        /^[*†‡§¶∗]/.test(lineText(l).trim()) ||
        (l.items[0]!.attached && /^\d{1,2}$/.test(l.items[0]!.str.trim()) && l.items[0]!.y < l.y));
    // 作者栏这类短行的堆叠（姓名一行、单位一行）：字体不同就是不同的条目；
    // 网格里上下两格的中线不一定对齐，所以短行只要求中线接近
    const short = prev !== undefined && Math.max(prev.x1 - prev.x0, l.x1 - l.x0) < l.size * 15 && Math.abs(center(prev) - center(l)) < l.size * 2;
    const restyled = prev !== undefined && (centered || short) && lineFont(prev) !== lineFont(l);
    // 表格里上下相邻的单元格各自独立（段落的短末行可以挨着表格，所以只看上一行）
    const afterCell = prev !== undefined && cells.has(prev);
    // 行间公式的编号「(6)」单独成块，不能并进下面的段落（否则会被当成正文挪走）
    const equationNumber = prev !== undefined && (EQUATION_NUMBER.test(lineText(prev).trim()) || EQUATION_NUMBER.test(lineText(l).trim()));
    if (b && (restyled || afterCell || equationNumber || (!centered && (indented || prevShort || nextItem)))) {
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

/** 块的正文颜色：字数最多的颜色 */
function bodyColor(lines: PdfLine[]): string | undefined {
  const count = new Map<string, number>();
  for (const l of lines) for (const i of l.items) if (i.color) count.set(i.color, (count.get(i.color) ?? 0) + i.str.trim().length);
  return [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
}

const styleKey = (font: string) => (BOLD_FONT.test(font) ? 'b' : '') + (ITALIC_FONT.test(font) ? 'i' : '');

/** 块的正文样式（粗体 / 斜体）：按字数取众数，不含公式、代码、上下标 */
function bodyStyle(lines: PdfLine[]): string {
  const count = new Map<string, number>();
  for (const l of lines) for (const i of l.items) if (!i.math && !i.mono && !i.attached) count.set(styleKey(i.font), (count.get(styleKey(i.font)) ?? 0) + i.str.trim().length);
  return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

/**
 * 块 → 待翻译片段：公式字体、等宽字体、挂靠的上下标连成原子，用 <xN/> 占位；行末连字符断词合并。
 * 和正文颜色不同的短片段（引用编号、交叉引用、链接）也作为原子：不需要翻译，写回时保留原来的颜色。
 * 和正文样式不同的片段（行内粗体、斜体）用 <gN>…</gN> 包起来：模型翻译其中的文字并保留标签，写回时按该样式画。
 */
export function buildSegment(
  lines: PdfLine[],
  bodyFamily: string,
): { text: string; atoms: PdfAtom[]; marks: PdfMark[]; atomChars: number; allChars: number } {
  const atoms: PdfAtom[] = [];
  const marks: PdfMark[] = [];
  let text = '';
  let atomChars = 0;
  let allChars = 0;
  const body = bodyColor(lines);
  const baseStyle = bodyStyle(lines);
  // 当前打开的 <gN> 的样式；undefined 表示没有打开
  let open: string | undefined;
  const closeMark = () => {
    if (open === undefined) return;
    text += `</g${marks.length - 1}>`;
    open = undefined;
  };
  // 短的彩色片段，或带年份的（作者-年份式引用，一串可以很长）；长的彩色句子照常翻译
  const accent = (it: LineItem) =>
    body !== undefined &&
    it.color !== undefined &&
    it.color !== body &&
    ((it.str.match(/\p{L}+/gu) ?? []).length <= 4 || /\b(19|20)\d{2}[a-z]?\b/.test(it.str));
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
      const next = line.items[k + 1];
      const spaced = prev !== undefined && it.x - (prev.x + prev.w) > it.size * 0.15;
      // 紧挨着上下标、或压着公式符号（波浪线、帽子等重音）的一两个字母是公式变量
      // （mathptmx 等用正文斜体写变量，字体上分不出来）：S̃ₜ 的 S
      const base =
        !it.attached &&
        next !== undefined &&
        it.str.trim().length <= 2 &&
        ((next.attached && next.x - (it.x + it.w) < it.size * 0.3) || (next.math && next.x < it.x + it.w - 0.5));
      const atomish =
        it.math ||
        it.mono ||
        it.attached ||
        base ||
        accent(it) ||
        (cur !== undefined && fontFamily(it.font) !== bodyFamily && it.x - cur.x1 < it.size * 0.4);
      const n = it.str.trim().length;
      allChars += n;
      if (atomish) {
        atomChars += n;
        if (cur) {
          cur.items.push(it);
          cur.x0 = Math.min(cur.x0, it.x);
          cur.x1 = Math.max(cur.x1, it.x + it.w);
        } else {
          closeMark();
          if (spaced && !/\s$/.test(text)) text += ' ';
          cur = { items: [it], x0: it.x, x1: it.x + it.w, y: line.y };
        }
        return;
      }
      flush();
      const style = styleKey(it.font);
      const want = style === baseStyle ? undefined : style;
      if (want !== open) closeMark();
      if (spaced && !/\s$/.test(text) && !/^\s/.test(it.str)) text += ' ';
      const [, lead = '', rest = ''] = /^(\s*)([\s\S]*)$/.exec(it.str) ?? [];
      text += lead;
      if (want !== undefined && open === undefined && rest !== '') {
        marks.push({ bold: want.includes('b'), italic: want.includes('i'), fontId: it.fontId });
        text += `<g${marks.length - 1}>`;
        open = want;
      }
      text += escape(rest);
    });
    flush();
    if (li < lines.length - 1) {
      // 行末连字符断词：repre- + sentation → representation
      const next = lines[li + 1]!.items[0]?.str ?? '';
      if (/[A-Za-z]-$/.test(text) && /^[a-z]/.test(next)) text = text.slice(0, -1);
      else if (!/\s$/.test(text)) text += ' ';
    }
  });
  closeMark();
  return { text: text.replace(/\s+/g, ' ').replace(/\s+(<\/g\d+>)/g, '$1 ').trim(), atoms, marks, atomChars, allChars };
}

/** 整页：行 → 块 → 片段，并判断哪些块保留原文。pageWidth 用于判断单行居中（标题） */
export function analyzePage(items: PdfTextItem[], pageWidth: number): PdfBlock[] {
  const lines = buildLines(items);
  // 正文字体族：字数最多的那个（公式里的罗马体 CMR 与正文 Times 区分开）
  const count = new Map<string, number>();
  for (const l of lines) for (const i of l.items) count.set(fontFamily(i.font), (count.get(fontFamily(i.font)) ?? 0) + i.str.length);
  const bodyFamily = [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';

  const cells = tableCells(lines);
  const blocks = buildBlocks(lines, cells).map((blockLines): PdfBlock => {
    const seg = buildSegment(blockLines, bodyFamily);
    const first = blockLines[0]!;
    const last = blockLines.at(-1)!;
    const size = Math.max(...blockLines.map((l) => l.size));
    const x0 = Math.min(...blockLines.map((l) => l.x0));
    const x1 = Math.max(...blockLines.map((l) => l.x1));
    const plain = seg.text.replace(/<x\d+\/>|<\/?g\d+>/g, '');
    const words = plain.match(/\p{L}{3,}/gu) ?? [];
    // 作者栏的姓名：单独一行、上下紧挨着字体不同的行（单位）。单独送去翻译时模型会音译，而且音译常常是错的
    const authorName =
      blockLines.length === 1 &&
      isNameLine(plain) &&
      lines.some((o) => o !== first && Math.abs(o.y - first.y) < size * 2.2 && Math.abs(center(o) - center(first)) < size * 2 && lineFont(o) !== lineFont(first));
    const keep =
      authorName ||
      words.length === 0 ||
      (seg.allChars > 0 && seg.atomChars / seg.allChars > 0.5) ||
      // 行间公式：带公式且真正的单词不到 3 个，如 Attention(Q, K, V) = softmax(…)
      (seg.atoms.length > 0 && words.length < 3) ||
      blockLines.every((l) => l.items.every((i) => i.mono));
    const multiCentered =
      blockLines.length > 1 &&
      blockLines.every((l) => Math.abs(center(l) - center(first)) < size * 0.5) &&
      blockLines.some((l) => centeredPair(l, first, size));
    // 单行：位于页面中线附近、两侧留白明显（标题、居中的章节名），或和上下相邻的行居中对齐（作者栏的单位）
    const singleCentered =
      blockLines.length === 1 &&
      ((Math.abs(center(first) - pageWidth / 2) < pageWidth * 0.02 && x0 > pageWidth * 0.15) ||
        lines.some((l) => l !== first && Math.abs(l.y - first.y) < size * 2.2 && centeredPair(l, first, size)));
    const rest = blockLines.slice(1).filter((l) => !isFragment(l));
    return {
      lines: blockLines,
      x0,
      x1,
      top: first.y - first.size,
      bottom: last.y + last.size * 0.3,
      size,
      align: multiCentered || singleCentered ? 'center' : 'left',
      cell: blockLines.length === 1 && cells.has(first),
      furniture: false,
      firstIndent: first.x0 - x0,
      restIndent: rest.length > 0 ? Math.min(...rest.map((l) => l.x0)) - x0 : 0,
      text: seg.text,
      atoms: seg.atoms,
      marks: seg.marks,
      keep,
    };
  });
  // 页码：页面最上或最下的一个纯数字（或罗马数字）块
  const topmost = Math.min(...blocks.map((b) => b.top));
  const bottommost = Math.max(...blocks.map((b) => b.bottom));
  for (const b of blocks) {
    if (/^(\d{1,4}|[ivxlc]{1,6})$/i.test(b.text) && (b.top === topmost || b.bottom === bottommost)) b.furniture = true;
  }
  return blocks;
}
