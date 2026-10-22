import { LANGUAGES } from '@/lib/languages';
import type { HoverKey, SelectionMode, TranslationStyle } from '@/lib/settings';

export const STYLE_LABELS: Record<TranslationStyle, string> = {
  none: '无',
  dashed: '虚线下划线',
  underline: '下划线',
  highlight: '高亮背景',
  weak: '弱化（半透明）',
  blur: '模糊（悬停显示，适合自测）',
};

export const HOVER_KEY_LABELS: Record<HoverKey, string> = {
  Control: 'Ctrl',
  Alt: 'Alt',
  Shift: 'Shift',
  off: '关闭',
};

export const SELECTION_MODE_LABELS: Record<SelectionMode, string> = {
  icon: '选中后显示翻译按钮',
  direct: '选中后直接翻译',
  off: '关闭',
};

export function fillSelect(select: HTMLSelectElement, options: [value: string, label: string][], value: string) {
  select.replaceChildren(
    ...options.map(([v, label]) => {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = label;
      return opt;
    }),
  );
  select.value = value;
}

export const languageOptions = (): [string, string][] => LANGUAGES.map((l) => [l.code, l.name]);
export const styleOptions = (): [string, string][] => Object.entries(STYLE_LABELS);
export const hoverKeyOptions = (): [string, string][] => Object.entries(HOVER_KEY_LABELS);
export const selectionModeOptions = (): [string, string][] => Object.entries(SELECTION_MODE_LABELS);

export function $<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`元素不存在：${selector}`);
  return el;
}
