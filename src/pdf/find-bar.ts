import { findMatches, type FindMatch } from '@/lib/pdf/find';
import { rangeRects, type PageTextBlock } from '@/lib/pdf/page-text';

/**
 * 阅读器的查找栏（接管 Ctrl+F，设计见 docs/specs/2026-10-24-pdf-text-layer-design.md）：
 * 浏览器原生查找不能跨绝对定位的行匹配，中文换行处的词经常搜不到；这里在显示文本里搜，命中处叠框。
 */

export interface FindSource {
  texts(): [number, { blocks: PageTextBlock[]; width: number; height: number }][];
  translatedSlot(page: number): HTMLElement | undefined;
}

export interface FindBar {
  /** 某页文字变了：重新搜，尽量停在原来那个命中上 */
  refresh(): void;
}

const pct = (v: number) => `${(v * 100).toFixed(4)}%`;

export function setupFindBar(getSource: () => FindSource | undefined): FindBar {
  const bar = document.createElement('div');
  bar.className = 'find-bar';
  bar.id = 'find-bar';
  bar.hidden = true;
  const input = document.createElement('input');
  input.type = 'search';
  input.id = 'find-input';
  input.placeholder = '在译文中查找';
  const count = document.createElement('span');
  count.id = 'find-count';
  count.className = 'muted';
  const button = (label: string, title: string, onClick: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn';
    b.textContent = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', onClick);
    return b;
  };
  bar.append(input, count, button('↑', '上一个', () => step(-1)), button('↓', '下一个', () => step(1)), button('×', '关闭查找', close));
  document.body.append(bar);

  let matches: FindMatch[] = [];
  let current = -1;

  const geometry = (page: number) => getSource()?.texts().find(([p]) => p === page)?.[1];

  /** 命中处叠框：每页一个 find-layer，放在文字层下面，不挡选中 */
  function paint() {
    for (const layer of document.querySelectorAll('.find-layer')) layer.replaceChildren();
    const source = getSource();
    if (!source || bar.hidden) return;
    matches.forEach((m, i) => {
      const g = geometry(m.page);
      const block = g?.blocks.find((b) => b.key === m.key);
      const slot = source.translatedSlot(m.page);
      if (!g || !block || !slot) return;
      let layer = slot.querySelector<HTMLElement>('.find-layer');
      if (!layer) {
        layer = document.createElement('div');
        layer.className = 'find-layer';
        slot.querySelector('.text-layer')?.before(layer);
      }
      for (const r of rangeRects(block, m.start, m.end)) {
        const hit = document.createElement('div');
        hit.className = i === current ? 'find-hit current' : 'find-hit';
        hit.style.cssText = `left:${pct(r.x / g.width)};top:${pct(r.y / g.height)};width:${pct(r.w / g.width)};height:${pct(r.h / g.height)}`;
        layer.append(hit);
      }
    });
    count.textContent = input.value.trim() === '' ? '' : matches.length === 0 ? '无结果' : `${current + 1} / ${matches.length}`;
  }

  /** 把当前命中滚到视口中间 */
  function reveal() {
    const m = matches[current];
    const source = getSource();
    if (!m || !source) return;
    const slot = source.translatedSlot(m.page);
    const g = geometry(m.page);
    const block = g?.blocks.find((b) => b.key === m.key);
    const rect = block && g ? rangeRects(block, m.start, m.end)[0] : undefined;
    if (!slot || !g || !rect) return;
    const box = slot.getBoundingClientRect();
    const y = box.top + (rect.y / g.height) * box.height;
    const x = box.left + (rect.x / g.width) * box.width;
    window.scrollBy({ top: y - window.innerHeight / 2, left: x < 0 || x > window.innerWidth ? x - window.innerWidth / 2 : 0 });
  }

  /** 视口里最上面那一页的页码：新的查询从这里往后找第一个命中 */
  function firstVisiblePage(): number {
    for (const el of document.querySelectorAll<HTMLElement>('.page')) {
      if (el.getBoundingClientRect().bottom > 80) return Number(el.dataset.page);
    }
    return 1;
  }

  function search() {
    const source = getSource();
    matches = source ? findMatches(source.texts().map(([p, g]) => [p, g.blocks]), input.value) : [];
    const from = firstVisiblePage();
    current = matches.length === 0 ? -1 : Math.max(0, matches.findIndex((m) => m.page >= from));
    paint();
    reveal();
  }

  function step(delta: number) {
    if (matches.length === 0) return;
    current = (current + delta + matches.length) % matches.length;
    paint();
    reveal();
  }

  function open() {
    bar.hidden = false;
    input.focus();
    input.select();
    if (input.value.trim() !== '') search();
  }

  function close() {
    bar.hidden = true;
    paint();
  }

  input.addEventListener('input', search);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') close();
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      open();
    } else if (e.key === 'Escape' && !bar.hidden) close();
  });

  return {
    refresh() {
      if (bar.hidden || input.value.trim() === '') return;
      const prev = matches[current];
      const source = getSource();
      matches = source ? findMatches(source.texts().map(([p, g]) => [p, g.blocks]), input.value) : [];
      const same = prev ? matches.findIndex((m) => m.page === prev.page && m.key === prev.key && m.start === prev.start) : -1;
      current = matches.length === 0 ? -1 : same >= 0 ? same : Math.min(Math.max(current, 0), matches.length - 1);
      paint();
    },
  };
}
