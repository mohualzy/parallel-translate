import { browser } from 'wxt/browser';

/** 侧栏打开时要翻译的文字（右键菜单「在侧栏中翻译选中文字」交给侧栏），存在 storage.session */
export const PENDING_TEXT_KEY = 'sidePanelPendingText';

type SidebarAction = { sidebarAction?: { open(): Promise<void> } };

/**
 * 打开侧栏。必须在用户操作（点击、快捷键、右键菜单）的处理函数里同步调用：
 * chrome.sidePanel.open() 在 await 之后调用会因为丢失用户手势而失败。
 * Chrome 用原生侧栏，Firefox 用 sidebarAction，都没有时在新标签页打开同一页面。
 */
export function openSidePanel(windowId: number | undefined): Promise<void> {
  if (browser.sidePanel?.open && windowId !== undefined) return browser.sidePanel.open({ windowId });
  const firefox = (browser as unknown as SidebarAction).sidebarAction;
  if (firefox) return firefox.open();
  return browser.tabs.create({ url: browser.runtime.getURL('/sidepanel.html') }).then(() => undefined);
}
