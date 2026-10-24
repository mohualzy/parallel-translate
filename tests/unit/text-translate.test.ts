import { describe, expect, it } from 'vitest';
import { buildTextMessages } from '@/lib/providers/prompt';
import { resolveTextTarget } from '@/lib/text-translate';

describe('resolveTextTarget', () => {
  it('自动：外文译成目标语言；已是目标语言时改译成写作语言', () => {
    expect(resolveTextTarget('Hello world, how are you?', 'auto', 'zh-CN', 'en')).toBe('zh-CN');
    expect(resolveTextTarget('你好，明天见。', 'auto', 'zh-CN', 'en')).toBe('en');
    expect(resolveTextTarget('', 'auto', 'zh-CN', 'en')).toBe('zh-CN');
  });

  it('手动指定时不做判断', () => {
    expect(resolveTextTarget('你好', 'ja', 'zh-CN', 'en')).toBe('ja');
  });
});

describe('buildTextMessages', () => {
  it('原文只放在 <text> 里；风格段来自档案；命中的术语注入 system', () => {
    const [system, user] = buildTextMessages('The agent is ready.\n\n- item', {
      targetLang: 'zh-CN',
      profile: 'tech',
      glossary: [{ source: 'agent', target: '智能体' }],
    });
    expect(system?.content).toContain('保留原文的段落、换行、列表');
    expect(system?.content).toContain('技术文档');
    expect(system?.content).toContain('agent → 智能体');
    expect(system?.content).not.toContain('The agent is ready');
    expect(user?.content).toBe('<text>The agent is ready.\n\n- item</text>');
  });

  it('其他目标语言用英文 prompt', () => {
    const [system] = buildTextMessages('你好', { targetLang: 'en' });
    expect(system?.content).toContain('native English translator');
  });
});
