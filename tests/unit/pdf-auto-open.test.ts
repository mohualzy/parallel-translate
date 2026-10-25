import { describe, expect, it } from 'vitest';
import {
  autoOpenRule,
  bypassLocalPdf,
  bypassRule,
  EMPTY_LOCAL_PDF_STATE,
  escapeRegExp,
  fileFromReaderUrl,
  localPdfAction,
  showingLocalPdf,
} from '@/lib/pdf/auto-open';

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

describe('localPdfAction', () => {
  const file = 'file:///D:/papers/a.pdf';

  it('新打开转进阅读器；从阅读器后退回来继续后退，从前一页前进过来继续前进', () => {
    const opened = localPdfAction(EMPTY_LOCAL_PDF_STATE, 7, file, false);
    expect(opened.action).toBe('open');
    // 阅读器显示后登记；从阅读器后退到这个文件：继续后退，登记随之清掉
    const back = localPdfAction(showingLocalPdf(opened.state, 7, file), 7, file, true);
    expect(back.action).toBe('back');
    // 之后从前一页前进到这个文件：继续前进到阅读器
    expect(localPdfAction(back.state, 7, file, true).action).toBe('forward');
  });

  it('这个标签页没自动转过这个文件时，前进后退到它就显示原文件', () => {
    const opened = localPdfAction(EMPTY_LOCAL_PDF_STATE, 7, file, false).state;
    expect(localPdfAction(EMPTY_LOCAL_PDF_STATE, 7, file, true).action).toBeNull();
    expect(localPdfAction(opened, 8, file, true).action).toBeNull();
    expect(localPdfAction(opened, 7, 'file:///D:/papers/b.pdf', true).action).toBeNull();
  });

  it('「原文件」放行后，这个标签页看这个文件不再转进阅读器，别的标签页不受影响', () => {
    const state = bypassLocalPdf(EMPTY_LOCAL_PDF_STATE, 7, file);
    expect(localPdfAction(state, 7, file, false).action).toBeNull();
    expect(localPdfAction(state, 7, file, true).action).toBeNull();
    expect(localPdfAction(state, 8, file, false).action).toBe('open');
  });
});
