import { describe, expect, it } from 'vitest';
import { mergeGlossary } from '@/lib/glossary';
import { buildTermsMessages, MAX_ARTICLE_TERMS, parseTerms } from '@/lib/providers/prompt';

const article = 'The agent calls a tool. Each agent keeps a scratchpad. Sam Altman said the agent loop matters.';

describe('buildTermsMessages', () => {
  it('正文只放在 <article> 里；列出已有术语；按目标语言选 prompt 语言', () => {
    const [system, user] = buildTermsMessages(article, 'zh-CN', [{ source: 'tool', target: '工具' }]);
    expect(system?.content).toContain('术语编辑');
    expect(system?.content).toContain('已有术语，不要重复：tool');
    expect(system?.content).not.toContain('scratchpad');
    expect(user?.content).toBe(`<article>${article}</article>`);
    const [en] = buildTermsMessages(article, 'ja', []);
    expect(en?.content).toContain('terminology editor');
    expect(en?.content).not.toContain('Already defined');
  });
});

describe('parseTerms', () => {
  it('解析「原文 = 译法」行，容忍编号、列表符号、代码块和思考过程', () => {
    const output = '<think>hmm</think>\n```\n1. agent = 智能体\n- scratchpad = 草稿区\nSam Altman = 萨姆·奥尔特曼\n```';
    expect(parseTerms(output, article)).toEqual([
      { source: 'agent', target: '智能体' },
      { source: 'scratchpad', target: '草稿区' },
      { source: 'Sam Altman', target: '萨姆·奥尔特曼' },
    ]);
  });

  it('丢弃文章里没有出现的条目（模型编造）和没有等号的行；最多保留 12 条', () => {
    expect(parseTerms('transformer = 变换器\nagent = 智能体\n这里没有术语', article)).toEqual([
      { source: 'agent', target: '智能体' },
    ]);
    const many = Array.from({ length: 20 }, (_, i) => `term${i}`);
    const text = many.join(' ');
    expect(parseTerms(many.map((t) => `${t} = 术语`).join('\n'), text)).toHaveLength(MAX_ARTICLE_TERMS);
  });
});

describe('mergeGlossary', () => {
  it('同一原文以用户术语表为准（不区分大小写），其余文章术语追加在后', () => {
    const merged = mergeGlossary(
      [{ source: 'Agent', target: '代理' }],
      [
        { source: 'agent', target: '智能体' },
        { source: 'scratchpad', target: '草稿区' },
      ],
    );
    expect(merged).toEqual([
      { source: 'Agent', target: '代理' },
      { source: 'scratchpad', target: '草稿区' },
    ]);
  });
});
