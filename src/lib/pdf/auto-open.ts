/**
 * 自动用双语阅读器打开 PDF（决策见 docs/DECISIONS.md D61）：declarativeNetRequest 按响应头重定向。
 * 这里只生成规则对象，增删规则由 background 负责；纯逻辑，可单测。
 */

/** 动态规则 id：自动打开 PDF */
export const AUTO_OPEN_RULE_ID = 1;
/** 会话规则 id 的起点：「原文件」按钮给某个标签页放行某个地址 */
export const BYPASS_RULE_BASE = 1000;

/** declarativeNetRequest 规则里用到的字段（与 chrome.declarativeNetRequest.Rule 兼容） */
export interface DnrRule {
  id: number;
  priority: number;
  action: { type: 'redirect'; redirect: { regexSubstitution: string } } | { type: 'allow' };
  condition: {
    regexFilter: string;
    resourceTypes: 'main_frame'[];
    tabIds?: number[];
    responseHeaders?: { header: string; values: string[] }[];
    excludedResponseHeaders?: { header: string; values: string[] }[];
  };
}

/**
 * 主框架请求的响应是 PDF 时重定向到阅读器：按 content-type 判断，arXiv /pdf/… 这类没有后缀的地址也能识别；
 * 以附件下载的（content-disposition: attachment）不拦。原地址原样放进 hash（regexSubstitution 不能编码，请求地址不带 #）。
 * readerPage：chrome.runtime.getURL('/pdf.html')。
 */
export function autoOpenRule(readerPage: string): DnrRule {
  return {
    id: AUTO_OPEN_RULE_ID,
    priority: 1,
    action: { type: 'redirect', redirect: { regexSubstitution: `${readerPage}#\\0` } },
    condition: {
      regexFilter: '^https?://.*',
      resourceTypes: ['main_frame'],
      responseHeaders: [{ header: 'content-type', values: ['application/pdf*'] }],
      excludedResponseHeaders: [{ header: 'content-disposition', values: ['attachment*'] }],
    },
  };
}

/** 正则里的特殊字符转义 */
export const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 「原文件」：这个标签页打开这个地址时放行（优先级高于自动打开），用 Chrome 自带的查看器看原文件 */
export function bypassRule(id: number, url: string, tabId: number): DnrRule {
  return {
    id,
    priority: 2,
    action: { type: 'allow' },
    condition: { regexFilter: `^${escapeRegExp(url)}$`, resourceTypes: ['main_frame'], tabIds: [tabId] },
  };
}

/** 阅读器地址里的 PDF 地址：?file=<编码后的地址>（弹窗、右键菜单），或 #<原地址>（自动打开的重定向） */
export function fileFromReaderUrl(href: string): string | undefined {
  const u = new URL(href);
  const param = u.searchParams.get('file');
  if (param) return param;
  const hash = href.indexOf('#');
  return hash >= 0 && hash + 1 < href.length ? href.slice(hash + 1) : undefined;
}
