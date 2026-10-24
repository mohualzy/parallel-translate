/**
 * E2E 用的测试 PDF：运行时生成，不往仓库里放二进制文件。
 * 第 1 页：居中标题、两段跨行正文、一行等宽代码、竖排水印；第 2 页：一段正文。
 * 只用 PDF 标准 14 字体（pdf.js 从扩展自带的 standard_fonts 加载）。
 */

interface TextRun {
  font: 'F1' | 'F2' | 'F3';
  size: number;
  x: number;
  y: number;
  text: string;
  rotate?: boolean;
}

export const SAMPLE_PDF_TEXT = {
  title: 'A Study of Bilingual Reading',
  paragraph1: [
    'Reading papers in a foreign language is slow, so we render each page',
    'next to a translated copy that keeps the original layout and fonts.',
  ],
  paragraph2: [
    'The translated page removes the original glyphs, keeps figures and rules,',
    'and writes the translation back into the same position on the page.',
  ],
  code: 'npm install --save pdfjs-dist',
  watermark: 'arXiv:0000.00000v1 [cs.CL]',
  page2: ['The second page has a single paragraph that is also translated', 'when the reader scrolls down to it.'],
};

const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

function stream(runs: TextRun[]): string {
  return runs
    .map((r) => {
      const m = r.rotate ? `0 1 -1 0 ${r.x} ${r.y}` : `1 0 0 1 ${r.x} ${r.y}`;
      return `BT /${r.font} ${r.size} Tf ${m} Tm (${escape(r.text)}) Tj ET`;
    })
    .join('\n');
}

export function samplePdf(): Buffer {
  const t = SAMPLE_PDF_TEXT;
  const body = (lines: string[], y: number): TextRun[] => lines.map((text, i) => ({ font: 'F1', size: 11, x: 72, y: y - i * 14, text }));
  const page1 = stream([
    { font: 'F2', size: 18, x: 170, y: 700, text: t.title },
    ...body(t.paragraph1, 640),
    // 第二段首行缩进，另起一段
    ...body(t.paragraph2, 600).map((r, i) => (i === 0 ? { ...r, x: 90 } : r)),
    { font: 'F3', size: 10, x: 72, y: 540, text: t.code },
    { font: 'F1', size: 14, x: 30, y: 300, text: t.watermark, rotate: true },
  ]);
  const page2 = stream(body(t.page2, 700));

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources 5 0 R /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources 5 0 R /Contents 7 0 R >>',
    '<< /Font << /F1 8 0 R /F2 9 0 R /F3 10 0 R >> >>',
    `<< /Length ${Buffer.byteLength(page1)} >>\nstream\n${page1}\nendstream`,
    `<< /Length ${Buffer.byteLength(page2)} >>\nstream\n${page2}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
