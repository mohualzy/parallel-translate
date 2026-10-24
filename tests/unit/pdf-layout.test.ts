import { describe, expect, it } from 'vitest';
import { analyzePage, buildLines, fontFamily, type PdfTextItem } from '@/lib/pdf/layout';

/** 造一个文本项：宽度按每字 0.5 个字号估算 */
function item(str: string, x: number, y: number, opts: Partial<PdfTextItem> = {}): PdfTextItem {
  const size = opts.size ?? 10;
  return { str, x, y, w: str.length * size * 0.5, size, font: 'ABCDEF+Times-Roman', rotated: false, mono: false, ...opts };
}
const MATH = 'ABCDEF+CMMI10';
const MATH_SMALL = 'ABCDEF+CMMI7';

/** 一行正文：从 x 开始，按词切成几个文本项 */
function textLine(text: string, x: number, y: number, opts: Partial<PdfTextItem> = {}): PdfTextItem[] {
  return [item(text, x, y, opts)];
}

describe('fontFamily', () => {
  it('去掉子集前缀、样式后缀与字号', () => {
    expect(fontFamily('ABCDEF+CMMI10')).toBe('CMMI');
    expect(fontFamily('AECCXO+NimbusRomNo9L-Regu')).toBe('NimbusRomNo9L');
  });
});

describe('buildLines', () => {
  it('上下标挂靠到主行，宽下标断开的同基线片段合并成一行', () => {
    const items = [
      item('with ', 0, 100),
      item('d', 25, 100, { font: MATH }),
      item('model', 30, 102, { font: 'ABCDEF+CMR7', size: 7 }),
      item('-dimensional keys', 52, 100),
    ];
    const lines = buildLines(items);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.items.map((i) => i.str)).toEqual(['with ', 'd', 'model', '-dimensional keys']);
    expect(lines[0]!.items.find((i) => i.str === 'model')!.attached).toBe(true);
  });

  it('基线不同的公式符号（根号）挂靠到主行；旋转文字（竖排水印）不进入任何行', () => {
    const items = [item('divide each by ', 0, 100), item('√', 75, 101.5, { font: 'ABCDEF+CMSY10' }), item('arXiv:2401.00001', 5, 300, { rotated: true })];
    const lines = buildLines(items);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.items.map((i) => i.str)).toEqual(['divide each by ', '√']);
  });

  it('公式碎片不会挂靠到与它水平重叠的正文行（根号、分子挂靠到所在行，而不是上一行）', () => {
    const items = [
      // 第一行正文铺满整行
      item('queries and keys of dimension values of the products of the', 0, 100),
      // 第二行：正文到 x=70 结束，紧接着根号（基线略高，离第一行也在挂靠距离内）
      item('divide each by', 0, 112),
      item('√', 72, 105, { font: 'ABCDEF+CMSY10' }),
      item('d', 78, 112, { font: MATH }),
    ];
    const lines = buildLines(items);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.items.map((i) => i.str)).toEqual(['queries and keys of dimension values of the products of the']);
    expect(lines[1]!.items.map((i) => i.str)).toEqual(['divide each by', '√', 'd']);
  });

  it('行末分式后的句号即使基线略高（排序在前）也并回本行', () => {
    const items = [item('we scale the products by', 0, 100), item('√', 122, 100, { font: 'ABCDEF+CMSY10' }), item('.', 130, 99.95)];
    const lines = buildLines(items);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.items.map((i) => i.str)).toEqual(['we scale the products by', '√', '.']);
  });

  it('cases 的大括号（CMEX，往下挂）不挂到上一段正文的末行；求和号的上下限挂到所在行', () => {
    const items = [
      item('the modified set follows the equation below.', 0, 92),
      item('For each state record j,', 0, 106),
      // 大括号的基线在正文末行下方 1.4 个字号（离公式更远），字形往下挂到公式里
      item('(', 126, 120, { font: 'ABCDEF+CMEX10' }),
      item('Rewrite', 134, 130),
      item('[S] =', 97, 137, { font: 'ABCDEF+CMR10' }),
    ];
    const paragraph = analyzePage(items, 600).find((b) => b.text.startsWith('the modified'))!;
    expect(paragraph.text).toBe('the modified set follows the equation below. For each state record j,');
    expect(paragraph.atoms).toHaveLength(0);

    const footnote = buildLines([
      item('their dot product, q · k = ', 0, 100, { size: 8 }),
      // 正文宽 108，求和号紧跟其后；下限在求和号正下方，离正文基线 7.5（接近一个字号）
      item('P', 110, 97, { size: 8, font: 'ABCDEF+CMEX10' }),
      item('i=1', 110, 107.5, { size: 6, font: 'ABCDEF+CMMI6' }),
    ]);
    expect(footnote).toHaveLength(1);
  });

  it('正常的小字行（脚注）不会被挂靠到正文', () => {
    const lines = buildLines([item('Main body line of text', 0, 100), item('a footnote about something', 0, 140, { size: 8 })]);
    expect(lines).toHaveLength(2);
  });
});

