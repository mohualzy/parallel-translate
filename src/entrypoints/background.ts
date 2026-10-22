import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import * as cache from '@/background/cache';
import { listModels, testProvider, translateSegments, translateSelection } from '@/background/translate';
import {
  SELECTION_PORT,
  type BackgroundRequest,
  type BackgroundResponses,
  type Envelope,
  type SelectionEvent,
  type SelectionRequest,
  type TabRequest,
  type TabState,
} from '@/lib/messages';

const MENU_TOGGLE = 'ptx-toggle';

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
  // 只发给顶层页面，iframe 由顶层页面广播同步；chrome:// 等页面没有内容脚本，忽略即可
  await browser.tabs.sendMessage(id, request, { frameId: 0 }).catch(() => undefined);
}

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener((details) => {
    browser.contextMenus.create({ id: MENU_TOGGLE, title: '翻译此页面 / 显示原文', contexts: ['page'] });
    if (details.reason === 'install') void browser.runtime.openOptionsPage();
  });

  browser.runtime.onStartup.addListener(() => void cache.prune().catch(() => undefined));

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === MENU_TOGGLE) void sendToActiveTab({ type: 'toggle' }, tab?.id);
  });

  browser.commands.onCommand.addListener((command, tab) => {
    const requests: Record<string, TabRequest> = {
      'toggle-translate': { type: 'toggle' },
      'translate-whole-page': { type: 'translate-whole-page' },
      'toggle-display-mode': { type: 'toggle-display-mode' },
      'toggle-mask': { type: 'toggle-mask' },
    };
    const request = requests[command];
    if (request) void sendToActiveTab(request, tab?.id);
  });

  // 划词翻译：长连接流式推送；页面断开（关闭弹窗、换选区）时中止请求
  browser.runtime.onConnect.addListener((port) => {
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
