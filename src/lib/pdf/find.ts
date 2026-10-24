/**
 * 译文页查找：在各块的显示文本里找（和断行无关，跨行的词也能找到；不跨块），不区分大小写。纯逻辑。
 * 设计见 docs/specs/2026-10-24-pdf-text-layer-design.md。
 */

export interface FindMatch {
  page: number;
  key: string;
  start: number;
  end: number;
}

/** pages：按页码排好的各页文字（块的顺序即阅读顺序） */
export function findMatches(pages: [number, { key: string; text: string }[]][], query: string): FindMatch[] {
  const q = query.trim();
  if (q === '') return [];
  const needle = q.toLowerCase();
  const out: FindMatch[] = [];
  for (const [page, blocks] of pages) {
    for (const b of blocks) {
      // 个别字符小写后长度会变（İ），偏移对不上，这种块按原样区分大小写
      const lower = b.text.toLowerCase();
      const [hay, n] = lower.length === b.text.length ? [lower, needle] : [b.text, q];
      for (let at = hay.indexOf(n); at >= 0; at = hay.indexOf(n, at + n.length)) {
        out.push({ page, key: b.key, start: at, end: at + n.length });
      }
    }
  }
  return out;
}
