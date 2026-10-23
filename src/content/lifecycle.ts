import type { ContentScriptContext } from 'wxt/utils/content-script-context';

/** <html> 上的「正在翻译」标记：新实例据此接续旧实例的翻译状态 */
export const TRANSLATING_ATTR = 'data-ptx-on';
const STARTED_EVENT = 'ptx-content-started';

/**
 * 接替页面里已有的旧实例（扩展更新 / 重载后残留的孤儿脚本，或重复注入的脚本）：
 * 先记下旧实例是否在翻译，再通知它退场；之后再有新实例启动时，本实例同样退场。
 * 用不带数据的普通 DOM 事件：跨隔离世界也收得到（WXT 自带的机制依赖 CustomEvent.detail，孤儿脚本读不到）。
 * @returns 旧实例是否正在翻译
 */
export function takeOverPreviousInstance(ctx: ContentScriptContext): boolean {
  const wasTranslating = document.documentElement.hasAttribute(TRANSLATING_ATTR);
  document.dispatchEvent(new Event(STARTED_EVENT));
  // 在派发之后才监听，不会被自己的事件触发
  document.addEventListener(STARTED_EVENT, () => ctx.notifyInvalidated(), { once: true, signal: ctx.signal });
  return wasTranslating;
}

/** 失效时的清理。孤儿脚本里调用扩展 API 会抛错，每一项各自兜住，互不影响 */
export function onTeardown(ctx: ContentScriptContext, cleanup: () => void) {
  ctx.onInvalidated(() => {
    try {
      cleanup();
    } catch {
      // 扩展上下文已失效
    }
  });
}
