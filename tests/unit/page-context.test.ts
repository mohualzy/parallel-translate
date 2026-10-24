import { afterEach, describe, expect, it } from 'vitest';
import { pageContext, pageSummary } from '@/content/page-context';

afterEach(() => {
  document.head.innerHTML = '';
});

describe('pageSummary', () => {
  it('优先 meta description，其次 og:description，压缩空白并截到 300 字', () => {
    document.head.innerHTML = '<meta property="og:description" content="OG text">';
    expect(pageSummary()).toBe('OG text');
    document.head.innerHTML += `<meta name="Description" content="  Main   text ${'x'.repeat(400)}">`;
    const summary = pageSummary();
    expect(summary.startsWith('Main text ')).toBe(true);
    expect(summary.length).toBe(300);
  });

  it('没有摘要时为空', () => {
    expect(pageSummary()).toBe('');
  });
});

describe('pageContext', () => {
  it('使用传入的原始标题', () => {
    document.title = '已翻译的标题';
    expect(pageContext('Original title ')).toEqual({ title: 'Original title', summary: '', profile: 'general' });
  });

  it('有 citation_* meta 的页面按论文风格；用户为网站指定的风格优先', () => {
    document.head.innerHTML = '<meta name="citation_title" content="Attention Is All You Need">';
    expect(pageContext('T').profile).toBe('paper');
    expect(pageContext('T', { [location.hostname]: 'news' }).profile).toBe('news');
  });
});
