import type { TextRange } from '@/lib/pdf/highlights';
import { textLines, type PageTextBlock } from '@/lib/pdf/page-text';

/**
 * 译文页的透明文字层（设计见 docs/specs/2026-10-24-pdf-text-layer-design.md）：
 * 每块一组、每行一个 span，绝对定位到画出来的位置，文字透明，只为选中、复制和浏览器的 Ctrl+F。
 * 位置用百分比、字号用 var(--w) 的比例：缩放后不用重建。
 */

/** 透明文字用的字体：只影响量宽度，按行用 scaleX 拉伸到画出来的宽度 */
const LAYER_FONT = 'sans-serif';
/** 字顶到基线的距离（字号的倍数），span 的 top 据此从基线往上算 */
const ASCENT = 0.88;

let measureCtx: CanvasRenderingContext2D | undefined;
function naturalWidth(text: string): number {
  measureCtx ??= document.createElement('canvas').getContext('2d')!;
  measureCtx.font = `100px ${LAYER_FONT}`;
  return measureCtx.measureText(text).width / 100;
}

const pct = (v: number) => `${(v * 100).toFixed(4)}%`;

/**
 * 按页面文字几何重建文字层。内容和上次相同时不动 DOM：译文陆续到达、页面重新渲染时，
 * 不打断用户正在拖的选区。width / height 是画布像素尺寸。
 */
export function renderTextLayer(layer: HTMLElement, blocks: PageTextBlock[], width: number, height: number): void {
  const parts: { key: string; spans: { text: string; start: number; style: string }[] }[] = [];
  for (const b of blocks) {
    const spans = [];
    for (const l of textLines(b)) {
      const text = b.text.slice(l.start, l.end);
      const drawn = text.trimEnd();
      if (drawn === '') continue;
      const natural = naturalWidth(drawn) * l.size;
      const scale = natural > 0 ? (l.x1 - l.x0) / natural : 1;
      spans.push({
        text,
        start: l.start,
        style: `left:${pct(l.x0 / width)};top:${pct((l.baseline - l.size * ASCENT) / height)};font-size:calc(var(--w) * ${(l.size / width).toFixed(6)});transform:scaleX(${scale.toFixed(4)})`,
      });
    }
    if (spans.length > 0) parts.push({ key: b.key, spans });
  }
  const signature = JSON.stringify(parts);
  if (layer.dataset.signature === signature) return;
  layer.dataset.signature = signature;
  layer.replaceChildren(
    ...parts.map((p) => {
      const group = document.createElement('div');
      group.className = 'tl-block';
      group.dataset.key = p.key;
      for (const s of p.spans) {
        const span = document.createElement('span');
        span.textContent = s.text;
        span.dataset.start = String(s.start);
        span.setAttribute('style', s.style);
        group.append(span);
      }
      // 复制时段落之间换行
      group.append(document.createElement('br'));
      return group;
    }),
  );
}

/** 选区端点在这个 span 里的偏移：端点在 span 之前为 0、之后为全长 */
function offsetIn(span: HTMLElement, container: Node, offset: number, atEnd: boolean): number {
  const len = span.textContent?.length ?? 0;
  if (container === span.firstChild) return offset;
  if (container === span) return offset === 0 ? 0 : len;
  return atEnd ? len : 0;
}

/** 当前选区落在译文页各块里的部分（块内显示文本的偏移），同一块合并成一段 */
export function selectionRanges(selection: Selection | null): TextRange[] {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return [];
  const range = selection.getRangeAt(0);
  const merged = new Map<string, TextRange>();
  // 强调只存在译文页上；原文页的选区只用来复制
  for (const span of document.querySelectorAll<HTMLElement>('.slot.translated .text-layer span[data-start]')) {
    if (!range.intersectsNode(span)) continue;
    const group = span.closest<HTMLElement>('.tl-block');
    const page = Number(span.closest<HTMLElement>('.page')?.dataset.page);
    if (!group?.dataset.key || !page) continue;
    const base = Number(span.dataset.start);
    const a = span.contains(range.startContainer) ? offsetIn(span, range.startContainer, range.startOffset, false) : 0;
    const b = span.contains(range.endContainer) ? offsetIn(span, range.endContainer, range.endOffset, true) : (span.textContent?.length ?? 0);
    if (b <= a) continue;
    const id = `${page}\n${group.dataset.key}`;
    const cur = merged.get(id);
    if (cur) {
      cur.start = Math.min(cur.start, base + a);
      cur.end = Math.max(cur.end, base + b);
    } else merged.set(id, { page, key: group.dataset.key, start: base + a, end: base + b });
  }
  return [...merged.values()];
}

/** 选区是否落在某个文字层里（含原文页） */
export function selectionInTextLayer(selection: Selection | null): boolean {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  return [...document.querySelectorAll('.text-layer')].some((layer) => selection.containsNode(layer, true));
}
