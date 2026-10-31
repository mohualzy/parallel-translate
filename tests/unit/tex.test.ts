import { describe, expect, it } from 'vitest';
import { renderTex } from '@/background/tex';
import { buildExcludeSelector, DomClassifier } from '@/content/dom';
import { deserialize, hasFormula, serialize } from '@/content/richtext';
import { splitTex, TEX_TAG } from '@/lib/tex';

const formulas = (text: string) => splitTex(text).flatMap((p) => (p.tex === undefined ? [] : [p.tex]));
const classifier = () => new DomClassifier(buildExcludeSelector([]));

function paragraph(html: string) {
  const p = document.createElement('p');
  p.innerHTML = html;
  return p;
}

describe('splitTex', () => {
  it('识别四种分隔符，区分行内和行间', () => {
    expect(splitTex('Let $x^2$ be')).toEqual([{ text: 'Let ' }, { text: '$x^2$', tex: 'x^2', display: false }, { text: ' be' }]);
    expect(splitTex('$$E=mc^2$$')).toEqual([{ text: '$$E=mc^2$$', tex: 'E=mc^2', display: true }]);
    expect(formulas(String.raw`inline \(\alpha\) and \[\sum_i x_i\]`)).toEqual([String.raw`\alpha`, String.raw`\sum_i x_i`]);
    expect(splitTex(String.raw`\[ a+b \]`)[0]?.display).toBe(true);
  });

  it('单个变量和常见公式算公式', () => {
    expect(formulas('where $x$ and $y_1$ and $x\'$ hold')).toEqual(['x', 'y_1', "x'"]);
    expect(formulas(String.raw`$\frac{a}{b}$, $a+b$, $a<b$`)).toEqual([String.raw`\frac{a}{b}`, 'a+b', 'a<b']);
  });

  it('价格、shell 变量、普通反斜杠不算公式', () => {
    for (const text of [
      'It costs $5 and $10 today',
      'From $5-$10 only',
      '$10+$20',
      'echo $HOME/$USER',
      '$foo$bar',
      'US$5 or US$10',
      String.raw`C:\Users\name (see \( and \))`,
      String.raw`footnote \[1\]`,
      'no dollars here',
      '',
    ]) {
      expect(formulas(text)).toEqual([]);
      expect(splitTex(text).map((p) => p.text).join('')).toBe(text);
    }
  });

  it('普通文字原样拼回，排在公式前后的不丢', () => {
    const text = String.raw`a $5 b $x^2$ c \(y\) d`;
    expect(splitTex(text).map((p) => p.text).join('')).toBe(text);
  });
});

describe('serialize / deserialize', () => {
  it('公式换成占位，纯文本不含公式，译文里还原成公式元素', () => {
    const ser = serialize(Array.from(paragraph('Let $x^2$ be &lt;positive&gt;').childNodes), true, classifier());
    expect(ser.text).toBe('Let <x0>$x^2$</x0> be &lt;positive&gt;');
    expect(ser.plain).toBe('Let be <positive>');
    expect(hasFormula(ser.refs)).toBe(true);

    const root = document.createElement('div');
    root.append(deserialize('设 <x0>$x^2$</x0> 为正', ser.refs, document));
    const el = root.querySelector(TEX_TAG)!;
    expect(el.getAttribute('data-tex')).toBe('x^2');
    expect(el.textContent).toBe('$x^2$');
  });

  it('公式里的 < 转义后发给模型，占位内容不影响渲染用的源码', () => {
    const ser = serialize(Array.from(paragraph('Then $a&lt;b$ holds').childNodes), true, classifier());
    expect(ser.text).toBe('Then <x0>$a&lt;b$</x0> holds');
    expect(ser.refs[0]?.getAttribute('data-tex')).toBe('a<b');
  });

  it('只有公式的段落：plain 退回公式文本，段落才能进翻译流程', () => {
    expect(serialize(Array.from(paragraph('$$E=mc^2$$').childNodes), true, classifier()).plain).toBe('$$E=mc^2$$');
  });

  it('code 里的 $ 不算公式', () => {
    const ser = serialize(Array.from(paragraph('Run <code>echo $x^2$</code> now').childNodes), true, classifier());
    expect(hasFormula(ser.refs)).toBe(false);
  });

  it('纯文本模式没有占位，译文文字里的公式同样还原', () => {
    const ser = serialize(Array.from(paragraph('Let $x^2$ be').childNodes), false, classifier());
    expect(ser.text).toBe('Let $x^2$ be');
    expect(ser.refs).toEqual([]);
    const root = document.createElement('div');
    root.append(deserialize('设 $x^2$ 为', ser.refs, document));
    expect(root.querySelector(TEX_TAG)?.getAttribute('data-tex')).toBe('x^2');
  });
});

describe('renderTex', () => {
  it('输出 MathML，行间公式带 block', () => {
    expect(renderTex('x^2', false)).toContain('<math');
    expect(renderTex('x^2', true)).toContain('display="block"');
  });

  it('语法错误返回 null，调用方保留源码', () => {
    expect(renderTex(String.raw`\frac{a`, false)).toBeNull();
    expect(renderTex(String.raw`\notacommand`, false)).toBeNull();
  });

  it('不产生链接：公式来自不可信的页面文本', () => {
    expect(renderTex(String.raw`\href{javascript:alert(1)}{x}`, false) ?? '').not.toMatch(/href\s*=/);
  });
});
