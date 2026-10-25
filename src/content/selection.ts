import { browser } from 'wxt/browser';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { isProbablyInLanguage } from '@/lib/languages';
import { SELECTION_PORT, type SelectionEvent, type SelectionRequest } from '@/lib/messages';
import { isSingleWord } from '@/lib/providers/prompt';
import type { Settings } from '@/lib/settings';
import { OWN_TAG } from './dom';
import { onTeardown } from './lifecycle';
import { highlightSupported, MARK_STYLES, PageMarks, type MarkStyle } from './marks';
import { isFromPageUi, mountPageUi, placeNear, type PageUi } from './ui/mount';
import selectionCss from './ui/selection.css?inline';

const MAX_TEXT = 2000;
const CONTEXT_CHARS = 600;
const CONTEXT_BLOCK = 'p,li,td,th,dd,dt,blockquote,figcaption,h1,h2,h3,h4,h5,h6,div,article,section';

interface Captured {
  text: string;
  context: string;
  rect: DOMRect;
  /** 选区的副本：点强调按钮时选区可能已经变了 */
  range: Range;
}

const MARK_TITLES: Record<MarkStyle, string> = { yellow: '黄色高亮', green: '绿色高亮', blue: '蓝色高亮', pink: '粉色高亮', underline: '下划线' };

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
 * 选区旁的工具条同时提供划词强调（高亮、下划线，只在当前页面有效，见 marks.ts）：
 * 「译」只在可翻译的选区出现，强调按钮对任何选区都出现（中文、译文也行）。
 */
