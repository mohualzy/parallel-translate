import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { mountPageUi, type PageUi } from './mount';

const css = `
.toast {
  position: fixed;
  top: 16px;
  left: 50%;
  z-index: 2147483647;
  max-width: min(420px, calc(100vw - 32px));
  padding: 10px 16px;
  border: 1px solid var(--ptx-border);
  border-radius: 10px;
  background: var(--ptx-bg);
  color: var(--ptx-text);
  box-shadow: var(--ptx-shadow);
  font: 13px/1.5 var(--ptx-font);
  transform: translateX(-50%);
}
`;

let ui: Promise<PageUi> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

/** 页面顶部的轻提示，同一时间只显示一条 */
export async function showToast(ctx: ContentScriptContext, message: string, durationMs = 4000) {
  ui ??= mountPageUi(ctx, 'toast', css);
  const { root } = await ui;
  root.innerHTML = '<div class="toast" role="status"></div>';
  root.querySelector('.toast')!.textContent = message;
  clearTimeout(timer);
  timer = setTimeout(() => root.replaceChildren(), durationMs);
}
