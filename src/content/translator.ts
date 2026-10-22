import { isProbablyInLanguage } from '@/lib/languages';
import { sendToBackground, type TabState } from '@/lib/messages';
import type { Settings } from '@/lib/settings';
import { collectRuns, runContainsPoint, type Run } from './collect';
import { buildExcludeSelector, CONTENT_CONTAINERS, DomClassifier, looksLikeUIChrome, OWN_TAG } from './dom';
import { pageContext } from './page-context';
import { deserialize, serialize } from './richtext';

type State = 'idle' | 'queued' | 'loading' | 'done' | 'error';

interface Paragraph extends Run {
  source: string;
  plain: string;
  refs: Element[];
  /** 译文与原文同行显示（短文本，如导航、按钮旁的标签） */
  inline: boolean;
  state: State;
  translation?: string;
  error?: string;
  /** 插入页面的 <ptx-t> 元素 */
  el?: HTMLElement;
  /** 仅译文模式下给译文设回的原文字号/行高（容器被设为 font-size:0） */
  font?: [size: string, lineHeight: string];
  /** 用户悬停关闭了这一段，之后不再自动补回 */
  dismissed: boolean;
  /** 被页面脚本删除后补回的次数，防止与页面无限拉锯 */
  restores: number;
  /** 内容刚变化过的段落要等到这个时间点（ms）仍未再变，才发起翻译 */
  settleAt?: number;
}

const MAX_INFLIGHT = 4;
const MAX_RESTORES = 5;
/**
 * 段落内容变化后的稳定窗口。逐字输出的页面（AI 对话、实时日志）会持续改写同一段，
 * 等它停下来再翻译，避免每次变化都发请求（见 docs/DECISIONS.md D13）。
 */
const SETTLE_MS = 1000;

/**
 * 页面翻译控制器：段落登记 → 进入视口排队 → 批量请求 → 渲染；
 * 监听 DOM 变化处理动态内容。对页面只做「追加 <ptx-t> + data-ptx-hide 属性」两种修改。
 */
export class PageTranslator {
  enabled = false;
  pageLang = '';

  private enabledListeners = new Set<(enabled: boolean) => void>();

  private classifier: DomClassifier;
  private paragraphs = new Set<Paragraph>();
  private byNode = new WeakMap<Node, Paragraph>();
  private byView = new WeakMap<Element, Paragraph>();
  /** 被 IntersectionObserver 观察的元素 → 等它进入视口的段落 */
  private targets = new Map<Element, Set<Paragraph>>();
  private queue: Paragraph[] = [];
  private inflight = 0;
  /** reset 时自增，用于丢弃过期的请求结果 */
  private generation = 0;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private rescanTimer?: ReturnType<typeof setTimeout>;
  private io?: IntersectionObserver;
  private mo?: MutationObserver;
  private dirtyRoots = new Set<Element>();
  /** 我们自己删除的节点，MutationObserver 回调里据此忽略 */
  private ownRemovals = new WeakSet<Node>();
  /** 每个容器最近一次登记的整段段落，用于发现「同一位置的内容被改写」 */
  private lastByContainer = new WeakMap<Element, Paragraph>();
  /** 当前扫描是否由 DOM 变化触发（首次整页扫描不算） */
  private dynamicScan = false;

  constructor(public settings: Settings) {
    this.classifier = new DomClassifier(buildExcludeSelector(settings.excludeSelectors));
    document.addEventListener('click', (e) => this.onClick(e), true);
  }

  // ---------- 对外接口 ----------

  /** 订阅「整页翻译开/关」变化（悬浮球等 UI 据此同步状态），返回取消订阅函数 */
  onEnabledChange(listener: (enabled: boolean) => void): () => void {
    this.enabledListeners.add(listener);
    return () => this.enabledListeners.delete(listener);
  }

  enable() {
    if (this.enabled || !document.body) return;
    this.enabled = true;
    this.io = new IntersectionObserver((entries) => this.onIntersect(entries), { rootMargin: '600px 0px' });
    this.mo = new MutationObserver((records) => this.onMutations(records));
    this.mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    this.scan([document.body]);
    this.emitEnabled();
  }

