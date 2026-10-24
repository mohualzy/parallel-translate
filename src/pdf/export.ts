import { writePdf, type PdfPageSpec } from '@/lib/pdf/write-pdf';

/**
 * 导出译文 PDF / 双语 PDF（决策见 docs/DECISIONS.md D63）：逐页离屏渲染、转 JPEG、拼成 PDF。
 * 一页转完就丢掉画布，内存只留压缩后的图片。
 */

export type ExportMode = 'translation' | 'bilingual';

export interface ExportSource {
  readonly pageCount: number;
  pageSize(index: number): { width: number; height: number };
  renderForExport(index: number, scale: number): Promise<{ original: HTMLCanvasElement; translated: HTMLCanvasElement; failed: number }>;
}

/** 渲染倍数：2 倍约 144 dpi，屏幕阅读和打印都够清楚 */
const SCALE = 2;
const QUALITY = 0.85;
/** 双语并排时左右两页之间的间隔（点） */
const GAP = 18;

async function toJpeg(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
  if (!blob) throw new Error('页面转图片失败');
  return new Uint8Array(await blob.arrayBuffer());
}

/** 释放画布占的内存（大页面 2 倍渲染一张就有十几 MB） */
const release = (canvas: HTMLCanvasElement) => {
  canvas.width = 0;
  canvas.height = 0;
};

export async function exportPdf(
  source: ExportSource,
  mode: ExportMode,
  title: string,
  onProgress: (done: number, total: number) => void,
  cancelled: () => boolean,
): Promise<{ bytes: Uint8Array; failed: number } | undefined> {
  const pages: PdfPageSpec[] = [];
  let failed = 0;
  const total = source.pageCount;
  for (let i = 1; i <= total; i++) {
    if (cancelled()) return undefined;
    onProgress(i - 1, total);
    const { width, height } = source.pageSize(i);
    const r = await source.renderForExport(i, SCALE);
    failed += r.failed;
    const image = async (canvas: HTMLCanvasElement, x: number) => ({
      jpeg: await toJpeg(canvas),
      pixelWidth: canvas.width,
      pixelHeight: canvas.height,
      x,
      y: 0,
      width,
      height,
    });
    pages.push(
      mode === 'bilingual'
        ? { width: width * 2 + GAP, height, images: [await image(r.original, 0), await image(r.translated, width + GAP)] }
        : { width, height, images: [await image(r.translated, 0)] },
    );
    release(r.original);
    release(r.translated);
  }
  onProgress(total, total);
  return { bytes: writePdf(pages, title), failed };
}

/** 文件名里不能有的字符换成空格 */
export const exportFileName = (title: string, mode: ExportMode) =>
  `${title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'pdf'}-${mode === 'bilingual' ? '双语' : '译文'}.pdf`;
