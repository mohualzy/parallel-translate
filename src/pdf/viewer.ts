import type { GlossaryEntry } from '@/lib/glossary';
import { addHighlight, locate, removeRange, type HighlightEntry, type HighlightStyle, type PdfHighlight, type TextRange } from '@/lib/pdf/highlights';
import { rangeRects, type PageTextBlock } from '@/lib/pdf/page-text';
import { isProbablyInLanguage } from '@/lib/languages';
import { sendToBackground, type PageContext } from '@/lib/messages';
import { splitByColor } from '@/lib/pdf/color';
import { analyzePage, type PdfBlock } from '@/lib/pdf/layout';
import { getSettings, type Settings } from '@/lib/settings';
import { drawHighlights, drawTranslatedPage, recordCoverage, type FontCoverage, type HighlightMarks } from './draw';
import { loadHighlights, saveHighlights } from './highlight-store';
import type { PdfDocument } from './loader';
import { extractText, renderPage, type Glyph } from './page-render';
import { renderTextLayer } from './text-layer';

/** 正文达到这个字数才抽取文章术语（同网页翻译），送去抽取的正文最多这么长 */
const TERMS_MIN_CHARS = 3000;
const TERMS_MAX_CHARS = 8000;
/** 等待术语抽取的上限：超时就不带术语先翻 */
const TERMS_TIMEOUT_MS = 10_000;

export type ViewMode = 'bilingual' | 'translation' | 'original';

interface PageState {
  index: number;
  el: HTMLElement;
  /** 原文页、译文页两个槽位；释放时只删画布，译文页的文字层留着（看过的页 Ctrl+F 都搜得到） */
  originalSlot: HTMLElement;
  translatedSlot: HTMLElement;
  layer: HTMLElement;
  /** 页面在缩放 1 时的尺寸（PDF 点） */
  width: number;
  height: number;
  rendered?: {
    scale: number;
    background: HTMLCanvasElement;
    glyphs: Glyph[];
    blocks: PdfBlock[];
    translated: HTMLCanvasElement;
  };
  rendering?: Promise<void>;
  /** 本页要翻译的块已全部有结果（成功或失败） */
  done: boolean;
  failed: number;
}

export interface ViewerEvents {
  onProgress(done: number, total: number, failed: number): void;
  onError(message: string): void;
  onNotice(message: string): void;
}

/**
 * PDF 双语阅读器（设计见 docs/specs/2026-10-24-pdf-bilingual-design.md）：
 * 每页左右两个 canvas，接近视口才渲染、翻译；离得很远的页面释放 canvas 控制内存。
 */
export class PdfViewer {
  private settings!: Settings;
  private pages: PageState[] = [];
  /** 块原文 → 译文（同一文档内复用；后台另有持久缓存） */
  private translations = new Map<string, string>();
  private failures = new Map<string, string>();
  private terms: GlossaryEntry[] = [];
  /** 各 PDF 字体画过的字符（跨页累积） */
  private coverage: FontCoverage = new Map();
  private termsReady: Promise<void> = Promise.resolve();
  private near?: IntersectionObserver;
  private far?: IntersectionObserver;
  private generation = 0;
  /** 划词强调（按文档保存）与各页最近一次画出的文字几何（定位强调用） */
  private highlights: PdfHighlight[] = [];
  /** 各页最近一次画出的文字几何与画布尺寸；画布释放后仍保留，查找、强调定位都用它 */
  private pageTexts = new Map<number, { blocks: PageTextBlock[]; width: number; height: number }>();
  /** 某页的文字重画了（译文到达、换字体、缩放）：查找栏据此刷新命中 */
  onTextChange?: (page: number) => void;
  /** 强调增删了（工具栏计数、强调面板据此刷新） */
  onHighlightsChange?: () => void;
  private docId = '';
  zoom = 1;
  mode: ViewMode = 'bilingual';
  profile = 'general';
  autoProfile = 'general';

  constructor(
    private readonly doc: PdfDocument,
    private readonly container: HTMLElement,
    private readonly title: string,
    private readonly events: ViewerEvents,
  ) {}

