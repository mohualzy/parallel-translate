import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import * as cache from '@/background/cache';
import {
  extractTerms,
  listModels,
  testProvider,
  translateInput,
  translateSegments,
  translateSelection,
  translateText,
} from '@/background/translate';
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
    case 'test-provider':
      return testProvider(request.provider);
    case 'list-models':
      return listModels(request.provider);
    case 'clear-cache':
      await cache.clear();
      return null;
    case 'cache-count':
      return cache.count();
  }
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
    if (details.reason === 'install') void browser.runtime.openOptionsPage();
    // 安装前打开的页面没有内容脚本，更新后旧脚本已失效：补注入，用户不用刷新页面
    if (details.reason === 'install' || details.reason === 'update') void injectIntoOpenTabs();
  });

  browser.runtime.onStartup.addListener(() => void cache.prune().catch(() => undefined));

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === MENU_TOGGLE) void sendToActiveTab({ type: 'toggle' }, tab?.id);
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
