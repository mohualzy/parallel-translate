import { describe, expect, it } from 'vitest';
import {
  buildMessages,
  buildInputMessages,
  buildSelectionMessages,
  buildVideoBriefMessages,
  cleanInputOutput,
  DEFAULT_STYLE_PROMPT,
  DEFAULT_STYLE_PROMPT_ZH,
  isSingleWord,
  parseSegments,
  parseVideoBrief,
} from '@/lib/providers/prompt';

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

  it('页面摘要与标题一起作为上下文放在分段前面', () => {
    const [, user] = buildMessages(['Hi'], { targetLang: 'zh-CN', title: 'T', summary: 'About cats.' });
    expect(user?.content).toBe('网页标题（仅供参考，不要翻译）：T\n网页摘要（仅供参考，不要翻译）：About cats.\n\n<s id="0">Hi</s>');
    const [, onlyBody] = buildMessages(['Hi'], { targetLang: 'en' });
    expect(onlyBody?.content).toBe('<s id="0">Hi</s>');
  });

  it('其他目标语言用英文 prompt', () => {
    const [system, user] = buildMessages(['Hallo'], { targetLang: 'en', title: 'Seite' });
    expect(system?.content).toContain('native English translator');
    expect(system?.content).toContain('never ask for more context');
    expect(system?.content).toContain(DEFAULT_STYLE_PROMPT);
    expect(user?.content).toContain('Page title (context only, do not translate): Seite');
  });

  it('自定义风格要求叠加在默认风格之后，格式约束仍然保留', () => {
    const [system] = buildMessages(['x'], { targetLang: 'ja', stylePrompt: 'Use polite form.' });
    expect(system?.content).toContain(`${DEFAULT_STYLE_PROMPT}\nAdditional requirements: Use polite form.`);
    expect(system?.content).toContain('<s id="0">');
  });
});

describe('视频字幕上下文', () => {
  it('字幕用「视频」的说法；前后台词放在片段前后，不是 <s> 片段', () => {
    const [, user] = buildMessages(['Next line'], {
      targetLang: 'zh-CN',
      title: 'T',
      summary: 'S',
      subtitles: true,
      around: { before: [{ text: 'Old', translation: '旧' }, { text: 'Pending' }], after: ['Later'] },
    });
    expect(user?.content).toContain('视频标题（仅供参考，不要翻译）：T\n视频内容摘要（仅供参考，不要翻译）：S');
    expect(user?.content).toContain(
      '<before>\nOld → 旧\nPending\n</before>\n\n<s id="0">Next line</s>\n\n后文（只用于理解，不要翻译、不要输出）：\n<after>\nLater\n</after>',
    );
    expect(parseSegments('<s id="0">下一句</s>', 1)).toEqual(['下一句']);
  });

  it('没有前后台词时不输出空块', () => {
    const [, user] = buildMessages(['Only'], { targetLang: 'en', around: { before: [], after: [] } });
    expect(user?.content).toBe('<s id="0">Only</s>');
  });

  it('预读把标题和字幕放进 user 消息，指令留在 system', () => {
    const [system, user] = buildVideoBriefMessages('Hello', 'My video', 'zh-CN', [{ source: 'agent', target: '智能体' }]);
    expect(system?.content).toContain('已有术语，不要重复：agent');
    expect(system?.content).not.toContain('Hello');
    expect(user?.content).toBe('视频标题：My video\n<transcript>Hello</transcript>');
  });

  it('解析预读结果：摘要 + 字幕里确实出现的术语', () => {
    const output = '<think>想一想</think>\n摘要：两位工程师聊智能体。语气轻松。\nagent = 智能体\n1. Sarah = 莎拉\nmade up = 不存在';
    expect(parseVideoBrief(output, 'The agent works. Sarah agrees.')).toEqual({
      summary: '两位工程师聊智能体。语气轻松。',
      terms: [
        { source: 'agent', target: '智能体' },
        { source: 'Sarah', target: '莎拉' },
      ],
    });
    expect(parseVideoBrief('Summary: A song about doubt.', 'x')).toEqual({ summary: 'A song about doubt.', terms: [] });
    expect(parseVideoBrief('nonsense', 'x')).toEqual({ summary: '', terms: [] });
  });
});

