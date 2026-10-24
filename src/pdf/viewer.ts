import type { GlossaryEntry } from '@/lib/glossary';
import { isProbablyInLanguage } from '@/lib/languages';
import { sendToBackground, type PageContext } from '@/lib/messages';
import { splitByColor } from '@/lib/pdf/color';
import { analyzePage, type PdfBlock } from '@/lib/pdf/layout';
import { getSettings, type Settings } from '@/lib/settings';
import { drawTranslatedPage, recordCoverage, type FontCoverage } from './draw';
import type { PdfDocument } from './loader';
import { extractText, renderPage, type Glyph } from './page-render';

/** 正文达到这个字数才抽取文章术语（同网页翻译），送去抽取的正文最多这么长 */
const TERMS_MIN_CHARS = 3000;
const TERMS_MAX_CHARS = 8000;
/** 等待术语抽取的上限：超时就不带术语先翻 */
const TERMS_TIMEOUT_MS = 10_000;

export type ViewMode = 'bilingual' | 'translation' | 'original';

interface PageState {
  index: number;
  el: HTMLElement;
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
    for (let i = 1; i <= this.doc.numPages; i++) {
      const page = await this.doc.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      const el = document.createElement('div');
      el.className = 'page';
      el.dataset.page = String(i);
      this.container.append(el);
      this.pages.push({ index: i, el, width: vp.width, height: vp.height, done: false, failed: 0 });
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
    page.el.replaceChildren();
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
    page.el.replaceChildren(original, translated);
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
    drawTranslatedPage(r.translated, r.background, r.glyphs, r.blocks, map, this.coverage);
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
