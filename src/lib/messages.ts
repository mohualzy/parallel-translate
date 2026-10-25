import { browser } from 'wxt/browser';
import { sendWithInject } from './inject';
import type { GlossaryEntry } from './glossary';
import type { ProviderConfig } from './settings';

// ---------- 页面 / 设置页 → background ----------

/** 随翻译请求附带的页面上下文，帮助模型判断领域、消歧（不计入缓存键，同一段文字跨页面复用缓存） */
export interface PageContext {
  title: string;
  /** meta description / og:description，最多 300 字 */
  summary: string;
  /** 内容是视频字幕：相邻片段是连续台词，译文要口语、简洁 */
  subtitles?: boolean;
  /** 内容来自 PDF 版面：译文要放回原位置，提示模型保持简洁 */
  fixedLayout?: boolean;
  /** 翻译风格档案 id（lib/profiles.ts），由内容脚本按网站解析 */
  profile?: string;
  /** AI 从本文抽取的术语（与用户术语表合并，用户的优先） */
  terms?: GlossaryEntry[];
}

export type BackgroundRequest =
  | { type: 'translate'; segments: string[]; page: PageContext }
  /** 长文术语抽取：从正文抽取全文需要一致的术语 */
  | { type: 'extract-terms'; text: string }
  /** 输入框翻译：译成 inputTargetLang */
  | { type: 'translate-input'; text: string }
  | { type: 'test-provider'; provider: ProviderConfig }
  | { type: 'list-models'; provider: ProviderConfig }
  | { type: 'clear-cache' }
  | { type: 'cache-count' }
  /** 顶层页面翻译开关变化后，请后台转告同一标签页的所有 iframe */
  | { type: 'broadcast-enabled'; enabled: boolean }
  /** iframe 加载时询问顶层页面是否在翻译 */
  | { type: 'top-frame-state' }
  /** PDF 阅读器「原文件」：本标签页放行这个地址（不再自动转进阅读器），用浏览器自带的查看器打开 */
  | { type: 'open-original-pdf'; url: string }
  /** 本地 PDF 页面加载：后台决定转进阅读器（自己换掉标签页）、让页面接着前进 / 后退，或什么都不做（D67） */
  | { type: 'local-pdf-loaded'; url: string; traverse: boolean }
  /** 阅读器显示了一个本地 PDF：记下来，之后从阅读器后退到那个文件时知道方向 */
  | { type: 'local-pdf-shown'; url: string };

export interface TranslateResult {
  /** 与 segments 等长；null 表示该段失败 */
  translations: (string | null)[];
  /** 有段失败时的原因 */
  error?: string;
}

export interface BackgroundResponses {
  translate: TranslateResult;
  'translate-input': string;
  'extract-terms': GlossaryEntry[];
  'test-provider': { text: string; ms: number };
  'list-models': string[];
  'clear-cache': null;
  'cache-count': number;
  'broadcast-enabled': null;
  'top-frame-state': TabState | null;
  'open-original-pdf': null;
  'local-pdf-loaded': 'back' | 'forward' | null;
  'local-pdf-shown': null;
}

export type Envelope<T> = { ok: true; data: T } | { ok: false; error: string };

export async function sendToBackground<R extends BackgroundRequest>(
  request: R,
): Promise<BackgroundResponses[R['type']]> {
  const res = (await browser.runtime.sendMessage(request)) as Envelope<BackgroundResponses[R['type']]> | undefined;
  if (!res) throw new Error('后台无响应，请刷新页面后重试');
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

// ---------- 划词翻译：长连接流式返回 ----------

/** 划词翻译用 runtime.connect 长连接：能逐段推送译文；页面关闭弹窗即断开，后台随之中止请求 */
export const SELECTION_PORT = 'ptx-selection';

export interface SelectionRequest {
  text: string;
  context: string;
  word: boolean;
}

export type SelectionEvent =
  | { type: 'delta'; delta: string }
  | { type: 'done'; text: string }
  | { type: 'error'; error: string };

// ---------- 弹窗 / background → 页面 ----------

export type TabRequest =
  | { type: 'toggle' }
  | { type: 'translate-whole-page' }
  | { type: 'toggle-display-mode' }
  | { type: 'toggle-mask' }
  /** 重试本页所有失败的段落 */
  | { type: 'retry-failed' }
  /** Alt+I：发给所有 frame，由焦点所在 frame 翻译其中的输入框 */
  | { type: 'translate-input' }
  | { type: 'get-state' }
  /** 后台转发给 iframe：跟随顶层页面开 / 关翻译 */
  | { type: 'set-enabled'; enabled: boolean };

export interface TabState {
  enabled: boolean;
  /** 已识别的段落数 / 已翻译 / 失败 */
  total: number;
  done: number;
  failed: number;
  pageLang: string;
  /** AI 从本文抽取的术语 */
  terms: GlossaryEntry[];
  /** 当前页面实际使用的翻译风格档案，以及不考虑用户指定时自动选择的档案 */
  profile: string;
  autoProfile: string;
}

/**
 * 发给标签页的顶层页面（frameId 0）；iframe 的状态由顶层页面广播同步，不直接控制。
 * 页面里没有可用的内容脚本（安装前打开、扩展更新后）时自动注入再发。
 */
export async function sendToTab(tabId: number, request: TabRequest): Promise<TabState> {
  return sendWithInject(tabId, async () => (await browser.tabs.sendMessage(tabId, request, { frameId: 0 })) as TabState);
}
