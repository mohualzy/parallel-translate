import { isProbablyInLanguage } from '@/lib/languages';
import { sendToBackground, type TabState } from '@/lib/messages';
import type { Settings } from '@/lib/settings';
import { matchGlossary, parseGlossary, type GlossaryEntry } from '@/lib/glossary';
import { findSiteRule } from '@/lib/site-rules';
import { collectRuns, runContainsPoint, type Run } from './collect';
import { buildExcludeSelector, composedParent, CONTENT_CONTAINERS, DomClassifier, looksLikeUIChrome, OWN_TAG } from './dom';
import { pageAutoProfile, pageContext, pageProfile } from './page-context';
import { cloneSources, deserialize, sameText, serialize } from './richtext';
import { ensureShadowStyles } from './shadow-styles';
import { TitleTranslator } from './title';
import { TRANSLATING_ATTR } from './lifecycle';

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
  /** 隐藏原文前容器最宽那一行的宽度，用于检测隐藏后译文是否被挤成窄列 */
  widthBeforeHide?: number;
  /** 仅译文模式下段落只占容器一部分时，被直接隐藏的原文元素（data-ptx-hide-node） */
  hiddenNodes?: Element[];
  /** 这一段隐藏原文会挤坏排版，仅译文模式下也保持双语显示 */
  noHide?: boolean;
  /** 用户悬停关闭了这一段，之后不再自动补回 */
  dismissed: boolean;
  /** 被页面脚本删除后补回的次数，防止与页面无限拉锯 */
  restores: number;
  /** 内容刚变化过的段落要等到这个时间点（ms）仍未再变，才发起翻译 */
  settleAt?: number;
  /** 发出请求时的文章术语版本：术语晚于请求返回时，要检查译法冲突 */
  termsVersion?: number;
}

const MAX_INFLIGHT = 4;
const MAX_RESTORES = 5;
/**
 * 段落内容变化后的稳定窗口。逐字输出的页面（AI 对话、实时日志）会持续改写同一段，
 * 等它停下来再翻译，避免每次变化都发请求（见 docs/DECISIONS.md D13）。
 */
const SETTLE_MS = 1000;
/** 整页可翻译文字少于这个字数时提示「可能已是目标语言」 */
const SAME_LANGUAGE_MAX_CHARS = 100;
/** 正文达到这个字数才算长文、才抽取术语；送去抽取的正文最多这么长（见文章术语设计） */
const TERMS_MIN_CHARS = 3000;
const TERMS_MAX_CHARS = 8000;

function classifierFor(settings: Settings): DomClassifier {
  const translateControls = settings.displayMode === 'translation';
  const rule = settings.siteRules ? findSiteRule(location.hostname) : undefined;
  return new DomClassifier(
    buildExcludeSelector([...settings.excludeSelectors, ...(rule?.exclude ?? [])], translateControls),
    translateControls,
    rule?.include?.join(',') ?? '',
  );
}

/** 元素是否渲染出来了（自身或祖先 display:none、visibility:hidden 时为否）；display:contents 没有盒子，按可见处理 */
/** 带交互的元素：隐藏后它的图标（CSS 伪元素画的展开三角）和行为（展开菜单、切换侧栏分组）都会跟着消失 */
const INTERACTIVE = 'label,button,summary,input,select,textarea,[role],[tabindex],[onclick],[contenteditable]';
/** 只靠脚本处理点击的链接：没有地址、地址是单独的 #、javascript:（页内锚点 #section 是正常链接） */
const isScriptLink = (a: Element) => {
  const href = a.getAttribute('href')?.trim() ?? '';
  return href === '' || href === '#' || /^javascript:/i.test(href);
};

/**
 * 仅译文模式下「部分隐藏」能直接藏起来的元素：有真实地址的链接、纯排版的行内标签（及其内部）。
 * 带交互的元素、只靠脚本处理点击的链接不藏，这一段保持双语（实测：Kubernetes 侧栏分组标题、
 * Wikipedia 的语言菜单都是 <label>，藏起来后展开三角和点击都没了）。
 */
function isPlainContent(el: Element): boolean {
  if (el.matches(INTERACTIVE) || el.querySelector(INTERACTIVE)) return false;
  const links = [...(el.localName === 'a' ? [el] : []), ...el.querySelectorAll('a')];
  return !links.some(isScriptLink);
}

/** 元素最宽的一行：块级元素就是盒子宽度；行内元素跨多行时盒子只代表最后一行，要看每一行的片段 */
function widestLine(el: Element): number {
  return Math.max(0, ...Array.from(el.getClientRects(), (r) => r.width));
}

