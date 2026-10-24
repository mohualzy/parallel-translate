import { describe, expect, it } from 'vitest';
import { findSiteRule, SITE_RULES } from '@/lib/site-rules';

describe('findSiteRule', () => {
  it('按主机名匹配，含子域名；没有规则的网站返回 undefined', () => {
    expect(findSiteRule('news.ycombinator.com')?.id).toBe('hacker-news');
    expect(findSiteRule('github.com')?.id).toBe('github');
    expect(findSiteRule('x.com')?.id).toBe('x');
    expect(findSiteRule('mobile.twitter.com')?.id).toBe('x');
    expect(findSiteRule('example.com')).toBeUndefined();
  });

  it('所有选择器都是合法的 CSS，且不用带哈希的 CSS Modules 类名', () => {
    for (const rule of SITE_RULES) {
      for (const sel of [...(rule.include ?? []), ...(rule.exclude ?? [])]) {
        expect(() => document.querySelector(sel), `${rule.id}: ${sel}`).not.toThrow();
        expect(sel, `${rule.id}: ${sel}`).not.toMatch(/__[\w-]{5,}/);
      }
    }
  });
});
