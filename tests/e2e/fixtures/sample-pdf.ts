/**
 * E2E 用的测试 PDF：运行时生成，不往仓库里放二进制文件。
 * sample.pdf —— 第 1 页：居中标题、两段跨行正文、一行等宽代码、竖排水印；第 2 页：一段正文。
 * two-column.pdf —— 通栏标题下左右两栏各两段，两栏的段落按纵坐标交错（测拖选不跨栏）。
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

export const TWO_COLUMN_TEXT = {
  title: 'Two Column Layout',
  left: [
    ['Alpha one starts the left column and', 'keeps going for a few more words so the', 'paragraph wraps.'],
    ['Alpha two is the second left paragraph', 'that follows after a visible gap in the', 'column.'],
  ],
  right: [
    ['Omega one starts the right column a', 'little lower than the left one so the', 'order interleaves.'],
    ['Omega two is the second right paragraph', 'that also follows after a visible gap', 'below.'],
  ],
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

/** 每页一段内容流，拼成 PDF（标准 14 字体，手算 xref 偏移） */
function buildPdf(pages: string[]): Buffer {
  const n = pages.length;
  // 对象：1 目录、2 页树、3..n+2 页、n+3 资源、n+4..2n+3 内容流、之后 3 个字体
  const font = (k: number) => 2 * n + 4 + k;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${i + 3} 0 R`).join(' ')}] /Count ${n} >>`,
    ...pages.map((_, i) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources ${n + 3} 0 R /Contents ${n + 4 + i} 0 R >>`),
    `<< /Font << /F1 ${font(0)} 0 R /F2 ${font(1)} 0 R /F3 ${font(2)} 0 R >> >>`,
    ...pages.map((p) => `<< /Length ${Buffer.byteLength(p)} >>\nstream\n${p}\nendstream`),
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

export function twoColumnPdf(): Buffer {
  const t = TWO_COLUMN_TEXT;
  const para = (lines: string[], x: number, y: number): TextRun[] => lines.map((text, i) => ({ font: 'F1', size: 10, x, y: y - i * 12, text }));
  return buildPdf([
    stream([
      { font: 'F2', size: 16, x: 230, y: 740, text: t.title },
      ...para(t.left[0]!, 72, 700),
      ...para(t.left[1]!, 72, 640),
      ...para(t.right[0]!, 320, 694),
      ...para(t.right[1]!, 320, 634),
    ]),
  ]);
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
  return buildPdf([page1, page2]);
}
