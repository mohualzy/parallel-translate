import type { DomClassifier } from './dom';

/**
 * 富文本占位协议（见 docs/DECISIONS.md D6）：
 *   <gN>…</gN>  需要翻译的格式元素（链接、加粗…），译后按编号浅克隆原元素包住译文
 *   <xN>…</xN>  原样保留的元素（行内代码、图片…），译后按编号深克隆原元素，忽略模型输出的内容
 * 文本中的 < > & 先转义，保证模型输入里只有我们自己的标签。
 */

/** 会被 <gN> 包裹、在译文中保留的格式标签；其他行内元素（span 等）直接展开，减少标签噪音 */
const WRAP_TAGS = new Set(['a', 'b', 'strong', 'em', 'i', 'u', 's', 'del', 'ins', 'mark', 'q', 'cite', 'abbr', 'dfn']);
/** 克隆会产生副作用的原子元素（重复加载媒体、重复表单控件），译文中只保留其文字；其余原子元素整体克隆 */
const UNCLONABLE_OPAQUE = new Set(['iframe', 'video', 'audio', 'object', 'embed', 'canvas', 'input', 'select', 'textarea', 'button', 'option']);
/** 标签过多时弱模型容易出错，降级为纯文本 */
export const MAX_TAGS = 24;

export interface Serialized {
  /** 发给模型的文本（可能含占位标签，已转义） */
  text: string;
  /** 纯文本（不含代码等原子内容），用于判断语言、是否值得翻译 */
  plain: string;
  /** 占位编号 → 原元素 */
  refs: Element[];
}

export function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function unescapeText(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, name: string) => ENTITIES[name] ?? '');
}

const collapse = (s: string) => s.replace(/\s+/g, ' ');

export function serialize(nodes: Node[], rich: boolean, classifier: DomClassifier): Serialized {
  const refs: Element[] = [];
  let plain = '';

  const walk = (node: Node): string => {
    const kind = classifier.classify(node);
    if (kind === 'text') {
      const s = collapse(node.textContent ?? '');
      plain += s;
      return escapeText(s);
    }
    if (kind === 'ignore' || kind === 'skip') return '';
    const el = node as Element;

    if (kind === 'opaque') {
      const content = collapse(el.textContent ?? '').trim();
      if (el.localName === 'br' || el.localName === 'wbr') {
        if (!rich) return ' ';
      } else if (!rich) {
        return content ? ` ${escapeText(content)} ` : '';
      }
      const n = refs.push(el) - 1;
      return content ? `<x${n}>${escapeText(content)}</x${n}>` : `<x${n}/>`;
    }

    // inline / block（行内元素内部偶尔出现的块级自定义元素，按行内展开）
    // 先序编号：外层先拿到编号，模型看到的 <g0><g1>…</g1></g0> 更自然
    const wrap = rich && WRAP_TAGS.has(el.localName) && Boolean(el.textContent?.trim());
    const n = wrap ? refs.push(el) - 1 : -1;
    const inner = Array.from(el.childNodes, walk).join('');
    return wrap ? `<g${n}>${inner}</g${n}>` : inner;
  };

  const text = collapse(nodes.map(walk).join('')).trim();
  if (rich && refs.length > MAX_TAGS) return serialize(nodes, false, classifier);
  return { text, plain: collapse(plain).trim(), refs };
}

function stripIds(el: Element) {
  el.removeAttribute('id');
  el.querySelectorAll('[id]').forEach((child) => child.removeAttribute('id'));
}

function cloneShallow(ref: Element): Element {
  const clone = ref.cloneNode(false) as Element;
  clone.removeAttribute('id');
  return clone;
}

function renderOpaque(ref: Element, doc: Document): Node {
  if (UNCLONABLE_OPAQUE.has(ref.localName)) return doc.createTextNode(ref.textContent ?? '');
  const clone = ref.cloneNode(true) as Element;
  stripIds(clone);
  return clone;
}

const TOKEN = /<(\/?)([gx])(\d+)\s*(\/?)>/g;

/**
 * 把模型译文还原为 DOM 片段。容错策略：
 * - 未知编号的标签丢弃，保留文字；未闭合的 <gN> 在末尾自动闭合；孤立的 </gN> 忽略
 * - <xN> 无论模型写成 <xN/>、<xN>…</xN> 还是只写开标签，都替换为原元素
 */
export function deserialize(translated: string, refs: Element[], doc: Document): DocumentFragment {
  // 先把 <xN>…</xN> 归一成 <xN/>，模型在里面写了什么都不要
  const normalized = translated.replace(/<x(\d+)\s*>[\s\S]*?<\/x\1\s*>/g, '<x$1/>');
  const fragment = doc.createDocumentFragment();
  const stack: { node: Node; tag?: string }[] = [{ node: fragment }];
  const top = () => stack[stack.length - 1]!.node;
  const appendText = (s: string) => {
    if (s) top().appendChild(doc.createTextNode(unescapeText(s)));
  };

  let last = 0;
  for (const m of normalized.matchAll(TOKEN)) {
    const [raw, closing, kind, num] = m;
    appendText(normalized.slice(last, m.index));
    last = (m.index ?? 0) + raw.length;

    const ref = refs[Number(num)];
    if (!ref) continue;
    const tag = `${kind}${num}`;

    if (kind === 'x') {
      if (!closing) top().appendChild(renderOpaque(ref, doc));
      continue;
    }
    if (closing) {
      const pos = stack.findLastIndex((s) => s.tag === tag);
      if (pos > 0) stack.length = pos;
      continue;
    }
    const clone = cloneShallow(ref);
    top().appendChild(clone);
    stack.push({ node: clone, tag });
  }
  appendText(normalized.slice(last));
  return fragment;
}
