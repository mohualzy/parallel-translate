import { browser } from 'wxt/browser';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { isProbablyInLanguage } from '@/lib/languages';
import { SELECTION_PORT, type SelectionEvent, type SelectionRequest } from '@/lib/messages';
import { isSingleWord } from '@/lib/providers/prompt';
import type { Settings } from '@/lib/settings';
import { OWN_TAG } from './dom';
import { onTeardown } from './lifecycle';
import { isFromPageUi, mountPageUi, placeNear, type PageUi } from './ui/mount';
import selectionCss from './ui/selection.css?inline';

const MAX_TEXT = 2000;
const CONTEXT_CHARS = 600;
const CONTEXT_BLOCK = 'p,li,td,th,dd,dt,blockquote,figcaption,h1,h2,h3,h4,h5,h6,div,article,section';

interface Captured {
  text: string;
  context: string;
  rect: DOMRect;
}

type Port = ReturnType<typeof browser.runtime.connect>;

/** 选区所在段落的文字（跳过本扩展插入的译文），过长时截取选区附近 */
export function contextOf(range: Range, selected: string): string {
  const start = range.commonAncestorContainer;
  const el = start.nodeType === Node.ELEMENT_NODE ? (start as Element) : start.parentElement;
  const block = el?.closest(CONTEXT_BLOCK) ?? document.body;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(`${OWN_TAG},script,style`) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let text = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) text += n.textContent;
  text = text.replace(/\s+/g, ' ').trim();
  if (text === selected || text.length <= CONTEXT_CHARS) return text === selected ? '' : text;
  const at = Math.max(0, text.indexOf(selected));
  const from = Math.max(0, at - CONTEXT_CHARS / 2);
  return text.slice(from, from + CONTEXT_CHARS);
}

/**
 * 划词翻译：选区捕获 → 触发模式（按钮 / 直接）→ 单例弹窗。
 * 弹窗只有一个，新查询覆盖旧查询并中止旧请求。
 */
export class SelectionTranslator {
  private ui?: Promise<PageUi>;
  private trigger?: HTMLButtonElement;
  private panel?: HTMLElement;
  private port?: Port;
  private captured?: Captured;

  constructor(
    private readonly ctx: ContentScriptContext,
    private readonly settings: () => Settings,
  ) {
    const { signal } = ctx;
    document.addEventListener('mouseup', (e) => this.onMouseUp(e), { capture: true, signal });
    document.addEventListener('mousedown', (e) => this.onMouseDown(e), { capture: true, signal });
    document.addEventListener('keydown', (e) => e.key === 'Escape' && this.closeAll(), { capture: true, signal });
    window.addEventListener('scroll', () => this.hideTrigger(), { capture: true, passive: true, signal });
    // 失效时断开划词长连接（后台随之中止请求）
    onTeardown(ctx, () => this.closeAll());
  }

  private onMouseUp(e: MouseEvent) {
    if (isFromPageUi(e) || this.settings().selectionMode === 'off') return;
    // 等浏览器更新完选区再读
    setTimeout(() => void this.capture(), 0);
  }

  private onMouseDown(e: MouseEvent) {
    if (isFromPageUi(e)) return;
    this.hideTrigger();
    this.closePanel();
  }

  private async capture() {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const text = selection.toString().replace(/\s+/g, ' ').trim();
    if (!text || text.length > MAX_TEXT || !/\p{L}/u.test(text)) return;
    if (isProbablyInLanguage(text, this.settings().targetLang)) return;

    const range = selection.getRangeAt(0);
    const anchor = range.commonAncestorContainer;
    const el = anchor.nodeType === Node.ELEMENT_NODE ? (anchor as Element) : anchor.parentElement;
    // 选中的是译文本身（多半是想复制），或在编辑区内，不打扰
    if (!el || el.closest(OWN_TAG) || (el as HTMLElement).isContentEditable) return;

    const rects = range.getClientRects();
    const rect = rects[rects.length - 1] ?? range.getBoundingClientRect();
    this.captured = { text, context: contextOf(range, text), rect };
    await this.ensureUi();
    if (this.settings().selectionMode === 'direct') this.openPanel();
    else this.showTrigger(rect);
  }

