import { describe, expect, it } from 'vitest';
import { isFromPageUi, placeNear } from '@/content/ui/mount';

function panelOfSize(width: number, height: number): HTMLElement {
  const panel = document.createElement('div');
  panel.getBoundingClientRect = () => ({ width, height }) as DOMRect;
  return panel;
}

describe('placeNear', () => {
  it('默认放在锚点下方、左对齐', () => {
    const panel = panelOfSize(200, 100);
    placeNear(panel, { left: 50, top: 100, bottom: 120 });
    expect(panel.style.left).toBe('50px');
    expect(panel.style.top).toBe('128px');
  });

  it('下方放不下时翻到锚点上方，右侧越界时左移', () => {
    const panel = panelOfSize(300, 200);
    placeNear(panel, { left: innerWidth - 50, top: innerHeight - 40, bottom: innerHeight - 20 });
    expect(panel.style.top).toBe(`${innerHeight - 40 - 8 - 200}px`);
    expect(panel.style.left).toBe(`${innerWidth - 300 - 8}px`);
  });
});

describe('isFromPageUi', () => {
  it('事件路径经过 ptx-ui-* 宿主时为真', () => {
    const host = document.createElement('ptx-ui-demo');
    const shadow = host.attachShadow({ mode: 'open' });
    const button = document.createElement('button');
    shadow.append(button);
    document.documentElement.append(host);

    let fromUi: boolean | undefined;
    document.addEventListener('click', (e) => (fromUi = isFromPageUi(e)), { once: true });
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    expect(fromUi).toBe(true);

    document.addEventListener('click', (e) => (fromUi = isFromPageUi(e)), { once: true });
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(fromUi).toBe(false);
    host.remove();
  });
});
