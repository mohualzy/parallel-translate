/**
 * 最小 PDF 写入器（导出译文 / 双语 PDF，决策见 docs/DECISIONS.md D63）：每页若干张 JPEG 图片。
 * JPEG 直接作为 DCTDecode 图片嵌入，不需要解码。坐标单位是 PDF 点，原点在页面左上角（写入时换算）。纯逻辑。
 */

export interface PdfImage {
  /** JPEG 文件内容 */
  jpeg: Uint8Array;
  /** 图片像素尺寸 */
  pixelWidth: number;
  pixelHeight: number;
  /** 在页面上的位置与大小（点，原点左上） */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfPageSpec {
  width: number;
  height: number;
  images: PdfImage[];
}

const encoder = new TextEncoder();
const num = (n: number) => String(Math.round(n * 100) / 100);

/** 文档信息里的文字：UTF-16BE 加 BOM，写成十六进制串（中文标题也不会乱码） */
function pdfText(s: string): string {
  let hex = 'FEFF';
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `<${hex}>`;
}

export function writePdf(pages: PdfPageSpec[], title = ''): Uint8Array {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const offsets: number[] = [];
  const push = (part: string | Uint8Array) => {
    const bytes = typeof part === 'string' ? encoder.encode(part) : part;
    chunks.push(bytes);
    length += bytes.length;
  };
  /** 写一个对象：记下它的起始偏移（xref 要用） */
  const object = (id: number, ...parts: (string | Uint8Array)[]) => {
    offsets[id] = length;
    push(`${id} 0 obj\n`);
    for (const p of parts) push(p);
    push('\nendobj\n');
  };

  // 对象编号：1 目录、2 页树、3 文档信息；之后每页依次是页面、内容流、各张图片
  let next = 4;
  const layout = pages.map((p) => {
    const page = next++;
    const content = next++;
    const images = p.images.map(() => next++);
    return { page, content, images };
  });

  push('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Kids [${layout.map((l) => `${l.page} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  object(3, `<< /Title ${pdfText(title)} /Producer ${pdfText('双语对照翻译')} >>`);
  pages.forEach((p, i) => {
    const l = layout[i]!;
    const xobjects = l.images.map((id, k) => `/Im${k} ${id} 0 R`).join(' ');
    object(
      l.page,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(p.width)} ${num(p.height)}] /Resources << /XObject << ${xobjects} >> >> /Contents ${l.content} 0 R >>`,
    );
    // PDF 坐标原点在左下：y 要翻过来
    const ops = p.images.map((im, k) => `q ${num(im.width)} 0 0 ${num(im.height)} ${num(im.x)} ${num(p.height - im.y - im.height)} cm /Im${k} Do Q`).join('\n');
    object(l.content, `<< /Length ${encoder.encode(ops).length} >>\nstream\n${ops}\nendstream`);
    p.images.forEach((im, k) => {
      object(
        l.images[k]!,
        `<< /Type /XObject /Subtype /Image /Width ${im.pixelWidth} /Height ${im.pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.jpeg.length} >>\nstream\n`,
        im.jpeg,
        '\nendstream',
      );
    });
  });

  const xref = length;
  const count = next;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < count; id++) table += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
