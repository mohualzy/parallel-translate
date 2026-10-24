import { describe, expect, it } from 'vitest';
import { rememberPosition, worthRemembering } from '@/lib/pdf/positions';

describe('rememberPosition', () => {
  it('新增或覆盖一篇文档的位置', () => {
    const a = rememberPosition({}, 'doc', { page: 3, offset: 0.5, at: 1 });
    expect(rememberPosition(a, 'doc', { page: 4, offset: 0, at: 2 })).toEqual({ doc: { page: 4, offset: 0, at: 2 } });
  });

  it('超过上限时淘汰最久没读的', () => {
    let map = {};
    for (let i = 0; i < 4; i++) map = rememberPosition(map, `d${i}`, { page: 2, offset: 0, at: 10 - i }, 3);
    // d3 最旧（at = 7）被淘汰
    expect(Object.keys(map).sort()).toEqual(['d0', 'd1', 'd2']);
  });
});

describe('worthRemembering', () => {
  it('第 1 页顶部不记', () => {
    expect(worthRemembering({ page: 1, offset: 0.01 })).toBe(false);
    expect(worthRemembering({ page: 1, offset: 0.3 })).toBe(true);
    expect(worthRemembering({ page: 2, offset: 0 })).toBe(true);
  });
});
