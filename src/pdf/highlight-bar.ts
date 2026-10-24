import type { HighlightStyle, TextRange } from '@/lib/pdf/highlights';
import { selectionInTextLayer, selectionRanges } from './text-layer';

/** 选中译文页文字后弹出的工具条：高亮颜色、下划线、复制、清除；在原文页选中时只有「复制」 */

export interface HighlightBarActions {
  apply(ranges: TextRange[], style: HighlightStyle | undefined): void;
  hasHighlight(ranges: TextRange[]): boolean;
}

const SWATCHES: [HighlightStyle, string, string][] = [
  ['yellow', '#ffe45c', '黄色高亮'],
  ['green', '#a8eb9a', '绿色高亮'],
  ['blue', '#a5d4ff', '蓝色高亮'],
  ['pink', '#ffb3d1', '粉色高亮'],
];

export function setupHighlightBar(pages: HTMLElement, actions: HighlightBarActions): void {
  const bar = document.createElement('div');
  bar.className = 'hl-bar';
  bar.id = 'hl-bar';
  bar.hidden = true;
  const button = (label: string, title: string, onClick: () => void, className = '') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  };
  let ranges: TextRange[] = [];
  const done = () => {
    bar.hidden = true;
    window.getSelection()?.removeAllRanges();
  };
  const apply = (style: HighlightStyle | undefined) => () => {
    actions.apply(ranges, style);
    done();
  };
  const clear = button('清除', '清除选中部分的强调', apply(undefined));
  for (const [style, color, title] of SWATCHES) {
    const b = button('', title, apply(style), 'swatch');
    b.dataset.style = style;
    b.style.setProperty('--c', color);
    bar.append(b);
  }
  const underline = button('U', '下划线', apply('underline'), 'underline');
  underline.dataset.style = 'underline';
  bar.append(
    underline,
    button('复制', '复制选中的文字', () => {
      void navigator.clipboard.writeText(window.getSelection()?.toString() ?? '');
      done();
    }),
    clear,
  );
  // 点工具条不能让选区消失
  bar.addEventListener('mousedown', (e) => e.preventDefault());
  document.body.append(bar);

  const show = () => {
    const selection = window.getSelection();
    ranges = selectionRanges(selection);
    if (ranges.length === 0 && !selectionInTextLayer(selection)) {
      bar.hidden = true;
      return;
    }
    bar.classList.toggle('copy-only', ranges.length === 0);
    clear.hidden = ranges.length === 0 || !actions.hasHighlight(ranges);
    const rects = [...selection!.getRangeAt(0).getClientRects()].filter((r) => r.width > 0);
    const last = rects.at(-1) ?? selection!.getRangeAt(0).getBoundingClientRect();
    bar.hidden = false;
    const { width, height } = bar.getBoundingClientRect();
    const left = Math.min(Math.max(8, last.right - width / 2), window.innerWidth - width - 8);
    // 优先放在选区下方，放不下放上方；都夹在视口内（选区可能已滚出视口）
    const below = last.bottom + 8;
    const top = below + height > window.innerHeight - 8 ? last.top - height - 8 : below;
    bar.style.left = `${left}px`;
    bar.style.top = `${Math.min(Math.max(8, top), window.innerHeight - height - 8)}px`;
  };
  // 松开鼠标、键盘调整选区后再看选区（等浏览器更新完选区）
  pages.addEventListener('mouseup', () => setTimeout(show, 0));
  pages.addEventListener('keyup', () => setTimeout(show, 0));
  document.addEventListener('mousedown', (e) => {
    if (!bar.contains(e.target as Node)) bar.hidden = true;
  });
  window.addEventListener('scroll', () => (bar.hidden = true), { passive: true });
}
