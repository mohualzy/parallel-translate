import { browser, type Browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import * as cache from '@/background/cache';
import { lookupLyrics } from '@/background/lyrics';
import {
  extractTerms,
  videoBrief,
  listModels,
  testProvider,
  translateInput,
  translateSegments,
  translateSelection,
  translateText,
} from '@/background/translate';
import {
  AUTO_OPEN_RULE_ID,
  autoOpenRule,
  BYPASS_RULE_BASE,
  bypassLocalPdf,
  bypassRule,
  EMPTY_LOCAL_PDF_STATE,
  localPdfAction,
  showingLocalPdf,
  type LocalPdfState,
} from '@/lib/pdf/auto-open';
import { PDF_LINK_PATTERNS, viewerUrl } from '@/lib/pdf/url';
import { renderTex } from '@/background/tex';
import { getSettings, onSettingsChanged } from '@/lib/settings';
import { openSidePanel, PENDING_TEXT_KEY } from '@/lib/side-panel';
import { TEXT_PORT, type TextRequest } from '@/lib/text-translate';
import { injectIntoOpenTabs, sendWithInject } from '@/lib/inject';
import {
  SELECTION_PORT,
  type BackgroundRequest,
  type BackgroundResponses,
  type Envelope,
  type SelectionEvent,
  sendToTab,
  type SelectionRequest,
  type TabRequest,
  type TabState,
} from '@/lib/messages';

const MENU_TOGGLE = 'ptx-toggle';
const MENU_SIDE_PANEL = 'ptx-side-panel-selection';
const MENU_PDF_LINK = 'ptx-pdf-link';

async function handle(
  request: BackgroundRequest,
  sender: { tab?: { id?: number } },
): Promise<BackgroundResponses[BackgroundRequest['type']]> {
  const tabId = sender.tab?.id;
  switch (request.type) {
    case 'broadcast-enabled':
      // 发给整个标签页的所有 frame；顶层页面自己会忽略 set-enabled
      if (tabId !== undefined) {
        await browser.tabs.sendMessage(tabId, { type: 'set-enabled', enabled: request.enabled } satisfies TabRequest).catch(() => undefined);
      }
      return null;
    case 'top-frame-state':
      if (tabId === undefined) return null;
      return ((await browser.tabs.sendMessage(tabId, { type: 'get-state' } satisfies TabRequest, { frameId: 0 }).catch(() => null)) ??
        null) as TabState | null;
    case 'translate':
      return translateSegments(request.segments, request.page);
    case 'translate-input':
      return translateInput(request.text);
    case 'extract-terms':
      return extractTerms(request.text);
    case 'video-brief':
      return videoBrief(request.title, request.text);
    case 'lookup-lyrics':
      return lookupLyrics(request.artist, request.track, request.seconds, request.lang);
    case 'render-tex':
      return request.items.map((item) => renderTex(item.tex, item.display));
    case 'test-provider':
      return testProvider(request.provider);
    case 'list-models':
      return listModels(request.provider);
    case 'open-original-pdf':
      if (tabId !== undefined) await openOriginalPdf(tabId, request.url);
      return null;
    case 'local-pdf-loaded':
      return localPdfLoaded(tabId, request.url, request.traverse);
    case 'local-pdf-shown':
      if (tabId !== undefined) await saveLocalPdfState(showingLocalPdf(await localPdfState(), tabId, request.url));
      return null;
    case 'clear-cache':
      await cache.clear();
      return null;
    case 'cache-count':
      return cache.count();
  }
}

/** 按设置增删「自动用双语阅读器打开 PDF」的动态规则（D61）；动态规则会持久保存，启动时再对齐一次 */
let autoOpenEnabled: boolean | undefined;
async function syncAutoOpen(enabled: boolean) {
  if (enabled === autoOpenEnabled) return;
  autoOpenEnabled = enabled;
  await browser.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [AUTO_OPEN_RULE_ID],
    addRules: enabled ? [autoOpenRule(browser.runtime.getURL('/pdf.html')) as Browser.declarativeNetRequest.Rule] : [],
  });
}

/** 本地 PDF 自动打开的状态（D67），存 storage.session：后台重启后仍在，浏览器关掉即清空 */
const LOCAL_PDF_KEY = 'localPdf';
const localPdfState = async () =>
  ((await browser.storage.session.get(LOCAL_PDF_KEY))[LOCAL_PDF_KEY] as LocalPdfState | undefined) ?? EMPTY_LOCAL_PDF_STATE;
const saveLocalPdfState = (state: LocalPdfState) => browser.storage.session.set({ [LOCAL_PDF_KEY]: state });

/** 本地 PDF 页面加载（local-pdf 内容脚本发来）：要转进阅读器时直接换掉标签页，前进后退时告诉页面接着往哪走 */
async function localPdfLoaded(tabId: number | undefined, url: string, traverse: boolean): Promise<'back' | 'forward' | null> {
  if (tabId === undefined || !(await getSettings()).pdfAutoOpen) return null;
  const { action, state } = localPdfAction(await localPdfState(), tabId, url, traverse);
  await saveLocalPdfState(state);
  if (action !== 'open') return action;
  await browser.tabs.update(tabId, { url: `${browser.runtime.getURL('/pdf.html')}#${url}` });
  return null;
}

