import { browser } from 'wxt/browser';

/** 地址像不像 PDF：路径以 .pdf 结尾，或 arXiv 的 /pdf/ 链接（没有扩展名） */
export function isPdfUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!/^(https?|file):$/.test(u.protocol)) return false;
    return /\.pdf$/i.test(u.pathname) || (/(^|\.)arxiv\.org$/i.test(u.hostname) && u.pathname.startsWith('/pdf/'));
  } catch {
    return false;
  }
}

/** 右键菜单「用双语阅读器打开 PDF」匹配的链接 */
export const PDF_LINK_PATTERNS = ['*://*/*.pdf', '*://*/*.pdf?*', '*://*/*.PDF', '*://arxiv.org/pdf/*'];

/** 阅读器页面地址，PDF 地址作为 file 参数 */
export function viewerUrl(file?: string): string {
  const page = browser.runtime.getURL('/pdf.html');
  return file ? `${page}?file=${encodeURIComponent(file)}` : page;
}
