// @vitest-environment node
import { describe, expect, it } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { writePdf, type PdfPageSpec } from '@/lib/pdf/write-pdf';

/** 1×1 像素的最小 JPEG */
const jpeg = Uint8Array.from(
  atob('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA='),
  (c) => c.charCodeAt(0),
);
const image = (x: number, width: number) => ({ jpeg, pixelWidth: 1, pixelHeight: 1, x, y: 0, width, height: 300 });

const pages: PdfPageSpec[] = [
  { width: 200, height: 300, images: [image(0, 200)] },
  { width: 420, height: 300, images: [image(0, 200), image(220, 200)] },
];

describe('writePdf', () => {
  it('xref 里每个偏移都指向对应对象的开头', () => {
    const bytes = writePdf(pages, 'T');
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text.startsWith('%PDF-1.7')).toBe(true);
    const xrefAt = Number(/startxref\n(\d+)/.exec(text)![1]);
    const rows = text.slice(xrefAt).split('\n').slice(3);
    // 编码按字节算偏移：latin1 解码后一个字节对应一个字符
    for (let id = 1; id <= 10; id++) {
      const offset = Number(rows[id - 1]!.slice(0, 10));
      expect(text.slice(offset, offset + `${id} 0 obj`.length)).toBe(`${id} 0 obj`);
    }
  });

  it('pdf.js 能解析：页数、页面尺寸、中文标题', async () => {
    const task = pdfjs.getDocument({ data: writePdf(pages, '注意力就是你所需要的一切') });
    const doc = await task.promise;
    expect(doc.numPages).toBe(2);
    expect((await doc.getPage(1)).view).toEqual([0, 0, 200, 300]);
    expect((await doc.getPage(2)).view).toEqual([0, 0, 420, 300]);
    const info = (await doc.getMetadata()).info as { Title?: string };
    expect(info.Title).toBe('注意力就是你所需要的一切');
    const ops = await (await doc.getPage(2)).getOperatorList();
    // 第 2 页画了两张图
    expect(ops.fnArray.filter((f) => f === pdfjs.OPS.paintImageXObject).length).toBe(2);
    await task.destroy();
  });
});