describe('analyzePage', () => {
  it('两栏的行不串栏，各成段落', () => {
    const items = [
      ...textLine('Left column first line of text here', 0, 100),
      ...textLine('Right column first line of text here', 200, 100),
      ...textLine('Left column second line of text here', 0, 112),
      ...textLine('Right column second line of text here', 200, 112),
    ];
    const blocks = analyzePage(items, 400);
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => b.text)).toEqual([
      'Left column first line of text here Left column second line of text here',
      'Right column first line of text here Right column second line of text here',
    ]);
  });

  it('首行缩进另起一段；上一行是短末行时另起一段', () => {
    const items = [
      ...textLine('First paragraph line one that is long', 0, 100),
      ...textLine('ends here.', 0, 112),
      ...textLine('Second paragraph starts with a long line', 0, 124),
      ...textLine('and continues on the next line here', 0, 136),
      ...textLine('Third paragraph is indented and long', 15, 148),
    ];
    expect(analyzePage(items, 400).map((b) => b.text)).toEqual([
      'First paragraph line one that is long ends here.',
      'Second paragraph starts with a long line and continues on the next line here',
      'Third paragraph is indented and long',
    ]);
  });

  it('居中的多行标题不被切开，并标为居中', () => {
    const items = [
      ...textLine('A Very Long Title For The Paper Here', 100, 100, { size: 16 }),
      ...textLine('Second Title Line', 176, 120, { size: 16 }),
    ];
    const blocks = analyzePage(items, 600);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.align).toBe('center');
  });

  it('行内公式（含挂靠的下标）成为原子 <xN/>，正文照常翻译', () => {
    const items = [
      item('queries of dimension ', 0, 100),
      item('d', 105, 100, { font: MATH }),
      item('k', 110, 102, { font: MATH_SMALL, size: 7 }),
      item(', and values of dimension ', 115, 100),
      item('d', 245, 100, { font: MATH }),
      item('v', 250, 102, { font: MATH_SMALL, size: 7 }),
      item('. We compute the products.', 255, 100),
    ];
    const [block] = analyzePage(items, 600);
    expect(block!.text).toBe('queries of dimension <x0/>, and values of dimension <x1/>. We compute the products.');
    expect(block!.atoms.map((a) => a.items.map((i) => i.str).join(''))).toEqual(['dk', 'dv']);
    expect(block!.keep).toBe(false);
  });

  it('行间公式（单词不到 3 个）、纯代码块、没有字母的块保留原文', () => {
    const formula = analyzePage([item('Attention(', 100, 100, { font: 'ABCDEF+CMR10' }), item('Q', 150, 100, { font: MATH }), item(') = softmax(', 156, 100, { font: 'ABCDEF+CMR10' })], 600);
    expect(formula[0]!.keep).toBe(true);
    const code = analyzePage([item('const answer = compute(value);', 0, 100, { font: 'ABCDEF+CMTT10', mono: true })], 600);
    expect(code[0]!.keep).toBe(true);
    const numbers = analyzePage([item('(1)', 500, 100)], 600);
    expect(numbers[0]!.keep).toBe(true);
  });

  it('行内代码成为原子，不被翻译', () => {
    const [block] = analyzePage([item('Run ', 0, 100), item('npm install', 20, 100, { font: 'ABCDEF+Courier', mono: true }), item(' before building the project.', 75, 100)], 600);
    expect(block!.text).toBe('Run <x0/> before building the project.');
  });

  it('行末连字符断词合并；特殊字符转义', () => {
    const items = [...textLine('We use repre-', 0, 100), ...textLine('sentation learning & more <tags>.', 0, 112)];
    expect(analyzePage(items, 400)[0]!.text).toBe('We use representation learning &amp; more &lt;tags&gt;.');
  });

  it('列表项的悬挂缩进不切段，下一项另起一块；多级章节号标题的第二行也算悬挂缩进', () => {
    const items = [
      ...textLine('2. We propose ESTI, a state-semantic attack that', 0, 100),
      ...textLine('reformulates a predefined adversarial objective', 12, 112),
      ...textLine('as false evidence while preserving the instruction.', 12, 124),
      ...textLine('3. We construct ESTI-Bench, a closed-loop evaluation', 0, 136),
      ...textLine('framework that separately measures the two levels.', 12, 148),
    ];
    const blocks = analyzePage(items, 600);
    expect(blocks.map((b) => b.text.slice(0, 2))).toEqual(['2.', '3.']);
    expect(blocks[0]!.restIndent).toBe(12);

    const heading = analyzePage([item('2.2', 0, 100, { size: 12 }), item('Indirect Prompt Injection against LLM', 25, 100, { size: 12 }), item('Agents', 25, 114, { size: 12 })], 600);
    expect(heading.map((b) => b.text)).toEqual(['2.2 Indirect Prompt Injection against LLM Agents']);
  });

  it('段首行（首行缩进、下一行大半是斜体）不被误判为居中而单独成块', () => {
    const items = [
      item('Based on this system property, we assume that an', 10, 100),
      item('can ', 0, 112),
      item('influence a limited subset of task-relevant', 20, 112, { font: 'ABCDEF+Times-Italic' }),
      item('agent, causing some values to become inconsistent.', 0, 124),
    ];
    const blocks = analyzePage(items, 600);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.align).toBe('left');
  });

  it('两端对齐的标题被拆成几段时并回一行；单级章节号的标题第二行算悬挂缩进', () => {
    const bold = { size: 12, font: 'ABCDEF+NimbusRomNo9L-Medi' };
    const items = [
      ...textLine('the previous paragraph of body text that spans the column.', 0, 80),
      item('3.3 State-Semantic', 0, 100, bold),
      item('Construction', 140, 100, bold),
      item('under', 230, 100, bold),
      item('Matched Groundability', 25, 114, bold),
      ...textLine('the next paragraph of body text that spans the whole column.', 0, 134),
    ];
    const blocks = analyzePage(items, 600);
    expect(blocks.map((b) => b.text)).toContain('3.3 State-Semantic Construction under Matched Groundability');
    const single = analyzePage([item('3 ESTI: Environment State-Text Injection At-', 0, 100, bold), item('tack', 18, 114, bold)], 600);
    expect(single.map((b) => b.text)).toEqual(['3 ESTI: Environment State-Text Injection Attack']);
  });

  it('两栏之间的栏缝不会被当成标题的词距并起来', () => {
    const items = [
      item('Left column heading words', 0, 100),
      item('Right column body text line', 160, 100),
      ...textLine('left body line under the heading here', 0, 112),
    ];
    expect(analyzePage(items, 400).map((b) => b.text)).not.toContain('Left column heading words Right column body text line');
  });

  it('公式编号「(6)」单独成块，不并进下面的段落', () => {
    const items = [item('(6)', 230, 100), ...textLine('where Sem, Aff, and Pre check semantic compatibility', 0, 112)];
    expect(analyzePage(items, 400).map((b) => b.text)).toEqual(['(6)', 'where Sem, Aff, and Pre check semantic compatibility']);
  });

  it('压着重音、带上下标的正文斜体字母是公式变量，和重音、下标连成一个原子', () => {
    const italic = 'ABCDEF+NimbusRomNo9L-ReguItal';
    const items = [
      item('Let ', 0, 100),
      item('S', 20, 100, { font: italic, w: 5 }),
      // 宽波浪线（CMEX）略高、压在 S 上
      item('e', 20.8, 97.6, { font: 'ABCDEF+CMEX10', w: 5.5 }),
      item('t', 24.8, 101.5, { font: italic, size: 7.4, w: 2 }),
      item(' denote the state supplied to the planner.', 27, 100),
    ];
    const [block] = analyzePage(items, 600);
    expect(block!.text).toBe('Let <x0/> denote the state supplied to the planner.');
    expect(block!.atoms[0]!.items.map((i) => i.str).sort()).toEqual(['S', 'e', 't']);
  });

  it('和段落正文样式不同的行内斜体、粗体用 <gN> 标出并记下样式', () => {
    const items = [
      item('We assume that an adversary can ', 0, 100),
      item('influence a limited subset', 160, 100, { font: 'ABCDEF+NimbusRomNo9L-ReguItal' }),
      item(' of states, as shown in ', 290, 100),
      item('Table 2', 405, 100, { font: 'ABCDEF+NimbusRomNo9L-Medi' }),
      item('.', 440, 100),
    ];
    const [block] = analyzePage(items, 800);
    expect(block!.text).toBe('We assume that an adversary can <g0>influence a limited subset</g0> of states, as shown in <g1>Table 2</g1>.');
    expect(block!.marks.map((m) => [m.bold, m.italic])).toEqual([
      [false, true],
      [true, false],
    ]);
    // 整块都是斜体（单位）时不加标签
    const [all] = analyzePage([item('Wuhan University', 0, 100, { font: 'ABCDEF+NimbusRomNo9L-ReguItal' })], 600);
    expect(all!.marks).toHaveLength(0);
  });

  it('以脚注标记开头的行是下一条脚注，即使两行一样短', () => {
    const items = [
      item('†', 0, 92.5, { size: 6, font: 'ABCDEF+CMSY6' }),
      item('Work performed while at Google Brain.', 4, 96.5, { size: 9 }),
      item('‡', 0, 103.6, { size: 6, font: 'ABCDEF+CMSY6' }),
      item('Work performed while at Google Research.', 4, 107.5, { size: 9 }),
    ];
    expect(analyzePage(items, 600).map((b) => b.text)).toEqual(['<x0/>Work performed while at Google Brain.', '<x0/>Work performed while at Google Research.']);
  });

  it('作者-年份式引用整串作为原子，即使超过 4 个词', () => {
    const [block] = analyzePage(
      [
        item('Pre-training is effective for many tasks ', 0, 100, { color: '#000000' }),
        item('(Dai and Le, 2015; Peters et al., 2018a)', 205, 100, { color: '#000080' }),
        item('. These include inference.', 405, 100, { color: '#000000' }),
      ],
      800,
    );
    expect(block!.text).toBe('Pre-training is effective for many tasks <x0/>. These include inference.');
  });

  it('作者栏：姓名与单位（字体不同）各成一块；姓名不翻译，单位翻译并居中', () => {
    const roman = 'ABCDEF+NimbusRomNo9L-Regu';
    const italic = 'ABCDEF+NimbusRomNo9L-ReguItal';
    const items = [
      item('Jiawei Liu', 75, 100, { font: roman }),
      item('Wuhan University', 60, 114, { font: italic }),
      item('Juan Wang', 77, 128, { font: roman }),
      item('Wuhan University', 60, 142, { font: italic }),
      item('Tian Zhang', 275, 100, { font: roman }),
      item('University at Buffalo', 250, 114, { font: italic }),
    ];
    const blocks = analyzePage(items, 600);
    expect(blocks.map((b) => [b.text, b.keep, b.align])).toEqual([
      ['Jiawei Liu', true, 'center'],
      ['Tian Zhang', true, 'center'],
      ['Wuhan University', false, 'center'],
      ['University at Buffalo', false, 'center'],
      ['Juan Wang', true, 'center'],
      ['Wuhan University', false, 'center'],
    ]);
  });

  it('表格：同一列上下相邻的单元格不连成段落', () => {
    const row = (label: string, y: number) => [item(label, 0, y), item('19.33%', 200, y), item('39.71%', 260, y)];
    const blocks = analyzePage([...row('EIRAD', 100), ...row('Vanilla IPI', 112), ...row('BADROBOT-contextual jailbreak', 124)], 600);
    const labels = blocks.filter((b) => !b.keep);
    expect(labels.map((b) => b.text)).toEqual(['EIRAD', 'Vanilla IPI', 'BADROBOT-contextual jailbreak']);
    expect(labels.every((b) => b.cell)).toBe(true);
  });

  it('和正文颜色不同的短片段（引用编号、链接）成为原子；长的彩色句子照常翻译', () => {
    const black = '#000000';
    const red = '#ff0000';
    const [block] = analyzePage(
      [
        item('robotic manipulation ', 0, 100, { color: black }),
        item('[1,20]', 105, 100, { color: red }),
        item('. Vision-language models are useful.', 135, 100, { color: black }),
      ],
      600,
    );
    expect(block!.text).toBe('robotic manipulation <x0/>. Vision-language models are useful.');
    const [long] = analyzePage(
      [
        item('Before running the benchmark, please note that ', 0, 100, { color: black }),
        item('this whole sentence is shown in red', 240, 100, { color: red }),
        item(' for emphasis.', 415, 100, { color: black }),
      ],
      600,
    );
    expect(long!.atoms).toHaveLength(0);
  });

  it('页面最下方的页码标为页面装饰；正文里单独的数字不算', () => {
    const blocks = analyzePage([...textLine('Body text of the page goes here.', 0, 100), item('12', 300, 760), item('(3)', 500, 400)], 600);
    expect(blocks.find((b) => b.text === '12')!.furniture).toBe(true);
    expect(blocks.find((b) => b.text === '(3)')!.furniture).toBe(false);
  });

  it('单行标题位于页面中线附近时标为居中', () => {
    const [title] = analyzePage([item('Attention Is All You Need', 194, 100, { size: 17 })], 600);
    expect(title!.align).toBe('center');
    const [left] = analyzePage([item('3.2 Scaled Dot-Product Attention', 50, 100)], 600);
    expect(left!.align).toBe('left');
  });
});