export class SelectionTranslator {
  private ui?: Promise<PageUi>;
  private bar?: HTMLElement;
  private trigger?: HTMLButtonElement;
  private markButtons?: HTMLElement;
  private unmark?: HTMLButtonElement;
  private readonly marks = highlightSupported() ? new PageMarks() : undefined;
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
    window.addEventListener('scroll', () => this.hideBar(), { capture: true, passive: true, signal });
    // 失效时断开划词长连接（后台随之中止请求）
    onTeardown(ctx, () => this.closeAll());
  }

  private onMouseUp(e: MouseEvent) {
    const settings = this.settings();
    if (isFromPageUi(e) || (settings.selectionMode === 'off' && !settings.pageMarks)) return;
    // 等浏览器更新完选区再读
    setTimeout(() => void this.capture(), 0);
  }

  private onMouseDown(e: MouseEvent) {
    if (isFromPageUi(e)) return;
    this.hideBar();
    this.closePanel();
  }

  private async capture() {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const text = selection.toString().replace(/\s+/g, ' ').trim();
    if (!text) return;
    const range = selection.getRangeAt(0);
    const anchor = range.commonAncestorContainer;
    const el = anchor.nodeType === Node.ELEMENT_NODE ? (anchor as Element) : anchor.parentElement;
    // 编辑区里的选区（写东西时选中）不打扰
    if (!el || (el as HTMLElement).isContentEditable) return;

    const settings = this.settings();
    // 可翻译：非目标语言、不是译文本身（选中译文多半是想复制）
    const canTranslate =
      settings.selectionMode !== 'off' &&
      text.length <= MAX_TEXT &&
      /\p{L}/u.test(text) &&
      !isProbablyInLanguage(text, settings.targetLang) &&
      !el.closest(OWN_TAG);
    const canMark = settings.pageMarks && this.marks !== undefined;
    if (!canTranslate && !canMark) return;

    const rects = range.getClientRects();
    const rect = rects[rects.length - 1] ?? range.getBoundingClientRect();
    this.captured = { text, context: canTranslate ? contextOf(range, text) : '', rect, range: range.cloneRange() };
    await this.ensureUi();
    const direct = canTranslate && settings.selectionMode === 'direct';
    if (direct) this.openPanel();
    // 直接翻译时弹窗在选区下方，工具条放到选区上方，免得挡住
    this.showBar(rect, { translate: canTranslate && !direct, marks: canMark, above: direct });
  }

  private ensureUi(): Promise<PageUi> {
    this.ui ??= mountPageUi(this.ctx, 'selection', selectionCss).then((ui) => {
      const markButtons = MARK_STYLES.map(
        (st) =>
          `<button class="mark mark-${st}" type="button" data-style="${st}" title="${MARK_TITLES[st]}" aria-label="${MARK_TITLES[st]}">${st === 'underline' ? 'U' : ''}</button>`,
      ).join('');
      ui.root.innerHTML = `
        <div class="bar" hidden>
          <button class="trigger" type="button" title="翻译选中文本">译</button>
          <span class="marks">${markButtons}<button class="unmark" type="button" title="清除选中部分的强调">清除</button></span>
        </div>
        <div class="panel" role="dialog" aria-label="划词翻译" hidden>
          <div class="head">
            <span class="title">划词翻译</span>
            <button class="copy" type="button">复制</button>
            <button class="close" type="button" aria-label="关闭">×</button>
          </div>
          <div class="source"></div>
          <div class="result" aria-live="polite"></div>
        </div>`;
      this.bar = ui.root.querySelector<HTMLElement>('.bar')!;
      this.trigger = ui.root.querySelector<HTMLButtonElement>('.trigger')!;
      this.markButtons = ui.root.querySelector<HTMLElement>('.marks')!;
      this.unmark = ui.root.querySelector<HTMLButtonElement>('.unmark')!;
      this.panel = ui.root.querySelector<HTMLElement>('.panel')!;
      // 按下按钮时阻止默认行为，否则页面选区会被清掉
      this.bar.addEventListener('mousedown', (e) => e.preventDefault());
      this.trigger.addEventListener('click', () => this.openPanel());
      for (const b of this.markButtons.querySelectorAll<HTMLButtonElement>('.mark')) {
        b.addEventListener('click', () => this.applyMark(b.dataset.style as MarkStyle));
      }
      this.unmark.addEventListener('click', () => this.applyMark(undefined));
      ui.root.querySelector('.close')!.addEventListener('click', () => this.closePanel());
      ui.root.querySelector('.copy')!.addEventListener('click', (e) => void this.copy(e.currentTarget as HTMLButtonElement));
      // 宿主隔离了按键事件，弹窗内按 Esc 需要在这里处理
      ui.root.addEventListener('keydown', (e) => e.key === 'Escape' && this.closeAll());
      return ui;
    });
    return this.ui;
  }

  private showBar(rect: DOMRect, show: { translate: boolean; marks: boolean; above: boolean }) {
    const { bar, trigger, markButtons, unmark, captured } = this;
    if (!bar || !trigger || !markButtons || !unmark || !captured) return;
    if (!show.translate && !show.marks) {
      this.hideBar();
      return;
    }
    trigger.hidden = !show.translate;
    markButtons.hidden = !show.marks;
    unmark.hidden = !this.marks?.overlaps(captured.range);
    bar.hidden = false;
    const { width, height } = bar.getBoundingClientRect();
    bar.style.left = `${Math.max(4, Math.min(rect.right + 4, innerWidth - width - 8))}px`;
    bar.style.top = `${show.above ? Math.max(4, rect.top - height - 6) : Math.min(rect.bottom + 4, innerHeight - height - 4)}px`;
  }

  private hideBar() {
    if (this.bar) this.bar.hidden = true;
  }

  /** 给选区加强调（style）或清除选区里的强调（undefined），然后收起选区和工具条 */
  private applyMark(style: MarkStyle | undefined) {
    const range = this.captured?.range;
    if (!range || !this.marks) return;
    if (style) this.marks.add(range, style);
    else this.marks.clear(range);
    document.getSelection()?.removeAllRanges();
    this.hideBar();
  }

  private openPanel() {
    const { panel, captured } = this;
    if (!panel || !captured) return;
    this.hideBar();
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
    this.hideBar();
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