  private ensureUi(): Promise<PageUi> {
    this.ui ??= mountPageUi(this.ctx, 'selection', selectionCss).then((ui) => {
      ui.root.innerHTML = `
        <button class="trigger" type="button" title="翻译选中文本" hidden>译</button>
        <div class="panel" role="dialog" aria-label="划词翻译" hidden>
          <div class="head">
            <span class="title">划词翻译</span>
            <button class="copy" type="button">复制</button>
            <button class="close" type="button" aria-label="关闭">×</button>
          </div>
          <div class="source"></div>
          <div class="result" aria-live="polite"></div>
        </div>`;
      this.trigger = ui.root.querySelector<HTMLButtonElement>('.trigger')!;
      this.panel = ui.root.querySelector<HTMLElement>('.panel')!;
      // 按下按钮时阻止默认行为，否则页面选区会被清掉
      this.trigger.addEventListener('mousedown', (e) => e.preventDefault());
      this.trigger.addEventListener('click', () => this.openPanel());
      ui.root.querySelector('.close')!.addEventListener('click', () => this.closePanel());
      ui.root.querySelector('.copy')!.addEventListener('click', (e) => void this.copy(e.currentTarget as HTMLButtonElement));
      // 宿主隔离了按键事件，弹窗内按 Esc 需要在这里处理
      ui.root.addEventListener('keydown', (e) => e.key === 'Escape' && this.closeAll());
      return ui;
    });
    return this.ui;
  }

  private showTrigger(rect: DOMRect) {
    const trigger = this.trigger;
    if (!trigger) return;
    trigger.hidden = false;
    trigger.style.left = `${Math.min(rect.right + 4, innerWidth - 34)}px`;
    trigger.style.top = `${Math.min(rect.bottom + 4, innerHeight - 34)}px`;
  }

  private hideTrigger() {
    if (this.trigger) this.trigger.hidden = true;
  }

  private openPanel() {
    const { panel, captured } = this;
    if (!panel || !captured) return;
    this.hideTrigger();
    const word = isSingleWord(captured.text);
    panel.dataset.mode = word ? 'word' : 'sentence';
    panel.querySelector('.source')!.textContent = captured.text;
    const result = panel.querySelector<HTMLElement>('.result')!;
    // data-state：loading → streaming → done | error，样式与测试都以它为准
    const show = (state: 'loading' | 'streaming' | 'done' | 'error', text: string) => {
      result.dataset.state = state;
      result.textContent = text;
    };
    show('loading', '翻译中…');
    panel.hidden = false;
    placeNear(panel, captured.rect);

    this.port?.disconnect();
    const port = browser.runtime.connect({ name: SELECTION_PORT });
    this.port = port;
    let received = '';
    port.onMessage.addListener((event: SelectionEvent) => {
      if (this.port !== port) return;
      if (event.type === 'delta') {
        received += event.delta;
        show('streaming', received);
      } else if (event.type === 'done') {
        show('done', event.text);
      } else {
        show('error', `翻译失败：${event.error}`);
      }
      placeNear(panel, captured.rect);
    });
    port.postMessage({ text: captured.text, context: captured.context, word } satisfies SelectionRequest);
  }

  private closePanel() {
    if (this.panel) this.panel.hidden = true;
    this.port?.disconnect();
    this.port = undefined;
  }

  private closeAll() {
    this.hideTrigger();
    this.closePanel();
  }

  private async copy(button: HTMLButtonElement) {
    const text = this.panel?.querySelector('.result')?.textContent ?? '';
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = '已复制';
    } catch {
      button.textContent = '复制失败';
    }
    setTimeout(() => (button.textContent = '复制'), 1500);
  }
}
