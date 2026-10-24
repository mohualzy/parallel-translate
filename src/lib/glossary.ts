/**
 * 用户术语表：设置页里每行一条 `原文 = 译法`；只写原文表示保持原文不译；`#` 开头为注释。
 * 只把当批文本里实际出现的条目注入 prompt，避免无关术语污染上下文。
 */
export interface GlossaryEntry {
  source: string;
  target: string;
  /**
   * 适用条件（可选）：写成 `Apple = Apple（指公司时）`。有条件的条目由模型按语境判断，
   * 不满足条件时正常翻译；没有条件的条目是硬规则（见 DECISIONS D49）。
   */
  condition?: string;
}

/** 译法末尾的括号说明是适用条件：`Apple（指公司时）`、`Apple (when it means the company)` */
const RE_CONDITION = /^(.*?)\s*[（(]([^（）()]+)[）)]$/;

export function parseGlossary(text: string): GlossaryEntry[] {
  const entries: GlossaryEntry[] = [];
  const seen = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    // 只写原文加条件（`Amazon（指公司时）`）：保持原文不译，但仅在条件满足时
    const bare = at === -1 ? RE_CONDITION.exec(line) : null;
    if (bare) {
      const source = bare[1]!.trim();
      if (!source || seen.has(source.toLowerCase())) continue;
      seen.add(source.toLowerCase());
      entries.push({ source, target: source, condition: bare[2]!.trim() });
      continue;
    }
    const source = (at === -1 ? line : line.slice(0, at)).trim();
    let target = (at === -1 ? source : line.slice(at + 1).trim()) || source;
    const key = source.toLowerCase();
    if (!source || seen.has(key)) continue;
    seen.add(key);
    const cond = RE_CONDITION.exec(target);
    if (cond) {
      target = cond[1]!.trim() || source;
      entries.push({ source, target, condition: cond[2]!.trim() });
    } else {
      entries.push({ source, target });
    }
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
