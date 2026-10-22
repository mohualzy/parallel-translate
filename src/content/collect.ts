import { isParagraphBreak, type DomClassifier } from './dom';

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
}

/**
 * 从 root 开始收集所有行内片段（文档顺序）。
 * deep=false 时只收集 root 的直接子片段，用于悬停翻译定位单个段落。
 */
export function collectRuns(root: Element, classifier: DomClassifier, deep = true): Run[] {
  const runs: Run[] = [];

  const visit = (el: Element) => {
    const own: Run[] = [];
    let current: Node[] = [];
    let sawBlock = false;
    const flush = () => {
      if (current.length === 0) return;
      const run = { container: el, nodes: current, whole: false };
      own.push(run);
      runs.push(run);
      current = [];
    };

    for (const child of Array.from(el.childNodes)) {
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
      sawBlock = true;
      flush();
      if (kind === 'block' && deep) visit(child as Element);
    }
    flush();
    if (!sawBlock && own.length === 1) own[0]!.whole = true;
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