function isRendered(el: Element): boolean {
  if (!el.checkVisibility) return true;
  return el.checkVisibility({ visibilityProperty: true }) || getComputedStyle(el).display === 'contents';
}

function isClipping(el: Element): boolean {
  const cs = getComputedStyle(el);
  if (/auto|scroll/.test(`${cs.overflowX} ${cs.overflowY}`)) return false;
  // 宽或高几乎为 0 的是有意折叠起来的内容（收起的菜单、手风琴），不是被截断，绝不展开
  if (el.clientHeight <= 2 || el.clientWidth <= 2) return false;
  const lineClamp = cs.webkitLineClamp !== '' && cs.webkitLineClamp !== 'none';
  const hides = cs.overflowX !== 'visible' || cs.overflowY !== 'visible' || cs.textOverflow === 'ellipsis';
  const overflowing = el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1;
  return (lineClamp || hides) && overflowing;
}

/**
 * 页面翻译控制器：段落登记 → 进入视口排队 → 批量请求 → 渲染；
 * 监听 DOM 变化处理动态内容。对页面只做「追加 <ptx-t> + data-ptx-hide / data-ptx-hide-node 属性」两种修改。
 */
export class PageTranslator {
  enabled = false;
  pageLang = '';

  private enabledListeners = new Set<(enabled: boolean) => void>();
  private title = new TitleTranslator(
    () => this.settings,
    (text) => this.isWorthTranslating(text),
  );

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
  /** 已挂上 MutationObserver 的 shadow root（MutationObserver 看不到 shadow 树内部的变化） */
  private watchedRoots = new WeakSet<ShadowRoot>();
  /** 刚渲染、待做排版检查的段落（下一帧批量读布局，避免逐段强制重排） */
  private layoutQueue = new Set<Paragraph>();
  /** 被解除截断的元素，关闭翻译时复原 */
  private unclamped = new Set<Element>();
  /** 每个容器最近一次登记的整段段落，用于发现「同一位置的内容被改写」 */
  private lastByContainer = new WeakMap<Element, Paragraph>();
  /** 当前扫描是否由 DOM 变化触发（首次整页扫描不算） */
  private dynamicScan = false;
  /** AI 从本文抽取的术语；随每批请求发送，与用户术语表合并 */
  private articleTerms: GlossaryEntry[] = [];
  /** 文章术语每更新一次 +1；本轮翻译是否已发起抽取 */
  private termsVersion = 0;
  private termsRequested = false;

  constructor(
    public settings: Settings,
    /** 内容脚本失效（被新实例接替）时解绑页面监听 */
    signal?: AbortSignal,
  ) {
    this.classifier = classifierFor(settings);
    document.addEventListener('click', (e) => this.onClick(e), { capture: true, signal });
  }

  // ---------- 对外接口 ----------

  /** 开启翻译后整页几乎没有可翻译内容时回调（多半已是目标语言） */
  onNothingToTranslate?: () => void;

  /** 一批请求有段失败时回调：失败原因与当前失败段落总数（页面据此提示，见批量重试设计） */
  onBatchError?: (message: string, failed: number) => void;

  /** 订阅「整页翻译开/关」变化（悬浮球等 UI 据此同步状态），返回取消订阅函数 */
  onEnabledChange(listener: (enabled: boolean) => void): () => void {
    this.enabledListeners.add(listener);
    return () => this.enabledListeners.delete(listener);
  }

  enable() {
    if (this.enabled || !document.body) return;
    this.enabled = true;
    // 页面上的「正在翻译」标记：扩展更新后新注入的脚本据此恢复翻译（见 content/lifecycle.ts）
    document.documentElement.setAttribute(TRANSLATING_ATTR, '');
    this.io = new IntersectionObserver((entries) => this.onIntersect(entries), { rootMargin: '600px 0px' });
    this.mo = new MutationObserver((records) => this.onMutations(records));
    this.mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    this.scan([document.body]);
    this.maybeExtractTerms();
    this.title.start();
    this.emitEnabled();
    // 稍等动态内容加载后再判断，避免 SPA 首屏还没渲染就误报
    const generation = this.generation;
    setTimeout(() => {
      if (generation !== this.generation || !this.enabled) return;
      let chars = 0;
      for (const p of this.paragraphs) chars += p.plain.length;
      if (chars < SAME_LANGUAGE_MAX_CHARS) this.onNothingToTranslate?.();
    }, 1500);
  }

