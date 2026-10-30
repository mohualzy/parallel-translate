import { beforeEach, describe, expect, it } from 'vitest';
import { collectRuns } from '@/content/collect';
import { buildExcludeSelector, DomClassifier, looksLikeUIChrome } from '@/content/dom';
import { deserialize, serialize } from '@/content/richtext';

let classifier: DomClassifier;

function setup(html: string) {
  document.body.innerHTML = html;
  classifier = new DomClassifier(buildExcludeSelector(['.skip-me']));
}

const texts = () =>
  collectRuns(document.body, classifier).map((r) =>
    r.nodes
      .map((n) => n.textContent)
      .join('')
      .replace(/\s+/g, ' ')
      .trim(),
  );

describe('collectRuns', () => {
  beforeEach(() => (document.body.innerHTML = ''));

  it('普通段落整段识别，whole=true', () => {
    setup('<p>Hello <a href="#">world</a>!</p>');
    const [run] = collectRuns(document.body, classifier);
    expect(run?.container.localName).toBe('p');
    expect(run?.whole).toBe(true);
    expect(run?.nodes).toHaveLength(3);
  });

  it('列表项的直接文本与嵌套列表分开识别', () => {
    setup('<ul><li>Parent item<ul><li>Child item</li></ul></li></ul>');
    const runs = collectRuns(document.body, classifier).filter((r) => r.nodes.some((n) => n.textContent?.trim()));
    const parent = runs.find((r) => r.nodes[0]?.textContent === 'Parent item');
    const child = runs.find((r) => r.nodes[0]?.textContent === 'Child item');
    expect(parent?.whole).toBe(false);
    expect(child?.whole).toBe(true);
  });

  it('没有文字的块级图标不打断段落：「文字 + 图标」仍是整段，图标记为装饰', () => {
    setup(`
      <div id="btn">Platform<div class="icon"><svg><title>Open menu</title></svg></div></div>
      <div id="two">Before<div class="icon"><svg></svg></div>After</div>
      <div id="ctl">Theme<div><input type="checkbox"></div></div>
    `);
    const runs = collectRuns(document.body, classifier);
    const btn = runs.find((r) => r.container.id === 'btn');
    expect(btn?.whole).toBe(true);
    expect(btn?.decorations?.map((e) => e.className)).toEqual(['icon']);
    // 图标两侧都有文字：仍是两段，都不算整段
    expect(runs.filter((r) => r.container.id === 'two').map((r) => r.whole)).toEqual([false, false]);
    // 装着表单控件的块不是装饰
    expect(runs.find((r) => r.container.id === 'ctl')?.whole).toBe(false);
  });

  it('跳过代码块、脚本、隐藏元素和排除区域', () => {
    setup(`
      <p>Visible text</p>
      <pre>const x = 1;</pre>
      <script>var y = 2;</script>
      <div style="display:none"><p>Hidden but registered lazily</p></div>
      <div class="notranslate"><p>No translate</p></div>
      <div class="skip-me"><p>User excluded</p></div>
      <div contenteditable="true"><p>Editor</p></div>
    `);
    const found = texts().filter(Boolean);
    expect(found).toContain('Visible text');
    expect(found).not.toContain('const x = 1;');
    expect(found).not.toContain('No translate');
    expect(found).not.toContain('User excluded');
    expect(found).not.toContain('Editor');
    expect(found.join(' ')).not.toContain('var y');
  });

  it('包含块级元素的 <a> 按块处理，内部段落各自识别', () => {
    setup('<a href="#"><h3>Card title</h3><p>Card body text</p></a>');
    const found = texts().filter(Boolean);
    expect(found).toEqual(['Card title', 'Card body text']);
  });

  it('行内代码属于段落的一部分', () => {
    setup('<p>Run <code>npm install</code> first</p>');
    expect(texts()).toEqual(['Run npm install first']);
  });

  it('连续两个 <br> 分段，单个 <br> 仍在段内', () => {
    setup('<p>First para<br>\n<br>Second <a href="#">link</a> para<br>still second</p>');
    // texts() 拼接 textContent，<br> 不产生字符；两个 <br> 之间的空白片段之后会被过滤
    expect(texts().filter(Boolean)).toEqual(['First para', 'Second link parastill second']);
  });

  it('内部用 <br><br> 分段的行内元素按块处理，进入内部切分', () => {
    setup('<div><font>Para one.<br><br>Para two.</font></div>');
    const runs = collectRuns(document.body, classifier).filter((r) => r.nodes.some((n) => n.textContent?.trim()));
    expect(runs.map((r) => r.container.localName)).toEqual(['font', 'font']);
    expect(texts().filter(Boolean)).toEqual(['Para one.', 'Para two.']);
  });

  it('读屏专用的隐藏文字被忽略', () => {
    setup('<p>Star<span class="sr-only"> this repository</span> now</p>');
    expect(texts()).toEqual(['Star now']);
  });

  it('进入 open shadow root 收集段落，并回报遇到的 shadow root', () => {
    setup('<x-host id="host"></x-host>');
    const host = document.getElementById('host')!;
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<p>Inside the shadow tree.</p>';
    const seen: ShadowRoot[] = [];
    classifier.reset();
    const runs = collectRuns(document.body, classifier, true, (sr) => seen.push(sr));
    expect(runs.map((r) => r.nodes.map((n) => n.textContent).join(''))).toContain('Inside the shadow tree.');
    expect(seen).toEqual([root]);
  });

  it('shadow 树里包着 <slot> 的行内自定义元素按块进入，投影内容逐段收集（仿 Reddit 的 devvit-wrapper）', () => {
    setup('<x-app id="app"><div><p>First projected paragraph.</p><p>Second projected paragraph.</p></div></x-app>');
    const root = document.getElementById('app')!.attachShadow({ mode: 'open' });
    root.innerHTML = '<x-wrapper><slot></slot></x-wrapper>';
    classifier.reset();
    expect(texts()).toEqual(['First projected paragraph.', 'Second projected paragraph.']);
  });

  it('视觉隐藏的 shadow 宿主（读屏专用组件）不收集', () => {
    setup('<p>Visible title.</p><x-sr id="sr" style="position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0)"><span>Visible title.</span></x-sr>');
    document.getElementById('sr')!.attachShadow({ mode: 'open' }).innerHTML = '<slot></slot>';
    classifier.reset();
    expect(texts()).toEqual(['Visible title.']);
  });

  it('html/body 上的 translate="no" 不屏蔽整页', () => {
    setup('<p>Still here</p>');
    document.body.setAttribute('translate', 'no');
    expect(texts()).toContain('Still here');
    document.body.removeAttribute('translate');
  });
});

