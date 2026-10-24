import { matchSite } from './settings';

/**
 * 常见网站的适配规则：只在通用段落识别确实出错的地方补一刀。
 * 每条规则都来自真实页面的实测（docs/specs/2026-10-23-site-rules-design.md），选择器只用稳定的属性，
 * 不用 CSS Modules 带哈希的类名（如 Box__0K17vj，每次发版都会变）。
 */
export interface SiteRule {
  id: string;
  /** 主机名，同网站规则的写法：`github.com` 同时匹配子域名 */
  hosts: string[];
  /**
   * 白名单：只翻译这些元素里的内容，其余一律不翻。
   * 只用在页面结构长期稳定、正文位置明确的网站：选择器失效时整页都不会翻译。
   */
  include?: string[];
  /** 不翻译的元素（与用户的排除区域合并） */
  exclude?: string[];
}

export const SITE_RULES: SiteRule[] = [
  {
    // 每条标题下的「N points by X 2 hours ago | hide | N comments」、评论头部的用户名与时间、「reply」
    // 占了评论页三分之二的段落；页面结构二十年没变过，适合白名单
    id: 'hacker-news',
    hosts: ['news.ycombinator.com'],
    include: ['.titleline', '.commtext', '.toptext'],
  },
  {
    id: 'github',
    hosts: ['github.com'],
    exclude: [
      // 仓库首页的文件列表：文件名，以及每行的提交信息（插入译文会把表格撑乱）
      'table[aria-labelledby="folders-and-files"]',
      '[data-testid="latest-commit"]',
      // 文件查看页的代码：不在 <pre>/<code> 里，每行一个 div，会被逐行当成段落
      '.react-code-file-contents',
      // PR / 提交的 diff 与文件头
      'table.diff-table',
      '.file-header',
      // 文件树、路径面包屑、文件大小
      'nav[aria-label="File Tree Navigation"]',
      'nav[aria-label="Breadcrumbs"]',
      'nav[data-testid="breadcrumbs"]',
      '[data-testid="breadcrumbs-filename"]',
      '[data-testid="blob-size"]',
    ],
  },
  {
    // 双语对照下通用识别已经干净（推文、简介、标题）；问题在仅译文模式：短文字照翻，
    // 用户名被意译（「Python Software Foundation」→「Python 软件基金会」，「Bball Paul」→「篮球保罗」）
    id: 'x',
    hosts: ['x.com', 'twitter.com'],
    exclude: [
      // 推文作者、个人主页头部的显示名与 @账号
      '[data-testid="User-Name"]',
      '[data-testid="UserName"]',
      // 推荐关注等用户卡片里的名字与 @账号（简介不在链接里，照常翻译）
      '[data-testid="UserCell"] a[role="link"]',
      // 趋势：大多是人名、话题标签
      '[data-testid="trend"]',
      // 浏览量（数字与「Views」分属两段，仅译文模式下会显示成「38.2K Views浏览量」）
      'a[href$="/analytics"]',
    ],
  },
];

/** 当前网站适用的规则；同一网站只取第一条 */
export function findSiteRule(hostname: string): SiteRule | undefined {
  return SITE_RULES.find((rule) => matchSite(hostname, rule.hosts));
}

// e2e 构建：给 localhost 上的测试页一条规则，验证白名单 / 排除机制（正式构建里 MODE 是常量，这段会被剔除）
if (import.meta.env.MODE === 'e2e') {
  SITE_RULES.push({ id: 'e2e', hosts: ['localhost'], include: ['.story-title', '.comment-text'], exclude: ['.code-view'] });
}
