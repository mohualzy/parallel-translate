import { highlightsMarkdown, STYLE_LABELS, type HighlightEntry } from '@/lib/pdf/highlights';

/** 强调面板：按阅读顺序列出这篇文档的强调，点一条跳过去；可删除单条、导出 Markdown */

export interface HighlightPanelSource {
  entries(): (HighlightEntry & { id: string })[];
  reveal(id: string): void;
  remove(id: string): void;
  /** 导出时的标题和来源（文件地址或文件名） */
  meta(): { title: string; from: string };
}

export interface HighlightPanel {
  refresh(): void;
}

const SWATCH: Record<string, string> = { yellow: '#ffe45c', green: '#a8eb9a', blue: '#a5d4ff', pink: '#ffb3d1', underline: '#e5484d' };

/** 文件名里不能有的字符换成空格 */
const fileName = (title: string) => `${title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'pdf'}-强调.md`;

export function setupHighlightPanel(toggle: HTMLButtonElement, getSource: () => HighlightPanelSource | undefined): HighlightPanel {
  const panel = document.createElement('aside');
  panel.className = 'hl-panel';
  panel.id = 'hl-panel';
  panel.hidden = true;
  const title = document.createElement('strong');
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn';
  copy.textContent = '复制 Markdown';
  const download = document.createElement('button');
  download.type = 'button';
  download.className = 'btn';
  download.textContent = '导出 .md';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn';
  close.textContent = '×';
  close.setAttribute('aria-label', '关闭强调面板');
  const head = document.createElement('div');
  head.className = 'hl-panel-head';
  head.append(title, copy, download, close);
  const list = document.createElement('div');
  list.className = 'hl-list';
  panel.append(head, list);
  document.body.append(panel);

  const markdown = () => {
    const source = getSource();
    if (!source) return '';
    const { title: t, from } = source.meta();
    return highlightsMarkdown(t, from, source.entries());
  };

  function render() {
    const entries = getSource()?.entries() ?? [];
    toggle.textContent = `强调 ${entries.length}`;
    title.textContent = `强调（${entries.length}）`;
    copy.disabled = download.disabled = entries.length === 0;
    if (panel.hidden) return;
    if (entries.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = '在译文页上选中文字，在弹出的工具条里选颜色或下划线，强调会列在这里。';
      list.replaceChildren(empty);
      return;
    }
    const nodes: HTMLElement[] = [];
    let page = -1;
    for (const e of entries) {
      if (e.page !== page) {
        page = e.page;
        const h = document.createElement('div');
        h.className = 'hl-page';
        h.textContent = `第 ${page} 页`;
        nodes.push(h);
      }
      const item = document.createElement('div');
      item.className = 'hl-item';
      item.dataset.id = e.id;
      item.title = '跳到这里';
      const dot = document.createElement('span');
      dot.className = `hl-dot ${e.style}`;
      dot.style.setProperty('--c', SWATCH[e.style]!);
      dot.title = STYLE_LABELS[e.style];
      const text = document.createElement('span');
      text.className = 'hl-quote';
      text.textContent = e.quote;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'hl-del';
      del.textContent = '×';
      del.title = '删除这条强调';
      del.setAttribute('aria-label', '删除这条强调');
      del.addEventListener('click', (ev) => {
        ev.stopPropagation();
        getSource()?.remove(e.id);
      });
      item.addEventListener('click', () => getSource()?.reveal(e.id));
      item.append(dot, text, del);
      nodes.push(item);
    }
    list.replaceChildren(...nodes);
  }

  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-pressed', String(!panel.hidden));
    render();
  });
  close.addEventListener('click', () => {
    panel.hidden = true;
    toggle.setAttribute('aria-pressed', 'false');
  });
  copy.addEventListener('click', () => {
    void navigator.clipboard.writeText(markdown()).then(() => {
      copy.textContent = '已复制';
      setTimeout(() => (copy.textContent = '复制 Markdown'), 1500);
    });
  });
  download.addEventListener('click', () => {
    const source = getSource();
    if (!source) return;
    const url = URL.createObjectURL(new Blob([markdown()], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName(source.meta().title);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  render();
  return { refresh: render };
}
