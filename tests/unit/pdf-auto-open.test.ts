import { describe, expect, it } from 'vitest';
import { autoOpenRule, bypassRule, escapeRegExp, fileFromReaderUrl } from '@/lib/pdf/auto-open';

describe('autoOpenRule', () => {
  it('按响应头判断 PDF，排除附件下载；原地址整段放进 hash', () => {
    const rule = autoOpenRule('chrome-extension://abc/pdf.html');
    expect(rule.action).toEqual({ type: 'redirect', redirect: { regexSubstitution: 'chrome-extension://abc/pdf.html#\\0' } });
    expect(rule.condition.resourceTypes).toEqual(['main_frame']);
    expect(rule.condition.responseHeaders).toEqual([{ header: 'content-type', values: ['application/pdf*'] }]);
    expect(rule.condition.excludedResponseHeaders).toEqual([{ header: 'content-disposition', values: ['attachment*'] }]);
    expect(new RegExp(rule.condition.regexFilter).test('https://arxiv.org/pdf/1706.03762')).toBe(true);
    expect(new RegExp(rule.condition.regexFilter).test('file:///C:/a.pdf')).toBe(false);
  });
});

describe('bypassRule', () => {
  it('只放行这个标签页的这个地址，优先级高于自动打开；地址里的特殊字符转义', () => {
    const url = 'https://example.com/a.pdf?x=1&y=(2)';
    const rule = bypassRule(1001, url, 7);
    expect(rule.priority).toBeGreaterThan(autoOpenRule('x').priority);
    expect(rule.condition.tabIds).toEqual([7]);
    const re = new RegExp(rule.condition.regexFilter);
    expect(re.test(url)).toBe(true);
    expect(re.test(`${url}&z=3`)).toBe(false);
    expect(re.test('https://example.com/aXpdf?x=1&y=(2)')).toBe(false);
  });

  it('escapeRegExp', () => {
    expect(new RegExp(escapeRegExp('a.b*c?')).test('a.b*c?')).toBe(true);
  });
});

describe('fileFromReaderUrl', () => {
  it('?file= 参数（编码）或 # 后的原地址（含查询串）', () => {
    expect(fileFromReaderUrl('chrome-extension://abc/pdf.html?file=https%3A%2F%2Fa.com%2Fx.pdf%3Fq%3D1')).toBe('https://a.com/x.pdf?q=1');
    expect(fileFromReaderUrl('chrome-extension://abc/pdf.html#https://arxiv.org/pdf/1706.03762?x=1&y=2')).toBe('https://arxiv.org/pdf/1706.03762?x=1&y=2');
    expect(fileFromReaderUrl('chrome-extension://abc/pdf.html')).toBeUndefined();
    expect(fileFromReaderUrl('chrome-extension://abc/pdf.html#')).toBeUndefined();
  });
});