  disable() {
    this.reset();
  }

  toggle() {
    if (this.enabled) this.disable();
    else this.enable();
  }

  updateSettings(next: Settings) {
    const prev = this.settings;
    this.settings = next;
    const excludeChanged = prev.excludeSelectors.join('\n') !== next.excludeSelectors.join('\n');
    if (excludeChanged) this.classifier = new DomClassifier(buildExcludeSelector(next.excludeSelectors));

    // 影响译文内容的设置：清空重来（命中缓存的段落会很快回来）
    const contentChanged = (['targetLang', 'richText', 'activeProviderId', 'skipShortUI'] as const).some(
      (k) => prev[k] !== next[k],
    );
    if (excludeChanged || contentChanged) {
      const wasEnabled = this.enabled;
      this.reset();
      if (wasEnabled) this.enable();
      return;
    }
    if (prev.displayMode !== next.displayMode || prev.translationStyle !== next.translationStyle) {
      for (const p of this.paragraphs) if (p.state === 'done' && !p.dismissed && p.el?.isConnected) this.renderDone(p);
    }
  }

  /** 悬停翻译：切换坐标处那一段的译文 */
  translateAt(target: Element, x: number, y: number) {
    const view = target.closest(OWN_TAG);
    if (view) {
      const p = this.byView.get(view);
      if (p) this.dismiss(p);
      return;
    }
    if (this.classifier.isInsideExcluded(target)) return;
    this.classifier.reset();
    const block = this.classifier.blockAncestor(target);
    if (!block) return;
    const runs = collectRuns(block, this.classifier, false);
    const run = runs.find((r) => runContainsPoint(r, x, y)) ?? (runs.length === 1 ? runs[0] : undefined);
    const p = run && this.register(run, true);
    if (!p) return;

    if (p.state === 'done' && !p.dismissed && p.el?.isConnected) {
      this.dismiss(p);
    } else if (p.state === 'done') {
      p.dismissed = false;
      this.renderDone(p);
    } else if (p.state === 'idle' || p.state === 'error') {
      p.dismissed = false;
      this.enqueue(p, true);
    }
  }

  state(): TabState {
    let done = 0;
    let failed = 0;
    for (const p of this.paragraphs) {
      if (p.state === 'done') done++;
      else if (p.state === 'error') failed++;
    }
    return { enabled: this.enabled, total: this.paragraphs.size, done, failed, pageLang: this.pageLang };
  }

  // ---------- 段落登记 ----------

  private scan(roots: Element[], dynamic = false) {
    this.classifier.reset();
    this.dynamicScan = dynamic;
    try {
      for (const root of roots) {
        if (!root.isConnected || this.classifier.isInsideExcluded(root)) continue;
        for (const run of collectRuns(root, this.classifier)) this.register(run);
      }
    } finally {
      this.dynamicScan = false;
    }
  }

  /** manual：用户悬停点名翻译的段落，不受「跳过界面文字」限制 */
  private isTranslatable(run: Run, plain: string, manual: boolean): boolean {
    if (plain.length < 2 || !/\p{L}/u.test(plain)) return false;
    if (/^(https?:\/\/|www\.)\S+$/i.test(plain) || /^\S+@\S+\.\S+$/.test(plain)) return false;
    if (isProbablyInLanguage(plain, this.settings.targetLang)) return false;
    return manual || !this.settings.skipShortUI || !looksLikeUIChrome(run.container, run.nodes, plain);
  }

