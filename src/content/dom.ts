/**
 * 节点分类：决定一个节点在「段落识别」中扮演什么角色。
 *
 * - text   文本节点，属于行内片段
 * - inline 行内元素，属于行内片段，可递归序列化
 * - opaque 行内但不可翻译的元素（行内代码、图片、表单控件），作为占位整体保留
 * - block  块级元素，打断行内片段，并递归寻找其内部段落
 * - skip   块级但不翻译的元素（pre、编辑器、被排除的区域），打断片段且不进入
 * - ignore 完全忽略（脚本、隐藏元素、本扩展插入的元素），既不打断也不参与
 */
export type NodeKind = 'text' | 'inline' | 'opaque' | 'block' | 'skip' | 'ignore';

export const OWN_TAG = 'ptx-t';

const IGNORED_TAGS = new Set(['script', 'style', 'noscript', 'template', 'link', 'meta', 'title', 'head']);

/** 不进入其内部翻译的元素 */
const OPAQUE_TAGS = new Set([
  'code', 'kbd', 'samp', 'var', 'pre', 'textarea', 'input', 'select', 'option', 'button',
  'svg', 'math', 'canvas', 'video', 'audio', 'iframe', 'object', 'embed', 'img', 'picture', 'br', 'wbr',
  // 上下标多是引用角标 [1]、化学式、指数，原样保留比翻译更准确
  'sup', 'sub', 'time',
]);

/** 这些标签几乎总是块级，跳过 getComputedStyle 以加快扫描 */
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'dd', 'details', 'dialog', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
  'hgroup', 'hr', 'html', 'li', 'main', 'nav', 'ol', 'p', 'section', 'summary', 'table', 'tbody',
  'thead', 'tfoot', 'tr', 'td', 'th', 'caption', 'ul',
]);

/** 行内元素内部若含这些块级元素，按块处理（例如包着整张卡片的 <a>） */
const BLOCK_SELECTOR = [...BLOCK_TAGS].filter((t) => t !== 'body' && t !== 'html').join(',');

/** 内置排除：编辑器、公式、控件、显式声明不翻译的区域 */
const BUILTIN_EXCLUDE = [
  '[translate="no"]',
  '.notranslate',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '.monaco-editor',
  '.CodeMirror',
  '.cm-editor',
  '.ace_editor',
  '.katex',
  '.MathJax',
  'mjx-container',
  '[role="button"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="switch"]',
  // 图标字体靠文字连字显示图标（如 <span class="material-icons">search</span>），翻译会把图标变成文字
  '.material-icons',
  '.material-icons-outlined',
  '.material-icons-round',
  'material-icon',
  '[class^="material-symbols-"]',
  '.google-symbols',
  'i.fa',
  'i[class^="fa-"]',
];

/** 只给屏幕阅读器的隐藏文字：看不见，翻译出来反而会显示在页面上 */
const VISUALLY_HIDDEN = '.sr-only,.visually-hidden,.visuallyhidden,.screen-reader-text,.a11y-hidden';

/** 正文类容器：里面的文字再短也是内容（标题、列表项、表格单元格） */
export const CONTENT_CONTAINERS = new Set([
  'p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'dd', 'dt', 'figcaption', 'td', 'th', 'caption', 'summary',
]);

const UI_ANCESTORS = 'a,button,label,[role="button"],[role="link"],[role="tab"],[role="menuitem"]';

const isBr = (n: Node | null): boolean => n?.nodeType === Node.ELEMENT_NODE && (n as Element).localName === 'br';
const isBlankText = (n: Node | null): boolean => n?.nodeType === Node.TEXT_NODE && !n.textContent?.trim();

function meaningfulSibling(node: Node, dir: 'previousSibling' | 'nextSibling'): Node | null {
  let cur = node[dir];
  while (cur && (isBlankText(cur) || cur.nodeType === Node.COMMENT_NODE)) cur = cur[dir];
  return cur;
}

/**
 * 连续两个 <br>（中间只有空白）视为段落分隔，单个 <br> 仍是段内换行。
 * 用 <br><br> 分段的页面（论坛、老式博客）因此能逐段对照，而不是整篇成一段。
 */
export function isParagraphBreak(br: Node): boolean {
  return isBr(br) && (isBr(meaningfulSibling(br, 'previousSibling')) || isBr(meaningfulSibling(br, 'nextSibling')));
}

/** 词数：拉丁/西里尔按词，CJK 每两个字算一个词 */
function wordCount(text: string): number {
  const words = text.match(/[\p{Script=Latin}\p{Script=Cyrillic}\p{N}]+/gu)?.length ?? 0;
  const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
  return words + Math.ceil(cjk / 2);
}

/** 行文容器：里面的短文字也按内容翻译（标题、段落、表格单元格） */
const PROSE_CONTAINERS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'figcaption', 'caption', 'td', 'th']);

/**
 * 是否像「界面文字」：按钮、标签页、徽章、导航链接等。
 * 这类文字翻译后对阅读帮助不大，却最容易撑乱布局，默认不自动翻译（悬停翻译仍可用）。
 */
