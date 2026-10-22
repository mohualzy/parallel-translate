import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import * as cache from '@/background/cache';
import { listModels, testProvider, translateSegments } from '@/background/translate';
import type { BackgroundRequest, BackgroundResponses, Envelope, TabRequest } from '@/lib/messages';

const MENU_TOGGLE = 'ptx-toggle';

async function handle(request: BackgroundRequest): Promise<BackgroundResponses[BackgroundRequest['type']]> {
  switch (request.type) {
    case 'translate':
      return translateSegments(request.segments, request.title);
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
  // chrome:// 等页面没有内容脚本，忽略即可
  await browser.tabs.sendMessage(id, request).catch(() => undefined);
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
    if (command === 'toggle-translate') void sendToActiveTab({ type: 'toggle' }, tab?.id);
    if (command === 'toggle-display-mode') void sendToActiveTab({ type: 'toggle-display-mode' }, tab?.id);
  });

  // 用 sendResponse + return true 的写法，兼容所有 Chromium 版本与 Firefox
  browser.runtime.onMessage.addListener((request: BackgroundRequest, _sender, sendResponse) => {
    handle(request).then(
      (data) => sendResponse({ ok: true, data } satisfies Envelope<unknown>),
      (err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
    return true;
  });
});