  async init() {
    this.settings = await getSettings();
    this.docId = this.doc.fingerprints[0] ?? this.title;
    this.highlights = await loadHighlights(this.docId).catch(() => []);
    for (let i = 1; i <= this.doc.numPages; i++) {
      const page = await this.doc.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      const el = document.createElement('div');
      el.className = 'page';
      el.dataset.page = String(i);
      const originalSlot = document.createElement('div');
      originalSlot.className = 'slot original';
      const translatedSlot = document.createElement('div');
      translatedSlot.className = 'slot translated';
      const layer = document.createElement('div');
      layer.className = 'text-layer';
      translatedSlot.append(layer);
      el.append(originalSlot, translatedSlot);
      this.container.append(el);
      this.pages.push({ index: i, el, originalSlot, translatedSlot, layer, width: vp.width, height: vp.height, done: false, failed: 0 });
    }
    const firstText = await this.collectText(5);
    this.autoProfile = /\bAbstract\b|arXiv/i.test(firstText.slice(0, 4000)) ? 'paper' : 'general';
    this.profile = this.autoProfile;
    this.termsReady = this.extractTerms(firstText);
    this.layoutPages();
  }

  /** 前几页的纯文本：判断风格、抽取文章术语（不需要渲染） */
  private async collectText(maxPages: number): Promise<string> {
    let text = '';
    for (let i = 1; i <= Math.min(maxPages, this.doc.numPages) && text.length < TERMS_MAX_CHARS; i++) {
      const content = await (await this.doc.getPage(i)).getTextContent();
      text += content.items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : '') : '')).join('');
    }
    return text;
  }

  private async extractTerms(text: string) {
    if (!this.settings.extractTerms || text.length < TERMS_MIN_CHARS) return;
    const timeout = new Promise<GlossaryEntry[]>((resolve) => setTimeout(() => resolve([]), TERMS_TIMEOUT_MS));
    const terms = await Promise.race([sendToBackground({ type: 'extract-terms', text: text.slice(0, TERMS_MAX_CHARS) }).catch(() => []), timeout]);
    this.terms = terms;
  }

  /** 页面的 CSS 尺寸：双语模式两页并排，按容器宽度适配，再乘缩放 */
  private cssScale(page: PageState): number {
    const columns = this.mode === 'bilingual' ? 2 : 1;
    const available = Math.max(320, this.container.clientWidth - 48) / columns - 12;
    return (available / page.width) * this.zoom;
  }

  /** 重新排列所有页（初次、缩放、切换显示方式、窗口尺寸变化）：已渲染的页释放，按需重画 */
  layoutPages() {
    this.generation++;
    this.near?.disconnect();
    this.far?.disconnect();
    this.container.dataset.mode = this.mode;
    for (const page of this.pages) {
      const scale = this.cssScale(page);
      page.el.style.setProperty('--w', `${page.width * scale}px`);
      page.el.style.setProperty('--h', `${page.height * scale}px`);
      this.release(page);
    }
    this.near = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) void this.show(this.pages[Number((e.target as HTMLElement).dataset.page) - 1]!);
    }, { rootMargin: '100% 0px' });
    this.far = new IntersectionObserver((entries) => {
      for (const e of entries) if (!e.isIntersecting) this.release(this.pages[Number((e.target as HTMLElement).dataset.page) - 1]!);
    }, { rootMargin: '400% 0px' });
    for (const page of this.pages) {
      this.near.observe(page.el);
      this.far.observe(page.el);
    }
  }

  private release(page: PageState) {
    page.originalSlot.replaceChildren();
    page.translatedSlot.querySelector('canvas')?.remove();
    page.rendered = undefined;
    page.rendering = undefined;
  }

  private show(page: PageState): Promise<void> {
    page.rendering ??= this.renderAndTranslate(page).catch((err: unknown) => this.events.onError(err instanceof Error ? err.message : String(err)));
    return page.rendering;
  }

  private async renderAndTranslate(page: PageState) {
    const generation = this.generation;
    const pdfPage = await this.doc.getPage(page.index);
    const dpr = window.devicePixelRatio || 1;
    const viewport = pdfPage.getViewport({ scale: this.cssScale(page) * dpr });
    const { original, background, glyphs } = await renderPage(pdfPage, viewport);
    const { items, type3 } = await extractText(pdfPage, viewport);
    if (generation !== this.generation) return;
    recordCoverage(this.coverage, glyphs);
    const blocks = analyzePage(splitByColor(items, glyphs), viewport.width);
    const translated = document.createElement('canvas');
    translated.width = background.width;
    translated.height = background.height;
    for (const [canvas, kind] of [
      [original, 'original'],
      [translated, 'translated'],
    ] as const) canvas.className = kind;
    page.originalSlot.replaceChildren(original);
    page.translatedSlot.querySelector('canvas')?.remove();
    page.translatedSlot.prepend(translated);
    page.rendered = { scale: viewport.scale, background, glyphs, blocks, translated };
    this.redraw(page);
    if (type3) {
      // Type3 字体用路径画字，去不掉原字形，译文会和原文叠在一起：这一页只显示原文
      page.el.dataset.type3 = '';
      this.events.onNotice(`第 ${page.index} 页使用了无法分离的字体，译文页暂显示原文`);
      page.done = true;
      this.reportProgress();
      return;
    }
    await this.translatePage(page, generation);
  }

  /** 这一页需要翻译的块：不保留原文、有字母、不是目标语言 */
  private pending(page: PageState): PdfBlock[] {
    return (page.rendered?.blocks ?? []).filter((b) => {
      if (b.keep || this.translations.has(b.text)) return false;
      const plain = b.text.replace(/<x\d+\/>/g, '');
      return !isProbablyInLanguage(plain, this.settings.targetLang);
    });
  }

  private async translatePage(page: PageState, generation: number) {
    await this.termsReady;
    const todo = this.pending(page);
    const context: PageContext = { title: this.title, summary: '', profile: this.profile, terms: this.terms, fixedLayout: true };
    const batches: PdfBlock[][] = [];
    let chars = 0;
    for (const b of todo) {
      const last = batches.at(-1);
      if (!last || last.length >= this.settings.batchMaxSegments || chars + b.text.length > this.settings.batchMaxChars) {
        batches.push([b]);
        chars = b.text.length;
      } else {
        last.push(b);
        chars += b.text.length;
      }
    }
    await Promise.all(
      batches.map(async (batch) => {
        try {
          const res = await sendToBackground({ type: 'translate', segments: batch.map((b) => b.text), page: context });
          batch.forEach((b, i) => {
            const t = res.translations[i];
            if (t) this.translations.set(b.text, t);
            else this.failures.set(b.text, res.error ?? '翻译失败');
          });
        } catch (err) {
          for (const b of batch) this.failures.set(b.text, err instanceof Error ? err.message : String(err));
        }
        if (generation === this.generation) this.redraw(page);
      }),
    );
    if (generation !== this.generation) return;
    page.failed = todo.filter((b) => this.failures.has(b.text) && !this.translations.has(b.text)).length;
    page.done = true;
    this.reportProgress();
    if (page.failed > 0) this.events.onError(`第 ${page.index} 页有 ${page.failed} 段翻译失败：${this.failures.get(todo.find((b) => this.failures.has(b.text))!.text)}`);
  }

  private redraw(page: PageState) {
    const r = page.rendered;
    if (!r) return;
    const map = new Map<PdfBlock, string>();
    for (const b of r.blocks) {
      const t = this.translations.get(b.text);
      if (t !== undefined) map.set(b, t);
    }
    const pageText = drawTranslatedPage(r.translated, r.background, r.glyphs, r.blocks, map, this.coverage, this.settings.pdfCjkFont);
    this.pageTexts.set(page.index, { blocks: pageText, width: r.translated.width, height: r.translated.height });
    drawHighlights(r.translated.getContext('2d')!, pageText, this.marksFor(page.index, pageText));
    renderTextLayer(page.layer, pageText, r.translated.width, r.translated.height);
    this.onTextChange?.(page.index);
    // 译文画在 canvas 上，DOM 里读不到；把已翻译的段落数写在页面元素上，便于测试与排查
    page.el.dataset.translated = String(map.size);
  }

  private reportProgress() {
    this.events.onProgress(
      this.pages.filter((p) => p.done).length,
      this.pages.length,
      this.pages.reduce((n, p) => n + p.failed, 0),
    );
  }

  /** 换风格：译文要按新风格重翻（后台缓存键含风格，不会误用旧译文） */
  setProfile(profile: string) {
    if (profile === this.profile) return;
    this.profile = profile;
    this.translations.clear();
    this.failures.clear();
    for (const p of this.pages) {
      p.done = false;
      p.failed = 0;
    }
    this.layoutPages();
  }

  /** 本页要画的强调：按块当前的显示文本定位，定位不到的暂不画 */
  private marksFor(index: number, pageText: PageTextBlock[]): HighlightMarks {
    const marks: HighlightMarks = new Map();
    for (const h of this.highlights) {
      if (h.page !== index) continue;
      const text = pageText.find((b) => b.key === h.key)?.text;
      const at = text === undefined ? undefined : locate(h, text);
      if (!at) continue;
      let list = marks.get(h.key);
      if (!list) marks.set(h.key, (list = []));
      list.push({ ...at, style: h.style });
    }
    return marks;
  }

  private textOf = (page: number, key: string) => this.pageTexts.get(page)?.blocks.find((b) => b.key === key)?.text;

  /** 看过的各页文字，按页码排序 */
  texts(): [number, { blocks: PageTextBlock[]; width: number; height: number }][] {
    return [...this.pageTexts.entries()].sort((a, b) => a[0] - b[0]);
  }

  /** 第 index 页的译文槽位（叠命中框、滚动定位用） */
  translatedSlot(index: number): HTMLElement | undefined {
    return this.pages[index - 1]?.translatedSlot;
  }

  /** 选区里是否已有强调（工具条据此显示「清除」） */
  hasHighlight(ranges: TextRange[]): boolean {
    return ranges.some((r) =>
      this.highlights.some((h) => {
        if (h.page !== r.page || h.key !== r.key) return false;
        const text = this.textOf(h.page, h.key);
        const at = text === undefined ? undefined : locate(h, text);
        return at !== undefined && at.start < r.end && at.end > r.start;
      }),
    );
  }

  /** 给选区加强调（style）或清除选区里的强调（undefined），保存后重画涉及的页 */
  async setHighlight(ranges: TextRange[], style: HighlightStyle | undefined) {
    for (const r of ranges) {
      this.highlights = style === undefined ? removeRange(this.highlights, r, this.textOf) : addHighlight(this.highlights, r, style, this.textOf);
    }
    for (const index of new Set(ranges.map((r) => r.page))) this.redraw(this.pages[index - 1]!);
    this.onHighlightsChange?.();
    await saveHighlights(this.docId, this.highlights);
  }

  /** 删除一条强调（强调面板） */
  async removeHighlight(id: string) {
    const h = this.highlights.find((x) => x.id === id);
    if (!h) return;
    this.highlights = this.highlights.filter((x) => x.id !== id);
    this.redraw(this.pages[h.page - 1]!);
    this.onHighlightsChange?.();
    await saveHighlights(this.docId, this.highlights);
  }

  /**
   * 强调列表，按阅读顺序：页码、块在页内的顺序、块内位置。
   * 这一页本次打开后看过才知道块的顺序和原文，没看过的页按保存时的偏移排、不带原文。
   */
  highlightEntries(): (HighlightEntry & { id: string })[] {
    const placed = this.highlights.map((h) => {
      const blocks = this.pageTexts.get(h.page)?.blocks;
      const index = blocks?.findIndex((b) => b.key === h.key) ?? -1;
      const block = index >= 0 ? blocks![index] : undefined;
      const at = block ? locate(h, block.text) : undefined;
      return { h, order: index >= 0 ? index : Infinity, start: at?.start ?? h.start, source: block?.translated ? block.source : undefined };
    });
    placed.sort((a, b) => a.h.page - b.h.page || a.order - b.order || a.start - b.start);
    return placed.map(({ h, source }) => ({ id: h.id, page: h.page, key: h.key, style: h.style, quote: h.quote, source }));
  }

  /** 滚到某条强调：这一页看过就定位到那一行，否则滚到页首（滚到后会渲染、画出强调） */
  revealHighlight(id: string) {
    const h = this.highlights.find((x) => x.id === id);
    const page = h && this.pages[h.page - 1];
    if (!h || !page) return;
    const geometry = this.pageTexts.get(h.page);
    const block = geometry?.blocks.find((b) => b.key === h.key);
    const at = block ? locate(h, block.text) : undefined;
    const rect = block && at ? rangeRects(block, at.start, at.end)[0] : undefined;
    if (!geometry || !rect) {
      page.el.scrollIntoView({ block: 'start' });
      return;
    }
    const box = page.translatedSlot.getBoundingClientRect();
    window.scrollBy({ top: box.top + (rect.y / geometry.height) * box.height - window.innerHeight / 3 });
  }

  /** 换译文中文字体：只用已有译文重画已渲染的页，不重新渲染 PDF、不重新请求翻译 */
  setCjkFont(font: string) {
    if (font === this.settings.pdfCjkFont) return;
    this.settings = { ...this.settings, pdfCjkFont: font };
    for (const page of this.pages) this.redraw(page);
  }

  setMode(mode: ViewMode) {
    this.mode = mode;
    this.layoutPages();
  }

  setZoom(zoom: number) {
    this.zoom = Math.min(3, Math.max(0.5, zoom));
    this.layoutPages();
  }

  /** 重试失败的段落：清掉失败记录，可见的页重新请求 */
  retryFailed() {
    this.failures.clear();
    for (const p of this.pages) {
      p.done = false;
      p.failed = 0;
    }
    this.layoutPages();
  }
}
