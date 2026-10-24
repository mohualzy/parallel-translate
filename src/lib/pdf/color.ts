import type { PdfTextItem } from './layout';

/** 渲染时记录的字形里，拆分颜色要用到的部分（视口坐标） */
export interface ColorGlyph {
  text: string;
  x: number;
  y: number;
  w: number;
  fill: string;
  fontId?: string;
}

/** 字形和文本项是同一个字体（都有 id 时才比较）：没有文字层的公式符号（大括号）不会被旁边的正文认领 */
export const sameFont = (item: { fontId?: string }, g: { fontId?: string }) => !item.fontId || !g.fontId || item.fontId === g.fontId;

interface Run {
  color: string;
  text: string;
}

/** 文本项对应的字形：同一基线、起点落在该项的水平范围内，不含空白字形 */
function glyphsIn(item: PdfTextItem, glyphs: ColorGlyph[]): ColorGlyph[] {
  return glyphs
    .filter(
      (g) => g.text.trim() !== '' && sameFont(item, g) && Math.abs(g.y - item.y) < item.size * 0.25 && g.x >= item.x - 0.5 && g.x < item.x + item.w - 0.5,
    )
    .sort((a, b) => a.x - b.x);
}

/**
 * 把颜色段边界上的括号、分隔符归到彩色段：[ 1 , 20 ] 里通常只有数字是彩色的，
 * 整个引用应作为一个原子保留，避免模型把括号和逗号译成全角或拆散。
 */
function absorbPunctuation(runs: Run[]): Run[] {
  // 开括号：上一段末尾的 [ ( 移到下一段开头
  for (let i = 0; i < runs.length - 1; i++) {
    const m = /[[(]\s*$/.exec(runs[i]!.text);
    if (!m) continue;
    runs[i]!.text = runs[i]!.text.slice(0, m.index);
    runs[i + 1]!.text = m[0] + runs[i + 1]!.text;
  }
  // 分隔符：夹在两个同色段之间的逗号、分号、连字符，三段合成一段
  for (let i = 1; i < runs.length - 1; i++) {
    if (/^[\s,;–-]+$/.test(runs[i]!.text) && runs[i - 1]!.color === runs[i + 1]!.color) {
      runs[i - 1]!.text += runs[i]!.text + runs[i + 1]!.text;
      runs.splice(i, 2);
      i--;
    }
  }
  // 闭括号：以开括号起头的段，把下一段开头的 ] ) 收回来
  for (let i = 0; i < runs.length - 1; i++) {
    if (!/^\s*[[(]/.test(runs[i]!.text) || /[\])]\s*$/.test(runs[i]!.text)) continue;
    const m = /^\s*[\])]/.exec(runs[i + 1]!.text);
    if (!m) continue;
    runs[i]!.text += m[0];
    runs[i + 1]!.text = runs[i + 1]!.text.slice(m[0].length);
  }
  return runs.filter((r) => r.text !== '');
}

/**
 * 按字形颜色拆分文本项，并给每项标上颜色。pdf.js 的文本项不区分颜色，
 * 引用编号、交叉引用、链接常和前后正文在同一个文本项里。
 * 文字和字形对不上（连字、重映射）时不拆，只标上主色。
 */
export function splitByColor(items: PdfTextItem[], glyphs: ColorGlyph[]): PdfTextItem[] {
  return items.flatMap((item) => {
    if (item.rotated) return [item];
    const own = glyphsIn(item, glyphs);
    if (own.length === 0) return [item];
    const colors = new Set(own.map((g) => g.fill));
    const chars = [...item.str];
    const visible = chars.filter((c) => c.trim() !== '');
    if (colors.size === 1 || visible.length !== own.length) {
      const count = new Map<string, number>();
      for (const g of own) count.set(g.fill, (count.get(g.fill) ?? 0) + 1);
      return [{ ...item, color: [...count].sort((a, b) => b[1] - a[1])[0]![0] }];
    }

    // 逐字上色：可见字符按顺序对应字形，空白跟随前一个字符
    const runs: Run[] = [];
    let k = 0;
    for (const c of chars) {
      const color = c.trim() === '' ? (runs.at(-1)?.color ?? own[0]!.fill) : own[k++]!.fill;
      const last = runs.at(-1);
      if (last?.color === color) last.text += c;
      else runs.push({ color, text: c });
    }

    // 每段的起点取它第一个可见字形的位置，终点到下一段起点（最后一段到原项末尾）
    const merged = absorbPunctuation(runs);
    let pos = 0;
    const starts = merged.map((run) => {
      const x = own[pos]?.x ?? item.x + item.w;
      pos += [...run.text].filter((c) => c.trim() !== '').length;
      return x;
    });
    return merged.map((run, i) => {
      const x = i === 0 ? item.x : starts[i]!;
      const end = i === merged.length - 1 ? item.x + item.w : starts[i + 1]!;
      return { ...item, str: run.text, x, w: end - x, color: run.color };
    });
  });
}
