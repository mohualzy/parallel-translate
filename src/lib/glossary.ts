/**
 * 用户术语表：设置页里每行一条 `原文 = 译法`；只写原文表示保持原文不译；`#` 开头为注释。
 * 只把当批文本里实际出现的条目注入 prompt，避免无关术语污染上下文。
 */
export interface GlossaryEntry {
  source: string;
  target: string;
}

export function parseGlossary(text: string): GlossaryEntry[] {
  const entries: GlossaryEntry[] = [];
  const seen = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    const source = (at === -1 ? line : line.slice(0, at)).trim();
    const target = (at === -1 ? source : line.slice(at + 1).trim()) || source;
    const key = source.toLowerCase();
    if (!source || seen.has(key)) continue;
    seen.add(key);
    entries.push({ source, target });
  }
  return entries;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 拉丁/西里尔等按「整词、不区分大小写」匹配，避免 cat 命中 category；CJK 等按子串匹配 */
function matches(entry: GlossaryEntry, text: string): boolean {
  if (/^[\p{Script=Latin}\p{Script=Cyrillic}\p{N}\s'’.-]+$/u.test(entry.source)) {
    return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(entry.source)}(?![\\p{L}\\p{N}])`, 'iu').test(text);
  }
  return text.includes(entry.source);
}

export function matchGlossary(entries: GlossaryEntry[], texts: string[]): GlossaryEntry[] {
  return entries.filter((entry) => texts.some((text) => matches(entry, text)));
}

/** 合并用户术语表与文章术语：同一原文以用户术语表为准（用户写的是确定的译法，AI 抽取的是推测） */
export function mergeGlossary(user: GlossaryEntry[], article: GlossaryEntry[]): GlossaryEntry[] {
  const known = new Set(user.map((e) => e.source.toLowerCase()));
  return [...user, ...article.filter((e) => !known.has(e.source.toLowerCase()))];
}
