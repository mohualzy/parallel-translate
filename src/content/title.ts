import { sendToBackground } from '@/lib/messages';
import type { Settings } from '@/lib/settings';
import { pageSummary } from './page-context';
import { escapeText, sameText, unescapeText } from './richtext';

/**
 * 标签页标题翻译：开启翻译时把 document.title 换成译文，关闭时还原。
 * 页面自己改标题（SPA 切换路由）时，以新标题为原文重新翻译。
 */
export class TitleTranslator {
  private original = '';
  private translated = '';
  private active = false;
  /** 每次重新翻译或停止时自增，丢弃过期结果 */
  private generation = 0;
  private observer?: MutationObserver;

  constructor(
    private readonly settings: () => Settings,
    private readonly isWorthTranslating: (text: string) => boolean,
  ) {}

  /** 页面的原始标题（发给模型做上下文时用它，而不是已翻译的标题） */
  get originalTitle(): string {
    return this.active ? this.original : document.title;
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.original = document.title;
    this.observer = new MutationObserver(() => this.onTitleChange());
    this.observer.observe(document.head ?? document.documentElement, { childList: true, subtree: true, characterData: true });
    void this.translate();
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.generation++;
    this.observer?.disconnect();
    if (this.translated && document.title === this.translated) document.title = this.original;
    this.translated = '';
  }

  private onTitleChange() {
    const now = document.title;
    // 我们自己设置的译文，或没有变化
    if (now === this.translated || now === this.original) return;
    this.original = now;
    this.translated = '';
    void this.translate();
  }

  private async translate() {
    const generation = ++this.generation;
    const title = this.original.trim();
    if (!this.settings().translateTitle || !title || !this.isWorthTranslating(title)) return;
    try {
      const res = await sendToBackground({
        type: 'translate',
        segments: [escapeText(title)],
        page: { title, summary: pageSummary() },
      });
      const text = res.translations[0];
      if (!text || generation !== this.generation || !this.active || document.title !== this.original) return;
      const plain = unescapeText(text.replace(/<\/?[gx]\d+\s*\/?>/g, '')).trim();
      if (!plain || sameText(plain, title)) return;
      this.translated = plain;
      document.title = plain;
    } catch {
      // 标题翻译失败不影响正文翻译
    }
  }
}
