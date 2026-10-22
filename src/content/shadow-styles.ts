import pageCss from '@/entrypoints/content/style.css?inline';

/**
 * 页面级 CSS 进不了 Shadow Root，插在 shadow 树里的译文会失去样式（块级排版、译文样式、仅译文模式）。
 * 用一份共享的 CSSStyleSheet 通过 adoptedStyleSheets 注入，每个 shadow root 只注入一次。
 */
let sheet: CSSStyleSheet | undefined;
const styled = new WeakSet<ShadowRoot>();

export function ensureShadowStyles(node: Node) {
  const root = node.getRootNode();
  if (!(root instanceof ShadowRoot) || styled.has(root)) return;
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(pageCss);
  }
  root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  styled.add(root);
}
