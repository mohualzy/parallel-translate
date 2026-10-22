import { browser } from 'wxt/browser';
import type { ProviderConfig } from './settings';

// ---------- 页面 / 设置页 → background ----------

/** 随翻译请求附带的页面上下文，帮助模型判断领域、消歧（不计入缓存键，同一段文字跨页面复用缓存） */
export interface PageContext {
  title: string;
  /** meta description / og:description，最多 300 字 */
  summary: string;
}

export type BackgroundRequest =
  | { type: 'translate'; segments: string[]; page: PageContext }
  | { type: 'test-provider'; provider: ProviderConfig }
  | { type: 'list-models'; provider: ProviderConfig }
  | { type: 'clear-cache' }
  | { type: 'cache-count' };

export interface TranslateResult {
  /** 与 segments 等长；null 表示该段失败 */
  translations: (string | null)[];
  /** 有段失败时的原因 */
  error?: string;
}

export interface BackgroundResponses {
  translate: TranslateResult;
  'test-provider': { text: string; ms: number };
  'list-models': string[];
  'clear-cache': null;
  'cache-count': number;
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

export type TabRequest = { type: 'toggle' } | { type: 'toggle-display-mode' } | { type: 'get-state' };

export interface TabState {
  enabled: boolean;
  /** 已识别的段落数 / 已翻译 / 失败 */
  total: number;
  done: number;
  failed: number;
  pageLang: string;
}

export async function sendToTab(tabId: number, request: TabRequest): Promise<TabState> {
  return (await browser.tabs.sendMessage(tabId, request)) as TabState;
}
