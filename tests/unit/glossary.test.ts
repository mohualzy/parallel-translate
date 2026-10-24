import { describe, expect, it } from 'vitest';
import { matchGlossary, parseGlossary } from '@/lib/glossary';
import { buildMessages, buildSelectionMessages } from '@/lib/providers/prompt';

describe('parseGlossary', () => {
  it('解析 原文 = 译法；只写原文表示保持不译；跳过注释、空行和重复', () => {
    expect(parseGlossary('# 注释\nLLM = 大语言模型\n\nKubernetes\nllm = 重复\nagent=智能体')).toEqual([
      { source: 'LLM', target: '大语言模型' },
      { source: 'Kubernetes', target: 'Kubernetes' },
      { source: 'agent', target: '智能体' },
    ]);
  });
});

describe('带条件的条目', () => {
  it('译法末尾的括号说明解析为适用条件（全角、半角都可）；只写原文加条件时译法为原文', () => {
    expect(parseGlossary('Apple = Apple（指公司时）\nMeta = Meta (when it means the company)\nAmazon（指公司时）')).toEqual([
      { source: 'Apple', target: 'Apple', condition: '指公司时' },
      { source: 'Meta', target: 'Meta', condition: 'when it means the company' },
      { source: 'Amazon', target: 'Amazon', condition: '指公司时' },
    ]);
  });

  it('注入 prompt 时附带条件，并说明不满足时正常翻译', () => {
    const [system] = buildMessages(['I ate an apple.'], {
      targetLang: 'zh-CN',
      glossary: [{ source: 'Apple', target: 'Apple', condition: '指公司时' }],
    });
    expect(system?.content).toContain('- Apple → Apple（仅当指公司时；否则按语境正常翻译）');
  });
});

describe('matchGlossary', () => {
  const entries = parseGlossary('cat = 猫\nC++ = C++\n机器学习 = ML\nopen source = 开源');

  it('英文按整词、不区分大小写匹配', () => {
    expect(matchGlossary(entries, ['The Cat sat.']).map((e) => e.source)).toEqual(['cat']);
    expect(matchGlossary(entries, ['A category of things.'])).toEqual([]);
    expect(matchGlossary(entries, ['We love Open Source.']).map((e) => e.source)).toEqual(['open source']);
  });

  it('含符号或 CJK 的术语按子串匹配', () => {
    expect(matchGlossary(entries, ['Written in C++.', '关于机器学习']).map((e) => e.source)).toEqual(['C++', '机器学习']);
  });
});

describe('术语注入 prompt', () => {
  it('命中的术语追加到 system prompt；没有命中时不出现术语表段落', () => {
    const glossary = parseGlossary('fox = 狐狸君');
    const [system] = buildMessages(['The fox.'], { targetLang: 'zh-CN', glossary });
    expect(system?.content).toContain('术语表');
    expect(system?.content).toContain('- fox → 狐狸君');
    const [plain] = buildMessages(['The fox.'], { targetLang: 'zh-CN' });
    expect(plain?.content).not.toContain('术语表');
    const [selection] = buildSelectionMessages('fox', { targetLang: 'en', word: true, glossary });
    expect(selection?.content).toContain('Glossary');
  });
});
