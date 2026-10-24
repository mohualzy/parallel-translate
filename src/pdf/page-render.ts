import { MONO_FONT, type PdfTextItem } from '@/lib/pdf/layout';
import { pdfjs, type PdfPage } from './loader';

/** 渲染时记录下来的一个字形：画回原样（保留块、公式原子）要用到原始参数 */
export interface Glyph {
  text: string;
  rawX: number;
  rawY: number;
  /** fillText 时的变换矩阵 */
  m: [number, number, number, number, number, number];
  /** 视口（设备像素）坐标下的基线位置 */
  x: number;
  y: number;
  fill: string;
  font: string;
  /** pdf.js 载入的字体 id（ctx.font 里的字体名），与文本项的 fontId 对应 */
  fontId: string;
  /** 设备像素下的宽度 */
  w: number;
}

export interface RenderedPage {
  original: HTMLCanvasElement;
  /** 去掉文字的底图：背景、图片、线条 */
  background: HTMLCanvasElement;
  glyphs: Glyph[];
}

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width);
  canvas.height = Math.ceil(height);
  return canvas;
}

/**
 * 渲染两次：一次原样；一次把 fillText / strokeText 换成记录函数，得到只有背景的底图和全部字形。
 * pdf.js 默认用 FontFace + fillText 画字，所以去字形对绝大多数 PDF 有效（Type3 字体除外，见 hasType3Font）。
 */
export async function renderPage(page: PdfPage, viewport: pdfjs.PageViewport): Promise<RenderedPage> {
  const original = makeCanvas(viewport.width, viewport.height);
  await page.render({ canvas: original, canvasContext: original.getContext('2d')!, viewport }).promise;

  const background = makeCanvas(viewport.width, viewport.height);
  const ctx = background.getContext('2d')!;
  const glyphs: Glyph[] = [];
  ctx.fillText = function (this: CanvasRenderingContext2D, text: string, x: number, y: number) {
    const t = this.getTransform();
    const scaleX = Math.hypot(t.a, t.b);
    glyphs.push({
      text,
      rawX: x,
      rawY: y,
      m: [t.a, t.b, t.c, t.d, t.e, t.f],
      x: t.a * x + t.c * y + t.e,
      y: t.b * x + t.d * y + t.f,
      fill: String(this.fillStyle),
      font: this.font,
      fontId: /px\s+"?([^",]+)/.exec(this.font)?.[1]?.trim() ?? '',
      w: this.measureText(text).width * scaleX,
    });
  };
  ctx.strokeText = () => undefined;
  await page.render({ canvas: background, canvasContext: ctx, viewport }).promise;
  // 实例上的覆盖删掉后，回到原型上的真 fillText，后面要在这张底图上写译文
  delete (ctx as { fillText?: unknown }).fillText;
  delete (ctx as { strokeText?: unknown }).strokeText;
  return { original, background, glyphs };
}

/** pdf.js 已加载的字体对象（需 fontExtraProperties: true 才有 name） */
function fontInfo(page: PdfPage, fontName: string): { name: string; isType3Font: boolean } {
  try {
    const font = page.commonObjs.get(fontName) as { name?: string; isType3Font?: boolean };
    return { name: font.name ?? '', isType3Font: font.isType3Font === true };
  } catch {
    return { name: '', isType3Font: false };
  }
}

export interface PageText {
  items: PdfTextItem[];
  /** 用了 Type3 字体：字形是路径画的，去不掉，译文会叠在原文上 */
  type3: boolean;
}

/** 文本项换算到视口坐标；字体名在渲染之后才可用，所以先 renderPage 再调用 */
export async function extractText(page: PdfPage, viewport: pdfjs.PageViewport): Promise<PageText> {
  const content = await page.getTextContent();
  const items: PdfTextItem[] = [];
  let type3 = false;
  for (const it of content.items) {
    if (!('str' in it) || it.str === '') continue;
    const t = pdfjs.Util.transform(viewport.transform, it.transform);
    const size = Math.hypot(t[2], t[3]);
    const font = fontInfo(page, it.fontName);
    if (font.isType3Font && it.str.trim()) type3 = true;
    items.push({
      str: it.str,
      x: t[4],
      y: t[5],
      w: it.width * viewport.scale,
      size,
      font: font.name,
      fontId: it.fontName,
      rotated: Math.abs(t[1]) > 0.01 * size || Math.abs(t[2]) > 0.01 * size,
      mono: MONO_FONT.test(font.name) || content.styles[it.fontName]?.fontFamily === 'monospace',
    });
  }
  return { items, type3 };
}
