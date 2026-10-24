import { describe, expect, it } from 'vitest';
import { autoProfile, getProfile, PROFILES, resolveProfile } from '@/lib/profiles';

describe('resolveProfile', () => {
  it('内置主机名映射（含子域名），文档子域名归技术，其他为通用', () => {
    expect(autoProfile('github.com', false)).toBe('tech');
    expect(autoProfile('www.reddit.com', false)).toBe('social');
    expect(autoProfile('arxiv.org', false)).toBe('paper');
    expect(autoProfile('www.reuters.com', false)).toBe('news');
    expect(autoProfile('docs.python.org', false)).toBe('tech');
    expect(autoProfile('example.com', false)).toBe('general');
  });

  it('页面有 citation_* meta 时按论文处理，优先于主机名', () => {
    expect(autoProfile('example.com', true)).toBe('paper');
    expect(autoProfile('github.com', true)).toBe('paper');
  });

  it('用户为网站指定的档案最优先；无效的指定被忽略', () => {
    expect(resolveProfile('github.com', { 'github.com': 'fiction' }, false)).toBe('fiction');
    expect(resolveProfile('gist.github.com', { 'github.com': 'news' }, false)).toBe('news');
    expect(resolveProfile('github.com', { 'github.com': 'nope' }, false)).toBe('tech');
    expect(resolveProfile('example.com', { 'github.com': 'fiction' }, true)).toBe('paper');
  });

  it('每个档案都有中英两版风格文本；未知 id 回退到通用', () => {
    for (const p of PROFILES) {
      expect(p.zh.length, p.id).toBeGreaterThan(20);
      expect(p.en.length, p.id).toBeGreaterThan(20);
    }
    expect(getProfile('missing').id).toBe('general');
  });
});