describe('划词 prompt', () => {
  it('isSingleWord：单个英文词（含连字符、撇号）为真，词组、中文为假', () => {
    expect(isSingleWord('brown')).toBe(true);
    expect(isSingleWord("state-of-the-art")).toBe(true);
    expect(isSingleWord("don't")).toBe(true);
    expect(isSingleWord('brown fox')).toBe(false);
    expect(isSingleWord('中文')).toBe(false);
    expect(isSingleWord('a'.repeat(40))).toBe(false);
  });

  it('单词走词典模式，句子只要译文；语境放进 <context>', () => {
    const [wordSys, wordUser] = buildSelectionMessages('brown', { targetLang: 'zh-CN', word: true, context: 'The quick brown fox.' });
    expect(wordSys?.content).toContain('词典');
    expect(wordUser?.content).toBe('<context>The quick brown fox.</context>\n<text>brown</text>');

    const [sentSys, sentUser] = buildSelectionMessages('Hello world.', { targetLang: 'en', word: false });
    expect(sentSys?.content).toContain('Output only the translation');
    expect(sentUser?.content).toBe('<text>Hello world.</text>');
  });
});

describe('PDF 版面提示', () => {
  it('fixedLayout 时在上下文里要求简洁、不加括注', () => {
    const [, zh] = buildMessages(['Hi'], { targetLang: 'zh-CN', fixedLayout: true });
    expect(zh?.content).toContain('内容类型：PDF 文档');
    const [, en] = buildMessages(['Hallo'], { targetLang: 'en', fixedLayout: true });
    expect(en?.content).toContain('do not add parenthesized originals');
    const [, none] = buildMessages(['Hi'], { targetLang: 'zh-CN' });
    expect(none?.content).not.toContain('PDF');
  });
});

describe('风格档案', () => {
  it('档案替换风格段，格式协议不变；自定义要求叠加在后', () => {
    const [tech] = buildMessages(['Hi'], { targetLang: 'zh-CN', profile: 'tech' });
    expect(tech?.content).toContain('技术文档');
    expect(tech?.content).toContain('<s id="0">');
    expect(tech?.content).not.toContain(DEFAULT_STYLE_PROMPT_ZH);

    const [custom] = buildMessages(['Hi'], { targetLang: 'zh-CN', profile: 'social', stylePrompt: 'API 名称保留英文' });
    expect(custom?.content).toContain('社交媒体');
    expect(custom?.content).toContain('额外要求：API 名称保留英文');

    const [en] = buildMessages(['Hallo'], { targetLang: 'en', profile: 'paper' });
    expect(en?.content).toContain('academic paper');
  });

  it('未指定档案时用通用风格', () => {
    const [system] = buildMessages(['Hi'], { targetLang: 'zh-CN' });
    expect(system?.content).toContain(DEFAULT_STYLE_PROMPT_ZH);
  });
});

describe('输入框 prompt', () => {
  it('按输入框目标语言选 prompt 语言，原文只放在 <text> 里', () => {
    const [enSys, enUser] = buildInputMessages('你好，明天见', 'en');
    expect(enSys?.content).toContain('native English translator');
    expect(enSys?.content).toContain('@mentions');
    expect(enSys?.content).not.toContain('你好');
    expect(enUser?.content).toBe('<text>你好，明天见</text>');
    const [zhSys] = buildInputMessages('See you', 'zh-CN');
    expect(zhSys?.content).toContain('简体中文母语译者');
  });

  it('cleanInputOutput：去掉思考过程与照抄的 <text> 标签，保留内部换行', () => {
    expect(cleanInputOutput('<think>hmm</think>\n<text>Hi\nthere</text>\n')).toBe('Hi\nthere');
    expect(cleanInputOutput('  See you tomorrow  ')).toBe('See you tomorrow');
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
