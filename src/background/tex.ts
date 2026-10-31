import katex from 'katex';

/** 公式来自不可信的页面文本：trust 保持默认的 false（\href 等不生效）。语法错误返回 null，调用方保留源码 */
export function renderTex(tex: string, display: boolean): string | null {
  try {
    return katex.renderToString(tex, { displayMode: display, output: 'mathml', throwOnError: true, strict: 'ignore' });
  } catch {
    return null;
  }
}
