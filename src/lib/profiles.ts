import { matchSite } from './settings';

/**
 * 翻译风格档案：叠加在同一套翻译请求上的风格要求，
 * 只替换 prompt 里的「风格」一段，格式协议不变。设计见 docs/specs/2026-10-23-prompt-profiles-design.md。
 */
export type ProfileId = 'general' | 'tech' | 'paper' | 'news' | 'social' | 'fiction';

export interface Profile {
  id: ProfileId;
  /** 界面显示名 */
  name: string;
  /** 目标语言是中文时用的风格要求 */
  zh: string;
  /** 其他目标语言用的风格要求 */
  en: string;
}

export const PROFILES: Profile[] = [
  {
    id: 'general',
    name: '通用',
    zh: '译文忠实、通顺，像母语者写的文字，避免翻译腔。专有名词、产品名、代码标识符和 URL 在保留原文更易读时保持不变。',
    en:
      'Translate faithfully and fluently, the way a native speaker would write it. ' +
      'Keep proper nouns, product names, code identifiers and URLs unchanged when that reads better.',
  },
  {
    id: 'tech',
    name: '技术文档',
    zh: '这是技术文档或开发者内容。术语使用业界通行的译法；API、函数名、类名、命令、参数、配置项、版本号和产品名保留原文；准确优先，不要意译或添加原文没有的解释；句子简洁。',
    en:
      'This is technical documentation or developer content. Use the established industry terminology; keep API names, functions, classes, commands, ' +
      'parameters, config keys, version numbers and product names in the original; prefer precision over paraphrase and add nothing that is not in the source; keep sentences concise.',
  },
  {
    id: 'paper',
    name: '学术论文',
    zh: '这是学术论文。使用严谨、正式的学术语体；关键术语使用学界通行译法，首次出现时在译文后用括号注明原文；公式、变量、引用标记、缩写和人名（作者、被引学者）原样保留，人名不要音译；不要简化或省略论证细节。',
    en:
      'This is an academic paper. Use a rigorous, formal academic register; use the accepted terminology of the field and put the original term in parentheses on its first occurrence; ' +
      'keep formulas, variables, citation markers, abbreviations and personal names (authors, cited researchers) unchanged, never transliterate names; do not simplify or drop details of the argument.',
  },
  {
    id: 'news',
    name: '新闻',
    zh: '这是新闻报道。使用客观、简洁的新闻语体；人名、地名、机构名使用通行译名；数字、日期、引语务必准确，不要添加评论或改变语气。',
    en:
      'This is a news article. Use an objective, concise journalistic register; use the established names for people, places and organizations; ' +
      'keep numbers, dates and quotes exact; do not add commentary or change the tone.',
  },
  {
    id: 'social',
    name: '社交媒体',
    zh: '这是社交媒体或论坛上的帖子和评论。译文口语化、自然，保留原文的语气、情绪和幽默；网络用语、梗和俚语换成意思相当的地道表达；@用户名、#话题标签、链接和表情符号原样保留。',
    en:
      'These are social media or forum posts and comments. Keep the translation casual and natural, preserving the tone, emotion and humor; ' +
      'render slang, memes and internet jargon with natural equivalents; keep @mentions, #hashtags, links and emoji unchanged.',
  },
  {
    id: 'fiction',
    name: '文学',
    zh: '这是小说或文学作品。译文要传神、优美，保留原文的修辞、节奏和意象；人物对话符合其身份和性格；不要省略细节或改写情节。',
    en:
      'This is fiction or literary writing. Make the translation expressive and graceful, preserving rhetoric, rhythm and imagery; ' +
      "keep each character's voice consistent with who they are; do not omit details or rewrite the plot.",
  },
];

export function getProfile(id: string | undefined): Profile {
  return PROFILES.find((p) => p.id === id) ?? PROFILES[0]!;
}

/** 内置的主机名 → 档案（含子域名），只收录内容类型明确的网站 */
const HOST_PROFILES: [ProfileId, string[]][] = [
  [
    'tech',
    [
      'github.com',
      'gitlab.com',
      'stackoverflow.com',
      'stackexchange.com',
      'developer.mozilla.org',
      'learn.microsoft.com',
      'readthedocs.io',
      'readthedocs.org',
      'dev.to',
      'npmjs.com',
      'pypi.org',
      'docs.rs',
    ],
  ],
  ['paper', ['arxiv.org', 'dl.acm.org', 'ieeexplore.ieee.org', 'openreview.net', 'semanticscholar.org', 'nature.com', 'sciencedirect.com']],
  ['news', ['reuters.com', 'apnews.com', 'bbc.com', 'bbc.co.uk', 'nytimes.com', 'theguardian.com', 'washingtonpost.com', 'wsj.com', 'bloomberg.com', 'ft.com', 'cnn.com', 'economist.com']],
  ['social', ['x.com', 'twitter.com', 'reddit.com', 'news.ycombinator.com', 'mastodon.social', 'bsky.app']],
];

/** 文档站常见的子域名前缀：docs.example.com、developer.example.com */
const TECH_SUBDOMAIN = /^(docs|developer|developers|dev)\./;

/**
 * 当前页面用哪个档案：用户为该网站指定的 > 页面是论文（有 citation_* meta）> 内置主机名映射 > 通用。
 */
export function resolveProfile(hostname: string, siteProfiles: Record<string, string>, hasCitationMeta: boolean): ProfileId {
  const host = hostname.toLowerCase();
  const chosen = Object.entries(siteProfiles).find(([site]) => matchSite(host, [site]))?.[1];
  if (chosen && PROFILES.some((p) => p.id === chosen)) return chosen as ProfileId;
  return autoProfile(host, hasCitationMeta);
}

/** 不考虑用户指定时的自动选择（弹窗里「自动（当前：…）」显示它） */
export function autoProfile(hostname: string, hasCitationMeta: boolean): ProfileId {
  if (hasCitationMeta) return 'paper';
  const host = hostname.toLowerCase();
  for (const [id, hosts] of HOST_PROFILES) if (matchSite(host, hosts)) return id;
  if (TECH_SUBDOMAIN.test(host)) return 'tech';
  return 'general';
}
