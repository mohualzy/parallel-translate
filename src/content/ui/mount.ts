import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root';
import themeCss from './theme.css?inline';

/**
 * 页面内 UI 的统一挂载：
 * - 每个组件一个 Shadow Root，网页 CSS 与组件 CSS 互不影响；
 * - 宿主标签统一 `ptx-ui-*`，段落扫描按 `ptx-` 前缀忽略，不会把扩展 UI 当原文；
 * - 挂在 <html> 下而不是 <body>，不触发正文的 MutationObserver，也不受 body 排版影响；
 * - 幂等：同名宿主已存在时先移除（扩展更新后旧内容脚本留下的残骸）；
 * - 扩展失效（更新/卸载）时由 ctx 自动移除。
 */
export interface PageUi {
  host: HTMLElement;
  shadow: ShadowRoot;
  /** 组件根容器，组件内容放这里 */
  root: HTMLElement;
  remove(): void;
}

export async function mountPageUi(ctx: ContentScriptContext, name: string, css: string): Promise<PageUi> {
  const tag = `ptx-ui-${name}`;
  document.querySelectorAll(tag).forEach((el) => el.remove());

  const ui = await createShadowRootUi(ctx, {
    name: tag,
    position: 'inline',
    anchor: document.documentElement,
    append: 'last',
    css: `${themeCss}\n${css}`,
    // 组件里的按键不要冒泡到网页（避免触发网页快捷键）
    isolateEvents: ['keydown', 'keyup', 'keypress'],
    onMount: (container) => container,
  });
  ui.mount();
  ui.shadowHost.setAttribute('translate', 'no');
  ui.shadowHost.classList.add('notranslate');
  return { host: ui.shadowHost, shadow: ui.shadow, root: ui.uiContainer, remove: () => ui.remove() };
}

/**
 * 事件是否发生在本扩展的页面内 UI 里（划词、悬停等逻辑据此忽略）。
 * Shadow DOM 内的事件冒泡到 document 时 target 被重定向为宿主，所以检查完整的 composedPath。
 */
export function isFromPageUi(e: Event): boolean {
  return e.composedPath().some((n) => n instanceof Element && n.localName.startsWith('ptx-ui-'));
}

/** 把面板放在锚点矩形附近，并夹紧在视口内 */
export function placeNear(
  panel: HTMLElement,
  anchor: { left: number; top: number; bottom: number },
  gap = 8,
): void {
  const margin = 8;
  const { width, height } = panel.getBoundingClientRect();
  let left = anchor.left;
  let top = anchor.bottom + gap;
  if (top + height > innerHeight - margin) top = Math.max(margin, anchor.top - gap - height);
  left = Math.min(Math.max(margin, left), innerWidth - width - margin);
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}
