/**
 * PDF 译文页的划词强调（设计见 docs/specs/2026-10-24-pdf-text-layer-design.md）：
 * 以「页码 + 块标识 + 显示文本里的偏移」定位，另存一份原文字（quote）用来校验和重新定位。纯逻辑。
 */

export const HIGHLIGHT_STYLES = ['yellow', 'green', 'blue', 'pink', 'underline'] as const;
export type HighlightStyle = (typeof HIGHLIGHT_STYLES)[number];

export interface PdfHighlight {
  id: string;
  page: number;
  /** 块标识（lib/pdf/page-text.ts 的 blockKeys） */
  key: string;
  start: number;
  end: number;
  quote: string;
  style: HighlightStyle;
}

/** 选区落在某一块里的部分 */
export interface TextRange {
  page: number;
  key: string;
  start: number;
  end: number;
}

/**
 * 在块的当前显示文本里定位：偏移处的文字没变就用原位置；变了（重新翻译、换了风格）时找 quote，
 * 只出现一次才用；找不到返回 undefined（暂不显示，但不删除，换回原来的译文还能显示）。
 */
export function locate(h: PdfHighlight, text: string): { start: number; end: number } | undefined {
  if (text.slice(h.start, h.end) === h.quote) return { start: h.start, end: h.end };
  const at = text.indexOf(h.quote);
  if (at < 0 || text.indexOf(h.quote, at + 1) >= 0) return undefined;
  return { start: at, end: at + h.quote.length };
}

const newId = () => crypto.randomUUID();

/**
 * 去掉区间覆盖的部分：同一块里和区间重叠的强调被切开，留下两侧不重叠的部分。
 * textOf 返回块当前的显示文本；定位不到的强调不动。
 */
export function removeRange(list: PdfHighlight[], r: TextRange, textOf: (page: number, key: string) => string | undefined): PdfHighlight[] {
  const out: PdfHighlight[] = [];
  for (const h of list) {
    const text = h.page === r.page && h.key === r.key ? textOf(h.page, h.key) : undefined;
    const at = text === undefined ? undefined : locate(h, text);
    if (!at || at.end <= r.start || at.start >= r.end) {
      out.push(h);
      continue;
    }
    if (at.start < r.start) out.push({ ...h, id: newId(), start: at.start, end: r.start, quote: text!.slice(at.start, r.start) });
    if (at.end > r.end) out.push({ ...h, id: newId(), start: r.end, end: at.end, quote: text!.slice(r.end, at.end) });
  }
  return out;
}

export const STYLE_LABELS: Record<HighlightStyle, string> = {
  yellow: '黄',
  green: '绿',
  blue: '蓝',
  pink: '粉',
  underline: '下划线',
};

/** 导出用的一条强调：按阅读顺序排好；source 是所在段落的原文（这一页看过才有） */
export interface HighlightEntry {
  page: number;
  key: string;
  style: HighlightStyle;
  quote: string;
  source?: string;
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * 导出 Markdown：按页分节，同一段里的强调列在一起，后面附该段原文作对照。
 * 高亮写成 ==…==（Obsidian 等能直接显示），下划线写成 <u>…</u>，非黄色在后面注明颜色。
 */
export function highlightsMarkdown(title: string, from: string, entries: HighlightEntry[]): string {
  const out = [`# ${oneLine(title)}：强调`, '', `来源：${from}`, ''];
  let page = -1;
  let key: string | undefined;
  let source: string | undefined;
  const flush = () => {
    if (source && oneLine(source) !== '') out.push('', `  > 原文：${oneLine(source)}`);
  };
  for (const e of entries) {
    if (e.page !== page) {
      flush();
      if (page !== -1) out.push('');
      out.push(`## 第 ${e.page} 页`, '');
      page = e.page;
      key = undefined;
    } else if (e.key !== key) flush();
    if (e.key !== key) {
      // 段落之间空一行；同一段的强调紧挨着
      if (key !== undefined) out.push('');
      key = e.key;
      source = e.source;
    }
    const text = oneLine(e.quote);
    const mark = e.style === 'underline' ? `<u>${text}</u>` : `==${text}==`;
    out.push(`- ${mark}${e.style === 'yellow' || e.style === 'underline' ? '' : `（${STYLE_LABELS[e.style]}）`}`);
  }
  flush();
  return `${out.join('\n')}\n`;
}

/** 添加强调：先切掉同一块里重叠的旧强调，新的覆盖在上面。首尾空白不算进强调 */
export function addHighlight(
  list: PdfHighlight[],
  r: TextRange,
  style: HighlightStyle,
  textOf: (page: number, key: string) => string | undefined,
): PdfHighlight[] {
  const text = textOf(r.page, r.key);
  if (text === undefined) return list;
  let { start, end } = r;
  while (start < end && /\s/.test(text[start]!)) start++;
  while (end > start && /\s/.test(text[end - 1]!)) end--;
  if (start >= end) return list;
  const rest = removeRange(list, { ...r, start, end }, textOf);
  return [...rest, { id: newId(), page: r.page, key: r.key, start, end, quote: text.slice(start, end), style }];
}