/** 「原文件」：给这个标签页的这个地址加一条会话级放行规则，再跳过去，由浏览器自带的查看器打开 */
async function openOriginalPdf(tabId: number, url: string) {
  if (url.startsWith('file:')) {
    await saveLocalPdfState(bypassLocalPdf(await localPdfState(), tabId, url));
    await browser.tabs.update(tabId, { url });
    return;
  }
  const rules = await browser.declarativeNetRequest.getSessionRules();
  const id = Math.max(BYPASS_RULE_BASE, ...rules.map((r) => r.id)) + 1;
  await browser.declarativeNetRequest.updateSessionRules({ addRules: [bypassRule(id, url, tabId) as Browser.declarativeNetRequest.Rule] });
  await browser.tabs.update(tabId, { url });
}

async function sendToActiveTab(request: TabRequest, tabId?: number) {
  const id = tabId ?? (await browser.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (id === undefined) return;
  // 只发给顶层页面，iframe 由顶层页面广播同步；chrome:// 等页面注入不了，忽略即可
  await sendToTab(id, request).catch(() => undefined);
}

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener((details) => {
    browser.contextMenus.create({ id: MENU_TOGGLE, title: '翻译此页面 / 显示原文', contexts: ['page'] });
    browser.contextMenus.create({ id: MENU_SIDE_PANEL, title: '在侧栏中翻译选中文字', contexts: ['selection'] });
    browser.contextMenus.create({ id: MENU_PDF_LINK, title: '用双语阅读器打开 PDF', contexts: ['link'], targetUrlPatterns: PDF_LINK_PATTERNS });
    if (details.reason === 'install') void browser.runtime.openOptionsPage();
    // 安装前打开的页面没有内容脚本，更新后旧脚本已失效：补注入，用户不用刷新页面
    if (details.reason === 'install' || details.reason === 'update') void injectIntoOpenTabs();
  });

  browser.runtime.onStartup.addListener(() => void cache.prune().catch(() => undefined));

  // 自动用双语阅读器打开 PDF：后台每次启动对齐一次，设置变化时跟着增删规则
  void getSettings().then((s) => syncAutoOpen(s.pdfAutoOpen));
  onSettingsChanged((s) => void syncAutoOpen(s.pdfAutoOpen).catch(() => undefined));

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === MENU_TOGGLE) void sendToActiveTab({ type: 'toggle' }, tab?.id);
    if (info.menuItemId === MENU_PDF_LINK && info.linkUrl) {
      void browser.tabs.create({ url: viewerUrl(info.linkUrl), index: tab ? tab.index + 1 : undefined });
    }
    if (info.menuItemId === MENU_SIDE_PANEL) {
      // 先同步打开（保住用户手势），再把文字交给侧栏：侧栏可能还没加载完，所以经 storage.session 而不是消息
      void openSidePanel(tab?.windowId).catch(() => undefined);
      void browser.storage.session.set({ [PENDING_TEXT_KEY]: info.selectionText ?? '' });
    }
  });

  browser.commands.onCommand.addListener((command, tab) => {
    if (command === 'open-side-panel') {
      void openSidePanel(tab?.windowId).catch(() => undefined);
      return;
    }
    if (command === 'translate-input') {
      // 焦点可能在 iframe 的输入框里：发给所有 frame，由拿着焦点的那个处理
      const id = tab?.id;
      if (id !== undefined) {
        void sendWithInject(id, () => browser.tabs.sendMessage(id, { type: 'translate-input' } satisfies TabRequest)).catch(() => undefined);
      }
      return;
    }
    const requests: Record<string, TabRequest> = {
      'toggle-translate': { type: 'toggle' },
      'translate-whole-page': { type: 'translate-whole-page' },
      'toggle-display-mode': { type: 'toggle-display-mode' },
      'toggle-mask': { type: 'toggle-mask' },
    };
    const request = requests[command];
    if (request) void sendToActiveTab(request, tab?.id);
  });

  // 划词翻译与侧栏文本翻译：长连接流式推送；页面断开（关闭弹窗、换选区、重新翻译）时中止请求
  browser.runtime.onConnect.addListener((port) => {
    if (port.name === TEXT_PORT) {
      const controller = new AbortController();
      port.onDisconnect.addListener(() => controller.abort());
      port.onMessage.addListener((request: TextRequest) => {
        const send = (event: SelectionEvent) => {
          if (!controller.signal.aborted) port.postMessage(event);
        };
        translateText(request, (delta) => send({ type: 'delta', delta }), controller.signal).then(
          (text) => send({ type: 'done', text }),
          (err: unknown) => send({ type: 'error', error: err instanceof Error ? err.message : String(err) }),
        );
      });
      return;
    }
    if (port.name !== SELECTION_PORT) return;
    const controller = new AbortController();
    const send = (event: SelectionEvent) => {
      if (!controller.signal.aborted) port.postMessage(event);
    };
    port.onDisconnect.addListener(() => controller.abort());
    port.onMessage.addListener((request: SelectionRequest) => {
      translateSelection(request, (delta) => send({ type: 'delta', delta }), controller.signal).then(
        (text) => send({ type: 'done', text }),
        (err: unknown) => send({ type: 'error', error: err instanceof Error ? err.message : String(err) }),
      );
    });
  });

  // 用 sendResponse + return true 的写法，兼容所有 Chromium 版本与 Firefox
  browser.runtime.onMessage.addListener((request: BackgroundRequest, sender, sendResponse) => {
    handle(request, sender).then(
      (data) => sendResponse({ ok: true, data } satisfies Envelope<unknown>),
      (err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
    return true;
  });
});