export function looksLikeUIChrome(container: Element, nodes: Node[], plain: string): boolean {
  if (PROSE_CONTAINERS.has(container.localName)) return false;
  if (wordCount(plain) > 3 || plain.length > 30) return false;
  // 文章正文里的短列表项、短链接是内容（如 README 的目录列表），不是界面
  if (container.closest('article,[role="article"]')) return false;
  if (container.closest(UI_ANCESTORS)) return true;
  // 整段内容就是一个链接/按钮，如 <li><a>Home</a></li>、<div><a><svg/> Readme</a></div>
  const meaningful = nodes.filter((n) => n.textContent?.trim());
  const only = meaningful.length === 1 ? meaningful[0] : undefined;
  if (only?.nodeType === Node.ELEMENT_NODE && (only as Element).matches(UI_ANCESTORS)) return true;
  if (CONTENT_CONTAINERS.has(container.localName)) return false;
  if (/^inline-(block|flex|grid)$/.test(getComputedStyle(container).display)) return true;
  const parent = container.parentElement;
  return parent !== null && /flex|grid/.test(getComputedStyle(parent).display);
}

/** 过滤掉语法错误的用户选择器，避免 matches() 抛错导致整页失效 */
export function buildExcludeSelector(extra: string[]): string {
  const valid = extra
    .map((s) => s.trim())
    .filter((s) => {
      if (!s) return false;
      try {
        document.createDocumentFragment().querySelector(s);
        return true;
      } catch {
        return false;
      }
    });
  return [...BUILTIN_EXCLUDE, ...valid].join(',');
}

/**
 * 组合树上的父元素：走到 shadow root 顶层时跳到它的宿主元素。
 * 段落容器查找、排除区域判断都要能穿过 Shadow DOM 边界。
 */
export function composedParent(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const parent = el.parentNode;
  return parent instanceof ShadowRoot ? parent.host : null;
}

/**
 * 组合树上的子节点（实际渲染出来的内容）：有 open shadow root 的元素取 shadow root 的子节点；
 * <slot> 取分配进来的节点，没有分配时取其后备内容。closed shadow root 读不到，保持原样。
 */
export function composedChildren(el: Element): Node[] {
  if (el.shadowRoot) return Array.from(el.shadowRoot.childNodes);
  if (el instanceof HTMLSlotElement) {
    const assigned = el.assignedNodes({ flatten: true });
    if (assigned.length > 0) return assigned;
  }
  return Array.from(el.childNodes);
}

export class DomClassifier {
  private cache = new WeakMap<Node, NodeKind>();

  constructor(private readonly excludeSelector: string) {}

  /** 每轮扫描前调用：样式可能已变化，旧分类作废 */
  reset() {
    this.cache = new WeakMap();
  }

  isExcluded(el: Element): boolean {
    // 有些站点在 <html>/<body> 上声明 translate="no"，这里不让它屏蔽整页
    if (el.localName === 'html' || el.localName === 'body') return false;
    return el.matches(this.excludeSelector);
  }

  /** el 自身或祖先是否在排除区域 / 本扩展的元素内 */
  isInsideExcluded(el: Element): boolean {
    for (let cur: Element | null = el; cur; cur = composedParent(cur)) {
      if (cur.localName === OWN_TAG || this.isExcluded(cur)) return true;
    }
    return false;
  }

  classify(node: Node): NodeKind {
    if (node.nodeType === Node.TEXT_NODE) return 'text';
    if (node.nodeType !== Node.ELEMENT_NODE) return 'ignore';
    const cached = this.cache.get(node);
    if (cached) return cached;
    const kind = this.compute(node as Element);
    this.cache.set(node, kind);
    return kind;
  }

  private compute(el: Element): NodeKind {
    const tag = el.localName;
    if (IGNORED_TAGS.has(tag) || tag.startsWith('ptx-') || el.matches(VISUALLY_HIDDEN)) return 'ignore';

    if (BLOCK_TAGS.has(tag)) return this.isExcluded(el) ? 'skip' : 'block';
    // Shadow 宿主与 <slot> 的真实内容不在自己的 childNodes 里，按块进入，由 composedChildren 取组合树子节点
    if (el.shadowRoot || tag === 'slot') return this.isExcluded(el) ? 'skip' : 'block';

    const cs = getComputedStyle(el);
    // 脱离文档的元素（以及 happy-dom）会返回空字符串；CSS 中 display 的初始值就是 inline
    const display = cs.display || 'inline';
    if (display === 'none') return 'ignore';
    // 通用的「视觉隐藏」写法：绝对定位 + clip 裁剪成 0
    if (cs.position === 'absolute' && ((cs.clip && cs.clip !== 'auto') || (cs.clipPath && cs.clipPath !== 'none'))) {
      return 'ignore';
    }
    const inlineLevel = display.startsWith('inline') || display === 'contents' || display.startsWith('ruby');

    if (OPAQUE_TAGS.has(tag) || this.isExcluded(el)) return inlineLevel ? 'opaque' : 'skip';
    if (!inlineLevel) return 'block';
    if (el.querySelector(BLOCK_SELECTOR)) return 'block';
    // 内部用 <br><br> 分段的行内元素（老式网页常见 <font> 包全文）按块处理，才能进入内部逐段切分
    return Array.from(el.querySelectorAll('br')).some(isParagraphBreak) ? 'block' : 'inline';
  }

  /** 最近的块级祖先（段落容器） */
  blockAncestor(node: Node): Element | null {
    let el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    while (el) {
      const kind = this.classify(el);
      if (kind === 'block') return el;
      if (kind === 'skip') return null;
      el = composedParent(el);
    }
    return null;
  }
}
