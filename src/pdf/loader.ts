import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { browser } from 'wxt/browser';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type PdfDocument = pdfjs.PDFDocumentProxy;
export type PdfPage = pdfjs.PDFPageProxy;
export { pdfjs };

// 这些文件由 wxt.config 的 build:publicAssets 钩子复制，不在 WXT 自动生成的路径类型里
const getURL = browser.runtime.getURL as (path: string) => string;
const asset = (dir: string) => getURL(`/pdfjs/${dir}/`);

/**
 * 在本机打开 PDF（AGENTS.md 硬性规则 7：文件不上传）。
 * fontExtraProperties：保留原字体名（CMMI10 等），用来识别公式和代码字体。
 */
export function openPdf(data: ArrayBuffer): Promise<PdfDocument> {
  return pdfjs.getDocument({
    data,
    cMapUrl: asset('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: asset('standard_fonts'),
    wasmUrl: asset('wasm'),
    fontExtraProperties: true,
    enableXfa: false,
  }).promise;
}

/** 读取远程或本地（file://）PDF；扩展页面凭主机权限请求，不受网页的跨域限制 */
export async function fetchPdf(url: string): Promise<ArrayBuffer> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new Error(
      url.startsWith('file:')
        ? '读取本地文件失败：请在扩展详情页打开「允许访问文件网址」，或点「打开本地文件」选择这个 PDF'
        : `下载 PDF 失败：无法连接 ${new URL(url).host}`,
    );
  }
  if (!res.ok) throw new Error(`下载 PDF 失败（HTTP ${res.status}）`);
  return res.arrayBuffer();
}