  private register(run: Run, manual = false): Paragraph | undefined {
    const ser = serialize(run.nodes, this.settings.richText, this.classifier);

    const olds = new Set<Paragraph>();
    for (const n of run.nodes) {
      const p = this.byNode.get(n);
      if (p && this.paragraphs.has(p)) olds.add(p);
    }
    const [old] = olds;
    if (olds.size === 1 && old && old.source === ser.text && old.container === run.container) {
      // 同一段落被重新扫描（DOM 有变化但文本没变）：更新节点引用，必要时补回译文
      old.nodes = run.nodes;
      old.whole = run.whole;
      for (const n of run.nodes) this.byNode.set(n, old);
      this.restoreView(old);
      if (this.enabled && old.state === 'idle') this.observe(old);
      return old;
    }
    for (const p of olds) this.drop(p);
    if (!this.isTranslatable(run, ser.plain, manual)) return undefined;

    const p: Paragraph = {
      ...run,
      source: ser.text,
      plain: ser.plain,
      refs: ser.refs,
      inline: this.preferInline(run, ser.plain),
      state: 'idle',
      dismissed: false,
      restores: 0,
    };
    // 内容被改写：原有节点变了文本，或同一容器里的整段被换成了新内容
    const previous = run.whole ? this.lastByContainer.get(run.container) : undefined;
    const rewritten = olds.size > 0 || (this.dynamicScan && previous !== undefined && previous.source !== ser.text);
    if (rewritten) p.settleAt = Date.now() + SETTLE_MS;
    if (run.whole) this.lastByContainer.set(run.container, p);

    this.paragraphs.add(p);
    for (const n of run.nodes) this.byNode.set(n, p);
    if (this.enabled) this.observe(p);
    return p;
  }

  private preferInline(run: Run, plain: string): boolean {
    if (run.whole && CONTENT_CONTAINERS.has(run.container.localName)) return false;
    return plain.length <= 40 && !/[.!?。！？:：]$/.test(plain);
  }

  private drop(p: Paragraph) {
    this.removeView(p);
    this.paragraphs.delete(p);
  }

  private prune() {
    for (const p of this.paragraphs) {
      if (!p.container.isConnected || !p.nodes[0]?.isConnected) this.drop(p);
    }
    for (const el of this.targets.keys()) {
      if (el.isConnected) continue;
      this.io?.unobserve(el);
      this.targets.delete(el);
    }
  }

  private emitEnabled() {
    for (const listener of this.enabledListeners) listener(this.enabled);
  }

  private reset() {
    const wasEnabled = this.enabled;
    this.generation++;
    this.enabled = false;
    if (wasEnabled) queueMicrotask(() => this.emitEnabled());
    this.io?.disconnect();
    this.mo?.disconnect();
    this.io = this.mo = undefined;
    clearTimeout(this.flushTimer);
    clearTimeout(this.rescanTimer);
    this.flushTimer = this.rescanTimer = undefined;
    for (const p of this.paragraphs) this.removeView(p);
    this.paragraphs.clear();
    this.byNode = new WeakMap();
    this.targets.clear();
    this.queue = [];
    this.dirtyRoots.clear();
    this.lastByContainer = new WeakMap();
  }

  // ---------- 懒翻译与批量请求 ----------

  private observeTarget(p: Paragraph): Element {
    if (p.whole) return p.container;
    const firstElement = p.nodes.find((n): n is Element => n.nodeType === Node.ELEMENT_NODE);
    if (firstElement) return firstElement;
    // 纯文本片段没有可观察的元素；观察整个容器会让长文（如 <br><br> 分段的文章）一次性全部排队。
    // 先在片段后插入空的译文占位作为锚点，进入视口后再填充
    const anchor = this.ensureView(p);
    if (!anchor) return p.container;
    if (p.state === 'idle') anchor.className = 'ptx-pending';
    return anchor;
  }

  private observe(p: Paragraph) {
    const target = this.observeTarget(p);
    let set = this.targets.get(target);
    if (!set) {
      this.targets.set(target, (set = new Set()));
      this.io?.observe(target);
    }
    set.add(p);
  }

