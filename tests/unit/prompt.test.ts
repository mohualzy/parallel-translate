import { describe, expect, it } from 'vitest';
import { buildMessages, DEFAULT_STYLE_PROMPT, DEFAULT_STYLE_PROMPT_ZH, parseSegments } from '@/lib/providers/prompt';

describe('buildMessages', () => {
  it('目标为中文时用中文 prompt，多段编号拼进 user 消息', () => {
    const [system, user] = buildMessages(['Hello', 'World'], { targetLang: 'zh-CN', title: 'My Page' });
    expect(system?.role).toBe('system');
    expect(system?.content).toContain('简体中文母语译者');
    expect(system?.content).toContain('不要索要更多上下文');
    expect(system?.content).toContain(DEFAULT_STYLE_PROMPT_ZH);
    expect(user?.content).toContain('网页标题（仅供参考，不要翻译）：My Page');
    expect(user?.content).toContain('<s id="0">Hello</s>\n<s id="1">World</s>');
  });

  it('其他目标语言用英文 prompt', () => {
    const [system, user] = buildMessages(['Hallo'], { targetLang: 'en', title: 'Seite' });
    expect(system?.content).toContain('native English translator');
    expect(system?.content).toContain('never ask for more context');
    expect(system?.content).toContain(DEFAULT_STYLE_PROMPT);
    expect(user?.content).toContain('Page title (context only, do not translate): Seite');
  });

  it('自定义风格要求替换默认值，格式约束仍然保留', () => {
    const [system] = buildMessages(['x'], { targetLang: 'ja', stylePrompt: 'Use polite form.' });
    expect(system?.content).toContain('Use polite form.');
    expect(system?.content).not.toContain(DEFAULT_STYLE_PROMPT);
    expect(system?.content).toContain('<s id="0">');
  });
});

describe('parseSegments', () => {
  it('解析标准输出', () => {
    expect(parseSegments('<s id="0">你好</s>\n<s id="1">世界</s>', 2)).toEqual(['你好', '世界']);
  });

  it('容忍乱序、缺少闭合标签、单引号', () => {
    expect(parseSegments("<s id='1'>世界\n<s id=\"0\">你好", 2)).toEqual(['你好', '世界']);
  });

  it('缺失的段返回 null', () => {
    expect(parseSegments('<s id="0">你好</s>', 3)).toEqual(['你好', null, null]);
  });

  it('剥离推理模型的 <think> 内容', () => {
    expect(parseSegments('<think>let me think <s id="0">wrong</s></think><s id="0">对</s>', 1)).toEqual(['对']);
  });

  it('单段且没有标签时整体作为译文，并去掉代码围栏', () => {
    expect(parseSegments('```\n你好\n```', 1)).toEqual(['你好']);
    expect(parseSegments('  你好  ', 1)).toEqual(['你好']);
  });

  it('多段但没有任何标签时全部视为失败', () => {
    expect(parseSegments('你好 世界', 2)).toEqual([null, null]);
  });

  it('忽略越界编号与重复编号', () => {
    expect(parseSegments('<s id="0">一</s><s id="0">二</s><s id="5">三</s>', 1)).toEqual(['一']);
  });

  it('保留段内的占位标签', () => {
    expect(parseSegments('<s id="0">点击<g0>这里</g0>运行 <x1/></s>', 1)).toEqual(['点击<g0>这里</g0>运行 <x1/>']);
  });
});
