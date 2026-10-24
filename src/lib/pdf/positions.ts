/**
 * PDF 阅读位置（决策见 docs/DECISIONS.md D62）：文档指纹 → 读到第几页、页内比例。
 * 所有文档共用一个存储键，只留最近的若干篇。纯逻辑。
 */

export interface ReadingPosition {
  page: number;
  /** 视口顶部落在这一页的比例（0 = 页首，1 = 页尾），和缩放无关 */
  offset: number;
  /** 保存时间（毫秒） */
  at: number;
}

export type PositionMap = Record<string, ReadingPosition>;

export const MAX_POSITIONS = 200;

/** 记下一篇文档的位置；超过上限时淘汰最久没读的 */
export function rememberPosition(map: PositionMap, docId: string, position: ReadingPosition, max = MAX_POSITIONS): PositionMap {
  const next: PositionMap = { ...map, [docId]: position };
  const ids = Object.keys(next);
  if (ids.length <= max) return next;
  for (const id of ids.sort((a, b) => next[a]!.at - next[b]!.at).slice(0, ids.length - max)) delete next[id];
  return next;
}

/** 第 1 页顶部附近等于没读，不值得记 */
export const worthRemembering = (p: Pick<ReadingPosition, 'page' | 'offset'>) => p.page > 1 || p.offset > 0.05;