  disable() {
    document.documentElement.removeAttribute('data-ptx-mask');
    this.reset();
  }

  /**
   * 内容脚本失效（被新实例接替）时调用：移除译文、断开观察，但留下「正在翻译」标记供新实例接续。
   * 新实例的 WXT ctx 在构造时就会让同一隔离世界里的旧实例失效，早于新实例读取标记，所以不能在这里删掉它。
   */
  shutdown() {
    const wasEnabled = this.enabled;
    this.disable();
    if (wasEnabled) document.documentElement.setAttribute(TRANSLATING_ATTR, '');
  }

  /**
   * 立即翻译整页（Alt+W）：不等段落进入视口，已识别的段落全部按文档顺序排队。
   * 已在翻译时再按一次则还原。之后动态出现的内容仍按懒翻译处理。
   */
  translateWholePage() {
    if (this.enabled) {
      this.disable();
      return;
    }
    this.enable();
    for (const p of this.paragraphs) {
      // 看不见的（收起的下拉菜单等）不提前翻译，仍由 IntersectionObserver 在出现时处理
      if (p.state === 'idle' && !p.dismissed && isRendered(p.container)) this.enqueueWhenSettled(p);
    }
  }

  /** 学习遮罩：译文模糊、悬停才显示，只对当前页生效；页面未翻译时顺便开启翻译 */
  toggleMask() {
    const root = document.documentElement;
    const on = !root.hasAttribute('data-ptx-mask');
    root.toggleAttribute('data-ptx-mask', on);
    if (on && !this.enabled) this.enable();
  }

  toggle() {
    if (this.enabled) this.disable();
    else this.enable();
  }

