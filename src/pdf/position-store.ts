import { browser } from 'wxt/browser';
import { rememberPosition, type PositionMap, type ReadingPosition } from '@/lib/pdf/positions';

/** PDF 阅读位置存在本机（chrome.storage.local，不同步），所有文档共用一个键 */
const KEY = 'pdfPositions';

async function loadAll(): Promise<PositionMap> {
  const stored = (await browser.storage.local.get(KEY))[KEY] as PositionMap | undefined;
  return stored && typeof stored === 'object' ? stored : {};
}

export async function loadPosition(docId: string): Promise<ReadingPosition | undefined> {
  return (await loadAll())[docId];
}

export async function savePosition(docId: string, position: ReadingPosition): Promise<void> {
  await browser.storage.local.set({ [KEY]: rememberPosition(await loadAll(), docId, position) });
}
