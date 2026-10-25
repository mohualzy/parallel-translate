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

/**
 * 本地 PDF（file://）自动打开的状态（D67），按「标签页 + 地址」记，存 storage.session。
 * file:// 不经过 DNR，网页也跳不到扩展页面（本地文件是不透明来源，web_accessible_resources 放行不了），
 * 只能由后台 tabs.update 换成阅读器，PDF 这条历史因此留着。前进 / 后退到它时按方向再走一步，效果等于跳过它。
 */
export interface LocalPdfState {
  /** 「原文件」放行：这个标签页看这个文件不再转进阅读器 */
  bypass: string[];
  /** 自动转进过阅读器的 */
  redirected: string[];
  /** 标签页 → 正在（或最近一次）显示的阅读器所读的本地文件；后退离开阅读器时据此判断方向 */
  showing: Record<string, string>;
}

export const EMPTY_LOCAL_PDF_STATE: LocalPdfState = { bypass: [], redirected: [], showing: {} };

const fileKey = (tabId: number, url: string) => `${tabId} ${url}`;

/**
 * 本地 PDF 页面加载时怎么做：open 转进阅读器；back / forward 是前进后退回到了这条历史，接着往同一方向走；
 * null 显示原文件（开关关着、被「原文件」放行、这个标签页没自动转过这个文件）。返回更新后的状态。
 */
export function localPdfAction(
  state: LocalPdfState,
  tabId: number,
  url: string,
  traverse: boolean,
): { action: 'open' | 'back' | 'forward' | null; state: LocalPdfState } {
  const key = fileKey(tabId, url);
  if (state.bypass.includes(key)) return { action: null, state };
  if (!traverse) {
    const redirected = state.redirected.includes(key) ? state.redirected : [...state.redirected, key];
    return { action: 'open', state: { ...state, redirected } };
  }
  if (!state.redirected.includes(key)) return { action: null, state };
  // 阅读器刚显示的就是这个文件：是从阅读器后退回来的，继续后退；否则是从前一页前进过来的，继续前进到阅读器
  if (state.showing[tabId] === url) {
    const { [tabId]: _, ...showing } = state.showing;
    return { action: 'back', state: { ...state, showing } };
  }
  return { action: 'forward', state };
}

/** 「原文件」：这个标签页看这个文件不再转进阅读器 */
export function bypassLocalPdf(state: LocalPdfState, tabId: number, url: string): LocalPdfState {
  return { ...state, bypass: [...state.bypass, fileKey(tabId, url)] };
}

/** 阅读器显示了某个本地文件 */
export function showingLocalPdf(state: LocalPdfState, tabId: number, url: string): LocalPdfState {
  return { ...state, showing: { ...state.showing, [tabId]: url } };
}

/** 阅读器地址里的 PDF 地址：?file=<编码后的地址>（弹窗、右键菜单），或 #<原地址>（自动打开的重定向） */
export function fileFromReaderUrl(href: string): string | undefined {
  const u = new URL(href);
  const param = u.searchParams.get('file');
  if (param) return param;
  const hash = href.indexOf('#');
  return hash >= 0 && hash + 1 < href.length ? href.slice(hash + 1) : undefined;
}
