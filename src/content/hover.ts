import type { HoverKey } from '@/lib/settings';

function isEditable(el: Element | null): boolean {
  if (!el) return false;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable;
}

/**
 * 悬停翻译：鼠标停在段落上，单独按一下修饰键（按下再松开，中间没有按其他键/点鼠标）即触发。
 * 用「松开时触发」而不是「按下时触发」，是为了不和 Ctrl+C、Ctrl+点击 等组合操作冲突。
 */
export function setupHoverTrigger(
  getKey: () => HoverKey,
  onTrigger: (target: Element, x: number, y: number) => void,
  signal?: AbortSignal,
) {
  let x = -1;
  let y = -1;
  let armed = false;

  const opts = { capture: true, passive: true, signal } as const;
  window.addEventListener('mousemove', (e) => {
    x = e.clientX;
    y = e.clientY;
  }, opts);
  window.addEventListener('keydown', (e) => {
    const key = getKey();
    armed = key !== 'off' && e.key === key && !e.repeat && !isEditable(document.activeElement);
  }, opts);
  window.addEventListener('keyup', (e) => {
    if (!armed || e.key !== getKey()) return;
    armed = false;
    const target = x >= 0 ? document.elementFromPoint(x, y) : null;
    if (target) onTrigger(target, x, y);
  }, opts);
  window.addEventListener('mousedown', () => (armed = false), opts);
  window.addEventListener('blur', () => (armed = false), { signal });
}
