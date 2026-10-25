import { composedChildren, isDecoration, isParagraphBreak, type DomClassifier } from './dom';

/**
 * 一个「行内片段」：某个块级容器下连续的行内子节点，即一个待翻译段落。
 * 例：<li>Item text<ul>…</ul></li> 中的 "Item text" 是一个片段（whole=false），
 *     <p>Hello <a>world</a></p> 中 p 的全部子节点是一个片段（whole=true）。
 */
export interface Run {
  container: Element;
  nodes: Node[];
  /** 片段是否覆盖容器的全部内容（决定仅译文模式能否隐藏原文） */
  whole: boolean;
  /** whole 时容器里与片段并列的装饰元素（图标），仅译文模式隐藏原文时保留显示 */
  decorations?: Element[];
}

/**
 * 从 root 开始收集所有行内片段（文档顺序）。
 * deep=false 时只收集 root 的直接子片段，用于悬停翻译定位单个段落。
 */
export function collectRuns(
  root: Element,
  classifier: DomClassifier,
  deep = true,
  /** 遍历中遇到 open shadow root 时回调（用于给它挂 MutationObserver、注入样式） */
  onShadowRoot?: (root: ShadowRoot) => void,
): Run[] {
  const runs: Run[] = [];

  const visit = (el: Element) => {
    const own: Run[] = [];
    let current: Node[] = [];
    let sawBlock = false;
    const decorations: Element[] = [];
    const flush = () => {
      if (current.length === 0) return;
      const run = { container: el, nodes: current, whole: false };
      own.push(run);
      runs.push(run);
      current = [];
    };

    if (el.shadowRoot) onShadowRoot?.(el.shadowRoot);
    for (const child of composedChildren(el)) {
      if (isParagraphBreak(child)) {
        sawBlock = true;
        flush();
        continue;
      }
      const kind = classifier.classify(child);
      if (kind === 'ignore') continue;
      if (kind === 'text' || kind === 'inline' || kind === 'opaque') {
        current.push(child);
        continue;
      }
      flush();
      // 没有文字的图标不算「容器里的别的内容」：「文字 + 图标」的按钮仍是整段
      if (isDecoration(child as Element)) {
        decorations.push(child as Element);
        continue;
      }
      sawBlock = true;
      if (kind === 'block' && deep) visit(child as Element);
    }
    flush();
    // 图标两侧的换行缩进会单独成片段，不算内容
    const meaningful = own.filter((r) => r.nodes.some((n) => n.nodeType !== Node.TEXT_NODE || n.textContent?.trim()));
    if (!sawBlock && meaningful.length === 1) {
      meaningful[0]!.whole = true;
      if (decorations.length > 0) meaningful[0]!.decorations = decorations;
    }
  };

  const kind = classifier.classify(root);
  if (kind === 'block') visit(root);
  return runs;
}

/** 片段是否覆盖了视口坐标 (x, y)，用于悬停翻译 */
export function runContainsPoint(run: Run, x: number, y: number): boolean {
  const range = document.createRange();
  range.setStartBefore(run.nodes[0]!);
  range.setEndAfter(run.nodes[run.nodes.length - 1]!);
  return Array.from(range.getClientRects()).some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
}
