import { describe, expect, it } from 'vitest';
import { isPdfUrl } from '@/lib/pdf/url';

describe('isPdfUrl', () => {
  it('路径以 .pdf 结尾（不区分大小写，可带查询参数）、arXiv 的 /pdf/ 链接、本地文件', () => {
    expect(isPdfUrl('https://example.com/papers/a.pdf')).toBe(true);
    expect(isPdfUrl('https://example.com/A.PDF?download=1')).toBe(true);
    expect(isPdfUrl('https://arxiv.org/pdf/1706.03762')).toBe(true);
    expect(isPdfUrl('file:///D:/papers/a.pdf')).toBe(true);
  });

  it('普通网页、扩展页面、arXiv 摘要页不算', () => {
    expect(isPdfUrl('https://example.com/pdf-guide.html')).toBe(false);
    expect(isPdfUrl('https://arxiv.org/abs/1706.03762')).toBe(false);
    expect(isPdfUrl('chrome-extension://abc/pdf.html?file=x.pdf')).toBe(false);
    expect(isPdfUrl('not a url')).toBe(false);
  });
});