describe('looksLikeUIChrome', () => {
  it('链接/按钮里的短文字、只含一个链接的列表项、flex 子项里的短文字算界面文字', () => {
    setup(`
      <a id="link"><div id="in-link">Sign in</div></a>
      <div style="display:flex"><div id="flex-item">Fork</div></div>
      <ul><li id="nav-li"><a href="#">Home</a></li><li id="text-li">Apples</li></ul>
      <div id="plain-div">Fork</div>
      <h3 id="heading"><a href="#">Fork</a></h3>
      <div style="display:flex"><div id="long">This is a full sentence with many words.</div></div>
      <article><ul><li id="article-li"><a href="#">Quick Start</a></li></ul></article>
    `);
    const ui = (id: string) => {
      const el = document.getElementById(id)!;
      return looksLikeUIChrome(el, Array.from(el.childNodes), el.textContent!);
    };
    expect(ui('in-link')).toBe(true);
    expect(ui('flex-item')).toBe(true);
    expect(ui('nav-li')).toBe(true);
    expect(ui('text-li')).toBe(false);
    expect(ui('plain-div')).toBe(false);
    expect(ui('heading')).toBe(false);
    expect(ui('long')).toBe(false);
    expect(ui('article-li')).toBe(false);
  });
});

describe('richtext', () => {
  it('序列化：链接/加粗用 g 标签，行内代码用 x 标签，plain 不含代码', () => {
    setup('<p>Click <a href="/docs" id="lnk">the <b>docs</b></a> or run <code>npm i</code> &lt;now&gt;</p>');
    const [run] = collectRuns(document.body, classifier);
    const ser = serialize(run!.nodes, true, classifier);
    expect(ser.text).toBe('Click <g0>the <g1>docs</g1></g0> or run <x2>npm i</x2> &lt;now&gt;');
    expect(ser.plain).toBe('Click the docs or run <now>');
    expect(ser.refs.map((r) => r.localName)).toEqual(['a', 'b', 'code']);
  });

  it('关闭富文本时不产生标签，代码文字仍保留给模型', () => {
    setup('<p>Click <a href="/docs">here</a> to run <code>npm i</code></p>');
    const [run] = collectRuns(document.body, classifier);
    const ser = serialize(run!.nodes, false, classifier);
    expect(ser.text).toBe('Click here to run npm i');
    expect(ser.refs).toHaveLength(0);
  });

  it('反序列化：重建链接（去掉 id）、克隆代码、反转义文本', () => {
    setup('<p>Click <a href="/docs" id="lnk">the <b>docs</b></a> or run <code>npm i</code></p>');
    const [run] = collectRuns(document.body, classifier);
    const { refs } = serialize(run!.nodes, true, classifier);
    const frag = deserialize('点击<g0><g1>文档</g1></g0>或运行 <x2>乱写</x2> &lt;现在&gt;', refs, document);
    const div = document.createElement('div');
    div.append(frag);
    expect(div.innerHTML).toBe('点击<a href="/docs"><b>文档</b></a>或运行 <code>npm i</code> &lt;现在&gt;');
  });

  it('容错：未知编号丢弃、未闭合自动闭合、孤立闭合标签忽略、xN 只有开标签', () => {
    setup('<p><a href="/a">A</a> <code>c</code></p>');
    const [run] = collectRuns(document.body, classifier);
    const { refs } = serialize(run!.nodes, true, classifier);
    const div = document.createElement('div');
    div.append(deserialize('</g0>前<g9>未知</g9><g0>链接 <x1> 后', refs, document));
    expect(div.innerHTML).toBe('前未知<a href="/a">链接 <code>c</code> 后</a>');
  });

  it('上下标、时间、图标字体原样保留：不进入 plain，译文中整体克隆', () => {
    setup(
      '<p>Water is H<sub>2</sub>O<sup><a href="#c1">[1]</a></sup>, updated <time>Oct 3</time> <span class="material-icons">search</span></p>',
    );
    const [run] = collectRuns(document.body, classifier);
    const ser = serialize(run!.nodes, true, classifier);
    expect(ser.text).toBe('Water is H<x0>2</x0>O<x1>[1]</x1>, updated <x2>Oct 3</x2> <x3>search</x3>');
    expect(ser.plain).toBe('Water is HO, updated');
    const div = document.createElement('div');
    div.append(deserialize('水是 H<x0/>O<x1/>，更新于 <x2/> <x3>搜索</x3>', ser.refs, document));
    expect(div.innerHTML).toBe(
      '水是 H<sub>2</sub>O<sup><a href="#c1">[1]</a></sup>，更新于 <time>Oct 3</time> <span class="material-icons">search</span>',
    );
  });

  it('表单控件在译文里不留文字（下拉框的文字是全部选项），按钮保留文字', () => {
    setup('<p>Theme <select><option>Auto</option><option>Dark</option></select> or <button>Reset</button></p>');
    const [run] = collectRuns(document.body, classifier);
    const ser = serialize(run!.nodes, true, classifier);
    const div = document.createElement('div');
    div.append(deserialize('主题 <x0/> 或 <x1/>', ser.refs, document));
    expect(div.textContent).toBe('主题  或 Reset');
  });

  it('标签过多时降级为纯文本', () => {
    const links = Array.from({ length: 30 }, (_, i) => `<a href="#${i}">w${i}</a>`).join(' ');
    setup(`<p>${links}</p>`);
    const [run] = collectRuns(document.body, classifier);
    const ser = serialize(run!.nodes, true, classifier);
    expect(ser.refs).toHaveLength(0);
    expect(ser.text).toContain('w0 w1');
  });
});
