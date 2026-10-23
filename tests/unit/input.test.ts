import { beforeEach, describe, expect, it } from 'vitest';
import { editableOf, readTarget, writeBack } from '@/content/input';

beforeEach(() => {
  document.body.innerHTML = '';
});

function mount<T extends Element>(html: string): T {
  document.body.innerHTML = html;
  return document.body.firstElementChild as T;
}

describe('editableOf', () => {
  it('只认文本类输入框、textarea 与 contenteditable 根，排除密码框和只读', () => {
    document.body.innerHTML = `
      <input id="text"><input id="search" type="search"><input id="pw" type="password"><input id="mail" type="email">
      <input id="ro" readonly><textarea id="ta"></textarea><textarea id="dis" disabled></textarea>
      <div id="ce" contenteditable="true"><p id="inner">hi</p></div><div id="plain">x</div>`;
    const $ = (id: string) => document.getElementById(id);
    expect(editableOf($('text'))).toBe($('text'));
    expect(editableOf($('search'))).toBe($('search'));
    expect(editableOf($('ta'))).toBe($('ta'));
    expect(editableOf($('pw'))).toBeNull();
    expect(editableOf($('mail'))).toBeNull();
    expect(editableOf($('ro'))).toBeNull();
    expect(editableOf($('dis'))).toBeNull();
    expect(editableOf($('plain'))).toBeNull();
    expect(editableOf($('inner'))).toBe($('ce'));
  });
});

describe('readTarget / writeBack（输入框）', () => {
  it('没有选中文字时取整框，写回后读得到译文', async () => {
    const ta = mount<HTMLTextAreaElement>('<textarea></textarea>');
    ta.value = '你好世界';
    ta.setSelectionRange(4, 4);
    const target = readTarget(ta);
    expect(target).toMatchObject({ whole: true, text: '你好世界', snapshot: '你好世界' });
    expect(await writeBack(target, 'Hello world')).not.toBe('failed');
    expect(ta.value).toBe('Hello world');
  });

  it('有选中文字时只替换选区，前后内容保留', async () => {
    const input = mount<HTMLInputElement>('<input>');
    input.value = 'Say 你好 please';
    input.setSelectionRange(4, 6);
    const target = readTarget(input);
    expect(target).toMatchObject({ whole: false, text: '你好', start: 4, end: 6 });
    expect(await writeBack(target, 'hello')).not.toBe('failed');
    expect(input.value).toBe('Say hello please');
  });

  it('写回会派发 input 事件，框架能感知', async () => {
    const input = mount<HTMLInputElement>('<input>');
    input.value = '你好';
    let fired = 0;
    input.addEventListener('input', () => fired++);
    await writeBack(readTarget(input), 'Hi');
    expect(fired).toBeGreaterThan(0);
  });
});

describe('fullText（contenteditable）', () => {
  it('由段落组成时逐段用单个换行连接，空段落保留为空行', () => {
    const ce = mount<HTMLElement>('<div contenteditable="true">\n  <p>你好</p>\n  <p><br></p>\n  <p>再见</p>\n</div>');
    expect(readTarget(ce).text).toBe('你好\n\n再见');
    const two = mount<HTMLElement>('<div contenteditable="true"><p>第一段</p><p>第二段</p></div>');
    expect(readTarget(two).text).toBe('第一段\n第二段');
  });
});
