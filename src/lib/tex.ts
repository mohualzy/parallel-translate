/**
 * LaTeX 源码识别：把文本切成普通文字和公式（设计见 docs/specs/2026-10-31-latex-rendering-design.md）。
 * 公式元素 <ptx-math> 的内容先是源码，渲染成功后换成 MathML（lib/tex-render.ts），失败时用户看到的是源码。
 */

export const TEX_TAG = 'ptx-math';

export interface TexPart {
  /** 原文（公式带分隔符） */
  text: string;
  /** 公式内容；普通文字没有这个字段 */
  tex?: string;
  /** 行间公式 */
  display?: boolean;
}

// $$…$$、\[…\]、\(…\)、$…$；$…$ 两端不能贴空白，后面不能跟字母数字，排除价格和 shell 变量
const TEX_PATTERN = /\$\$([^$]+)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<![\\\w$])\$(?![\s$])([^$\n]+?)(?<![\s\\])\$(?![\w$])/g;

/** 内容要像公式：有命令或运算符，或者是单个变量（$x$、$x'$、$x1$） */
function looksLikeTex(body: string): boolean {
  return /\\[a-zA-Z]|[\^_=+<>]/.test(body) || /^\s*[a-zA-Z]\d?'*\s*$/.test(body);
}

export function splitTex(text: string): TexPart[] {
  if (!text.includes('$') && !text.includes('\\')) return text ? [{ text }] : [];
  const parts: TexPart[] = [];
  let last = 0;
  for (const m of text.matchAll(TEX_PATTERN)) {
    const [raw, dollars, bracket, paren, dollar] = m;
    const body = dollars ?? bracket ?? paren ?? dollar ?? '';
    if (!looksLikeTex(body)) continue;
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ text: raw, tex: body.trim(), display: dollars !== undefined || bracket !== undefined });
    last = m.index + raw.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

export function texElement(part: TexPart, doc: Document): Element {
  const el = doc.createElement(TEX_TAG);
  el.setAttribute('data-tex', part.tex ?? '');
  if (part.display) el.setAttribute('data-display', '');
  el.textContent = part.text;
  return el;
}

/** 把文字追加到 parent，其中的公式换成公式元素 */
export function appendTexText(parent: Node, text: string, doc: Document) {
  for (const part of splitTex(text)) {
    parent.appendChild(part.tex === undefined ? doc.createTextNode(part.text) : texElement(part, doc));
  }
}