  updateSettings(next: Settings) {
    const prev = this.settings;
    this.settings = next;
    if (prev.extractTerms !== next.extractTerms) {
      // 关闭后之后的批次不再带文章术语；开启时当前页如是长文就补发抽取
      this.articleTerms = [];
      this.termsRequested = false;
      this.maybeExtractTerms();
    }
    const excludeChanged =
      prev.excludeSelectors.join('\n') !== next.excludeSelectors.join('\n') || prev.siteRules !== next.siteRules;
    const modeChanged = prev.displayMode !== next.displayMode;
    if (excludeChanged || modeChanged) this.classifier = classifierFor(next);

    // 影响译文内容的设置：清空重来（命中缓存的段落会很快回来）；当前网站的风格档案变了也要按新风格重翻
    const contentChanged =
      (['targetLang', 'richText', 'activeProviderId', 'skipShortUI'] as const).some((k) => prev[k] !== next[k]) ||
      pageProfile(prev.siteProfiles) !== pageProfile(next.siteProfiles);
    // 切换显示方式会改变翻译范围：仅译文模式下按钮、短界面文字也要翻译（双语对照时跳过）
    if (excludeChanged || contentChanged || modeChanged) {
      const wasEnabled = this.enabled;
      this.reset();
      if (wasEnabled) this.enable();
      return;
    }
    if (prev.unclamp && !next.unclamp) {
      for (const el of this.unclamped) el.removeAttribute('data-ptx-unclamp');
      this.unclamped.clear();
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

  /**
   * 重试本页所有失败的段落。失败几乎总是成片发生（限流、网络、余额），原因是共同的，
   * 所以点任一失败提示都全部重试；走正常队列，照样合批、受并发上限约束。
   */
  retryFailed() {
    const failed = [...this.paragraphs].filter((p) => p.state === 'error' && p.container.isConnected);
    // 倒序插到队首，保持文档顺序
    for (const p of failed.reverse()) {
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
    return {
      enabled: this.enabled,
      total: this.paragraphs.size,
      done,
      failed,
      pageLang: this.pageLang,
      terms: this.articleTerms,
      profile: pageProfile(this.settings.siteProfiles),
      autoProfile: pageAutoProfile(),
    };
  }

  // ---------- 段落登记 ----------

  private scan(roots: Element[], dynamic = false) {
    this.classifier.reset();
    this.dynamicScan = dynamic;
    try {
      for (const root of roots) {
        if (!root.isConnected || this.classifier.isInsideExcluded(root)) continue;
        for (const run of collectRuns(root, this.classifier, true, (sr) => this.watchShadowRoot(sr))) this.register(run);
      }
    } finally {
      this.dynamicScan = false;
    }
  }

  /** manual：用户悬停点名翻译的段落，不受「跳过界面文字」限制 */
  /** 文本本身值不值得翻译：有字母、不是网址/邮箱、不是目标语言 */
  private isWorthTranslating(plain: string): boolean {
    if (plain.length < 2 || !/\p{L}/u.test(plain)) return false;
    if (/^(https?:\/\/|www\.)\S+$/i.test(plain) || /^\S+@\S+\.\S+$/.test(plain)) return false;
    return !isProbablyInLanguage(plain, this.settings.targetLang);
  }

  private isTranslatable(run: Run, plain: string, manual: boolean): boolean {
    if (!this.isWorthTranslating(plain)) return false;
    if (manual) return true;
    // 网站规则的白名单：区域外不翻；区域内是规则认定的正文，短也照翻（如 HN 的短标题）。
    // 看段落里的节点而不是容器：HN 标题的段落容器是 <td>，白名单元素 .titleline 在它里面
    if (this.classifier.includeSelector) {
      return run.nodes.every((n) => {
        if (!n.textContent?.trim()) return true;
        const el = n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement;
        return el !== null && this.classifier.isInsideIncluded(el);
      });
    }
    // 跳过界面文字是为了防止双语对照把按钮、导航撑乱；仅译文模式是原地替换，不会撑乱，照常翻译
    if (!this.settings.skipShortUI || this.settings.displayMode !== 'bilingual') return true;
    return !looksLikeUIChrome(run.container, run.nodes, plain);
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

  private watchShadowRoot(root: ShadowRoot) {
    if (!this.mo || this.watchedRoots.has(root)) return;
    this.mo.observe(root, { childList: true, subtree: true, characterData: true });
    this.watchedRoots.add(root);
  }

  private emitEnabled() {
    for (const listener of this.enabledListeners) listener(this.enabled);
  }

  private reset() {
    const wasEnabled = this.enabled;
    this.title.stop();
    this.generation++;
    this.enabled = false;
    document.documentElement.removeAttribute(TRANSLATING_ATTR);
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
    this.watchedRoots = new WeakSet();
    this.layoutQueue.clear();
    for (const el of this.unclamped) el.removeAttribute('data-ptx-unclamp');
    this.unclamped.clear();
    this.articleTerms = [];
    this.termsRequested = false;
  }

  // ---------- 文章术语（见 docs/specs/2026-10-23-article-terms-design.md） ----------

  /** 长文：并行抽取术语，不阻塞首屏；每轮翻译最多抽取一次。动态加载的页面在正文变长后补发 */
  private maybeExtractTerms() {
    if (this.termsRequested || !this.enabled || !this.settings.extractTerms) return;
    // 时间线、评论流不是同一篇文章，没有前后一致的问题
    if (pageProfile(this.settings.siteProfiles) === 'social') return;
    let text = '';
    for (const p of this.paragraphs) {
      text += `${p.plain}\n`;
      if (text.length >= TERMS_MAX_CHARS) break;
    }
    if (text.length < TERMS_MIN_CHARS) return;
    this.termsRequested = true;
    const generation = this.generation;
    void sendToBackground({ type: 'extract-terms', text: text.slice(0, TERMS_MAX_CHARS) }).then(
      (terms) => {
        if (generation !== this.generation || terms.length === 0) return;
        this.articleTerms = terms;
        this.termsVersion++;
        for (const p of this.paragraphs) if (p.state === 'done' && this.conflictsWithTerms(p)) this.enqueue(p);
      },
      () => undefined, // 抽取失败不影响翻译，只是少了一致性保证
    );
  }

  /** 译文没有采用本文术语的译法（用户术语表里的词不算，它从一开始就在 prompt 里） */
  private conflictsWithTerms(p: Paragraph): boolean {
    const translation = p.translation;
    if (!translation) return false;
    const user = new Set(parseGlossary(this.settings.glossary).map((e) => e.source.toLowerCase()));
    return matchGlossary(this.articleTerms, [p.plain]).some(
      (e) => !user.has(e.source.toLowerCase()) && !translation.includes(e.target),
    );
  }

  // ---------- 懒翻译与批量请求 ----------

  private observeTarget(p: Paragraph): Element {
    // display: contents 的容器（如 <slot>）没有盒子，IntersectionObserver 永远不会触发，改观察片段本身
    if (p.whole && getComputedStyle(p.container).display !== 'contents') return p.container;
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
      // 被祖先裁剪成零面积（折叠的菜单、手风琴）：浏览器对「贴边」的零面积交集也报告 isIntersecting。
      // 这种内容用户看不见，不翻译；继续观察，等它真正展开再翻
      const box = entry.boundingClientRect;
      const visible = entry.intersectionRect;
      if (box.width * box.height > 0 && visible.width * visible.height === 0) continue;
      // visibility:hidden 的下拉菜单有盒子也在视口里，同样看不见。位置不变时 IntersectionObserver 不会再通知，
      // 所以它展开后也不会补翻（悬停可按 Ctrl 单独翻译）；换来的是不再为收起的菜单付费
      if (!isRendered(entry.target)) continue;
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
    const termsVersion = this.termsVersion;
    for (const p of batch) {
      p.state = 'loading';
      p.termsVersion = termsVersion;
      // 带着术语重翻的段落保留旧译文，新译文到了再替换，不闪加载提示
      if (!p.translation) this.renderLoading(p);
    }
    try {
      const page = { ...pageContext(this.title.originalTitle, this.settings.siteProfiles), terms: this.articleTerms };
      const res = await sendToBackground({ type: 'translate', segments: batch.map((p) => p.source), page });
      if (generation !== this.generation) return;
      batch.forEach((p, i) => {
        if (!this.paragraphs.has(p)) return;
        const text = res.translations[i];
        if (text) {
          p.state = 'done';
          p.translation = text;
          p.error = undefined;
          if (!p.dismissed) this.renderDone(p);
          // 请求发出后才拿到文章术语：译法冲突就带着术语重翻
          if ((p.termsVersion ?? 0) < this.termsVersion && this.conflictsWithTerms(p)) this.enqueue(p);
        } else {
          p.state = 'error';
          p.error = res.error ?? '翻译失败';
          this.renderError(p);
        }
      });
      if (res.translations.some((t) => !t)) this.reportError(res.error ?? '翻译失败');
    } catch (err) {
      if (generation !== this.generation) return;
      const message = err instanceof Error ? err.message : String(err);
      for (const p of batch) {
        if (!this.paragraphs.has(p)) continue;
        p.state = 'error';
        p.error = message;
        this.renderError(p);
      }
      this.reportError(message);
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
      // 被分配到具名 slot 的内容：译文跟着进同一个 slot，否则不会被渲染
      const slot = last.nodeType === Node.ELEMENT_NODE ? (last as Element).getAttribute('slot') : null;
      if (slot) p.el.setAttribute('slot', slot);
      ensureShadowStyles(p.el);
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
    if (p.translation === undefined) return;
    // 模型原样返回（人名、产品名、代码等本就不需要翻译）：再显示一遍只是重复，不插入译文
    if (sameText(p.translation, p.source)) {
      this.removeView(p);
      return;
    }
    const el = this.ensureView(p);
    if (!el) return;
    el.className = `${this.layoutClass(p)} ptx-style-${this.settings.translationStyle}`;
    el.lang = this.settings.targetLang;
    el.removeAttribute('title');
    const inner = document.createElement('ptx-i');
    inner.append(deserialize(p.translation, p.refs, document));
    el.replaceChildren(inner);
    this.applyHide(p, this.settings.displayMode === 'translation');
    this.scheduleLayoutCheck(p);
  }

  private reportError(message: string) {
    this.onBatchError?.(message, this.state().failed);
  }

  private renderError(p: Paragraph) {
    const el = this.ensureView(p);
    if (!el) return;
    el.className = `${this.layoutClass(p)} ptx-error`;
    el.title = p.error ?? '';
    el.textContent = '⚠ 翻译失败，点击重试';
    this.applyHide(p, false);
  }

  /**
   * 仅译文模式：
   * - 段落占满容器：容器 font-size:0 隐藏原文文本节点，CSS 隐藏原文子元素，译文显式设回字号；
   * - 段落只占容器一部分（目录项后面跟着子目录、列表项编号后面跟着正文块）：容器里还有别的内容，不能整个藏。
   *   段落里只有元素（链接、行内标签）时给这些元素打 data-ptx-hide-node 直接隐藏；有裸文字时不包裹节点就藏不住，保持双语。
   */
  private applyHide(p: Paragraph, hide: boolean) {
    const container = p.container;
    if (hide && p.el && !p.noHide) {
      if (p.whole) {
        if (!container.hasAttribute('data-ptx-hide')) {
          const cs = getComputedStyle(container);
          p.font = [cs.fontSize, cs.lineHeight];
          p.widthBeforeHide = widestLine(container);
          container.setAttribute('data-ptx-hide', '');
        }
        if (p.font) {
          p.el.style.fontSize = p.font[0];
          p.el.style.lineHeight = p.font[1];
        }
        return;
      }
      const elements = p.nodes.filter((n): n is Element => n.nodeType === Node.ELEMENT_NODE);
      const bareText = p.nodes.some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
      if (elements.length > 0 && !bareText && elements.every(isPlainContent)) {
        for (const el of elements) el.setAttribute('data-ptx-hide-node', '');
        p.hiddenNodes = elements;
        p.el.classList.add('ptx-replace');
        return;
      }
    }
    container.removeAttribute('data-ptx-hide');
    for (const el of p.hiddenNodes ?? []) el.removeAttribute('data-ptx-hide-node');
    p.hiddenNodes = undefined;
    p.el?.classList.remove('ptx-replace');
    p.el?.style.removeProperty('font-size');
    p.el?.style.removeProperty('line-height');
  }

  // ---------- 渲染后的排版检查：仅译文挤压检测、解除截断 ----------

  private scheduleLayoutCheck(p: Paragraph) {
    this.layoutQueue.add(p);
    if (this.layoutQueue.size === 1) requestAnimationFrame(() => this.flushLayoutChecks());
  }

  /**
   * 仅译文模式靠容器 font-size:0 隐藏原文。页面若用 em / ch 等相对字号的单位给容器定宽（如 max-width: 40ch），
   * 字号归零后宽度也归零，译文会被挤成一字一行。检测到「容器明显变窄 + 译文变得很高」时，这一段退回双语显示。
   */
  private isSqueezed(p: Paragraph): boolean {
    if (!p.el || !p.font || !p.widthBeforeHide || p.widthBeforeHide < 40) return false;
    // 比「最宽的一行」而不是容器盒子：行内容器（arXiv 列表项里 display:inline 的 <p>）的盒子只量得到最后一行，
    // 按它判断会把排得好好的译文误判成被挤窄
    const width = widestLine(p.el);
    const lineHeight = Number.parseFloat(p.font[1]) || Number.parseFloat(p.font[0]) * 1.4;
    return width < p.widthBeforeHide * 0.5 && p.el.getBoundingClientRect().height > lineHeight * 3;
  }

  /**
   * 译文插入后，如果所在容器（及最多 5 层祖先）因省略号 / 行数限制 / 固定高度把内容裁掉了，
   * 打上 data-ptx-unclamp，由 CSS 解除截断。可滚动容器是有意为之，不处理。
   */
  private flushLayoutChecks() {
    const items = [...this.layoutQueue];
    this.layoutQueue.clear();
    for (const p of items) {
      if (!p.el?.isConnected) continue;
      if (p.container.hasAttribute('data-ptx-hide') && this.isSqueezed(p)) {
        p.noHide = true;
        this.applyHide(p, false);
      }
      if (!this.settings.unclamp) continue;
      let el: Element | null = p.container;
      for (let depth = 0; el && el !== document.body && depth < 5; depth++, el = el.parentElement) {
        if (this.unclamped.has(el) || !isClipping(el)) continue;
        el.setAttribute('data-ptx-unclamp', '');
        this.unclamped.add(el);
      }
    }
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
    if (p.state === 'done' && p.translation !== undefined && sameText(p.translation, p.source)) return;
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
    const target = e.target as Element | null;
    const view = target?.closest?.(`${OWN_TAG}.ptx-error`);
    const p = view && this.byView.get(view);
    if (p) {
      e.preventDefault();
      e.stopPropagation();
      this.retryFailed();
      return;
    }
    // 点译文里的链接副本：转给原链接去点。副本没有页面脚本绑定的事件，单页应用的路由会退化成整页跳转，
    // 只靠脚本处理的链接（href="#"）干脆没反应。带修饰键（新标签页打开等）交给浏览器按副本的 href 处理
    if (!target?.closest?.(OWN_TAG) || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    for (let el: Element | null = target; el && el.localName !== OWN_TAG; el = el.parentElement) {
      const source = cloneSources.get(el);
      if (!source?.isConnected || !(source instanceof HTMLElement)) continue;
      e.preventDefault();
      e.stopPropagation();
      source.click();
      return;
    }
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
      for (let a = composedParent(b); a; a = composedParent(a)) if (blocks.has(a)) return false;
      return true;
    });
    this.scan(outermost, true);
    this.maybeExtractTerms();
    this.prune();
  }
}
