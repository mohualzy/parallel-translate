import { sendToBackground } from './messages';
import { appendTexText, TEX_TAG } from './tex';

const rendered = new Map<string, string | null>();
const keyOf = (el: Element) => `${el.hasAttribute('data-display') ? 'block' : 'inline'}:${el.getAttribute('data-tex')}`;

/** 把 root 里的公式元素换成 MathML；KaTeX 在后台，内容脚本不打包。失败的公式保留源码 */
export async function renderTexIn(root: ParentNode) {
  const elements = [...root.querySelectorAll(`${TEX_TAG}:not([data-rendered])`)];
  const missing = [...new Map(elements.filter((el) => !rendered.has(keyOf(el))).map((el) => [keyOf(el), el])).values()];
  if (missing.length > 0) {
    const items = missing.map((el) => ({ tex: el.getAttribute('data-tex') ?? '', display: el.hasAttribute('data-display') }));
    // 后台不可用（扩展刚更新）时页面上留着源码，下次翻译再试
    const results = await sendToBackground({ type: 'render-tex', items }).catch(() => null);
    if (!results) return;
    missing.forEach((el, i) => rendered.set(keyOf(el), results[i] ?? null));
  }
  for (const el of elements) {
    const html = rendered.get(keyOf(el));
    const math = html && new DOMParser().parseFromString(html, 'text/html').querySelector('math');
    if (!math) continue;
    el.replaceChildren(el.ownerDocument.importNode(math, true));
    el.setAttribute('data-rendered', '');
  }
}

/** 纯文本译文（划词、侧栏）的公式渲染：内容换成文字 + 公式元素，再渲染 */
export function setTexText(el: Element, text: string) {
  el.replaceChildren();
  appendTexText(el, text, el.ownerDocument);
  return renderTexIn(el);
}
