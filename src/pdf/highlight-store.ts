import { browser } from 'wxt/browser';
import type { PdfHighlight } from '@/lib/pdf/highlights';

/**
 * 划词强调按文档存在本机（chrome.storage.local，不同步、不上传）。
 * 键用 pdf.js 的文档指纹：同一个文件不管从哪个地址打开都一样。
 */
const keyOf = (docId: string) => `pdfHighlights:${docId}`;

export async function loadHighlights(docId: string): Promise<PdfHighlight[]> {
  const stored = (await browser.storage.local.get(keyOf(docId)))[keyOf(docId)] as PdfHighlight[] | undefined;
  return Array.isArray(stored) ? stored : [];
}

export async function saveHighlights(docId: string, list: PdfHighlight[]): Promise<void> {
  if (list.length === 0) await browser.storage.local.remove(keyOf(docId));
  else await browser.storage.local.set({ [keyOf(docId)]: list });
}