  private onIntersect(entries: IntersectionObserverEntry[]) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const set = this.targets.get(entry.target);
      if (!set) continue;
      this.targets.delete(entry.target);
      this.io?.unobserve(entry.target);
      for (const p of set) {
        if (p.state === 'idle' && !p.dismissed && this.paragraphs.has(p)) this.enqueueWhenSettled(p);
      }
    }
  }

  /** 内容仍在变化的段落延后入队；期间再变化会产生新段落、旧段落被丢弃，计时器随之失效 */
  private enqueueWhenSettled(p: Paragraph) {
    const wait = (p.settleAt ?? 0) - Date.now();
    if (wait <= 0) {
      this.enqueue(p);
      return;
    }
    const generation = this.generation;
    setTimeout(() => {
      if (generation !== this.generation || !this.paragraphs.has(p)) return;
      if (p.state === 'idle' && !p.dismissed) this.enqueueWhenSettled(p);
    }, wait);
  }

  private enqueue(p: Paragraph, urgent = false) {
    p.state = 'queued';
    if (urgent) {
      this.queue.unshift(p);
      this.flush();
    } else {
      this.queue.push(p);
      // 稍等片刻，让同一屏的段落凑成一批
      this.flushTimer ??= setTimeout(() => {
        this.flushTimer = undefined;
        this.flush();
      }, 40);
    }
  }

  private flush() {
    while (this.inflight < MAX_INFLIGHT) {
      const batch = this.takeBatch();
      if (batch.length === 0) return;
      void this.runBatch(batch);
    }
  }

  private takeBatch(): Paragraph[] {
    const batch: Paragraph[] = [];
    let chars = 0;
    while (this.queue.length > 0 && batch.length < this.settings.batchMaxSegments) {
      const p = this.queue[0]!;
      if (p.state !== 'queued' || !this.paragraphs.has(p)) {
        this.queue.shift();
        continue;
      }
      if (batch.length > 0 && chars + p.source.length > this.settings.batchMaxChars) break;
      this.queue.shift();
      batch.push(p);
      chars += p.source.length;
    }
    return batch;
  }

  private async runBatch(batch: Paragraph[]) {
    this.inflight++;
    const generation = this.generation;
    for (const p of batch) {
      p.state = 'loading';
      this.renderLoading(p);
    }
    try {
      const res = await sendToBackground({ type: 'translate', segments: batch.map((p) => p.source), page: pageContext() });
      if (generation !== this.generation) return;
      batch.forEach((p, i) => {
        if (!this.paragraphs.has(p)) return;
        const text = res.translations[i];
        if (text) {
          p.state = 'done';
          p.translation = text;
          p.error = undefined;
          if (!p.dismissed) this.renderDone(p);
        } else {
          p.state = 'error';
          p.error = res.error ?? '翻译失败';
          this.renderError(p);
        }
      });
    } catch (err) {
      if (generation !== this.generation) return;
      const message = err instanceof Error ? err.message : String(err);
      for (const p of batch) {
        if (!this.paragraphs.has(p)) continue;
        p.state = 'error';
        p.error = message;
        this.renderError(p);
      }
    } finally {
      this.inflight--;
      this.flush();
    }
  }

  // ---------- 渲染 ----------

  private ensureView(p: Paragraph): HTMLElement | undefined {
    if (!p.el) {
      p.el = document.createElement(OWN_TAG);
      p.el.setAttribute('translate', 'no');
      this.byView.set(p.el, p);
    }
    if (!p.el.isConnected) {
      const last = p.nodes[p.nodes.length - 1] as ChildNode | undefined;
      if (!last?.isConnected) return undefined;
      last.after(p.el);
    }
    return p.el;
  }

  private layoutClass(p: Paragraph) {
    return p.inline ? 'ptx-inline' : 'ptx-block';
  }

  private renderLoading(p: Paragraph) {
    const el = this.ensureView(p);
    if (!el) return;
    el.className = `${this.layoutClass(p)} ptx-loading`;
    el.removeAttribute('title');
    el.replaceChildren(document.createElement('ptx-spin'));
    this.applyHide(p, false);
  }

  private renderDone(p: Paragraph) {
    const el = this.ensureView(p);
    if (!el || p.translation === undefined) return;
    el.className = `${this.layoutClass(p)} ptx-style-${this.settings.translationStyle}`;
    el.lang = this.settings.targetLang;
    el.removeAttribute('title');
    const inner = document.createElement('ptx-i');
    inner.append(deserialize(p.translation, p.refs, document));
    el.replaceChildren(inner);
    this.applyHide(p, this.settings.displayMode === 'translation');
  }

  private renderError(p: Paragraph) {
    const el = this.ensureView(p);
    if (!el) return;
    el.className = `${this.layoutClass(p)} ptx-error`;
    el.title = p.error ?? '';
    el.textContent = '⚠ 翻译失败，点击重试';
    this.applyHide(p, false);
  }

  /** 仅译文模式：容器 font-size:0 隐藏原文文本节点，CSS 隐藏原文子元素，译文显式设回字号 */
  private applyHide(p: Paragraph, hide: boolean) {
    const container = p.container;
    if (hide && p.whole && p.el) {
      if (!container.hasAttribute('data-ptx-hide')) {
        const cs = getComputedStyle(container);
        p.font = [cs.fontSize, cs.lineHeight];
        container.setAttribute('data-ptx-hide', '');
      }
      if (p.font) {
        p.el.style.fontSize = p.font[0];
        p.el.style.lineHeight = p.font[1];
      }
      return;
    }
    container.removeAttribute('data-ptx-hide');
    p.el?.style.removeProperty('font-size');
    p.el?.style.removeProperty('line-height');
  }

  private removeView(p: Paragraph) {
    this.applyHide(p, false);
    if (p.el) {
      this.ownRemovals.add(p.el);
      p.el.remove();
    }
  }

  private restoreView(p: Paragraph) {
    if (!p.el || p.el.isConnected || p.dismissed || p.state === 'idle' || p.state === 'queued') return;
    if (p.restores++ >= MAX_RESTORES) return;
    if (p.state === 'done') this.renderDone(p);
    else if (p.state === 'error') this.renderError(p);
    else this.renderLoading(p);
  }

  private dismiss(p: Paragraph) {
    p.dismissed = true;
    this.removeView(p);
  }

  private onClick(e: MouseEvent) {
    const view = (e.target as Element | null)?.closest?.(`${OWN_TAG}.ptx-error`);
    const p = view && this.byView.get(view);
    if (!p) return;
    e.preventDefault();
    e.stopPropagation();
    this.enqueue(p, true);
  }

  // ---------- 动态内容 ----------

  private onMutations(records: MutationRecord[]) {
    for (const r of records) {
      const el = r.target.nodeType === Node.ELEMENT_NODE ? (r.target as Element) : r.target.parentElement;
      if (!el || el.closest(OWN_TAG)) continue;
      if (r.type === 'childList') {
        const foreignAdded = Array.from(r.addedNodes).some(
          (n) => !(n.nodeType === Node.ELEMENT_NODE && (n as Element).localName === OWN_TAG),
        );
        const foreignRemoved = Array.from(r.removedNodes).some((n) => !this.ownRemovals.has(n));
        if (!foreignAdded && !foreignRemoved) continue;
      }
      this.dirtyRoots.add(el);
    }
    if (this.dirtyRoots.size > 0) this.rescanTimer ??= setTimeout(() => this.rescanDirty(), 150);
  }

  private rescanDirty() {
    this.rescanTimer = undefined;
    const roots = [...this.dirtyRoots];
    this.dirtyRoots.clear();
    if (!this.enabled) return;

    this.classifier.reset();
    const blocks = new Set<Element>();
    for (const root of roots) {
      const block = root.isConnected ? this.classifier.blockAncestor(root) : null;
      if (block) blocks.add(block);
    }
    // 只扫描最外层，避免嵌套重复
    const outermost = [...blocks].filter((b) => {
      for (let a = b.parentElement; a; a = a.parentElement) if (blocks.has(a)) return false;
      return true;
    });
    this.scan(outermost, true);
    this.prune();
  }
}
