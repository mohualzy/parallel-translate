/**
 * 网页划词强调（一次性，决策见 docs/DECISIONS.md D66）：只在当前页面有效，不存储。
 * 用 CSS Custom Highlight API 画：按样式各一个 Highlight，往里放 Range，不改动网页 DOM（硬性规则 2）。
 * Range 是活的，页面改了文字会跟着调整；内容被删掉后收成空区间，这里顺手丢掉。
 */

export const MARK_STYLES = ['yellow', 'green', 'blue', 'pink', 'underline'] as const;
export type MarkStyle = (typeof MARK_STYLES)[number];

const COLORS: MarkStyle[] = ['yellow', 'green', 'blue', 'pink'];

/** ::highlight() 用的名字，样式写在内容脚本的 style.css */
export const markName = (style: MarkStyle) => `ptx-mark-${style}`;

/** 点 (n1, o1) 严格在点 (n2, o2) 之前；不在同一棵树里（跨 Shadow DOM）时返回 false */
function before(n1: Node, o1: number, n2: Node, o2: number): boolean {
  try {
    const at = (n1.ownerDocument ?? (n1 as Document)).createRange();
    at.setStart(n1, o1);
    return at.comparePoint(n2, o2) === 1;
  } catch {
    return false;
  }
}

/** 两个区间有重叠（只是首尾相接不算） */
export function intersects(a: Range, b: Range): boolean {
  return before(a.startContainer, a.startOffset, b.endContainer, b.endOffset) && before(b.startContainer, b.startOffset, a.endContainer, a.endOffset);
}

/** a 减去 b：重叠部分去掉，两侧各留一段（可能为空） */
export function subtract(a: Range, b: Range): Range[] {
  if (!intersects(a, b)) return [a];
  const out: Range[] = [];
  if (before(a.startContainer, a.startOffset, b.startContainer, b.startOffset)) {
    const left = a.cloneRange();
    left.setEnd(b.startContainer, b.startOffset);
    out.push(left);
  }
  if (before(b.endContainer, b.endOffset, a.endContainer, a.endOffset)) {
    const right = a.cloneRange();
    right.setStart(b.endContainer, b.endOffset);
    out.push(right);
  }
  return out;
}

/** 把某种样式的区间交给浏览器画（默认写进 CSS.highlights；单测里换成记录函数） */
export type MarkRenderer = (style: MarkStyle, ranges: Range[]) => void;

export const highlightSupported = () => typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

const cssRenderer: MarkRenderer = (style, ranges) => {
  if (ranges.length === 0) CSS.highlights.delete(markName(style));
  else CSS.highlights.set(markName(style), new Highlight(...ranges));
};

/**
 * 当前页面的强调。高亮颜色之间互相覆盖（新的切掉旧的重叠部分，两侧保留）；下划线和高亮各管各的，可以叠加。
 */
export class PageMarks {
  private ranges = new Map<MarkStyle, Range[]>();

  constructor(private readonly render: MarkRenderer = cssRenderer) {}

  private get(style: MarkStyle): Range[] {
    return (this.ranges.get(style) ?? []).filter((r) => !r.collapsed);
  }

  private set(style: MarkStyle, list: Range[]) {
    const kept = list.filter((r) => !r.collapsed);
    this.ranges.set(style, kept);
    this.render(style, kept);
  }

  add(range: Range, style: MarkStyle) {
    if (range.collapsed) return;
    const rivals = style === 'underline' ? ['underline' as const] : COLORS;
    for (const s of rivals) if (s !== style) this.set(s, this.get(s).flatMap((r) => subtract(r, range)));
    this.set(style, [...this.get(style).flatMap((r) => subtract(r, range)), range.cloneRange()]);
  }

  /** 去掉区间里的全部强调（高亮和下划线），两侧保留 */
  clear(range: Range) {
    for (const s of MARK_STYLES) if (this.get(s).length > 0) this.set(s, this.get(s).flatMap((r) => subtract(r, range)));
  }

  overlaps(range: Range): boolean {
    return MARK_STYLES.some((s) => this.get(s).some((r) => intersects(r, range)));
  }

  count(style: MarkStyle): number {
    return this.get(style).length;
  }
}
